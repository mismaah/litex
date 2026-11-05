import type { Page, Tweet } from '../../shared/types';

export class ApiError extends Error {
  constructor(
    msg: string,
    public status: number,
  ) {
    super(msg);
  }
}

let onAuthLost: () => void = () => {};
export const setAuthLost = (fn: () => void) => (onAuthLost = fn);

async function req<T>(method: string, path: string, body?: BodyInit, json = true): Promise<T> {
  const headers: Record<string, string> = { 'x-litex': '1' };
  if (body && json) headers['content-type'] = 'application/json';
  let res: Response;
  try {
    res = await fetch('/api' + path, { method, body, headers, credentials: 'same-origin' });
  } catch {
    throw new ApiError('Network error. Check your connection.', 0);
  }
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && data.error === 'auth') onAuthLost();
  if (!res.ok) throw new ApiError(data.error || `Error ${res.status}`, res.status);
  return data as T;
}

export const get = <T = Page>(path: string, params: Record<string, string | undefined> = {}) => {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v) qs.set(k, v);
  const s = qs.toString();
  return req<T>('GET', path + (s ? '?' + s : ''));
};
export const post = <T = { ok: true }>(path: string, body?: unknown) => req<T>('POST', path, body === undefined ? undefined : JSON.stringify(body));

export async function uploadMedia(blob: Blob): Promise<string> {
  const fd = new FormData();
  fd.append('file', blob, 'image');
  const r = await req<{ id: string }>('POST', '/media', fd, false);
  return r.id;
}

export const compose = (b: { text: string; replyTo?: string; quote?: string; mediaIds?: string[] }) => post<{ tweet: Tweet | null }>('/compose', b);
