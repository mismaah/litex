// Media viewer and bottom sheets. Both close with Back.
import type { Tweet } from '../../shared/types';
import { icon } from './icons';
import { useSavedVolume } from './media/video';
import { img } from './render/media';
import { closeOverlay, pushOverlay } from './router';
import { esc, h } from './util';

const MAX_ZOOM = 5;
const TAP_ZOOM = 2.5;
type Pt = { x: number; y: number };

function lockScroll(on: boolean) {
  document.documentElement.classList.toggle('locked', on);
}

/** Full-screen gallery: swipe, arrows, or ←/→ keys to move; swipe down, ✕, Esc or Back to close; pinch or double-tap a photo to zoom. */
export function openViewer(t: Tweet, index: number) {
  const media = t.media || [];
  const many = media.length > 1;
  const el = h('div', 'viewer');
  el.innerHTML = `<button class="ib vclose" aria-label="Close">${icon('x')}</button>${many ? '<div class="vcount"></div>' : ''}<div class="vtrack">${media
    .map((m, i) =>
      m.type === 'photo'
        ? `<div class="vslide"><img src="${esc(img(m.url, 'large'))}" alt="${esc(m.alt || '')}" decoding="async"${i === index ? '' : ' loading="lazy"'}></div>`
        : `<div class="vslide"><video src="${esc(m.src || '')}" poster="${esc(img(m.url, 'small'))}" controls playsinline preload="none"${m.type === 'gif' ? ' loop muted autoplay' : ''}></video></div>`,
    )
    .join('')}</div>${
    many ? `<button class="ib vnav vprev" aria-label="Previous">${icon('back')}</button><button class="ib vnav vnext" aria-label="Next">${icon('back')}</button>` : ''
  }`;
  for (const v of el.querySelectorAll('video')) if (!v.loop) useSavedVolume(v);
  document.body.append(el);
  lockScroll(true);
  const track = el.querySelector<HTMLElement>('.vtrack')!;
  const count = el.querySelector<HTMLElement>('.vcount');
  const prev = el.querySelector<HTMLElement>('.vprev');
  const next = el.querySelector<HTMLElement>('.vnext');
  let cur = -1;

  // Zoom on photos: pinch, double-tap / double-click, or ctrl+wheel (trackpad pinch); drag pans while zoomed.
  // The image is scaled with a transform from its top-left corner, kept inside the slide by clamp().
  let zImg: HTMLImageElement | null = null;
  let zs = 1;
  let zx = 0;
  let zy = 0;
  const photo = (i = cur) => track.children[i]?.querySelector('img') || null;
  const box = (img: HTMLImageElement) => {
    const slide = img.parentElement!;
    const r = slide.getBoundingClientRect();
    const w = img.offsetWidth;
    const hh = img.offsetHeight;
    return { r, w, h: hh, ox: (slide.clientWidth - w) / 2, oy: (slide.clientHeight - hh) / 2 };
  };
  // Centre the image on an axis while it fits, otherwise keep its edges outside the slide.
  const clamp = (t: number, size: number, o: number, view: number) => (size <= view ? view / 2 - o - size / 2 : Math.min(-o, Math.max(view - o - size, t)));
  const setZoom = (img: HTMLImageElement, s: number, x: number, y: number, animate = false) => {
    s = Math.max(1, Math.min(MAX_ZOOM, s));
    const b = box(img);
    zImg = img;
    zs = s;
    zx = s === 1 ? 0 : clamp(x, b.w * s, b.ox, b.r.width);
    zy = s === 1 ? 0 : clamp(y, b.h * s, b.oy, b.r.height);
    img.style.transition = animate ? 'transform 0.2s' : '';
    img.style.transform = s === 1 ? '' : `translate(${zx}px, ${zy}px) scale(${s})`;
    el.classList.toggle('zoomed', s > 1);
  };
  const resetZoom = (animate = false) => zImg && setZoom(zImg, 1, 0, 0, animate);
  /** Scale to `s` so the image point that was under client point `from` (at scale s0, offset x0/y0) lands under `to`. */
  const zoomTo = (img: HTMLImageElement, s0: number, x0: number, y0: number, from: Pt, s: number, to: Pt = from, animate = false) => {
    const b = box(img);
    s = Math.max(1, Math.min(MAX_ZOOM, s));
    const px = (from.x - b.r.left - b.ox - x0) / s0;
    const py = (from.y - b.r.top - b.oy - y0) / s0;
    setZoom(img, s, to.x - b.r.left - b.ox - px * s, to.y - b.r.top - b.oy - py * s, animate);
  };
  const toggleZoom = (img: HTMLImageElement, at: Pt) => {
    if (zs > 1) setZoom(img, 1, 0, 0, true);
    else zoomTo(img, 1, 0, 0, at, TAP_ZOOM, at, true);
  };

  const sync = () => {
    const i = Math.round(track.scrollLeft / track.clientWidth);
    if (i === cur) return;
    cur = i;
    resetZoom();
    if (count) count.textContent = `${i + 1} / ${media.length}`;
    if (prev) prev.hidden = i === 0;
    if (next) next.hidden = i === media.length - 1;
    // Only the visible slide's video keeps playing.
    track.querySelectorAll('video').forEach((v, j) => j !== i && v.pause());
  };
  const go = (i: number) => {
    const to = Math.max(0, Math.min(media.length - 1, i));
    track.scrollTo({ left: to * track.clientWidth, behavior: 'smooth' });
  };
  track.scrollLeft = index * track.clientWidth;
  sync();
  track.addEventListener('scroll', sync, { passive: true });
  prev?.addEventListener('click', () => go(cur - 1));
  next?.addEventListener('click', () => go(cur + 1));

  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'ArrowLeft') go(cur - 1);
    else if (e.key === 'ArrowRight') go(cur + 1);
    else if (e.key === 'Escape') closeOverlay();
    else return;
    e.preventDefault();
  };
  const onResize = () => {
    resetZoom();
    track.scrollLeft = cur * track.clientWidth;
  };
  addEventListener('keydown', onKey);
  addEventListener('resize', onResize);

  // Touch: pinch to zoom, one finger pans while zoomed, double-tap toggles. Otherwise swipe down to close;
  // the axis locks on the first real move so sideways swipes stay sideways.
  type Gesture = { mode: 'pinch'; s0: number; x0: number; y0: number; p0: Pt; d0: number } | { mode: 'pan'; x0: number; y0: number; p0: Pt };
  let g: Gesture | null = null;
  let x0 = 0;
  let y0 = 0;
  let dy = 0;
  let axis: '' | 'x' | 'y' | 'z' = '';
  let lastTap: { t: number; p: Pt } | null = null;
  let lastTouch = 0;
  let moved = false;
  const pt = (t: Touch): Pt => ({ x: t.clientX, y: t.clientY });
  const mid = (a: Touch, b: Touch): Pt => ({ x: (a.clientX + b.clientX) / 2, y: (a.clientY + b.clientY) / 2 });
  const dist = (a: Touch, b: Touch) => Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
  const startGesture = (e: TouchEvent) => {
    const img = photo();
    g = null;
    if (!img) return;
    if (e.touches.length >= 2) {
      const [a, b] = [e.touches[0], e.touches[1]];
      if (zImg !== img) {
        resetZoom();
        zImg = img;
        zs = 1;
        zx = zy = 0;
      }
      g = { mode: 'pinch', s0: zs, x0: zx, y0: zy, p0: mid(a, b), d0: dist(a, b) || 1 };
      // Stop the track from scrolling to a neighbour mid-pinch.
      el.classList.add('zoomed');
    } else if (zs > 1 && zImg === img) g = { mode: 'pan', x0: zx, y0: zy, p0: pt(e.touches[0]) };
    if (g) {
      axis = 'z';
      track.style.transform = '';
    }
  };
  el.addEventListener(
    'touchstart',
    (e) => {
      lastTouch = Date.now();
      if (e.touches.length === 1) {
        moved = false;
        x0 = e.touches[0].clientX;
        y0 = e.touches[0].clientY;
        dy = 0;
        axis = '';
      } else moved = true;
      startGesture(e);
    },
    { passive: true },
  );
  el.addEventListener(
    'touchmove',
    (e) => {
      const t = e.touches[0];
      if (Math.hypot(t.clientX - x0, t.clientY - y0) > 10) moved = true;
      if (g) {
        // Keep the browser from zooming or scrolling the page underneath.
        if (e.cancelable) e.preventDefault();
        if (!zImg) return;
        if (g.mode === 'pinch' && e.touches.length >= 2) {
          const [a, b] = [e.touches[0], e.touches[1]];
          zoomTo(zImg, g.s0, g.x0, g.y0, g.p0, (g.s0 * dist(a, b)) / g.d0, mid(a, b));
        } else if (g.mode === 'pan') setZoom(zImg, zs, g.x0 + t.clientX - g.p0.x, g.y0 + t.clientY - g.p0.y);
        return;
      }
      const dx = t.clientX - x0;
      const d = t.clientY - y0;
      if (!axis && Math.max(Math.abs(dx), Math.abs(d)) > 10) axis = Math.abs(d) > Math.abs(dx) ? 'y' : 'x';
      if (axis === 'y') {
        dy = d;
        track.style.transform = `translateY(${dy}px)`;
      }
    },
    { passive: false },
  );
  const endTouch = (e: TouchEvent) => {
    lastTouch = Date.now();
    if (g) {
      // Lifting one finger of a pinch carries on as a pan (or nothing, at 1x).
      if (e.touches.length) return startGesture(e);
      g = null;
      if (zs <= 1.01) resetZoom(true);
    } else if (axis === 'y' && Math.abs(dy) > 120) return closeOverlay();
    else track.style.transform = '';
    if (e.type !== 'touchend' || moved || e.touches.length) return;
    const p = pt(e.changedTouches[0]);
    const img = photo();
    const now = Date.now();
    if (img && lastTap && now - lastTap.t < 300 && Math.hypot(p.x - lastTap.p.x, p.y - lastTap.p.y) < 40) {
      lastTap = null;
      toggleZoom(img, p);
      // Don't let the second tap's click close the viewer.
      axis = 'z';
    } else lastTap = { t: now, p };
  };
  el.addEventListener('touchend', endTouch);
  el.addEventListener('touchcancel', endTouch);
  // iOS Safari's own pinch, which ignores touch-action on some versions.
  el.addEventListener('gesturestart', (e) => e.preventDefault());

  // Mouse: double-click toggles, ctrl+wheel zooms, drag pans while zoomed.
  el.addEventListener('dblclick', (e) => {
    const img = photo();
    if (!img || Date.now() - lastTouch < 800 || !(e.target as Element).closest('.vslide')) return;
    toggleZoom(img, { x: e.clientX, y: e.clientY });
  });
  el.addEventListener(
    'wheel',
    (e) => {
      const img = photo();
      if (!img || !e.ctrlKey) return;
      e.preventDefault();
      const p = { x: e.clientX, y: e.clientY };
      const [s0, sx, sy] = zImg === img ? [zs, zx, zy] : [1, 0, 0];
      zoomTo(img, s0, sx, sy, p, s0 * Math.exp(-e.deltaY / 100), p);
    },
    { passive: false },
  );
  let drag: { x0: number; y0: number; p0: Pt; moved: boolean } | null = null;
  el.addEventListener('mousedown', (e) => {
    if (e.button || zs <= 1 || !zImg || !(e.target as Element).closest('.vslide')) return;
    e.preventDefault();
    drag = { x0: zx, y0: zy, p0: { x: e.clientX, y: e.clientY }, moved: false };
  });
  const onMouseMove = (e: MouseEvent) => {
    if (!drag || !zImg) return;
    if (Math.hypot(e.clientX - drag.p0.x, e.clientY - drag.p0.y) > 4) drag.moved = true;
    setZoom(zImg, zs, drag.x0 + e.clientX - drag.p0.x, drag.y0 + e.clientY - drag.p0.y);
  };
  const onMouseUp = () => setTimeout(() => (drag = null));
  addEventListener('mousemove', onMouseMove);
  addEventListener('mouseup', onMouseUp);

  el.addEventListener('click', (e) => {
    const target = e.target as Element;
    if (target.closest('.vclose')) return closeOverlay();
    // A tap on the backdrop closes, unless it ended a zoom gesture or the photo is zoomed.
    if (target.classList.contains('vslide') && !axis && zs <= 1 && !drag?.moved) closeOverlay();
  });
  pushOverlay(() => {
    removeEventListener('keydown', onKey);
    removeEventListener('resize', onResize);
    removeEventListener('mousemove', onMouseMove);
    removeEventListener('mouseup', onMouseUp);
    for (const v of el.querySelectorAll('video')) {
      v.pause();
      v.removeAttribute('src');
      v.load();
    }
    el.remove();
    lockScroll(false);
  });
}

export interface SheetItem {
  label: string;
  icon?: string;
  danger?: boolean;
  run: () => void;
}

export function openSheet(items: SheetItem[], title?: string) {
  const el = h('div', 'sheet-bg');
  el.innerHTML = `<div class="sheet">${title ? `<div class="sh-t">${esc(title)}</div>` : ''}${items
    .map((it, i) => `<button data-i="${i}" class="${it.danger ? 'danger' : ''}">${it.icon ? icon(it.icon) : ''}<span>${esc(it.label)}</span></button>`)
    .join('')}<button class="cancel" data-cancel>Cancel</button></div>`;
  document.body.append(el);
  requestAnimationFrame(() => el.classList.add('on'));
  el.addEventListener('click', (e) => {
    const b = (e.target as Element).closest<HTMLElement>('button');
    if (b?.dataset.i) {
      closeOverlay(items[Number(b.dataset.i)].run);
      return;
    }
    if (b || e.target === el) closeOverlay();
  });
  pushOverlay(() => el.remove());
}
