import type { Page } from '../../../shared/types';
import { get } from '../api';
import { Feed } from '../feed/feed';
import { icon } from '../icons';
import { itemHtml } from '../render/cells';
import type { View } from '../router';
import { me } from '../store';
import { esc, h } from '../util';
import { TabFeeds, onTab, shell } from './base';

const POLL_MS = 120_000;

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
    ],
    active: 'foryou',
    inlineTabs: true,
  });
  const ptr = h('div', 'ptr', '<div class="spin"></div>');
  const pill = h('button', 'pill');
  pill.hidden = true;
  s.el.append(pill);
  s.body.append(ptr);

  const pending = new Map<string, Page>();
  const tf = new TabFeeds(s.body, (tab) => new Feed({ load: (cursor) => get('/home', { tab, cursor }), render: itemHtml, dedupe: true }));
  tf.select('foryou');
  onTab(s.tabs!, (tab) => {
    pill.hidden = true;
    tf.select(tab);
  });

  async function checkNew(apply: boolean) {
    const tab = tf.cur;
    const feed = tf.feed;
    if (!feed) return;
    try {
      const page = await get('/home', { tab });
      if (tab !== tf.cur) return;
      if (apply) {
        feed.prepend(page.items);
        pill.hidden = true;
      } else {
        pending.set(tab, page);
        const fresh = page.items.filter((i) => i.type === 'tweet').slice(0, 3);
        if (fresh.length && scrollY > 400) {
          pill.innerHTML = `${icon('up')}${fresh.map((i) => (i.type === 'tweet' ? `<img src="${esc(i.tweet.user.avatar)}" alt="">` : '')).join('')}<span>New posts</span>`;
          pill.hidden = false;
        } else if (scrollY <= 400) {
          feed.prepend(page.items);
        }
      }
    } catch {
      /* silent: background check */
    }
  }

  pill.addEventListener('click', () => {
    const page = pending.get(tf.cur);
    if (page) tf.feed?.prepend(page.items);
    pending.delete(tf.cur);
    pill.hidden = true;
    scrollTo({ top: 0 });
  });

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
      await checkNew(true);
      ptr.classList.remove('busy');
    }
    ptr.style.transform = '';
    ptr.style.opacity = '0';
  });

  let timer = 0;
  const poll = () => {
    clearInterval(timer);
    timer = window.setInterval(() => document.visibilityState === 'visible' && checkNew(false), POLL_MS);
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
      if (scrollY > 0) scrollTo({ top: 0 });
      else checkNew(true);
    },
  };
}
