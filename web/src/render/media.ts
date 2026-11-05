import type { Card, Media, Tweet } from '../../../shared/types';
import { mi } from '../icons';
import { prefs } from '../store';
import { dur, esc, num, safeUrl } from '../util';

export function img(url: string, size: 'small' | 'medium' | 'large' | 'thumb' | '360x360' = 'small') {
  if (!/pbs\.twimg\.com/.test(url)) return url;
  const u = url.replace(/\?.*$/, '');
  const m = u.match(/\.(jpe?g|png|webp)$/);
  return m ? `${u.slice(0, -m[0].length)}?format=${m[1] === 'png' ? 'png' : 'jpg'}&name=${size}` : `${u}?name=${size}`;
}

const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));

function cell(t: Tweet, m: Media, i: number, size: 'small' | 'medium') {
  const alt = m.alt ? esc(m.alt) : '';
  let extra = '';
  if (m.type === 'video') extra = `<span class="mp">${mi('play')}</span>${m.dur ? `<span class="mb">${dur(m.dur)}</span>` : ''}`;
  else if (m.type === 'gif') extra = `<span class="mb">GIF</span>`;
  const act = m.type === 'photo' ? 'media' : 'play';
  const gif = m.type === 'gif' && prefs.gifs ? ' data-gif' : '';
  return `<button class="mc" data-act="${act}" data-tid="${t.id}" data-i="${i}"${gif} aria-label="${m.type}"><img src="${esc(img(m.url, size))}" alt="${alt}" loading="lazy" decoding="async">${extra}</button>`;
}

export function mediaHtml(t: Tweet, small = false): string {
  const list = t.media;
  if (!list?.length) return '';
  const size = prefs.hq && !small ? 'medium' : 'small';
  if (list.length === 1) {
    const m = list[0];
    const r = clamp(m.w / m.h, 0.75, 2);
    return `<div class="md md1" style="aspect-ratio:${r.toFixed(3)}">${cell(t, m, 0, size)}</div>`;
  }
  return `<div class="md md${Math.min(list.length, 4)}">${list
    .slice(0, 4)
    .map((m, i) => cell(t, m, i, size))
    .join('')}</div>`;
}

export function cardHtml(c: Card | undefined): string {
  if (!c) return '';
  if (c.kind === 'poll') {
    const total = (c.choices || []).reduce((n, x) => n + x.count, 0) || 1;
    const max = Math.max(...(c.choices || []).map((x) => x.count));
    const rows = (c.choices || [])
      .map((x) => {
        const p = Math.round((x.count / total) * 100);
        return `<div class="pr${x.count === max ? ' win' : ''}"><span class="pb" style="transform:scaleX(${p / 100})"></span><span class="pl">${esc(x.label)}</span><span class="pp">${p}%</span></div>`;
      })
      .join('');
    const ended = c.closed || (c.ends && new Date(c.ends) < new Date());
    return `<div class="poll">${rows}<div class="pm">${num(total)} votes · ${ended ? 'Final results' : 'Open'}</div></div>`;
  }
  if (!c.url) return '';
  const image = c.image ? `<img src="${esc(c.image)}" alt="" loading="lazy" decoding="async">` : '';
  return `<a class="card${c.large && c.image ? ' lg' : ''}" href="${esc(safeUrl(c.url))}" target="_blank" rel="noopener noreferrer nofollow">${
    image ? `<div class="ci">${image}</div>` : ''
  }<div class="cb">${c.domain ? `<div class="cdm">${esc(c.domain)}</div>` : ''}${c.title ? `<div class="ct">${esc(c.title)}</div>` : ''}${
    c.desc && !c.large ? `<div class="cdd">${esc(c.desc)}</div>` : ''
  }</div></a>`;
}
