// Media viewer and bottom sheets. Both close with Back.
import type { Tweet } from '../../shared/types';
import { icon } from './icons';
import { img } from './render/media';
import { closeOverlay, pushOverlay } from './router';
import { esc, h } from './util';

function lockScroll(on: boolean) {
  document.documentElement.classList.toggle('locked', on);
}

/** Full-screen gallery: swipe, arrows, or ←/→ keys to move; swipe down, ✕, Esc or Back to close. */
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
  document.body.append(el);
  lockScroll(true);
  const track = el.querySelector<HTMLElement>('.vtrack')!;
  const count = el.querySelector<HTMLElement>('.vcount');
  const prev = el.querySelector<HTMLElement>('.vprev');
  const next = el.querySelector<HTMLElement>('.vnext');
  let cur = -1;

  const sync = () => {
    const i = Math.round(track.scrollLeft / track.clientWidth);
    if (i === cur) return;
    cur = i;
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
  const onResize = () => (track.scrollLeft = cur * track.clientWidth);
  addEventListener('keydown', onKey);
  addEventListener('resize', onResize);

  // Swipe down to close. The axis locks on the first real move so sideways swipes stay sideways.
  let x0 = 0;
  let y0 = 0;
  let dy = 0;
  let axis: '' | 'x' | 'y' = '';
  el.addEventListener('touchstart', (e) => ((x0 = e.touches[0].clientX), (y0 = e.touches[0].clientY), (dy = 0), (axis = '')), { passive: true });
  el.addEventListener(
    'touchmove',
    (e) => {
      const dx = e.touches[0].clientX - x0;
      const d = e.touches[0].clientY - y0;
      if (!axis && Math.max(Math.abs(dx), Math.abs(d)) > 10) axis = Math.abs(d) > Math.abs(dx) ? 'y' : 'x';
      if (axis === 'y') {
        dy = d;
        track.style.transform = `translateY(${dy}px)`;
      }
    },
    { passive: true },
  );
  el.addEventListener('touchend', () => {
    if (axis === 'y' && Math.abs(dy) > 120) closeOverlay();
    else track.style.transform = '';
  });
  el.addEventListener('click', (e) => {
    const target = e.target as Element;
    if (target.closest('.vclose') || (target.classList.contains('vslide') && !axis)) closeOverlay();
  });
  pushOverlay(() => {
    removeEventListener('keydown', onKey);
    removeEventListener('resize', onResize);
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
