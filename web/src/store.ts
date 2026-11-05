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
