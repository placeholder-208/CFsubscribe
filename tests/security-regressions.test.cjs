const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHash, webcrypto } = require('node:crypto');

const workerPath = process.env.EDGETUNNEL_TEST_SOURCE || path.join(__dirname, '..', '_worker.js');
const source = fs.readFileSync(workerPath, 'utf8');
const UUID = '11111111-1111-4111-8111-111111111111';
const encoder = new TextEncoder();
const bytes = text => encoder.encode(text);
const proxy = { hostname: 'proxy.example', port: 8080 };
// Workers supports MD5 in WebCrypto; Node only exposes it via createHash.
const cfCrypto = {
  getRandomValues: array => webcrypto.getRandomValues(array),
  subtle: { digest: async (algorithm, data) => algorithm === 'MD5'
    ? Uint8Array.from(createHash('md5').update(data).digest()).buffer
    : webcrypto.subtle.digest(algorithm, data) },
};
function loadWorker({ connect = () => { throw new Error('Unexpected TCP connection'); }, fetch = async () => { throw new Error('Unexpected fetch'); } } = {}) {
  const code = source.replace(/^import \{ connect \} from 'cloudflare:sockets';\s*$/m, '').replace('export default {', 'const worker = {');
  return new Function('connect', 'fetch', 'crypto', `'use strict';\n${code}\nreturn {
    worker, socks5Connect, httpConnect, httpsConnect, 读取config_JSON, 创建请求TCP连接器, MD5MD5
  };`)(connect, fetch, cfCrypto);
}
function socket(chunks, options = {}) {
  const writes = [];
  let closed = false, cancelled = false;
  const result = {
    readable: new ReadableStream({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(Uint8Array.from(chunk));
        if (!options.keepOpen) controller.close();
      },
      cancel() { cancelled = true; },
    }),
    writable: new WritableStream({ write(chunk) { writes.push(Uint8Array.from(chunk)); } }),
    opened: options.opened || Promise.resolve(),
    closed: Promise.resolve(),
    async close() { closed = true; },
    writes,
    get wasClosed() { return closed; },
    get wasCancelled() { return cancelled; },
  };
  return result;
}
async function deadline(promise) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Operation stalled')), 1000); })]);
  } finally { clearTimeout(timer); }
}
async function readAll(stream) {
  const reader = stream.getReader();
  const chunks = [];
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) return Buffer.concat(chunks);
      chunks.push(Buffer.from(value));
    }
  } finally { reader.releaseLock(); }
}
function kv(initial = {}, beforeGet = async () => {}) {
  const data = new Map(Object.entries(initial));
  return { data, async get(key) { await beforeGet(key); return data.get(key) ?? null; }, async put(key, value) { data.set(key, value); } };
}
function request(url, options) {
  const req = new Request(url, options);
  req.cf = { colo: 'HKG', asn: 1, country: 'HK' };
  return req;
}
function context() {
  const tasks = [];
  return { tasks, waitUntil(task) { tasks.push(task); } };
}
async function authHeaders(api) {
  return { 'User-Agent': 'regression-test', Cookie: `auth=${await api.MD5MD5('regression-test' + '勿动此默认密钥，有需求请自行通过添加变量KEY进行修改' + 'test-admin')}` };
}

