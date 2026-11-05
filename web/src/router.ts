// History-API router that keeps recent views alive (hidden) so Back is instant and
// restores the scroll position exactly. Tab roots are kept forever.
import { handoff, pauseAll } from './media/video';
import { quietScroll } from './util';

export interface View {
  el: HTMLElement;
  title?: string;
  tab?: string; // which bottom-nav tab this belongs to
  noFab?: boolean; // hide the compose button (it would cover the post's actions)
  show?(): void;
  hide?(): void;
  destroy?(): void;
  /** Called when the user taps the active tab icon again. */
  reselect?(): void;
}

type Factory = (m: RegExpMatchArray, url: URL) => View;
interface Route {
  re: RegExp;
  make: Factory;
  root?: boolean;
}
interface Entry {
  view: View;
  y: number;
  path: string;
}

const routes: Route[] = [];
const live = new Map<string, Entry>(); // key -> entry
const roots = new Map<string, Entry>(); // path -> entry for tab roots
const order: string[] = [];
const KEEP = 10;
let current: Entry | null = null;
let currentKey = '';
let overlayClose: (() => void) | null = null;
let afterClose: (() => void) | null = null;
let idx = 0;
let container: HTMLElement;
let onChange: (v: View) => void = () => {};

export function route(re: RegExp, make: Factory, root = false) {
  routes.push({ re, make, root });
}

const newKey = () => Math.random().toString(36).slice(2, 10);

function build(url: URL): View {
  for (const r of routes) {
    const m = url.pathname.match(r.re);
    if (m) return r.make(m, url);
  }
  return routes[routes.length - 1].make([] as any, url);
}

function isRoot(path: string) {
  return routes.some((r) => r.root && r.re.test(path));
}

function activate(e: Entry, y: number) {
  if (current && current !== e) {
    current.y = scrollY;
    current.view.el.hidden = true;
    current.view.hide?.();
  }
  current = e;
  e.view.el.hidden = false;
  if (!e.view.el.isConnected) container.append(e.view.el);
  // A video playing in the post being opened keeps playing there.
  if (!handoff(e.view.el)) pauseAll();
  quietScroll(y);
  e.view.show?.();
  document.title = e.view.title ? `${e.view.title} · litex` : 'litex';
  onChange(e.view);
}

function entryFor(key: string, url: URL): Entry {
  const path = url.pathname + url.search;
  if (isRoot(url.pathname)) {
    let r = roots.get(path);
    if (!r) roots.set(path, (r = { view: build(url), y: 0, path }));
    return r;
  }
  let e = live.get(key);
  if (!e) {
    e = { view: build(url), y: 0, path };
    live.set(key, e);
    order.push(key);
    while (order.length > KEEP) {
      const old = order.shift()!;
      const oe = live.get(old);
      if (oe && oe !== current) {
        oe.view.destroy?.();
        oe.view.el.remove();
        live.delete(old);
      }
    }
  }
  return e;
}

export function navigate(href: string, replace = false) {
  const url = new URL(href, location.origin);
  if (url.origin !== location.origin) return void window.open(url.href, '_blank', 'noopener');
  const path = url.pathname + url.search;
  if (current && path === current.path && !replace) {
    current.view.reselect?.();
    return;
  }
  const key = newKey();
  if (current) current.y = scrollY;
  if (replace) history.replaceState({ key, idx }, '', path);
  else history.pushState({ key, idx: ++idx }, '', path);
  currentKey = key;
  const e = entryFor(key, url);
  activate(e, isRoot(url.pathname) ? e.y : 0);
}

/** Open an overlay (media viewer, composer) that Back closes. */
export function pushOverlay(close: () => void) {
  overlayClose = close;
  history.pushState({ key: currentKey, overlay: true, idx: idx + 1 }, '', location.href);
}

/** Close the open overlay; `then` runs after the history entry is gone (safe to navigate). */
export function closeOverlay(then?: () => void) {
  if (!overlayClose) return then?.();
  afterClose = then || null;
  history.back();
}

export function startRouter(el: HTMLElement, change: (v: View) => void) {
  container = el;
  onChange = change;
  history.scrollRestoration = 'manual';
  addEventListener('popstate', (ev) => {
    if (overlayClose) {
      const c = overlayClose;
      overlayClose = null;
      c();
      const then = afterClose;
      afterClose = null;
      if (then) setTimeout(then, 0);
      if (ev.state?.key === currentKey) return;
    }
    const key = ev.state?.key || newKey();
    idx = ev.state?.idx ?? 0;
    if (!ev.state?.key) history.replaceState({ key, idx }, '', location.href);
    if (ev.state?.overlay) {
      // Forward into a stale overlay entry: skip it.
      history.back();
      return;
    }
    currentKey = key;
    const url = new URL(location.href);
    const e = entryFor(key, url);
    activate(e, e.y);
  });
  const key = newKey();
  history.replaceState({ key, idx: 0 }, '', location.href);
  currentKey = key;
  const url = new URL(location.href);
  activate(entryFor(key, url), 0);
}

/** Back within the app, or to Home when this is the first page (e.g. opened from a link). */
export function goBack() {
  if (idx > 0) history.back();
  else navigate('/', true);
}

export const currentView = () => current?.view;
