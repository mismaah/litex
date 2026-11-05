import type { Seg } from '../../../shared/types';
import { esc, safeUrl } from '../util';

/** Map x.com/twitter.com links to in-app paths. */
export function internal(href: string): string | null {
  try {
    const u = new URL(href);
    if (!/^(www\.|mobile\.)?(x|twitter)\.com$/.test(u.hostname)) return null;
    if (/^\/(i\/(lists\/\d+)|\w{1,15}(\/status\/\d+)?|hashtag\/\w+|search)\/?$/.test(u.pathname)) return u.pathname + u.search;
  } catch {
    /* not a url */
  }
  return null;
}

export function segsHtml(segs: Seg[] | undefined): string {
  if (!segs) return '';
  let out = '';
  for (const s of segs) {
    switch (s.t) {
      case 'text':
        out += esc(s.v);
        break;
      case 'mention':
        out += `<a href="/${esc(s.u)}">${esc(s.v)}</a>`;
        break;
      case 'hash':
        out += `<a href="/search?q=${encodeURIComponent(s.v)}">${esc(s.v)}</a>`;
        break;
      case 'cash':
        out += `<a href="/search?q=${encodeURIComponent(s.v)}">${esc(s.v)}</a>`;
        break;
      case 'url': {
        const inn = internal(s.href);
        out += inn
          ? `<a href="${esc(inn)}">${esc(s.v)}</a>`
          : `<a href="${esc(safeUrl(s.href))}" target="_blank" rel="noopener noreferrer nofollow">${esc(s.v)}</a>`;
        break;
      }
    }
  }
  return out;
}

export const segsLen = (segs: Seg[] | undefined) => (segs || []).reduce((n, s) => n + s.v.length, 0);
export const plain = (segs: Seg[] | undefined) => (segs || []).map((s) => s.v).join('');
