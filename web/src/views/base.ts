import { Feed } from '../feed/feed';
import { icon } from '../icons';
import { esc, h, quietScroll } from '../util';

export interface Shell {
  el: HTMLElement;
  top: HTMLElement;
  bar: HTMLElement;
  body: HTMLElement;
  tabs?: HTMLElement;
}

export function shell(o: {
  title?: string;
  sub?: string;
  back?: boolean;
  left?: string;
  right?: string;
  center?: string;
  tabs?: [string, string][];
  active?: string;
  /** Put the tabs in the title bar itself (one-row header). */
  inlineTabs?: boolean;
}): Shell {
  const el = h('section', 'view');
  const top = h('header', 'top');
  const bar = h('div', 'bar');
  const left = o.back ? `<button class="ib" data-act="back" aria-label="Back">${icon('back')}</button>` : o.left || '';
  const mid = o.center ?? `<div class="ttl"><b>${esc(o.title || '')}</b>${o.sub ? `<small>${esc(o.sub)}</small>` : ''}</div>`;
  bar.innerHTML = `${left}${o.inlineTabs ? '' : mid}${o.right || ''}`;
  top.append(bar);
  let tabs: HTMLElement | undefined;
  if (o.tabs) {
    tabs = h('nav', 'tabs');
    setTabs(tabs, o.tabs, o.active || o.tabs[0][0]);
    if (o.inlineTabs) bar.insertBefore(tabs, bar.children[1] || null);
    else top.append(tabs);
  }
  const body = h('div', 'body');
  el.append(top, body);
  return { el, top, bar, body, tabs };
}

export function setTabs(nav: HTMLElement, tabs: [string, string][], active: string) {
  nav.classList.toggle('scroll', tabs.length > 4);
  nav.innerHTML = tabs.map(([id, label]) => `<button data-tab="${id}" class="${id === active ? 'on' : ''}"><span>${esc(label)}</span></button>`).join('');
}

export function onTab(nav: HTMLElement, fn: (id: string) => void) {
  nav.addEventListener('click', (e) => {
    const b = (e.target as Element).closest<HTMLElement>('[data-tab]');
    if (!b) return;
    for (const x of nav.querySelectorAll('.on')) x.classList.remove('on');
    b.classList.add('on');
    fn(b.dataset.tab!);
  });
}

/** Several feeds behind tabs, each remembering its own scroll position. */
export class TabFeeds {
  private feeds = new Map<string, { feed: Feed; y: number }>();
  cur = '';
  constructor(
    private host: HTMLElement,
    private make: (tab: string) => Feed,
    private stickY: () => number = () => 0,
  ) {}

  get feed() {
    return this.feeds.get(this.cur)?.feed;
  }

  select(tab: string) {
    if (tab === this.cur) {
      scrollTo({ top: Math.min(scrollY, this.stickY()), behavior: 'smooth' });
      return;
    }
    const base = Math.min(scrollY, this.stickY());
    const prev = this.feeds.get(this.cur);
    if (prev) {
      prev.y = scrollY;
      prev.feed.pause();
      prev.feed.el.hidden = true;
    }
    this.cur = tab;
    let e = this.feeds.get(tab);
    if (!e) {
      const feed = this.make(tab);
      this.host.append(feed.el);
      e = { feed, y: base };
      this.feeds.set(tab, e);
      quietScroll(base);
      feed.start();
    } else {
      e.feed.el.hidden = false;
      quietScroll(Math.max(base, e.y));
      e.feed.resume();
    }
  }

  pause() {
    this.feed?.pause();
  }
  resume() {
    this.feed?.resume();
  }
  destroy() {
    for (const { feed } of this.feeds.values()) feed.destroy();
    this.feeds.clear();
  }
  each(fn: (f: Feed) => void) {
    for (const { feed } of this.feeds.values()) fn(feed);
  }
}

export function errorBox(msg: string) {
  return `<div class="err big">${esc(msg)}</div>`;
}
