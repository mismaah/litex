// Threaded (Reddit-style) rendering for the Home "Threads" tab. Replies and quotes are
// children of a post, loaded only when the user expands it.
// Expansion state lives here, keyed by post id, so a virtual-feed chunk that is emptied
// and re-rendered (see feed.ts) comes back with the same threads open.
import type { Item, Page, Tweet } from '../../../shared/types';
import { ApiError, get } from '../api';
import { mi } from '../icons';
import { mountMedia, unmountMedia } from '../media/video';
import { segsHtml } from '../render/text';
import { intern, showOriginal, tweets } from '../store';
import { tweetHtml, nameHtml, statusPath, type TweetItem } from '../render/tweet';
import { esc, num, quietScroll } from '../util';

type Kind = 'r' | 'q';

/** One source of children: the post's replies or its quotes, paged separately. */
interface Src {
  cursor?: string;
  done?: boolean;
  /** Last request failed; Retry asks this source again. */
  failed?: boolean;
}

/** A child post; `q` marks a quote (rendered without re-embedding the parent). */
type Kid = TweetItem & { q?: boolean };

interface State {
  open: boolean;
  /** Replies and quotes together, in display order (each loaded batch sorted by likes). */
  kids: Kid[];
  r: Src;
  q: Src;
  /** Replies so far came only from a parent's response (a chain), not this post's own request. */
  partial?: boolean;
  loading?: boolean;
  error?: string;
}

/** Deepest nesting level rendered inline; deeper posts link to their page. */
const MAX_DEPTH = 4;
/** Guard against rendering a post inside itself if X ever returns a cycle. */
const MAX_NEST = 12;

const expanded = new Map<string, State>();

const state = (id: string) => {
  let s = expanded.get(id);
  if (!s) expanded.set(id, (s = { open: false, kids: [], r: {}, q: {} }));
  return s;
};

/** Append children, skipping ones already shown. Returns how many were new. */
function addKids(s: State, kids: Tweet[], q = false) {
  const have = new Set(s.kids.map((i) => i.tweet.id));
  let n = 0;
  for (const t of kids)
    if (!have.has(t.id)) {
      have.add(t.id);
      s.kids.push({ k: 'c' + t.id, type: 'tweet', tweet: t, q: q || undefined });
      n++;
    }
  return n;
}

/** Pre-open a post's replies with posts that came from someone else's response. */
function preload(id: string, kids: Tweet[]) {
  const s = state(id);
  if (!s.kids.length && !s.loading) {
    s.open = true;
    s.partial = true;
  }
  if (s.partial) addKids(s, kids);
}

/**
 * Nest a reply chain under `rootId`: each post goes under the post it replies to when that
 * post is in the chain, otherwise under `prevParent(i)` (X sometimes skips a middle reply).
 * Grandchildren are stored as pre-opened partial branches of their parents.
 */
function nest(rootId: string, chain: Tweet[], prevParent: (i: number) => string) {
  const ids = new Set([rootId, ...chain.map((t) => t.id)]);
  const direct: Tweet[] = [];
  chain.forEach((t, i) => {
    const parent = t.replyToId && ids.has(t.replyToId) && t.replyToId !== t.id ? t.replyToId : prevParent(i);
    if (parent === rootId) direct.push(t);
    else preload(parent, [t]);
  });
  return direct;
}

/**
 * Collapse the conversation modules of a home page (runs of `line` posts) into their first
 * post, with the rest of the run pre-opened as its replies.
 */
export function groupThreads(page: Page): Page {
  intern(page); // the state map must hold the shared store objects
  const out: Item[] = [];
  let run: Item[] = [];
  const flush = () => {
    const tws = run.filter((i): i is TweetItem => i.type === 'tweet');
    run = [];
    if (!tws.length) return;
    const root = tws[0];
    out.push({ ...root, line: false });
    const chain = tws.slice(1).map((i) => i.tweet);
    if (chain.length) preload(root.tweet.id, nest(root.tweet.id, chain, (i) => (i === 0 ? root.tweet.id : chain[i - 1].id)));
  };
  for (const it of page.items) {
    if (run.length || ('line' in it && it.line)) {
      run.push(it);
      if (!('line' in it && it.line)) flush();
    } else out.push(it);
  }
  flush();
  return { ...page, items: out };
}

/** Replies to `id` from a TweetDetail page, as direct children (deeper ones are nested). */
function repliesOf(id: string, page: Page) {
  const items = page.items;
  const fi = items.findIndex((i) => i.type === 'tweet' && i.tweet.id === id);
  const chain: Tweet[] = [];
  const lineBefore: boolean[] = [];
  let prevLine = false;
  for (const it of items.slice(fi + 1)) {
    if (it.type === 'tweet' && it.tweet.id !== id) {
      chain.push(it.tweet);
      lineBefore.push(prevLine);
    }
    prevLine = 'line' in it && !!it.line;
  }
  // A post continuing a conversation group (previous item drew a line to it) defaults to
  // the previous post as parent; otherwise it is a direct reply.
  return nest(id, chain, (i) => (lineBefore[i] && i > 0 ? chain[i - 1].id : id));
}

