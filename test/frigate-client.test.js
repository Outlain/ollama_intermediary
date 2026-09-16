import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { FrigateClient, FrigateError } from '../src/frigate-client.js';

async function server(t, handle, settings = {}) {
  const requests = [];
  const listener = http.createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    requests.push({ method: request.method, url: request.url, headers: request.headers, body });
    handle(request, response, body);
  });
  listener.listen(0, '127.0.0.1');
  await once(listener, 'listening');
  const client = new FrigateClient({ url: `http://127.0.0.1:${listener.address().port}`, requestTimeoutMs: 500, ...settings });
  t.after(async () => {
    client.close();
    const closed = once(listener, 'close');
    listener.close();
    listener.closeAllConnections?.();
    await closed;
  });
  return { client, requests, listener };
}

const json = (response, body, code = 200) => {
  response.writeHead(code, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
};

test('Frigate capabilities inspect schema without mutation probes', async (t) => {
  const { client, requests } = await server(t, (request, response) => json(response, {
    paths: {
      '/events/{event_id}/description/regenerate': { put: {} },
      '/review/{review_id}/regenerate_description': { put: {} },
    },
  }));
  assert.deepEqual(await client.capabilities(), { object: true, review: true });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].method, 'GET');
  assert.equal(requests[0].url, '/api/openapi.json');
  assert.equal(requests[0].headers['x-cache-bypass'], '1');
});

test('Frigate native generation uses PUT for objects and reviews and never force enables', async (t) => {
  const { client, requests } = await server(t, (request, response) => json(response, { success: true }, request.url.includes('/review/') ? 202 : 200));
  assert.deepEqual(await client.regenerate('object', 'event-1', 'snapshot'), { accepted: true });
  assert.deepEqual(await client.regenerate('review', 'review-1', 'recordings'), { accepted: true });
  assert.deepEqual(requests.map((request) => [request.method, request.url]), [
    ['PUT', '/api/events/event-1/description/regenerate?source=snapshot&force=false'],
    ['PUT', '/api/review/review-1/regenerate_description'],
  ]);
});

test('Frigate login uses native user/password body, cookie and one refresh after 401', async (t) => {
  let loginCount = 0;
  let getCount = 0;
  const { client, requests } = await server(t, (request, response) => {
    if (request.url === '/api/login') {
      loginCount += 1;
      response.writeHead(200, { 'set-cookie': `frigate_token=token-${loginCount}; HttpOnly; Path=/` });
      response.end();
    } else if (getCount++ === 0) json(response, { error: 'expired' }, 401);
    else json(response, { cameras: {} });
  }, { username: 'test-user', password: 'test-password' });
  assert.deepEqual(await client.getConfig(), { cameras: {} });
  assert.equal(loginCount, 2);
  assert.deepEqual(JSON.parse(requests[0].body), { user: 'test-user', password: 'test-password' });
  assert.equal(requests[1].headers.cookie, 'frigate_token=token-1');
  assert.equal(requests[3].headers.cookie, 'frigate_token=token-2');
});

test('explicit bearer authentication never performs password login', async (t) => {
  const { client, requests } = await server(t, (request, response) => json(response, {}), {
    username: 'unused', password: 'unused', auth_token: 'token-value',
  });
  await client.getConfig();
  assert.equal(requests.length, 1);
  assert.equal(requests[0].headers.authorization, 'Bearer token-value');
});

test('request errors do not expose response bodies, URL or credentials', async (t) => {
  const { client } = await server(t, (request, response) => json(response, { error: 'PRIVATE_CAMERA_PASSWORD' }, 503));
  await assert.rejects(client.getConfig(), (error) => {
    assert.equal(error.code, 'http_503');
    assert.equal(error.statusCode, 503);
    assert.doesNotMatch(String(error), /PRIVATE|127\.0\.0\.1/);
    return true;
  });
});

test('redirects are rejected, never followed with an authorization token', async (t) => {
  const { client, requests } = await server(t, (request, response) => {
    response.writeHead(302, { location: 'http://another-host.test/' });
    response.end();
  }, { auth_token: 'sensitive-token' });
  await assert.rejects(client.getConfig(), { code: 'http_302' });
  assert.equal(requests.length, 1);
});

test('retained media preflight checks thumbnail and snapshot without storing image data', async (t) => {
  const { client, requests } = await server(t, (request, response) => {
    response.setHeader('content-type', 'image/jpeg');
    response.end('IMAGE_DATA');
  });
  assert.equal(await client.hasMedia('object', { id: 'x', has_snapshot: true }, 'snapshot'), true);
  assert.deepEqual(requests.map((request) => request.url), ['/api/events/x/thumbnail.jpg', '/api/events/x/snapshot.jpg']);
});

test('missing media returns false; authentication failure is not mistaken for expired footage', async (t) => {
  let code = 404;
  const { client } = await server(t, (request, response) => json(response, {}, code));
  assert.equal(await client.hasMedia('object', { id: 'x' }, 'thumbnails'), false);
  code = 403;
  await assert.rejects(client.hasMedia('object', { id: 'x' }, 'thumbnails'), { code: 'authentication_failed' });
});

test('review media preflight requires overlapping main-stream recordings', async (t) => {
  let recordings = [{ start_time: 100, end_time: 110 }];
  const { client, requests } = await server(t, (request, response) => json(response, recordings));
  const item = { camera: 'yard', start_time: 105, end_time: 115 };
  assert.equal(await client.hasMedia('review', item, 'recordings'), true);
  assert.equal(requests[0].url, '/api/yard/recordings?after=105&before=115');
  recordings = [];
  assert.equal(await client.hasMedia('review', item, 'recordings'), false);
});

test('metadata request timeout is bounded and client can cancel outstanding work', async (t) => {
  const { client } = await server(t, () => {}, { requestTimeoutMs: 20 });
  await assert.rejects(client.getConfig(), { code: 'request_timeout' });
  const outstanding = client.getConfig();
  client.close();
  await assert.rejects(outstanding, { code: 'stopped' });
});

test('TLS certificates are verified by default, explicit opt-out is scoped to this client', () => {
  const verified = new FrigateClient({ url: 'https://frigate.test' });
  const unverified = new FrigateClient({ url: 'https://frigate.test', verify_tls: false });
  assert.equal(verified.httpsAgent.options.rejectUnauthorized, true);
  assert.equal(unverified.httpsAgent.options.rejectUnauthorized, false);
  verified.close();
  unverified.close();
  assert.throws(() => new FrigateClient({ url: 'https://user:password@frigate.test' }), FrigateError);
});

test('invalid list, event and schema payloads are not treated as success', async (t) => {
  const { client } = await server(t, (request, response) => json(response, { success: false }));
  await assert.rejects(client.list('object', {}), { code: 'invalid_event_list' });
  await assert.rejects(client.get('object', 'id'), { code: 'invalid_event_response' });
  await assert.rejects(client.capabilities(), { code: 'invalid_api_schema' });
  await assert.rejects(client.regenerate('object', 'id', 'snapshot'), { code: 'generation_not_accepted' });
});
