// Programmatic scrolls shouldn't trigger hide-on-scroll for the header.
export let quietUntil = 0;
export function quietScroll(y: number) {
  quietUntil = performance.now() + 250;
  scrollTo(0, y);
}

/** Only http(s) links from X data make it into hrefs. */
export const safeUrl = (u?: string) => (u && /^https?:\/\//i.test(u) ? u : '#');

const ESC: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => ESC[c]);

export function num(n?: number) {
  if (!n) return '';
  if (n < 1000) return String(n);
  if (n < 1e6) return (n / 1e3).toFixed(n < 1e4 ? 1 : 0).replace(/\.0$/, '') + 'K';
  if (n < 1e9) return (n / 1e6).toFixed(n < 1e7 ? 1 : 0).replace(/\.0$/, '') + 'M';
  return (n / 1e9).toFixed(1).replace(/\.0$/, '') + 'B';
}

export const fullNum = (n?: number) => (n || 0).toLocaleString();

const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export function ago(iso?: string) {
  if (!iso) return '';
  const d = new Date(iso);
  const s = (Date.now() - d.getTime()) / 1000;
  if (s < 60) return Math.max(1, Math.floor(s)) + 's';
  if (s < 3600) return Math.floor(s / 60) + 'm';
  if (s < 86400) return Math.floor(s / 3600) + 'h';
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return `${MON[d.getMonth()]} ${d.getDate()}${sameYear ? '' : ', ' + d.getFullYear()}`;
}

export function fullDate(iso: string) {
  const d = new Date(iso);
  const t = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  return `${t} · ${MON[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`;
}

export function joined(iso?: string) {
  if (!iso) return '';
  const d = new Date(iso);
  return `Joined ${d.toLocaleString('en', { month: 'long' })} ${d.getFullYear()}`;
}

export function dur(ms?: number) {
  if (!ms) return '';
  const s = Math.round(ms / 1000);
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, '0')}`;
}

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', html = ''): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  if (html) el.innerHTML = html;
  return el;
}

let toastTimer = 0;
export function toast(msg: string) {
  let el = document.getElementById('toast');
  if (!el) {
    el = h('div');
    el.id = 'toast';
    document.body.append(el);
  }
  el.textContent = msg;
  el.classList.add('on');
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => el!.classList.remove('on'), 2600);
}

const LS = (() => {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
})();
export function getPref<T>(k: string, d: T): T {
  try {
    const v = LS?.getItem('litex:' + k);
    return v == null ? d : JSON.parse(v);
  } catch {
    return d;
  }
}
export function setPref(k: string, v: unknown) {
  try {
    LS?.setItem('litex:' + k, JSON.stringify(v));
  } catch {
    /* storage unavailable */
  }
}