const byLikes = (a: Tweet, b: Tweet) => b.likes - a.likes;

function count(t: Tweet, kind: Kind) {
  const have = expanded.get(t.id)?.kids.filter((k) => !!k.q === (kind === 'q')).length || 0;
  return Math.max(kind === 'r' ? t.replies : t.quotes, have);
}

/** Sources that can still bring children (kinds with a zero count never cost a request). */
function pending(t: Tweet, s: State): Kind[] {
  const out: Kind[] = [];
  if (t.replies && (s.partial ? count(t, 'r') > s.kids.filter((k) => !k.q).length || !s.r.done : !s.r.done)) out.push('r');
  if (t.quotes && !s.q.done) out.push('q');
  return out;
}

/**
 * Load the next page of replies and quotes together, then append the new posts sorted by
 * likes. Posts already on screen keep their place, so nothing jumps while reading.
 */
async function load(id: string) {
  const t = tweets.get(id);
  const s = state(id);
  if (!t || s.loading) return;
  const failed = (['r', 'q'] as const).filter((k) => s[k].failed);
  const kinds = failed.length ? failed : pending(t, s);
  if (!kinds.length) return;
  s.loading = true;
  s.error = undefined;
  refresh(id);
  const batch: { t: Tweet; q: boolean }[] = [];
  await Promise.all(
    kinds.map(async (kind) => {
      const src = s[kind];
      const cursor = kind === 'r' && s.partial ? undefined : src.cursor;
      try {
        const page = intern(await get(kind === 'r' ? `/tweet/${id}` : `/tweet/${id}/quotes`, { cursor }));
        const got = kind === 'r' ? repliesOf(id, page) : page.items.flatMap((i) => (i.type === 'tweet' && i.tweet.id !== id ? [i.tweet] : []));
        const known = new Set([...s.kids.map((k) => k.tweet.id), ...batch.map((b) => b.t.id)]);
        const fresh = got.filter((x) => !known.has(x.id));
        for (const x of fresh) batch.push({ t: x, q: kind === 'q' });
        src.done = !page.bottom || page.bottom === cursor || (!fresh.length && !(kind === 'r' && s.partial));
        src.cursor = page.bottom;
        src.failed = false;
        if (kind === 'r') s.partial = false;
      } catch (e) {
        src.failed = true;
        s.error = e instanceof ApiError ? e.message : 'Something went wrong.';
      }
    }),
  );
  batch.sort((a, b) => byLikes(a.t, b.t));
  for (const b of batch) addKids(s, [b.t], b.q);
  s.loading = false;
  refresh(id);
}

/** The post a thread control belongs to: the expander bar's previous sibling. */
function postOf(el: HTMLElement): HTMLElement | null {
  const bar = el.closest<HTMLElement>('.thx') || (el.closest('.kids')?.previousElementSibling as HTMLElement | null);
  return (bar?.previousElementSibling as HTMLElement | null) ?? null;
}

/** Scroll a post back under the header if it is above the screen (after collapsing). */
function reveal(post: HTMLElement | null, always = false) {
  if (!post?.isConnected) return;
  const head = post.closest('.view')?.querySelector('.top')?.getBoundingClientRect().bottom || 0;
  const top = post.getBoundingClientRect().top;
  if (always || top < head) quietScroll(scrollY + top - Math.max(0, head));
}

/**
 * Handles `data-act="thread"`: toggle a post's children (replies and quotes together), or
 * `data-more` to load more / retry, `data-close` to collapse, `data-top` to
 * jump back to the post.
 */
export function threadAction(el: HTMLElement) {
  const id = el.dataset.id!;
  const s = state(id);
  if (el.dataset.more !== undefined) return load(id);
  if (el.dataset.top !== undefined) return reveal(postOf(el), true);
  const post = postOf(el);
  if (s.open || el.dataset.close !== undefined) {
    s.open = false;
    refresh(id);
    return reveal(post);
  }
  s.open = true;
  // One tap loads replies and quotes together; already-loaded children just reappear.
  if (!s.kids.length) load(id);
  refresh(id);
}

const plural = (n: number, one: string) => `${num(n)} ${n === 1 ? one : one === 'reply' ? 'replies' : one + 's'}`;

/** Post text (translated when the post shows its translation), clamped to 3 lines by CSS. */
function shortText(t: Tweet) {
  const segs = t.tr && !showOriginal.has(t.id) ? t.tr.text : t.text;
  return segs.length ? `<div class="tx">${segsHtml(segs)}</div>` : '';
}

