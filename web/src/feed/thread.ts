// Threaded (Reddit-style) rendering for the Home "Threads" tab. Replies and quotes are
// children of a post, loaded only when the user expands them (one X request per tap).
// Expansion state lives here, keyed by post id, so a virtual-feed chunk that is emptied
// and re-rendered (see feed.ts) comes back with the same threads open.
import type { Item, Page, Tweet } from '../../../shared/types';
import { ApiError, get } from '../api';
import { mi } from '../icons';
import { mountMedia, unmountMedia } from '../media/video';
import { intern, tweets } from '../store';
import { tweetHtml, statusPath, type TweetItem } from '../render/tweet';
import { esc, num } from '../util';

type Kind = 'r' | 'q';

interface Branch {
  items: TweetItem[];
  open: boolean;
  loading: boolean;
  error?: string;
  cursor?: string;
  done?: boolean;
  /** Filled from a parent's response (a chain), not from this post's own request yet. */
  partial?: boolean;
}

type State = Partial<Record<Kind, Branch>>;

/** Deepest nesting level rendered inline; deeper posts link to their page. */
const MAX_DEPTH = 4;
/** Guard against rendering a post inside itself if X ever returns a cycle. */
const MAX_NEST = 12;

const expanded = new Map<string, State>();

const branch = (id: string, kind: Kind) => {
  let s = expanded.get(id);
  if (!s) expanded.set(id, (s = {}));
  return (s[kind] ||= { items: [], open: false, loading: false });
};

const asChild = (t: Tweet): TweetItem => ({ k: 'c' + t.id, type: 'tweet', tweet: t });

/** Add children to a branch, skipping ones already there. Returns how many were new. */
function addKids(b: Branch, kids: Tweet[]) {
  const have = new Set(b.items.map((i) => i.tweet.id));
  let n = 0;
  for (const t of kids)
    if (!have.has(t.id)) {
      have.add(t.id);
      b.items.push(asChild(t));
      n++;
    }
  return n;
}

/**
 * Nest a reply chain under `rootId`: each post goes under the post it replies to when that
 * post is in the chain, otherwise under the previous post (X sometimes skips a middle reply).
 * Grandchildren are stored as pre-opened partial branches of their parents.
 */
