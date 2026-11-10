import './styles.css';
import type { User } from '../../shared/types';
import { ApiError, get, post, setAuthLost } from './api';
import { openCompose } from './compose';
import { icon } from './icons';
import { threadAction } from './feed/thread';
import { playVideo } from './media/video';
import { openSheet, openViewer } from './overlays';
import { refreshActions, refreshText } from './render/tweet';
import { goBack, navigate, route, startRouter, type View } from './router';
import { me, prefs, savePref, setMe, showOriginal, tweets, users, type Theme } from './store';
import { esc, h, quietUntil, toast } from './util';
import { exploreView, searchView } from './views/explore';
import { homeView } from './views/home';
import { followsView, profileView } from './views/profile';
import { bookmarksFeed, bookmarksView, listView, listsView, notificationsView } from './views/simple';
import { quotesView, tweetView } from './views/tweet';
import { shell } from './views/base';

// ---------- theme ----------
function applyTheme(t: Theme) {
  const root = document.documentElement;
  if (t === 'system') root.removeAttribute('data-theme');
  else root.dataset.theme = t;
  const dark = t === 'dark' || t === 'dim' || (t === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
  document.querySelector('meta[name=theme-color]')?.setAttribute('content', t === 'dim' ? '#15202b' : dark ? '#000000' : '#ffffff');
}
applyTheme(prefs.theme);
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => applyTheme(prefs.theme));

// ---------- routes ----------
const notAvailable = (what: string): View => {
  const s = shell({ back: true, title: what });
  s.body.innerHTML = `<div class="emp">${esc(what)} isn't available in litex.</div>`;
  return { el: s.el, title: what };
};

route(/^\/(home)?$/, () => homeView(), true);
route(/^\/explore\/?$/, () => exploreView(), true);
route(/^\/notifications(\/mentions)?\/?$/, () => notificationsView(), true);
route(/^\/i\/bookmarks\/?$|^\/bookmarks\/?$/, () => bookmarksView(), true);
route(/^\/search\/?$/, (_m, url) => searchView(url));
route(/^\/hashtag\/([^/]+)$/, (m) => searchView(new URL(`/search?q=${encodeURIComponent('#' + decodeURIComponent(m[1]))}`, location.origin)));
route(/^\/i\/lists\/(\d+)\/?$/, (m) => listView(m[1]));
route(/^\/(lists|\w{1,15}\/lists)\/?$/, () => listsView());
route(/^\/(messages|i\/grok|i\/premium\w*|i\/verified\w*|i\/communities.*|i\/jobs|i\/money.*|settings.*)/, (m) => notAvailable(m[1].split('/').pop() || 'This'));
route(/^\/(\w{1,15})\/status\/(\d+)\/quotes\/?$/, (m) => quotesView(m[2]));
route(/^\/(\w{1,15})\/status\/(\d+)/, (m) => tweetView(m[2]));
route(/^\/(\w{1,15})\/(followers|following|verified_followers)\/?$/, (m) => followsView(m[1], m[2] === 'following' ? 'following' : 'followers'));
route(/^\/(\w{1,15})(?:\/(with_replies|media|likes))?\/?$/, (m) => profileView(m[1], m[2]));
route(/./, () => notAvailable('Page'));

// ---------- bottom nav ----------
const nav = document.getElementById('nav')!;
function renderNav() {
  const u = me();
  // Labels only show in the wide desktop sidebar.
  nav.innerHTML = `<a href="/" data-tab="home" aria-label="Home">${icon('home')}<span class="nl">Home</span></a>
<a href="/explore" data-tab="explore" aria-label="Explore">${icon('search')}<span class="nl">Explore</span></a>
<a href="/notifications" data-tab="notifications" aria-label="Notifications">${icon('bell')}<span class="nl">Notifications</span></a>
<a href="/bookmarks" data-tab="bookmarks" aria-label="Bookmarks">${icon('bookmark')}<span class="nl">Bookmarks</span></a>
<a href="${u ? '/' + esc(u.sn) : '#'}" data-tab="me" aria-label="Profile">${u ? `<img src="${esc(u.avatar)}" alt="" width="26" height="26">` : icon('user')}<span class="nl">Profile</span></a>`;
}
function markNav(v: View) {
  for (const a of nav.querySelectorAll<HTMLElement>('[data-tab]')) a.classList.toggle('on', a.dataset.tab === v.tab);
}

// ---------- actions ----------
function tweetOf(el: Element) {
  const id = el.closest<HTMLElement>('[data-tid]')?.dataset.tid;
  return id ? tweets.get(id) : undefined;
}

async function toggle(t: NonNullable<ReturnType<typeof tweetOf>>, key: 'liked' | 'rted' | 'bookmarked', count: 'likes' | 'rts' | 'bookmarks', on: string, off: string) {
  const was = !!t[key];
  t[key] = !was;
  t[count] = Math.max(0, t[count] + (was ? -1 : 1));
  refreshActions(t);
  try {
    await post(`/tweet/${t.id}/${was ? off : on}`);
    return true;
  } catch (e) {
    t[key] = was;
    t[count] = Math.max(0, t[count] + (was ? 1 : -1));
    refreshActions(t);
    toast((e as Error).message);
    return false;
  }
}