/** Compact copy of a top-level post, shown in its sticky bar once the post scrolls away. */
function previewHtml(t: Tweet) {
  return `<div class="thp" data-act="thread" data-top data-id="${t.id}"><img src="${esc(t.user.avatar)}" alt="" width="24" height="24"><div class="bd">
<div class="hd">${nameHtml(t.user)}<span class="sn">@${esc(t.user.sn)}</span></div>${shortText(t)}</div>${closeBtn(t)}</div>`;
}

const closeBtn = (t: Tweet) => `<button class="tb on" data-act="thread" data-close data-id="${t.id}" aria-expanded="true">${mi('minus')}<span>Collapse</span></button>`;

function barHtml(t: Tweet, depth: number) {
  const r = count(t, 'r');
  const q = count(t, 'q');
  if (!r && !q) return '';
  const head = `<div class="thx" data-thx="${t.id}" data-d="${depth}">`;
  if (depth >= MAX_DEPTH) return `${head}<a class="tb" href="${statusPath(t)}">Continue thread ›</a></div>`;
  if (expanded.get(t.id)?.open) return `${head}${closeBtn(t)}${depth === 0 ? previewHtml(t) : ''}</div>`;
  const label = [r && plural(r, 'reply'), q && plural(q, 'quote')].filter(Boolean).join(' · ');
  return `${head}<button class="tb" data-act="thread" data-id="${t.id}" aria-expanded="false">${mi('plus')}<span>${label}</span></button></div>`;
}

function kidsInner(t: Tweet, depth: number, nest: number): string {
  const s = expanded.get(t.id);
  if (depth >= MAX_DEPTH || nest >= MAX_NEST || !s?.open) return '';
  const kids = s.kids
    .map((it) => (it.q ? `<div class="kqb">${mi('quotes')}Quote</div>` : '') + nodeHtml(it.q ? tweetHtml(it, t.id) : tweetHtml(it), it.tweet, depth + 1, nest + 1))
    .join('');
  const more = `data-act="thread" data-id="${t.id}" data-more`;
  let foot = '';
  if (s.loading) foot = `<div class="spin sm"></div>`;
  else if (s.error) foot = `<div class="kerr">${esc(s.error)} <button ${more}>Retry</button></div>`;
  else if (pending(t, s).length) foot = `<button class="kmore" ${more}>${s.partial ? 'Show all replies and quotes' : 'Load more'}</button>`;
  else if (!s.kids.length) foot = `<div class="kerr">Nothing to show.</div>`;
  // The guide line on the left collapses this thread from anywhere inside it.
  return `<button class="kl" data-act="thread" data-close data-id="${t.id}" aria-label="Collapse thread"></button><div class="kc">${kids}${foot}</div>`;
}

function nodeHtml(postHtml: string, t: Tweet, depth: number, nest = depth): string {
  return `${postHtml}${barHtml(t, depth)}<div class="kids" data-kids="${t.id}" data-d="${depth}">${kidsInner(t, depth, nest)}</div>`;
}

/**
 * Feed renderer for the Threads tab. Each top-level post is wrapped in `.th`, which bounds
 * its sticky bar: the bar stays under the header while the post's children are on screen.
 */
export function threadHtml(it: Item): string {
  if (it.type !== 'tweet') return '';
  return `<div class="th">${nodeHtml(tweetHtml(it as TweetItem), it.tweet, 0)}</div>`;
}

/** Re-render a post's expander bar and children everywhere it is on screen. */
function refresh(id: string) {
  const t = tweets.get(id); // rendered posts are always in the shared store (touchTweet)
  if (!t) return;
  for (const bar of document.querySelectorAll<HTMLElement>(`.thx[data-thx="${id}"]`)) {
    const kids = bar.nextElementSibling as HTMLElement | null;
    const depth = Number(bar.dataset.d);
    if (!kids?.matches('.kids')) continue;
    unmountMedia(kids);
    kids.innerHTML = kidsInner(t, depth, depth);
    mountMedia(kids);
    bar.outerHTML = barHtml(t, depth);
  }
}

// ---- sticky preview ----
// The bar sticks by CSS alone; the compact preview inside it shows only once the post itself
// has scrolled off the top (`.th.stuck`), so the post never appears twice.
const stuckIo = new IntersectionObserver((es) => {
  for (const e of es) {
    const th = (e.target as HTMLElement).parentElement;
    if (th) th.classList.toggle('stuck', !e.isIntersecting && e.boundingClientRect.top < (e.rootBounds?.top ?? 0));
  }
});

/** Feed hooks: watch top-level posts of a rendered chunk for the sticky preview. */
export function mountThreads(el: HTMLElement) {
  for (const a of el.querySelectorAll(':scope > .th > article')) stuckIo.observe(a);
}
export function unmountThreads(el: HTMLElement) {
  for (const a of el.querySelectorAll(':scope > .th > article')) stuckIo.unobserve(a);
}
