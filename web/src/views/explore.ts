import { get } from '../api';
import { Feed } from '../feed/feed';
import { icon } from '../icons';
import { gridHtml, itemHtml } from '../render/cells';
import { navigate, type View } from '../router';
import { esc } from '../util';
import { TabFeeds, onTab, shell } from './base';

function searchBox(q = '') {
  return `<form class="sbox" role="search">${icon('search')}<input name="q" type="search" enterkeyhint="search" autocomplete="off" placeholder="Search" value="${esc(q)}"></form>`;
}

function wireSearch(root: HTMLElement, tab?: () => string) {
  root.querySelector('form.sbox')!.addEventListener('submit', (e) => {
    e.preventDefault();
    const input = (e.target as HTMLFormElement).q as HTMLInputElement;
    const q = input.value.trim();
    if (!q) return;
    input.blur();
    const t = tab?.();
    navigate(`/search?q=${encodeURIComponent(q)}${t && t !== 'top' ? `&f=${t}` : ''}`);
  });
}

export function exploreView(): View {
  const s = shell({
    center: searchBox(),
    tabs: [
      ['for_you', 'For you'],
      ['trending', 'Trending'],
      ['news', 'News'],
      ['sports', 'Sports'],
      ['entertainment', 'Entertainment'],
    ],
  });
  wireSearch(s.bar);
  const tf = new TabFeeds(s.body, (tab) => new Feed({ load: (cursor) => get('/explore', { tab, cursor }), render: itemHtml, dedupe: true, empty: 'Nothing trending right now.' }));
  tf.select('for_you');
  onTab(s.tabs!, (t) => tf.select(t));
  return { el: s.el, title: 'Explore', tab: 'explore', show: () => tf.resume(), hide: () => tf.pause(), reselect: () => scrollTo({ top: 0 }) };
}

const SEARCH_TABS: [string, string][] = [
  ['top', 'Top'],
  ['latest', 'Latest'],
  ['people', 'People'],
  ['media', 'Media'],
];
const F_ALIAS: Record<string, string> = { live: 'latest', user: 'people', image: 'media', video: 'media' };

export function searchView(url: URL): View {
  const q = url.searchParams.get('q') || '';
  const f = url.searchParams.get('f') || 'top';
  const initial = F_ALIAS[f] || (SEARCH_TABS.some(([id]) => id === f) ? f : 'top');
  const s = shell({ back: true, center: searchBox(q), tabs: SEARCH_TABS, active: initial });
  const tf = new TabFeeds(
    s.body,
    (tab) =>
      new Feed({
        load: (cursor) => get('/search', { q, tab, cursor }),
        render: tab === 'media' ? gridHtml : itemHtml,
        cls: tab === 'media' ? 'grid' : '',
        dedupe: true,
        empty: `No results for "${q}"`,
      }),
  );
  wireSearch(s.bar, () => tf.cur);
  tf.select(initial);
  onTab(s.tabs!, (t) => {
    tf.select(t);
    history.replaceState(history.state, '', `/search?q=${encodeURIComponent(q)}${t !== 'top' ? `&f=${t}` : ''}`);
  });
  return { el: s.el, title: q, tab: 'explore', show: () => tf.resume(), hide: () => tf.pause(), destroy: () => tf.destroy() };
}
