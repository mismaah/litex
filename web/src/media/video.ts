// Video & GIF handling: posters by default, one playing video at a time,
// GIFs only play while on screen, and every <video> is unloaded when it leaves the DOM.
import type { Media } from '../../../shared/types';
import { get } from '../api';
import { intern, tweets } from '../store';
import { toast } from '../util';

let active: HTMLVideoElement | null = null;

function stop(v: HTMLVideoElement) {
  v.pause();
  v.removeAttribute('src');
  v.load(); // releases the decoder + network buffer
  v.remove();
}

const gifIo = new IntersectionObserver(
  (entries) => {
    for (const e of entries) {
      const cell = e.target as HTMLElement;
      const v = cell.querySelector('video');
      if (e.isIntersecting && !v) {
        const m = tweets.get(cell.dataset.tid!)?.media?.[Number(cell.dataset.i)];
        if (!m?.src) continue;
        const vid = document.createElement('video');
        Object.assign(vid, { muted: true, loop: true, playsInline: true, autoplay: true, src: m.src });
        vid.setAttribute('muted', '');
        vid.setAttribute('playsinline', '');
        cell.append(vid);
      } else if (!e.isIntersecting && v) stop(v);
    }
  },
  { threshold: 0.5 },
);

const playIo = new IntersectionObserver(
  (entries) => {
    for (const e of entries) if (!e.isIntersecting) (e.target as HTMLVideoElement).pause();
  },
  { threshold: 0.25 },
);

export function mountMedia(root: HTMLElement) {
  for (const c of root.querySelectorAll('[data-gif]')) gifIo.observe(c);
}

export function unmountMedia(root: HTMLElement) {
  for (const c of root.querySelectorAll('[data-gif]')) gifIo.unobserve(c);
  for (const v of root.querySelectorAll('video')) {
    playIo.unobserve(v);
    if (v === active) active = null;
    stop(v);
  }
}

/** The media behind a poster cell, also when the cell belongs to a quote no longer in the store. */
function mediaOf(cell: HTMLElement): Media | undefined {
  const tid = cell.dataset.tid!;
  let t = tweets.get(tid);
  if (!t) {
    const outer = cell.closest<HTMLElement>('article[data-tid]')?.dataset.tid;
    const q = outer ? tweets.get(outer)?.quote : undefined;
    if (q?.id === tid) t = q;
  }
  return t?.media?.[Number(cell.dataset.i)];
}

export function playVideo(cell: HTMLElement) {
  const m = mediaOf(cell);
  if (m?.src) return start(cell, m);
  // Missing locally (e.g. a quoted post that came without its video): load the post, then play.
  if (cell.classList.contains('loading')) return;
  cell.classList.add('loading');
  get(`/tweet/${cell.dataset.tid}`)
    .then((page) => intern(page))
    .catch(() => {})
    .finally(() => {
      cell.classList.remove('loading');
      if (!cell.isConnected) return;
      const m = mediaOf(cell);
      // Autoplay may be refused now the tap is in the past; the controls are there to start it.
      if (m?.src) start(cell, m);
      else toast("Couldn't load this video.");
    });
}

function start(cell: HTMLElement, m: Media) {
  if (!m.src) return;
  if (active) {
    playIo.unobserve(active);
    const old = active;
    active = null;
    restore(old);
  }
  if (m.type === 'gif') {
    gifIo.unobserve(cell);
    cell.querySelector('video')?.remove();
  }
  // A <video> with controls can't live inside the poster <button>; swap in a wrapper.
  const wrap = document.createElement('div');
  wrap.className = 'mc playing';
  const v = document.createElement('video');
  v.className = 'pv';
  Object.assign(v, { controls: true, playsInline: true, autoplay: true, src: m.src, loop: m.type === 'gif' });
  v.setAttribute('playsinline', '');
  v.poster = (cell.querySelector('img') as HTMLImageElement | null)?.src || '';
  wrap.append(v);
  posters.set(v, cell);
  cell.replaceWith(wrap);
  active = v;
  playIo.observe(v);
  v.play().catch(() => {});
}

const posters = new WeakMap<HTMLVideoElement, HTMLElement>();
function restore(v: HTMLVideoElement) {
  const cell = posters.get(v);
  const wrap = v.parentElement;
  stop(v);
  if (cell && wrap?.isConnected) {
    wrap.replaceWith(cell);
    if (cell.hasAttribute('data-gif')) gifIo.observe(cell);
  }
}

/**
 * Move the active video into the same post's media cell inside `root` (e.g. opening the
 * post it's playing in), so playback carries on. The old spot gets its poster back.
 * Moving a media element within one task doesn't pause it.
 */
export function handoff(root: HTMLElement): boolean {
  const v = active;
  const old = v && posters.get(v);
  const wrap = v?.parentElement;
  if (!v || !old || !wrap?.isConnected) return false;
  const target = root.querySelector<HTMLElement>(`.mc[data-act="play"][data-tid="${old.dataset.tid}"][data-i="${old.dataset.i}"]`);
  if (!target?.isConnected) return false;
  wrap.replaceWith(old);
  if (old.hasAttribute('data-gif')) gifIo.observe(old);
  if (target.hasAttribute('data-gif')) {
    gifIo.unobserve(target);
    target.querySelector('video')?.remove();
  }
  target.replaceWith(wrap);
  posters.set(v, target);
  return true;
}

/** Stop everything (e.g. when navigating away). */
export function pauseAll() {
  if (active) active.pause();
}
