import type { Item, Tweet, User } from '../../../shared/types';
import { badge, mi } from '../icons';
import { touchTweet } from '../store';
import { ago, esc, fullDate, num } from '../util';
import { cardHtml, img, mediaHtml } from './media';
import { segsHtml, segsLen } from './text';

export type TweetItem = Extract<Item, { type: 'tweet' }> & { lt?: boolean };

export const statusPath = (t: Tweet) => `/${t.user.sn}/status/${t.id}`;

export function nameHtml(u: User, cls = '') {
  return `<span class="nm ${cls}"><b>${esc(u.name)}</b>${u.verified ? badge(u.verified) : ''}${u.protected ? mi('lock', 'lk') : ''}</span>`;
}

export const avatarHtml = (u: User, size = 40) =>
  `<a class="av" href="/${esc(u.sn)}" style="width:${size}px;height:${size}px"><img src="${esc(u.avatar)}" alt="" width="${size}" height="${size}" loading="lazy" decoding="async"></a>`;

// A placeholder keeps the action bar aligned on posts without quotes.
const quotesBtn = (t: Tweet) =>
  t.quotes ? `<a class="a qq" href="${statusPath(t)}/quotes" aria-label="View quotes">${mi('quotes')}<span>${num(t.quotes)}</span></a>` : `<span class="a sp" aria-hidden="true"></span>`;

/** The same bar on feed posts and the open post. */
export function actionsHtml(t: Tweet) {
  return `<div class="ab">
<button class="a rp" data-act="reply" aria-label="Reply">${mi('reply')}<span>${num(t.replies)}</span></button>
<button class="a rt${t.rted ? ' on' : ''}" data-act="rt" aria-label="Repost">${mi('rt')}<span>${num(t.rts)}</span></button>
${quotesBtn(t)}
<button class="a lk${t.liked ? ' on' : ''}" data-act="like" aria-label="Like">${mi(t.liked ? 'heartf' : 'heart')}<span>${num(t.likes)}</span></button>
<button class="a sh" data-act="share" aria-label="Share">${mi('share')}</button>
<button class="a bm${t.bookmarked ? ' on' : ''}" data-act="bm" aria-label="Bookmark">${mi(t.bookmarked ? 'bmf' : 'bookmark')}</button>
</div>`;
}

export function quoteHtml(q: Tweet | null | undefined) {
  if (q === undefined) return '';
  if (q === null) return `<div class="qt qt-na">This post is unavailable.</div>`;
  const long = segsLen(q.text) > 280;
  return `<div class="qt" data-href="${statusPath(q)}" data-tid="${q.id}">
<div class="hd"><img class="qa" src="${esc(q.user.avatar)}" alt="" width="20" height="20" loading="lazy">${nameHtml(q.user)}<span class="sn">@${esc(q.user.sn)}</span><span class="dt">· ${ago(q.time)}</span></div>
${q.text.length ? `<div class="tx${long ? ' clamp' : ''}">${segsHtml(q.text)}</div>` : ''}
${mediaHtml(q, true)}
</div>`;
}

function ctxHtml(it: TweetItem) {
  if (it.pinned) return `<div class="ctx">${mi('pin')}Pinned</div>`;
  if (it.rtBy) return `<div class="ctx">${mi('rt')}<a href="/${esc(it.rtBy.sn)}">${esc(it.rtBy.name)} reposted</a></div>`;
  return '';
}

/** Compact pinned version of a post (top of its Quotes page). */
export function pinnedHtml(t: Tweet) {
  const m = t.media?.[0];
  return `<div class="qpin" data-href="${statusPath(t)}" data-tid="${t.id}"><img class="qa" src="${esc(t.user.avatar)}" alt="" width="24" height="24"><div class="bd">
<div class="hd">${nameHtml(t.user)}<span class="sn">@${esc(t.user.sn)}</span><span class="dt">· ${ago(t.time)}</span></div>
${t.text.length ? `<div class="tx">${segsHtml(t.text)}</div>` : ''}</div>${m ? `<img class="qthumb" src="${esc(img(m.url, 'small'))}" alt="">` : ''}</div>`;
}

/** `hideQuoteOf`: leave out the embedded quote when it's this post (Quotes page). */
export function tweetHtml(it: TweetItem, hideQuoteOf?: string): string {
  const t = it.tweet;
  touchTweet(t);
  if (it.focal) return focalHtml(it);
  const long = segsLen(t.text) > 600;
  const cls = `tw${it.line ? ' ln' : ''}${it.lt ? ' lt' : ''}`;
  return `<article class="${cls}" data-tid="${t.id}" data-href="${statusPath(t)}">
${ctxHtml(it)}<div class="row">${avatarHtml(t.user)}<div class="bd">
<div class="hd">${nameHtml(t.user)}<span class="sn">@${esc(t.user.sn)}</span><a class="dt" href="${statusPath(t)}">· ${ago(t.time)}</a></div>
${t.replyTo && !it.lt ? `<div class="rpl">Replying to <a href="/${esc(t.replyTo)}">@${esc(t.replyTo)}</a></div>` : ''}
${t.text.length ? `<div class="tx${long ? ' clamp' : ''}">${segsHtml(t.text)}</div>${long ? `<a class="smore" href="${statusPath(t)}">Show more</a>` : ''}` : ''}
${mediaHtml(t)}${cardHtml(t.card)}${t.quote && t.quote.id === hideQuoteOf ? '' : quoteHtml(t.quote)}
${actionsHtml(t)}
</div></div></article>`;
}

function focalHtml(it: TweetItem): string {
  const t = it.tweet;
  return `<article class="tw focal${it.lt ? ' lt' : ''}" data-tid="${t.id}">
${ctxHtml(it)}<div class="fh">${avatarHtml(t.user, 44)}<div class="fn"><a href="/${esc(t.user.sn)}">${nameHtml(t.user)}</a><span class="sn">@${esc(t.user.sn)}</span></div></div>
${t.replyTo ? `<div class="rpl">Replying to <a href="/${esc(t.replyTo)}">@${esc(t.replyTo)}</a></div>` : ''}
${t.text.length ? `<div class="tx">${segsHtml(t.text)}</div>` : ''}
${mediaHtml(t)}${cardHtml(t.card)}${quoteHtml(t.quote)}
<div class="fd">${fullDate(t.time)}${t.views ? ` · <b>${num(t.views)}</b> Views` : ''}</div>
${actionsHtml(t)}
</article>`;
}

/** Update the action buttons for a tweet everywhere it is on screen. */
export function refreshActions(t: Tweet) {
  for (const el of document.querySelectorAll<HTMLElement>(`article[data-tid="${t.id}"]`)) {
    const ab = el.querySelector(':scope .ab');
    if (ab) ab.outerHTML = actionsHtml(t);
  }
}
