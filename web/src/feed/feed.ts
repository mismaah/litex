// Chunked virtual feed. Items are rendered in chunks of ~20. A chunk far from the
// viewport is emptied and held open at its measured height, so DOM size stays roughly
// constant no matter how far you scroll. Native scrolling and scroll anchoring keep working.
import type { Item, Page } from '../../../shared/types';
import { ApiError } from '../api';
import { mountMedia, unmountMedia } from '../media/video';
import { intern } from '../store';
import { esc, h } from '../util';

const CHUNK = 10;
const MAX_ITEMS = 3000; // older item data is released beyond this (spacer kept)

interface Chunk {
  el: HTMLDivElement;
  items: (Item & { lt?: boolean })[] | null;
  live: boolean;
}

export interface FeedOpts {
  load(cursor?: string): Promise<Page>;
  render(item: Item): string;
  cls?: string; // extra class for chunks (e.g. "grid")
  empty?: string;
  dedupe?: boolean;
  /** Render the whole first page immediately (tweet view needs the focal post laid out). */
  eagerFirst?: boolean;
  onPage?(page: Page, first: boolean): void;
  /** Called once per post when at least half of it has been on screen. */
  onSeen?(id: string): void;
  /** Called after a chunk's posts are rendered, and before they are removed. */
  onMount?(el: HTMLElement): void;
  onUnmount?(el: HTMLElement): void;
}

export class Feed {
  el = h('div', 'feed');
  private list = h('div', 'chunks');
  private foot = h('div', 'foot');
  private chunks: Chunk[] = [];
  private byEl = new WeakMap<Element, Chunk>();
  private seen = new Set<string>();
  private cursor?: string;
  top?: string;
  private loading = false;
  private done = false;
  private error = '';
  private count = 0;
  private dry = 0; // consecutive pages with nothing new
  private io: IntersectionObserver;
  private queue = new Set<Chunk>(); // chunks waiting to render, one per frame
  private raf = 0;
  private footIo: IntersectionObserver;
  private active = true;
  private seenIo?: IntersectionObserver;

  constructor(private o: FeedOpts) {
    this.el.append(this.list, this.foot);
    // ~2 screens of rendered content above and below the viewport.
    this.io = new IntersectionObserver((e) => this.onChunks(e), { rootMargin: '200% 0px' });
    this.footIo = new IntersectionObserver((e) => e[0]?.isIntersecting && this.more(), { rootMargin: '150% 0px' });
    if (o.onSeen) {
      const onSeen = o.onSeen;
      this.seenIo = new IntersectionObserver(
        (es) => {
          for (const e of es)
            if (e.isIntersecting) {
              this.seenIo!.unobserve(e.target);
              onSeen((e.target as HTMLElement).dataset.tid!);
            }
        },
        { threshold: 0.5 },
      );
    }
    this.foot.addEventListener('click', (e) => {
      if ((e.target as Element).closest('[data-retry]')) this.more();
    });
  }

  start() {
    this.renderFoot();
    this.footIo.observe(this.foot);
    return this.more();
  }

  get empty() {
    return this.count === 0;
  }

  async more() {
    if (this.loading || this.done || !this.active) return;
    this.loading = true;
    this.error = '';
    this.renderFoot();
    const first = this.count === 0;
    try {
      const page = intern(await this.o.load(this.cursor));
      const items = this.filter(page.items);
      if (first) this.top = page.top;
      // Stop when the cursor doesn't advance or several pages bring nothing new (X pads the end with empty pages).
      this.dry = items.length ? 0 : this.dry + 1;
      if (!page.bottom || page.bottom === this.cursor || this.dry >= 3) this.done = true;
      this.cursor = page.bottom;
      this.append(items);
      this.o.onPage?.(page, first);
    } catch (e) {
      this.error = e instanceof ApiError ? e.message : 'Something went wrong.';
    } finally {
      this.loading = false;
      this.renderFoot();
      // If the page didn't fill the viewport, keep going.
      if (!this.error && !this.done && this.active) requestAnimationFrame(() => this.checkFoot());
    }
  }

  private checkFoot() {
    const r = this.foot.getBoundingClientRect();
    if (r.top < innerHeight * 2.5) this.more();
  }

  private filter(items: Item[]) {
    if (!this.o.dedupe) return items;
    return items.filter((it) => {
      const id = it.type === 'tweet' ? 't' + it.tweet.id : it.k;
      if (this.seen.has(id)) return false;
      this.seen.add(id);
      return true;
    });
  }

  private lastItem(): (Item & { lt?: boolean }) | undefined {
    for (let i = this.chunks.length - 1; i >= 0; i--) {
      const it = this.chunks[i].items;
      if (it?.length) return it[it.length - 1];
    }
  }

  /** Rough height for a never-rendered chunk, so only chunks near the viewport intersect. */
  private estimate(items: Item[]) {
    if (this.o.cls === 'grid') return Math.ceil(items.length / 3) * 130;
    let px = 0;
    for (const it of items) {
      if (it.type === 'tweet') px += 130 + (it.tweet.media ? 300 : 0) + (it.tweet.quote ? 110 : 0) + (it.tweet.card ? 120 : 0);
      else px += it.type === 'notif' ? 110 : 76;
    }
    return px;
  }

  private makeChunk(items: Item[], before?: Element, eager = false) {
    const el = h('div', 'chunk' + (this.o.cls ? ' ' + this.o.cls : ''));
    const ch: Chunk = { el, items, live: false };
    this.byEl.set(el, ch);
    if (eager) this.hydrate(ch);
    else el.style.height = this.estimate(items) + 'px';
    this.list.insertBefore(el, before || null);
    if (this.active) this.io.observe(el);
    return ch;
  }

