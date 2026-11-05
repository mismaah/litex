import type { Item, List, User } from '../../../shared/types';
import { mi } from '../icons';
import { me, putUser } from '../store';
import { ago, esc, num } from '../util';
import { img } from './media';
import { segsHtml } from './text';
import { avatarHtml, nameHtml, tweetHtml, type TweetItem } from './tweet';

export function followBtn(u: User) {
  if (me()?.id === u.id) return '';
  return `<button class="fb${u.following ? ' on' : ''}" data-act="follow" data-uid="${u.id}">${u.following ? 'Following' : 'Follow'}</button>`;
}

export function userCell(u: User) {
  putUser(u);
  return `<div class="uc" data-href="/${esc(u.sn)}">${avatarHtml(u)}<div class="bd">
<div class="uh"><div class="un">${nameHtml(u)}<span class="sn">@${esc(u.sn)}${u.followedBy ? ' <i class="fy">Follows you</i>' : ''}</span></div>${followBtn(u)}</div>
${u.bio?.length ? `<div class="ub">${segsHtml(u.bio)}</div>` : ''}</div></div>`;
}

export function listCell(l: List) {
  const banner = l.banner ? `<img src="${esc(l.banner)}" alt="" loading="lazy">` : '';
  return `<div class="lc" data-href="/i/lists/${l.id}"><div class="lb">${banner || mi('list')}</div><div class="bd">
<div class="ln1"><b>${esc(l.name)}</b>${l.private ? mi('lock', 'lk') : ''}</div>
<div class="ln2">${l.owner ? `${esc(l.owner.name)} · ` : ''}${num(l.members) || 0} members</div></div></div>`;
}

const NOTIF_ICON: Record<string, string> = { heart: 'heart', retweet: 'rt', person: 'person', bell: 'bell', bird: 'bell', recommendation: 'star', milestone: 'star', birdwatch: 'star' };

export function notifCell(it: Extract<Item, { type: 'notif' }>) {
  const ic = NOTIF_ICON[it.icon] || 'bell';
  const avs = it.users
    .slice(0, 7)
    .map((u) => `<a href="/${esc(u.sn)}"><img src="${esc(u.avatar)}" alt="" width="32" height="32" loading="lazy"></a>`)
    .join('');
  return `<div class="nc"${it.url ? ` data-href="${esc(it.url)}"` : ''}><div class="ni ni-${esc(it.icon)}">${mi(ic === 'heart' ? 'heartf' : ic)}</div><div class="bd">
${avs ? `<div class="na">${avs}</div>` : ''}<div class="nt">${segsHtml(it.text)}${it.time ? ` <span class="dt">· ${ago(it.time)}</span>` : ''}</div>
${it.snippet ? `<div class="ns">${esc(it.snippet)}</div>` : ''}</div></div>`;
}

export function trendCell(it: Extract<Item, { type: 'trend' }>) {
  return `<a class="tc" href="/search?q=${encodeURIComponent(it.q)}">${it.ctx ? `<div class="tx2">${esc(it.ctx)}</div>` : ''}<div class="tn">${esc(it.name)}</div>${
    it.meta ? `<div class="tx2">${esc(it.meta)}</div>` : ''
  }</a>`;
}

/** Default renderer for any feed item. */
export function itemHtml(it: Item): string {
  switch (it.type) {
    case 'tweet':
      return tweetHtml(it as TweetItem);
    case 'tombstone':
      return `<div class="tomb${it.line ? ' ln' : ''}">${esc(it.text)}</div>`;
    case 'user':
      return userCell(it.user);
    case 'list':
      return listCell(it.list);
    case 'notif':
      return notifCell(it);
    case 'trend':
      return trendCell(it);
    case 'more':
      return it.href ? `<a class="more" href="${esc(it.href)}">${esc(it.label)}</a>` : '';
  }
}

/** Media-grid renderer (profile Media tab, search Media). */
export function gridHtml(it: Item): string {
  if (it.type !== 'tweet' || !it.tweet.media?.length) return '';
  const t = it.tweet;
  const m = t.media![0];
  const mark = m.type === 'video' ? `<span class="mp sm">${mi('play')}</span>` : t.media!.length > 1 ? `<span class="mb">${t.media!.length}</span>` : '';
  return `<a class="gc" href="/${esc(t.user.sn)}/status/${t.id}"><img src="${esc(img(m.url, '360x360'))}" alt="" loading="lazy" decoding="async">${mark}</a>`;
}
