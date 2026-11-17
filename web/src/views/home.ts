import type { Page } from '../../../shared/types';
import { get } from '../api';
import { Feed } from '../feed/feed';
import { groupThreads, mountThreads, threadHtml, unmountThreads } from '../feed/thread';
import { icon } from '../icons';
import { itemHtml } from '../render/cells';
import type { View } from '../router';
import { markSeen, me, seenParam } from '../store';
import { esc, h, toast } from '../util';
import { TabFeeds, onTab, setNavBusy, shell } from './base';

const POLL_MS = 120_000;

// The Threads tab shows For you posts, so it uses For you's X timeline and seen list.
const xTab = (tab: string) => (tab === 'threads' ? 'foryou' : tab);
const shape = (tab: string, page: Page) => (tab === 'threads' ? groupThreads(page) : page);

export function homeView(): View {
  const avatar = () => {
    const u = me();
    return `<button class="ib me" data-act="menu" aria-label="Menu">${u ? `<img src="${esc(u.avatar)}" alt="" width="32" height="32">` : icon('user')}</button>`;
  };
  // Home always opens on For you.
  const s = shell({
    left: avatar(),
    right: `<span class="ib"></span>`,
    tabs: [
      ['foryou', 'For you'],
      ['following', 'Following'],
      ['threads', 'Threads'],
    ],
    active: 'foryou',
    inlineTabs: true,
  });
  const ptr = h('div', 'ptr', '<div class="spin"></div>');
  const pill = h('button', 'pill');
  pill.hidden = true;
  s.el.append(pill);
  s.body.append(ptr);

  // Tabs where a background check found new posts; the pill only says they exist (avatars).
  const pending = new Map<string, string[]>();
  const showPill = () => {
    const avatars = pending.get(tf.cur);
    pill.hidden = !avatars;
    if (avatars) pill.innerHTML = `${icon('up')}${avatars.map((a) => `<img src="${esc(a)}" alt="">`).join('')}<span>New posts</span>`;
  };
  const tf = new TabFeeds(
    s.body,
    (tab) =>
      new Feed({
        load: async (cursor) => shape(tab, await get('/home', { tab: xTab(tab), cursor, seen: seenParam(xTab(tab)) })),
        render: tab === 'threads' ? threadHtml : itemHtml,
        dedupe: true,
        onSeen: (id) => markSeen(xTab(tab), id),
        ...(tab === 'threads' ? { onMount: mountThreads, onUnmount: unmountThreads } : {}),
      }),
  );
  tf.select('foryou');
  onTab(s.tabs!, (tab, same) => {
    if (same) return void refresh();
    tf.select(tab);
    showPill();
  });

  // The feed never changes on its own: only user actions call refresh().
  let inflight = false;
  async function refresh() {
    const tab = tf.cur;
    const feed = tf.feed;
    scrollTo({ top: 0 });
    if (!feed || inflight) return;
    inflight = true;
    pending.delete(tab);
    showPill();
    setNavBusy('home', true);
    try {
      // Explicit refreshes tell X it's a pull to refresh (x.com sends "ptr").
      const page = shape(tab, await get('/home', { tab: xTab(tab), seen: seenParam(xTab(tab)), ctx: 'ptr' }));
      feed.prepend(page.items);
    } catch {
      toast("Couldn't refresh.");
    } finally {
      inflight = false;
      setNavBusy('home', false);
    }
  }

  /** Background check: only shows the "New posts" pill, never touches the feed. */
  async function peek() {
    const tab = tf.cur;
    const feed = tf.feed;
    if (!feed || inflight) return;
    try {
      const page = shape(tab, await get('/home', { tab: xTab(tab), seen: seenParam(xTab(tab)) }));
      if (inflight) return;
      const fresh = feed.unseen(page.items).filter((i) => i.type === 'tweet');
      if (!fresh.length) return;
      pending.set(tab, fresh.slice(0, 3).map((i) => (i.type === 'tweet' ? i.tweet.user.avatar : '')));
      if (tab === tf.cur) showPill();
    } catch {
      /* silent: background check */
    }
  }

  pill.addEventListener('click', () => void refresh());

  // Pull to refresh (native one is disabled via overscroll-behavior).
  let y0 = -1;
  let dy = 0;
  s.el.addEventListener(
    'touchstart',
    (e) => {
      y0 = scrollY <= 0 ? e.touches[0].clientY : -1;
      dy = 0;
    },
    { passive: true },
  );
  s.el.addEventListener(
    'touchmove',
    (e) => {
      if (y0 < 0) return;
      dy = Math.max(0, Math.min(120, e.touches[0].clientY - y0));
      ptr.style.transform = `translateY(${dy - 60}px)`;
      ptr.style.opacity = String(Math.min(1, dy / 70));
    },
    { passive: true },
  );
  s.el.addEventListener('touchend', async () => {
    if (y0 < 0) return;
    y0 = -1;
    if (dy > 70) {
      ptr.classList.add('busy');
      await refresh();
      ptr.classList.remove('busy');
    }
    ptr.style.transform = '';
    ptr.style.opacity = '0';
  });

  let timer = 0;
  const poll = () => {
    clearInterval(timer);
    timer = window.setInterval(() => document.visibilityState === 'visible' && peek(), POLL_MS);
  };

  return {
    el: s.el,
    title: 'Home',
    tab: 'home',
    show() {
      tf.resume();
      const b = s.bar.querySelector('[data-act="menu"]');
      if (b) b.outerHTML = avatar();
      poll();
    },
    hide() {
      tf.pause();
      clearInterval(timer);
    },
    reselect() {
      void refresh();
    },
  };
}
