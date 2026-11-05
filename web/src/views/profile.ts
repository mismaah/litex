import type { User } from '../../../shared/types';
import { get } from '../api';
import { Feed } from '../feed/feed';
import { icon } from '../icons';
import { followBtn, gridHtml, itemHtml } from '../render/cells';
import { segsHtml } from '../render/text';
import { nameHtml } from '../render/tweet';
import type { View } from '../router';
import { me, putUser } from '../store';
import { esc, h, joined, num, safeUrl } from '../util';
import { TabFeeds, errorBox, onTab, setTabs, shell } from './base';

const TAB_FROM_PATH: Record<string, string> = { with_replies: 'replies', media: 'media', likes: 'likes' };

export function profileView(sn: string, sub?: string): View {
  const s = shell({ back: true, title: sn });
  const head = h('div', 'phead', `<div class="pban"></div><div class="spin"></div>`);
  const tabs = h('nav', 'tabs ptabs');
  const host = h('div');
  s.body.append(head, tabs, host);
  let tf: TabFeeds | null = null;

  get<User>(`/user/${sn}`)
    .then((raw) => {
      const u = putUser(raw);
      const self = me()?.id === u.id;
      s.bar.querySelector('.ttl')!.innerHTML = `<b>${esc(u.name)}</b><small>${num(u.tweets) || 0} posts</small>`;
      const meta = [
        u.location ? `<span>${icon('pin')}${esc(u.location)}</span>` : '',
        u.url ? `<a href="${esc(safeUrl(u.url.href))}" target="_blank" rel="noopener noreferrer nofollow">${icon('link')}${esc(u.url.v)}</a>` : '',
        u.joined ? `<span>${icon('calendar')}${joined(u.joined)}</span>` : '',
      ].join('');
      head.innerHTML = `<div class="pban">${u.banner ? `<img src="${esc(/pbs\.twimg\.com/.test(u.banner) ? u.banner + '/600x200' : u.banner)}" alt="">` : ''}</div>
<div class="prow"><img class="pav" src="${esc(u.avatar.replace('_bigger.', '_200x200.'))}" alt="" width="80" height="80">${followBtn(u)}</div>
<div class="pinfo"><h2>${nameHtml(u)}</h2><div class="sn">@${esc(u.sn)}${u.followedBy ? ' <i class="fy">Follows you</i>' : ''}</div>
${u.bio?.length ? `<div class="pbio">${segsHtml(u.bio)}</div>` : ''}${meta ? `<div class="pmeta">${meta}</div>` : ''}
<div class="pcount"><a href="/${esc(u.sn)}/following"><b>${num(u.followingCount) || 0}</b> Following</a><a href="/${esc(u.sn)}/followers"><b>${num(u.followers) || 0}</b> Followers</a></div></div>`;
      if (u.protected && !u.following && !self) {
        host.innerHTML = `<div class="emp">${icon('lock')}<p>These posts are protected. Only approved followers can see them.</p></div>`;
        return;
      }
      const list: [string, string][] = [
        ['posts', 'Posts'],
        ['replies', 'Replies'],
        ['media', 'Media'],
      ];
      if (self) list.push(['likes', 'Likes']);
      const initial = TAB_FROM_PATH[sub || ''] && list.some(([id]) => id === TAB_FROM_PATH[sub!]) ? TAB_FROM_PATH[sub!] : 'posts';
      setTabs(tabs, list, initial);
      tf = new TabFeeds(
        host,
        (tab) =>
          new Feed({
            load: (cursor) => get(`/user/${u.id}/timeline`, { tab, cursor }),
            render: tab === 'media' ? gridHtml : itemHtml,
            cls: tab === 'media' ? 'grid' : '',
            dedupe: true,
            empty: tab === 'media' ? 'No photos or videos yet.' : tab === 'likes' ? 'No likes yet.' : `@${u.sn} hasn't posted yet.`,
          }),
        () => tabs.offsetTop - s.top.offsetHeight,
      );
      tf.select(initial);
      onTab(tabs, (t) => tf!.select(t));
    })
    .catch((e) => (head.innerHTML = errorBox(e.status === 404 ? "This account doesn't exist." : e.message)));

  return { el: s.el, title: '@' + sn, tab: me()?.sn.toLowerCase() === sn.toLowerCase() ? 'me' : undefined, show: () => tf?.resume(), hide: () => tf?.pause(), destroy: () => tf?.destroy() };
}

export function followsView(sn: string, kind: 'followers' | 'following'): View {
  const s = shell({
    back: true,
    title: '@' + sn,
    tabs: [
      ['followers', 'Followers'],
      ['following', 'Following'],
    ],
    active: kind,
  });
  let tf: TabFeeds | null = null;
  get<User>(`/user/${sn}`)
    .then((u) => {
      s.bar.querySelector('.ttl')!.innerHTML = `<b>${esc(u.name)}</b><small>@${esc(u.sn)}</small>`;
      tf = new TabFeeds(s.body, (tab) => new Feed({ load: (cursor) => get(`/user/${u.id}/${tab}`, { cursor }), render: itemHtml, dedupe: true, empty: 'Nobody here yet.' }));
      tf.select(kind);
      onTab(s.tabs!, (t) => {
        tf!.select(t);
        history.replaceState(history.state, '', `/${sn}/${t}`);
      });
    })
    .catch((e) => (s.body.innerHTML = errorBox(e.message)));
  return { el: s.el, title: '@' + sn, show: () => tf?.resume(), hide: () => tf?.pause(), destroy: () => tf?.destroy() };
}