function nest(rootId: string, chain: Tweet[], prevParent: (i: number) => string) {
  const ids = new Set([rootId, ...chain.map((t) => t.id)]);
  const direct: Tweet[] = [];
  chain.forEach((t, i) => {
    const parent = t.replyToId && ids.has(t.replyToId) && t.replyToId !== t.id ? t.replyToId : prevParent(i);
    if (parent === rootId) return direct.push(t);
    const b = branch(parent, 'r');
    if (!b.items.length && !b.loading) {
      b.open = true;
      b.partial = true;
    }
    if (b.partial) addKids(b, [t]);
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
    if (!chain.length) return;
    const direct = nest(root.tweet.id, chain, (i) => (i === 0 ? root.tweet.id : chain[i - 1].id));
    const b = branch(root.tweet.id, 'r');
    if (!b.items.length && !b.loading) {
      b.open = true;
      b.partial = true;
    }
    if (b.partial) addKids(b, direct);
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
  const after = items.slice(fi + 1);
  const chain: Tweet[] = [];
  const lineBefore: boolean[] = [];
  let prevLine = false;
  for (const it of after) {
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

async function load(id: string, kind: Kind) {
  const b = branch(id, kind);
  if (b.loading) return;
  b.loading = true;
  b.error = undefined;
  refresh(id);
  const cursor = b.partial ? undefined : b.cursor;
  try {
    const page = intern(await get(kind === 'r' ? `/tweet/${id}` : `/tweet/${id}/quotes`, { cursor }));
    const kids = kind === 'r' ? repliesOf(id, page) : page.items.flatMap((i) => (i.type === 'tweet' && i.tweet.id !== id ? [i.tweet] : []));
    const fresh = addKids(b, kids);
    b.done = !page.bottom || page.bottom === cursor || (!fresh && !b.partial);
    b.cursor = page.bottom;
    b.partial = false;
  } catch (e) {
    b.error = e instanceof ApiError ? e.message : 'Something went wrong.';
  } finally {
    b.loading = false;
    refresh(id);
  }
}

/** Handles `data-act="thread"` buttons: toggle a branch, or load more / retry. */
export function threadAction(el: HTMLElement) {
  const id = el.dataset.id!;
  const kind = el.dataset.kind as Kind;
  const b = branch(id, kind);
  if (el.dataset.more !== undefined) return load(id, kind);
  b.open = !b.open;
  if (b.open && !b.items.length && !b.done) return load(id, kind);
  refresh(id);
}

function count(t: Tweet, kind: Kind) {
  const b = expanded.get(t.id)?.[kind];
  return Math.max(kind === 'r' ? t.replies : t.quotes, b?.items.length || 0);
}

function barHtml(t: Tweet, depth: number) {
  const r = count(t, 'r');
  const q = count(t, 'q');
  if (!r && !q) return '';
  if (depth >= MAX_DEPTH) return `<div class="thx" data-thx="${t.id}" data-d="${depth}"><a class="tb" href="${statusPath(t)}">Continue thread ›</a></div>`;
  const s = expanded.get(t.id);
  const btn = (kind: Kind, n: number, noun: string) => {
    if (!n) return '';
    const open = s?.[kind]?.open;
    const label = open ? `Hide ${noun}` : `${num(n)} ${n === 1 ? noun.slice(0, -1) : noun}`;
    return `<button class="tb${open ? ' on' : ''}" data-act="thread" data-kind="${kind}" data-id="${t.id}" aria-expanded="${!!open}">${mi(open ? 'minus' : 'plus')}<span>${label}</span></button>`;
  };
  return `<div class="thx" data-thx="${t.id}" data-d="${depth}">${btn('r', r, 'replies')}${btn('q', q, 'quotes')}</div>`;
}

function branchHtml(t: Tweet, kind: Kind, depth: number, nest: number): string {
  const b = expanded.get(t.id)?.[kind];
  if (!b?.open) return '';
  const kids = b.items
    .map((it) => (kind === 'q' ? `<div class="kqb">${mi('quotes')}Quote</div>` : '') + nodeHtml(kind === 'q' ? tweetHtml(it, t.id) : tweetHtml(it), it.tweet, depth + 1, nest + 1))
    .join('');
  const noun = kind === 'r' ? 'replies' : 'quotes';
  const more = `data-act="thread" data-kind="${kind}" data-id="${t.id}" data-more`;
  let foot = '';
  if (b.loading) foot = `<div class="spin sm"></div>`;
  else if (b.error) foot = `<div class="kerr">${esc(b.error)} <button ${more}>Retry</button></div>`;
  else if (b.partial ? count(t, kind) > b.items.length : !b.done) foot = `<button class="kmore" ${more}>${b.partial ? `Show all ${noun}` : `Load more ${noun}`}</button>`;
  else if (!b.items.length) foot = `<div class="kerr">No ${noun} to show.</div>`;
  return `<div class="k${kind}">${kids}${foot}</div>`;
}

function kidsInner(t: Tweet, depth: number, nest: number): string {
  if (depth >= MAX_DEPTH || nest >= MAX_NEST) return '';
  return branchHtml(t, 'r', depth, nest) + branchHtml(t, 'q', depth, nest);
}

function nodeHtml(postHtml: string, t: Tweet, depth: number, nest = depth): string {
  return `${postHtml}${barHtml(t, depth)}<div class="kids" data-kids="${t.id}" data-d="${depth}">${kidsInner(t, depth, nest)}</div>`;
}

/** Feed renderer for the Threads tab. Posts stay direct children of the chunk (seen tracking). */
export function threadHtml(it: Item): string {
  if (it.type !== 'tweet') return '';
  return nodeHtml(tweetHtml(it as TweetItem), it.tweet, 0);
}

/** Re-render a post's expander bar and children everywhere it is on screen. */
function refresh(id: string) {
  for (const bar of document.querySelectorAll<HTMLElement>(`.thx[data-thx="${id}"]`)) {
    const kids = bar.nextElementSibling as HTMLElement | null;
    const depth = Number(bar.dataset.d);
    const t = tweets.get(id); // rendered posts are always in the shared store (touchTweet)
    if (!t || !kids?.matches('.kids')) continue;
    unmountMedia(kids);
    kids.innerHTML = kidsInner(t, depth, depth);
    mountMedia(kids);
    bar.outerHTML = barHtml(t, depth);
  }
}
