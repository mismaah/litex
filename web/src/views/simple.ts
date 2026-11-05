// Notifications, bookmarks, lists and list timelines.
import type { List } from '../../../shared/types';
import { get } from '../api';
import { Feed } from '../feed/feed';
import { itemHtml } from '../render/cells';
import { segsHtml } from '../render/text';
import type { View } from '../router';
import { esc, h, num } from '../util';
import { TabFeeds, errorBox, onTab, shell } from './base';

export function notificationsView(): View {
  const s = shell({
    title: 'Notifications',
    tabs: [
      ['all', 'All'],
      ['mentions', 'Mentions'],
    ],
  });
  const tf = new TabFeeds(s.body, (tab) => new Feed({ load: (cursor) => get('/notifications', { tab, cursor }), render: itemHtml, dedupe: true, empty: 'No notifications yet.' }));
  tf.select('all');
  onTab(s.tabs!, (t) => tf.select(t));
  return {
    el: s.el,
    title: 'Notifications',
    tab: 'notifications',
    show: () => tf.resume(),
    hide: () => tf.pause(),
    reselect: () => (scrollY > 0 ? scrollTo({ top: 0 }) : tf.feed?.reset()),
  };
}

export let bookmarksFeed: Feed | null = null;
export function bookmarksView(): View {
  const s = shell({ title: 'Bookmarks' });
  const feed = new Feed({ load: (cursor) => get('/bookmarks', { cursor }), render: itemHtml, dedupe: true, empty: 'Save posts to see them here.' });
  bookmarksFeed = feed;
  s.body.append(feed.el);
  feed.start();
  return {
    el: s.el,
    title: 'Bookmarks',
    tab: 'bookmarks',
    show: () => feed.resume(),
    hide: () => feed.pause(),
    reselect: () => (scrollY > 0 ? scrollTo({ top: 0 }) : feed.reset()),
  };
}

export function listsView(): View {
  const s = shell({ back: true, title: 'Lists' });
  const feed = new Feed({ load: (c) => (c ? Promise.resolve({ items: [] }) : get('/lists')), render: itemHtml, empty: "You haven't created or followed any lists." });
  s.body.append(feed.el);
  feed.start();
  return { el: s.el, title: 'Lists', show: () => feed.resume(), hide: () => feed.pause(), destroy: () => feed.destroy() };
}

export function listView(id: string): View {
  const s = shell({ back: true, title: 'List' });
  const head = h('div', 'lhead');
  s.body.append(head);
  get<List>(`/list/${id}`)
    .then((l) => {
      s.bar.querySelector('.ttl')!.innerHTML = `<b>${esc(l.name)}</b>${l.owner ? `<small>@${esc(l.owner.sn)}</small>` : ''}`;
      head.innerHTML = `${l.banner ? `<div class="lbn"><img src="${esc(l.banner)}" alt=""></div>` : ''}<div class="lmeta"><h2>${esc(l.name)}</h2>${
        l.desc ? `<p>${segsHtml([{ t: 'text', v: l.desc }])}</p>` : ''
      }${l.owner ? `<p><a href="/${esc(l.owner.sn)}"><b>${esc(l.owner.name)}</b> @${esc(l.owner.sn)}</a></p>` : ''}<p class="mut"><b>${num(l.members) || 0}</b> Members · <b>${num(l.subscribers) || 0}</b> Followers</p></div>`;
    })
    .catch((e) => (head.innerHTML = errorBox(e.message)));
  const feed = new Feed({ load: (cursor) => get(`/list/${id}/tweets`, { cursor }), render: itemHtml, dedupe: true, empty: 'No posts in this list yet.' });
  s.body.append(feed.el);
  feed.start();
  return { el: s.el, title: 'List', show: () => feed.resume(), hide: () => feed.pause(), destroy: () => feed.destroy() };
}
