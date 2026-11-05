import { get } from '../api';
import { Feed } from '../feed/feed';
import { handoff, mountMedia, unmountMedia } from '../media/video';
import { itemHtml } from '../render/cells';
import { pinnedHtml, tweetHtml, type TweetItem } from '../render/tweet';
import type { View } from '../router';
import { tweets } from '../store';
import { h, quietScroll } from '../util';
import { shell } from './base';

export function quotesView(id: string): View {
  // The quoted post sits in the header row (which doesn't hide on scroll);
  // quotes below don't repeat it. "Quotes" shows until the post is known.
  const s = shell({ back: true, center: `<div class="qbar"><div class="ttl"><b>Quotes</b></div></div>` });
  s.el.classList.add('keep-top');
  const pin = s.bar.querySelector<HTMLElement>('.qbar')!;
  let pinned = false;
  const showPin = (t: NonNullable<ReturnType<typeof tweets.get>>) => {
    pin.innerHTML = pinnedHtml(t);
    pinned = true;
  };
  const cached = tweets.get(id);
  if (cached) showPin(cached);
  const feed = new Feed({
    load: (cursor) => get(`/tweet/${id}/quotes`, { cursor }),
    render: (it) => (it.type === 'tweet' ? tweetHtml(it as TweetItem, id) : itemHtml(it)),
    dedupe: true,
    empty: 'No quotes to show.',
    onPage(page) {
      if (pinned) return;
      // Opened directly (not from a feed): take the original from any quote.
      for (const it of page.items) if (it.type === 'tweet' && it.tweet.quote?.id === id) return showPin(it.tweet.quote);
    },
  });
  s.body.append(feed.el);
  feed.start();
  return { el: s.el, title: 'Quotes', show: () => feed.resume(), hide: () => feed.pause(), destroy: () => feed.destroy() };
}

export function tweetView(id: string): View {
  const s = shell({ back: true, title: 'Post' });
  s.el.classList.add('tview', 'keep-top');

  // Like X: if the post is already loaded (from a feed), show it immediately and
  // fetch only the thread around it. The placeholder is swapped out when the thread arrives.
  const cached = tweets.get(id);
  let pre: HTMLElement | null = null;
  if (cached) {
    pre = h('div', 'pre', tweetHtml({ k: 'pre', type: 'tweet', tweet: cached, focal: true }));
    s.body.append(pre);
    mountMedia(pre);
  }

  const feed = new Feed({
    load: (cursor) => get(`/tweet/${id}`, { cursor }),
    render: itemHtml,
    dedupe: true,
    eagerFirst: true,
    empty: 'This post is unavailable.',
    onPage(_p, first) {
      if (!first) return;
      const f = s.el.querySelector<HTMLElement>('.feed .focal');
      if (pre) {
        // Keep the focal post exactly where the placeholder was, even though
        // parent posts were just inserted above it.
        const at = pre.getBoundingClientRect().top;
        handoff(feed.el);
        unmountMedia(pre);
        pre.remove();
        pre = null;
        if (f) quietScroll(f.getBoundingClientRect().top + scrollY - at);
        return;
      }
      // Ancestors render above the focal post; bring the focal post to the top.
      requestAnimationFrame(() => {
        if (f && f.offsetTop > s.top.offsetHeight + 4) quietScroll(f.getBoundingClientRect().top + scrollY - s.top.offsetHeight);
      });
    },
  });
  s.body.append(feed.el);
  feed.start();
  return { el: s.el, title: 'Post', noFab: true, show: () => feed.resume(), hide: () => feed.pause(), destroy: () => feed.destroy() };
}
