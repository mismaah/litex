import type { Tweet } from '../../shared/types';
import { compose, uploadMedia } from './api';
import { icon } from './icons';
import { quoteHtml } from './render/tweet';
import { closeOverlay, pushOverlay } from './router';
import { me } from './store';
import { esc, h, toast } from './util';

const MAX_IMAGES = 4;
const LIMIT = 280;

/** Downscale big photos client-side before upload (saves data and time on mobile). */
async function prepare(file: File): Promise<Blob> {
  if (file.type === 'image/gif' || file.size < 400_000) return file;
  try {
    const bmp = await createImageBitmap(file);
    const scale = Math.min(1, 2048 / Math.max(bmp.width, bmp.height));
    const c = document.createElement('canvas');
    c.width = Math.round(bmp.width * scale);
    c.height = Math.round(bmp.height * scale);
    c.getContext('2d')!.drawImage(bmp, 0, 0, c.width, c.height);
    bmp.close();
    return await new Promise<Blob>((ok, no) => c.toBlob((b) => (b ? ok(b) : no(new Error('encode'))), 'image/jpeg', 0.86));
  } catch {
    return file;
  }
}

export function openCompose(o: { replyTo?: Tweet; quote?: Tweet } = {}) {
  const files: { file: File; url: string }[] = [];
  const el = h('div', 'compose');
  const u = me();
  el.innerHTML = `<div class="cbar"><button class="ib" data-x aria-label="Close">${icon('x')}</button><button class="post" data-post disabled>${o.replyTo ? 'Reply' : 'Post'}</button></div>
<div class="cbody">${o.replyTo ? `<div class="crep">Replying to <b>@${esc(o.replyTo.user.sn)}</b></div>` : ''}
<div class="crow">${u ? `<img class="cav" src="${esc(u.avatar)}" alt="" width="40" height="40">` : ''}<textarea placeholder="${o.replyTo ? 'Post your reply' : o.quote ? 'Add a comment' : "What's happening?"}" maxlength="25000"></textarea></div>
<div class="cimgs"></div>${o.quote ? quoteHtml(o.quote) : ''}</div>
<div class="ctool"><label class="ib" aria-label="Add photos">${icon('image')}<input type="file" accept="image/jpeg,image/png,image/webp,image/gif" multiple hidden></label><span class="ccount"></span></div>`;
  document.body.append(el);
  document.documentElement.classList.add('locked');
  const ta = el.querySelector('textarea')!;
  const postBtn = el.querySelector<HTMLButtonElement>('[data-post]')!;
  const imgs = el.querySelector<HTMLElement>('.cimgs')!;
  const count = el.querySelector<HTMLElement>('.ccount')!;
  const input = el.querySelector<HTMLInputElement>('input[type=file]')!;
  let busy = false;

  const update = () => {
    const n = [...ta.value].length;
    count.textContent = n > LIMIT - 40 ? String(LIMIT - n) : '';
    count.classList.toggle('over', n > LIMIT);
    postBtn.disabled = busy || (!ta.value.trim() && !files.length);
    ta.style.height = 'auto';
    ta.style.height = ta.scrollHeight + 'px';
  };
  const renderImgs = () => {
    imgs.className = `cimgs n${files.length}`;
    imgs.innerHTML = files.map((f, i) => `<div><img src="${f.url}" alt=""><button data-rm="${i}" aria-label="Remove">${icon('x')}</button></div>`).join('');
    update();
  };
  ta.addEventListener('input', update);
  input.addEventListener('change', () => {
    for (const f of input.files || []) {
      if (files.length >= MAX_IMAGES) break;
      files.push({ file: f, url: URL.createObjectURL(f) });
    }
    input.value = '';
    renderImgs();
  });
  imgs.addEventListener('click', (e) => {
    const b = (e.target as Element).closest<HTMLElement>('[data-rm]');
    if (!b) return;
    const [f] = files.splice(Number(b.dataset.rm), 1);
    URL.revokeObjectURL(f.url);
    renderImgs();
  });
  el.querySelector('[data-x]')!.addEventListener('click', () => closeOverlay());
  postBtn.addEventListener('click', async () => {
    busy = true;
    update();
    postBtn.textContent = 'Posting…';
    try {
      const mediaIds = [];
      for (const f of files) mediaIds.push(await uploadMedia(await prepare(f.file)));
      const r = await compose({
        text: ta.value,
        replyTo: o.replyTo?.id,
        quote: o.quote ? `https://x.com/${o.quote.user.sn}/status/${o.quote.id}` : undefined,
        mediaIds,
      });
      if (o.replyTo) {
        o.replyTo.replies++;
      }
      closeOverlay();
      toast(r.tweet ? 'Your post was sent.' : 'Posted.');
    } catch (e) {
      toast((e as Error).message || 'Could not post');
      busy = false;
      postBtn.textContent = o.replyTo ? 'Reply' : 'Post';
      update();
    }
  });
  pushOverlay(() => {
    for (const f of files) URL.revokeObjectURL(f.url);
    el.remove();
    document.documentElement.classList.remove('locked');
  });
  update();
  setTimeout(() => ta.focus(), 50);
}