for (const atyp of [1, 3, 4]) {
  test(`SOCKS5 handles byte-by-byte replies, authentication and ATYP ${atyp}`, async () => {
    const api = loadWorker();
    const address = atyp === 1 ? [127, 0, 0, 1] : atyp === 3 ? [3, 97, 98, 99] : new Array(16).fill(0);
    const reply = [5, 2, 1, 0, 5, 0, 0, atyp, ...address, 0, 80];
    const upstream = socket([...reply.map(byte => [byte]), bytes('PAYLOAD')]);
    const result = await deadline(api.socks5Connect('example.com', 443, bytes('CLIENT'), () => upstream, { ...proxy, username: 'u', password: 'p' }));
    assert.equal((await readAll(result.readable)).toString(), 'PAYLOAD');
    assert.deepEqual([...upstream.writes[1]], [1, 1, 117, 1, 112]);
    assert.equal(Buffer.from(upstream.writes.at(-1)).toString(), 'CLIENT');
  });
}
test('SOCKS5 preserves payload coalesced with the CONNECT reply', async () => {
  const api = loadWorker();
  const upstream = socket([[5, 0], [5, 0, 0, 1, 127, 0, 0, 1, 0, 80, ...bytes('FIRST')], bytes('SECOND')]);
  const result = await api.socks5Connect('example.com', 443, null, () => upstream, proxy);
  assert.equal((await readAll(result.readable)).toString(), 'FIRSTSECOND');
});
for (const reply of [[5, 0, 0, 1, 127], [5, 0, 0, 9], [4, 0, 0, 1, 127, 0, 0, 1, 0, 80], [5, 5, 0, 1]]) {
  test(`SOCKS5 rejects malformed/truncated reply ${reply.join(',')}`, async () => {
    const api = loadWorker();
    const upstream = socket([[5, 0], reply]);
    await assert.rejects(api.socks5Connect('example.com', 443, null, () => upstream, proxy), /S5/);
    assert.equal(upstream.wasClosed, true);
    assert.equal(upstream.readable.locked, false);
    assert.equal(upstream.writable.locked, false);
  });
}

test('HTTP CONNECT returns promptly and preserves coalesced and later payload', async () => {
  const api = loadWorker();
  const upstream = socket([bytes('HTTP/1.1 200 Connection established\r\n\r\nFIRST'), bytes('SECOND')]);
  const result = await deadline(api.httpConnect('example.com', 443, bytes('CLIENT'), false, () => upstream, proxy));
  assert.equal((await readAll(result.readable)).toString(), 'FIRSTSECOND');
  assert.equal(Buffer.from(upstream.writes.at(-1)).toString(), 'CLIENT');
});
test('HTTP CONNECT handles fragmented headers without a coalesced payload', async () => {
  const api = loadWorker();
  const upstream = socket([bytes('HTTP/1.1 200 OK\r'), bytes('\n\r'), bytes('\n'), bytes('BODY')]);
  const result = await deadline(api.httpConnect('example.com', 443, null, false, () => upstream, proxy));
  assert.equal((await readAll(result.readable)).toString(), 'BODY');
});
test('Cancelling a buffered tunnel cancels and closes the upstream', async () => {
  const api = loadWorker();
  const upstream = socket([bytes('HTTP/1.1 200 OK\r\n\r\nFIRST')], { keepOpen: true });
  const result = await deadline(api.httpConnect('example.com', 443, null, false, () => upstream, proxy));
  await result.readable.cancel('client disconnected');
  assert.equal(upstream.wasClosed, true);
  assert.equal(upstream.wasCancelled, true);
});
test('HTTP CONNECT rejects a header exceeding its size limit', async () => {
  const api = loadWorker();
  const upstream = socket([bytes('HTTP/1.1 200 OK\r\nX-Padding: ' + 'a'.repeat(8192) + '\r\n\r\n')]);
  await assert.rejects(api.httpConnect('example.com', 443, null, false, () => upstream, proxy), /响应头/);
  assert.equal(upstream.wasClosed, true);
});
for (const hostname of ['proxy.example', '192.0.2.10', '[2001:db8::1]']) {
  test(`HTTPS proxy ${hostname} fails closed before sending credentials when platform TLS fails`, async () => {
    const api = loadWorker();
    const upstream = socket([], { opened: Promise.reject(new Error('certificate verification failed')) });
    let calls = 0;
    await assert.rejects(api.httpsConnect('example.com', 443, bytes('SECRET_PAYLOAD'), (address, options) => {
      calls++;
      assert.equal(address.hostname, hostname);
      assert.equal(options.secureTransport, 'on');
      return upstream;
    }, { ...proxy, hostname, username: 'secret-user', password: 'secret-password' }), /certificate verification failed/);
    assert.equal(calls, 1);
    assert.equal(upstream.writes.length, 0);
    assert.equal(upstream.wasClosed, true);
  });
}
test('HTTPS proxy forwards CONNECT and payload after platform TLS succeeds', async () => {
  const api = loadWorker();
  const upstream = socket([bytes('HTTP/1.1 200 OK\r\n\r\nRESPONSE')]);
  const result = await deadline(api.httpsConnect('example.com', 443, bytes('CLIENT'), (_, options) => {
    assert.equal(options.secureTransport, 'on');
    return upstream;
  }, { ...proxy, username: 'u', password: 'p' }));
  assert.match(Buffer.from(upstream.writes[0]).toString(), /Proxy-Authorization: Basic dTpw\r\n/);
  assert.equal((await readAll(result.readable)).toString(), 'RESPONSE');
});