async function share(t: NonNullable<ReturnType<typeof tweetOf>>) {
  const url = `https://x.com/${t.user.sn}/status/${t.id}`;
  try {
    if (navigator.share) return await navigator.share({ url });
    await navigator.clipboard.writeText(url);
    toast('Link copied');
  } catch {
    /* user cancelled */
  }
}

async function follow(btn: HTMLElement) {
  const u = users.get(btn.dataset.uid!);
  if (!u) return;
  const was = !!u.following;
  const set = (v: boolean) => {
    u.following = v;
    for (const b of document.querySelectorAll<HTMLElement>(`[data-act="follow"][data-uid="${u.id}"]`)) {
      b.classList.toggle('on', v);
      b.textContent = v ? 'Following' : 'Follow';
    }
  };
  if (was) {
    return openSheet([{ label: `Unfollow @${u.sn}`, danger: true, run: () => doFollow(u, false, set) }]);
  }
  doFollow(u, true, set);
}
async function doFollow(u: User, on: boolean, set: (v: boolean) => void) {
  set(on);
  try {
    await post(`/user/${u.id}/${on ? 'follow' : 'unfollow'}`);
  } catch (e) {
    set(!on);
    toast((e as Error).message);
  }
}

// ---------- install (PWA) ----------
// Chrome fires beforeinstallprompt only when the page is installable (HTTPS, manifest, service worker).
type InstallPrompt = Event & { prompt(): Promise<void>; userChoice: Promise<{ outcome: string }> };
let installPrompt: InstallPrompt | null = null;
addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  installPrompt = e as InstallPrompt;
});
addEventListener('appinstalled', () => {
  installPrompt = null;
  toast('litex installed');
});
const standalone = () => matchMedia('(display-mode: standalone)').matches || (navigator as { standalone?: boolean }).standalone === true;
async function install() {
  if (installPrompt) {
    const p = installPrompt;
    installPrompt = null; // a prompt can only be used once
    await p.prompt();
    return;
  }
  if (!isSecureContext) return toast('Open litex over HTTPS to install');
  const problems = await installProblems();
  if (!problems.length) return toast("Use your browser's menu → Install app / Add to Home screen");
  alert(`litex can't be installed from ${location.host}:\n\n- ${problems.join('\n- ')}`);
}

// Checks what Chrome checks, the way Chrome fetches it (the manifest request sends no cookies by
// default), so a proxy login page or a missing file shows up as a readable reason.
async function installProblems(): Promise<string[]> {
  const out: string[] = [];
  const check = async (url: string, wantType: string, creds: RequestCredentials) => {
    try {
      const r = await fetch(url, { credentials: creds, cache: 'no-store' });
      const type = r.headers.get('content-type') || '';
      if (r.redirected) out.push(`${url} redirects to ${new URL(r.url).host}${new URL(r.url).pathname} (a login proxy in front of litex?)`);
      else if (!r.ok) out.push(`${url} returns HTTP ${r.status}`);
      else if (!type.includes(wantType)) out.push(`${url} is served as "${type}" instead of ${wantType}`);
      else return r;
    } catch (e) {
      out.push(`${url} can't be fetched (${(e as Error).message})`);
    }
    return null;
  };
  const res = await check('/manifest.webmanifest', 'json', 'omit');
  if (res) {
    try {
      const m = (await res.json()) as { icons?: { src: string }[] };
      for (const ic of m.icons || []) await check(ic.src, 'image/', 'omit');
    } catch {
      out.push('/manifest.webmanifest is not valid JSON');
    }
  }
  const reg = await navigator.serviceWorker?.getRegistration().catch(() => undefined);
  if (!reg) out.push('the service worker is not registered');
  else if (!reg.active) out.push('the service worker is not active yet (reload the page)');
  return out;
}

function openMenu() {
  const u = me();
  const themes: Theme[] = ['system', 'light', 'dim', 'dark'];
  const next = themes[(themes.indexOf(prefs.theme) + 1) % themes.length];
  openSheet(
    [
      ...(u ? [{ label: 'Profile', icon: 'user', run: () => navigate('/' + u.sn) }] : []),
      { label: 'Lists', icon: 'list', run: () => navigate('/lists') },
      { label: 'Bookmarks', icon: 'bookmark', run: () => navigate('/bookmarks') },
      {
        label: `Theme: ${prefs.theme} → ${next}`,
        icon: 'settings',
        run: () => {
          savePref('theme', next);
          applyTheme(next);
        },
      },
      {
        label: `Autoplay GIFs: ${prefs.gifs ? 'on' : 'off'}`,
        icon: 'play',
        run: () => {
          savePref('gifs', !prefs.gifs);
          toast('Applies to newly loaded posts');
        },
      },
      {
        label: `Image quality: ${prefs.hq ? 'high' : 'data saver'}`,
        icon: 'image',
        run: () => {
          savePref('hq', !prefs.hq);
          toast('Applies to newly loaded posts');
        },
      },
      ...(standalone() ? [] : [{ label: 'Install app', icon: 'download', run: install }]),
      { label: 'Log out', icon: 'logout', danger: true, run: () => post('/logout').finally(() => location.reload()) },
    ],
    u ? `@${u.sn}` : undefined,
  );
}