  append(items: Item[]) {
    if (!items.length) return;
    let prev = this.lastItem();
    for (const it of items as (Item & { lt?: boolean })[]) {
      if (prev && 'line' in prev && prev.line) it.lt = true;
      prev = it;
    }
    const first = this.count === 0;
    for (let i = 0; i < items.length; i += CHUNK) this.chunks.push(this.makeChunk(items.slice(i, i + CHUNK), undefined, first && (i === 0 || !!this.o.eagerFirst)));
    this.count += items.length;
    this.trim();
  }

  /** Insert newer items at the top (pull-to-refresh / new posts). */
  prepend(items: Item[]) {
    const fresh = this.filter(items);
    if (!fresh.length) return 0;
    const ch = this.makeChunk(fresh, this.list.firstChild as Element, true);
    this.chunks.unshift(ch);
    this.count += fresh.length;
    return fresh.length;
  }

  private trim() {
    let n = this.count;
    for (const ch of this.chunks) {
      if (n <= MAX_ITEMS) break;
      if (ch.items && !ch.live) {
        n -= ch.items.length;
        ch.items = null;
      }
    }
    this.count = n;
  }

  private hydrate(ch: Chunk) {
    if (ch.live || !ch.items) return;
    this.unwatch(ch.el);
    ch.el.innerHTML = ch.items.map((it) => this.o.render(it)).join('');
    ch.el.style.height = '';
    ch.live = true;
    mountMedia(ch.el);
    this.watch(ch.el);
    this.o.onMount?.(ch.el);
  }

  private posts(el: Element) {
    // Threaded feeds wrap each top-level post in `.th`.
    return el.querySelectorAll(':scope > article[data-tid], :scope > .th > article[data-tid]');
  }

  private watch(el: Element) {
    if (this.seenIo && this.active) for (const a of this.posts(el)) this.seenIo.observe(a);
  }

  private unwatch(el: Element) {
    if (this.seenIo) for (const a of this.posts(el)) this.seenIo.unobserve(a);
  }

  private onChunks(entries: IntersectionObserverEntry[]) {
    // Use entry rects (already computed) instead of reading layout ourselves.
    for (const e of entries) {
      const ch = this.byEl.get(e.target);
      if (!ch) continue;
      if (e.isIntersecting) {
        if (!ch.live) this.queue.add(ch);
      } else {
        this.queue.delete(ch);
        if (ch.live && e.boundingClientRect.height > 0) {
          unmountMedia(ch.el);
          this.unwatch(ch.el);
          this.o.onUnmount?.(ch.el);
          ch.el.style.height = e.boundingClientRect.height + 'px';
          ch.el.textContent = '';
          ch.live = false;
        }
      }
    }
    this.pump();
  }

  /** Render queued chunks one per frame so no single task renders a whole page. */
  private pump() {
    if (this.raf || !this.queue.size) return;
    const next = this.queue.values().next().value!;
    this.queue.delete(next);
    this.hydrate(next);
    if (this.queue.size)
      this.raf = requestAnimationFrame(() => {
        this.raf = 0;
        this.pump();
      });
  }

  private renderFoot() {
    if (this.error) this.foot.innerHTML = `<div class="err">${esc(this.error)}<button data-retry>Retry</button></div>`;
    else if (this.loading) this.foot.innerHTML = `<div class="spin"></div>`;
    else if (this.done && this.count === 0) this.foot.innerHTML = `<div class="emp">${esc(this.o.empty || 'Nothing to see here yet.')}</div>`;
    else if (this.done) this.foot.innerHTML = '';
    else this.foot.innerHTML = `<div class="pad"></div>`;
  }

  /** Stop observing while the view is hidden (hidden elements report zero size). */
  pause() {
    this.active = false;
    this.queue.clear();
    cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.io.disconnect();
    this.footIo.disconnect();
    this.seenIo?.disconnect();
  }

  resume() {
    if (this.active) return;
    this.active = true;
    for (const ch of this.chunks) {
      this.io.observe(ch.el);
      if (ch.live) this.watch(ch.el);
    }
    this.footIo.observe(this.foot);
  }

  reset() {
    for (const ch of this.chunks) this.unmount(ch);
    this.io.disconnect();
    this.seenIo?.disconnect();
    this.queue.clear();
    this.chunks = [];
    this.list.textContent = '';
    this.seen.clear();
    this.cursor = undefined;
    this.done = false;
    this.error = '';
    this.count = 0;
    this.dry = 0;
    return this.more();
  }

  destroy() {
    this.pause();
    for (const ch of this.chunks) this.unmount(ch);
    this.el.remove();
  }

  /** Re-render live chunks (e.g. after a pref change). */
  rerender() {
    for (const ch of this.chunks)
      if (ch.live && ch.items) {
        this.unmount(ch);
        ch.live = false;
        this.hydrate(ch);
      }
  }

  /** Remove an item (e.g. un-bookmarked) wherever it is. */
  removeWhere(fn: (it: Item) => boolean) {
    for (const ch of this.chunks) {
      if (!ch.items) continue;
      const before = ch.items.length;
      ch.items = ch.items.filter((it) => !fn(it));
      if (ch.items.length !== before && ch.live) {
        this.unmount(ch);
        ch.live = false;
        this.hydrate(ch);
      }
    }
  }

  private unmount(ch: Chunk) {
    unmountMedia(ch.el);
    if (ch.live) this.o.onUnmount?.(ch.el);
  }

  domNodes() {
    return this.list.getElementsByTagName('*').length;
  }
}