test('Concurrent admin requests retain their own configuration and hostname', async () => {
  const api = loadWorker();
  let release, reached;
  const gate = new Promise(resolve => { release = resolve; });
  const atGate = new Promise(resolve => { reached = resolve; });
  let first = true;
  const KV = kv({}, async key => {
    if (key === 'tg.json' && first) { first = false; reached(); await gate; }
  });
  const env = { ADMIN: 'test-admin', UUID, KV };
  const headers = await authHeaders(api);
  const ctxA = context(), ctxB = context();
  const promiseA = api.worker.fetch(request('https://a.example/admin/config.json', { headers }), env, ctxA);
  await deadline(atGate);
  const responseB = await api.worker.fetch(request('https://b.example/admin/config.json', { headers }), env, ctxB);
  release();
  const responseA = await promiseA;
  assert.equal((await responseA.json()).HOST, 'a.example');
  assert.equal((await responseB.json()).HOST, 'b.example');
  await Promise.all([...ctxA.tasks, ...ctxB.tasks]);
});
test('Legacy configuration gets missing nested defaults without overwriting stored settings', async () => {
  const api = loadWorker();
  const saved = JSON.stringify({ UUID, HOST: 'old.example', PATH: '/custom', 优选订阅生成: { SUBNAME: 'custom' } });
  const KV = kv({ 'config.json': saved });
  const config = await api.读取config_JSON({ KV }, 'worker.example', UUID);
  assert.equal(config.PATH, '/custom');
  assert.equal(config.优选订阅生成.SUBNAME, 'custom');
  assert.equal(config.优选订阅生成.本地IP库.随机数量, 16);
  assert.equal(config.订阅转换配置.SUBLIST, false);
  assert.equal(KV.data.get('config.json'), saved);
});
for (const saved of ['null', '[]', '{', JSON.stringify({ UUID, HOST: 'old.example', 反代: [] })]) {
  test(`Malformed stored config recovers in memory: ${saved}`, async () => {
    const api = loadWorker();
    const KV = kv({ 'config.json': saved });
    const config = await api.读取config_JSON({ KV }, 'worker.example', UUID);
    assert.equal(config.HOST, 'worker.example');
    assert.equal(config.订阅转换配置.SUBLIST, false);
    assert.equal(KV.data.get('config.json'), saved);
  });
}
for (const change of [{ 反代: null }, { SS: [] }, { HOSTS: 'example.com' }, { PATH: 123 }, { 订阅转换配置: { SUBLIST: 'false' } }, { 优选订阅生成: { 本地IP库: { 随机数量: -1 } } }]) {
  test(`Config save rejects invalid types/ranges: ${JSON.stringify(change)}`, async () => {
    const api = loadWorker();
    const existing = await api.读取config_JSON({ KV: kv() }, 'worker.example', UUID);
    existing.PATH = '/existing';
    const saved = JSON.stringify(existing);
    const KV = kv({ 'config.json': saved });
    const ctx = context();
    const response = await api.worker.fetch(request('https://worker.example/admin/config.json', {
      method: 'POST', headers: await authHeaders(api), body: JSON.stringify({ UUID, HOST: 'worker.example', ...change }),
    }), { ADMIN: 'test-admin', UUID, KV }, ctx);
    assert.equal(response.status, 400, await response.text());
    assert.equal(KV.data.get('config.json'), saved);
    await Promise.all(ctx.tasks);
  });
}
test('Config save normalizes a minimal valid config to a complete structure', async () => {
  const api = loadWorker();
  const KV = kv();
  const ctx = context();
  const response = await api.worker.fetch(request('https://worker.example/admin/config.json', {
    method: 'POST', headers: await authHeaders(api), body: JSON.stringify({ UUID, HOST: 'worker.example' }),
  }), { ADMIN: 'test-admin', UUID, KV }, ctx);
  assert.equal(response.status, 200);
  assert.equal(JSON.parse(KV.data.get('config.json')).订阅转换配置.SUBLIST, false);
  await Promise.all(ctx.tasks);
});