function onAction(act: string, el: HTMLElement) {
  const t = tweetOf(el);
  switch (act) {
    case 'back':
      return goBack();
    case 'menu':
      return openMenu();
    case 'compose':
      return openCompose();
    case 'follow':
      return follow(el);
    case 'media':
      return t && openViewer(t, Number(el.dataset.i || 0));
    case 'play':
      return playVideo(el);
    case 'like':
      return t && toggle(t, 'liked', 'likes', 'like', 'unlike');
    case 'bm':
      if (!t) return;
      return toggle(t, 'bookmarked', 'bookmarks', 'bookmark', 'unbookmark').then((ok) => {
        if (!ok) return;
        toast(t.bookmarked ? 'Added to Bookmarks' : 'Removed from Bookmarks');
        if (!t.bookmarked) bookmarksFeed?.removeWhere((it) => it.type === 'tweet' && it.tweet.id === t.id);
      });
    case 'rt':
      if (!t) return;
      return openSheet([
        { label: t.rted ? 'Undo repost' : 'Repost', icon: 'rt', run: () => toggle(t, 'rted', 'rts', 'rt', 'unrt') },
        { label: 'Quote', icon: 'quote', run: () => openCompose({ quote: t }) },
      ]);
    case 'reply':
      return t && openCompose({ replyTo: t });
    case 'share':
      return t && share(t);
    case 'thread':
      return threadAction(el);
    case 'orig':
      if (!t) return;
      if (!showOriginal.delete(t.id)) showOriginal.add(t.id);
      return refreshText(t);
  }
}

document.addEventListener('click', (e) => {
  if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey) return;
  const target = e.target as Element;
  const act = target.closest<HTMLElement>('[data-act]');
  if (act) {
    e.preventDefault();
    onAction(act.dataset.act!, act);
    return;
  }
  const a = target.closest<HTMLAnchorElement>('a[href]');
  if (a) {
    if (a.target === '_blank' || a.origin !== location.origin || a.getAttribute('href') === '#') return;
    e.preventDefault();
    navigate(a.pathname + a.search);
    return;
  }
  // Tap anywhere on a post/cell opens it (unless selecting text).
  const card = target.closest<HTMLElement>('[data-href]');
  if (card && !getSelection()?.toString()) navigate(card.dataset.href!);
});

// ---------- hide header on scroll down ----------
let lastY = scrollY;
let ticking = false;
addEventListener(
  'scroll',
  () => {
    if (ticking) return;
    ticking = true;
    requestAnimationFrame(() => {
      const y = scrollY;
      if (performance.now() < quietUntil) lastY = y;
      else if (Math.abs(y - lastY) > 6) {
        document.body.classList.toggle('bars-hidden', y > lastY && y > 120);
        lastY = y;
      }
      ticking = false;
    });
  },
  { passive: true },
);

// ---------- boot ----------
function loginScreen(msg = '') {
  const app = document.getElementById('app')!;
  nav.hidden = true;
  document.getElementById('fab')!.hidden = true;
  app.innerHTML = `<form class="login"><div class="logo big">litex</div><p>Enter the password for this litex server.</p>
<input type="password" name="password" autocomplete="current-password" placeholder="Password" required>
<button type="submit">Log in</button><div class="lerr">${esc(msg)}</div></form>`;
  const form = app.querySelector('form')!;
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = form.querySelector('button')!;
    btn.disabled = true;
    try {
      await post('/login', { password: (form.password as HTMLInputElement).value });
      location.reload();
    } catch (err) {
      form.querySelector('.lerr')!.textContent = (err as Error).message;
      btn.disabled = false;
    }
  });
}

async function boot() {
  let status: { authed: boolean; mock: boolean; session: boolean };
  try {
    status = await get('/status');
  } catch {
    document.getElementById('app')!.innerHTML = `<div class="emp">Can't reach the litex server.</div>`;
    return;
  }
  if (!status.authed) return loginScreen();
  setAuthLost(() => loginScreen('Session expired. Log in again.'));
  const app = document.getElementById('app')!;
  app.textContent = '';
  if (!status.session) app.before(h('div', 'banner', 'The server has no X session configured. Set X_AUTH_TOKEN and X_CT0.'));
  renderNav();
  const fab = document.getElementById('fab')!;
  fab.innerHTML = icon('pen');
  fab.hidden = false;
  try {
    setMe(await get<User>('/me'));
    renderNav();
  } catch (e) {
    if (e instanceof ApiError && e.status !== 401) toast(e.message);
  }
  startRouter(app, (v) => {
    markNav(v);
    fab.hidden = !!v.noFab;
    document.body.classList.remove('bars-hidden');
  });
}

boot();

if ('serviceWorker' in navigator && isSecureContext) {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}
