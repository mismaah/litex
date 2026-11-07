// Shared tweet/user objects so a like in one view shows everywhere. LRU-capped.
import type { Item, Page, Tweet, User } from '../../shared/types';
import { getPref, setPref } from './util';

const MAX = 6000;
export const tweets = new Map<string, Tweet>();
export const users = new Map<string, User>();

function lru<T>(m: Map<string, T>, id: string, v: T) {
  m.delete(id);
  m.set(id, v);
  if (m.size > MAX) {
    let n = m.size - MAX + 500;
    for (const k of m.keys()) {
      if (n-- <= 0) break;
      m.delete(k);
    }
  }
}

export function putTweet(t: Tweet): Tweet {
  const ex = tweets.get(t.id);
  const v = ex ? Object.assign(ex, t) : t;
  if (v.quote) v.quote = putTweet(v.quote);
  lru(tweets, t.id, v);
  putUser(v.user);
  return v;
}

export function putUser(u: User): User {
  const ex = users.get(u.id);
  // Keep full-profile fields if this copy is a light one.
  const v = ex ? Object.assign(ex, Object.fromEntries(Object.entries(u).filter(([, x]) => x !== undefined))) : u;
  lru(users, u.id, v);
  return v;
}

/** Re-register an object when it is rendered, so anything on screen is always findable. */
export function touchTweet(t: Tweet) {
  if (tweets.get(t.id) !== t) lru(tweets, t.id, t);
  // The embedded quote is on screen too (its media cells look it up by id).
  if (t.quote && tweets.get(t.quote.id) !== t.quote) lru(tweets, t.quote.id, t.quote);
}

export function intern(page: Page): Page {
  for (const it of page.items as Item[]) {
    if (it.type === 'tweet') {
      it.tweet = putTweet(it.tweet);
      if (it.rtBy) it.rtBy = putUser(it.rtBy);
    } else if (it.type === 'user') it.user = putUser(it.user);
  }
  return page;
}

/** Translated posts the user switched back to the original text. */
export const showOriginal = new Set<string>();

// ---- prefs ----
export type Theme = 'system' | 'light' | 'dim' | 'dark';
export const prefs = {
  theme: getPref<Theme>('theme', 'system'),
  gifs: getPref('gifs', true),
  hq: getPref('hq', false),
};
export function savePref<K extends keyof typeof prefs>(k: K, v: (typeof prefs)[K]) {
  prefs[k] = v;
  setPref(k, v);
}

let meUser: User | null = null;
export const me = () => meUser;
export const setMe = (u: User) => (meUser = putUser(u));

// ---- seen home posts ----
// Posts the user has actually had on screen, newest last, per home tab. Sent to X as
// seenTweetIds (like x.com does) so the ranker stops serving them again, even after a reload.
const SEEN_MAX = 200;
const SEEN_SEND = 100;
const seenLists = new Map<string, string[]>();
let seenSave = 0;

function seenList(tab: string) {
  let l = seenLists.get(tab);
  if (!l) seenLists.set(tab, (l = getPref<string[]>('seen:' + tab, [])));
  return l;
}

export function markSeen(tab: string, id: string) {
  const l = seenList(tab);
  const i = l.indexOf(id);
  if (i >= 0) l.splice(i, 1);
  l.push(id);
  if (l.length > SEEN_MAX) l.splice(0, l.length - SEEN_MAX);
  // Batch writes: posts scroll into view in bursts.
  if (!seenSave)
    seenSave = window.setTimeout(() => {
      seenSave = 0;
      for (const [t, v] of seenLists) setPref('seen:' + t, v);
    }, 1000);
}

/** Most recently seen post IDs, newest first, as the comma list /api/home expects. */
export function seenParam(tab: string): string | undefined {
  const l = seenList(tab);
  return l.length ? l.slice(-SEEN_SEND).reverse().join(',') : undefined;
}