test('Camouflage origin receives presentation headers but no credentials or visitor identity', async () => {
  let captured;
  const api = loadWorker({ fetch: async (url, options) => { captured = { url, options }; return new Response('OK'); } });
  const headers = {
    Cookie: 'auth=SECRET', Authorization: 'Bearer SECRET', 'Proxy-Authorization': 'Basic SECRET',
    'X-Api-Key': 'SECRET', 'CF-Access-Jwt-Assertion': 'SECRET', 'CF-Connecting-IP': '192.0.2.1',
    Accept: 'text/html', 'Accept-Language': 'zh-CN', 'User-Agent': 'test-agent',
    Origin: 'https://worker.example', Referer: 'https://worker.example/sub?token=SECRET',
  };
  const response = await api.worker.fetch(request('https://worker.example/favicon.ico', { headers }), {
    ADMIN: 'test-admin', UUID, URL: 'https://camouflage.example',
  }, context());
  assert.equal(response.status, 200);
  assert.equal(captured.url, 'https://camouflage.example/favicon.ico');
  for (const name of ['Cookie', 'Authorization', 'Proxy-Authorization', 'X-Api-Key', 'CF-Access-Jwt-Assertion', 'CF-Connecting-IP']) assert.equal(captured.options.headers.has(name), false, name);
  assert.equal(captured.options.headers.get('Accept-Language'), 'zh-CN');
  assert.equal(captured.options.headers.get('User-Agent'), 'test-agent');
  assert.equal(captured.options.headers.get('Referer'), 'https://camouflage.example');
});
test('TCP connector retains the request fetcher receiver and falls back to official connect', () => {
  const fallback = () => 'fallback';
  const api = loadWorker({ connect: fallback });
  const fetcher = { connect(address) { assert.equal(this, fetcher); return address; } };
  assert.equal(api.创建请求TCP连接器({ fetcher })('address'), 'address');
  assert.equal(api.创建请求TCP连接器(new Request('https://example.com')), fallback);
});
test('Admin proxy probe uses HTTP port 80 and releases stream locks', async () => {
  const body = 'ip=192.0.2.5\nloc=HK\n';
  const upstream = socket([bytes('HTTP/1.1 200 OK\r\n\r\n'), bytes(`HTTP/1.1 200 OK\r\nContent-Length: ${body.length}\r\n\r\n${body}`)]);
  const api = loadWorker({ connect: () => upstream });
  const response = await api.worker.fetch(request('https://worker.example/admin/check?http=proxy.example:8080', {
    headers: await authHeaders(api),
  }), { ADMIN: 'test-admin', UUID, KV: kv() }, context());
  const result = await response.json();
  assert.equal(result.success, true, result.error);
  assert.equal(result.probe, 'http');
  assert.equal(result.ip, '192.0.2.5');
  assert.match(Buffer.from(upstream.writes[0]).toString(), /^CONNECT cloudflare.com:80 /);
  assert.match(Buffer.from(upstream.writes[1]).toString(), /^GET \/cdn-cgi\/trace /);
  assert.equal(upstream.wasClosed, true);
  assert.equal(upstream.readable.locked, false);
  assert.equal(upstream.writable.locked, false);
});

test('An explicitly empty ECH SNI from the admin UI remains null through save and load', async () => {
  const api = loadWorker();
  const KV = kv();
  const ctx = context();
  const response = await api.worker.fetch(request('https://worker.example/admin/config.json', {
    method: 'POST', headers: await authHeaders(api),
    body: JSON.stringify({ UUID, HOST: 'worker.example', PATH: '/ech', ECH: true, ECHConfig: { SNI: null } }),
  }), { ADMIN: 'test-admin', UUID, KV }, ctx);
  assert.equal(response.status, 200, await response.text());
  const loaded = await api.读取config_JSON({ KV }, 'worker.example', UUID);
  assert.equal(loaded.ECHConfig.SNI, null);
  assert.equal(loaded.PATH, '/ech');
  assert.equal(loaded.ECH, true);
  await Promise.all(ctx.tasks);
});
