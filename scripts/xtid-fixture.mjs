// Regenerates server/xtid/testdata from a fresh logged-out X page, using the reference JS
// library (x-client-transaction-id, a devDependency). The Go test then checks the Go port against it.
// Run after X changes something, or when updating the library: npm run xtid:fixture
if (!ArrayBuffer.prototype.transfer) {
  ArrayBuffer.prototype.transfer = function (n = this.byteLength) {
    const o = new ArrayBuffer(n);
    new Uint8Array(o).set(new Uint8Array(this, 0, Math.min(n, this.byteLength)));
    return o;
  };
}
import fs from 'node:fs';
import { ClientTransaction } from 'x-client-transaction-id';
import { parseHTML } from 'linkedom';

const dir = 'server/xtid/testdata';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36';
const html = await (await fetch('https://x.com/i/jf/', { headers: { 'user-agent': UA } })).text();

// Capture the ondemand.s script the library downloads, so the Go test can run offline.
let ondemand = '';
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  const res = await realFetch(url, init);
  if (String(url).includes('ondemand.s')) ondemand = await res.clone().text();
  return res;
};
const t = await ClientTransaction.create(parseHTML(html).document);
globalThis.fetch = realFetch;

const cases = [];
const paths = ['/i/api/graphql/qpemjmVMoTWDvcRT43JIVQ/TweetDetail', '/i/api/graphql/fedFLLzmiCAuzPgA8lyh8Q/HomeTimeline', '/i/api/1.1/account/settings.json', '/i/media/upload.json'];
let k = 0;
for (const method of ['GET', 'POST'])
  for (const path of paths)
    for (const time of [1, 123456789, 220000000]) {
      const rnd = (k++ * 37) % 256;
      const orig = Math.random;
      Math.random = () => (rnd + 0.5) / 256; // fixes the random byte to rnd
      cases.push({ method, path, time, rnd, id: await t.generateTransactionId(method, path, undefined, undefined, undefined, time) });
      Math.random = orig;
    }

fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(`${dir}/page.html`, html);
fs.writeFileSync(`${dir}/ondemand.js`, ondemand);
fs.writeFileSync(`${dir}/expected.json`, JSON.stringify({ rowIndex: t.DEFAULT_ROW_INDEX, keyIndices: t.DEFAULT_KEY_BYTES_INDICES, keyBytes: t.keyBytes, animationKey: t.animationKey, cases }, null, 1) + '\n');
console.log(`wrote ${dir}: animation key ${t.animationKey}, ${cases.length} ids (ondemand ${ondemand.length} bytes)`);
