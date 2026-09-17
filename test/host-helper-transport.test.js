import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { once } from 'node:events';
import test from 'node:test';
import { HostHelperClient, HOST_PROTOCOL } from '../src/host-helper.js';
import { testConfig } from './helpers.js';

// Real HTTP over an isolated Unix socket. Never connects to a real helper,
// Ollama service, GPU, or privileged host command.
async function fixture(t, handler) {
  // Short prefix also keeps the socket below macOS's sockaddr_un path limit.
  const directory = fs.mkdtempSync('/tmp/oi-host-');
  const socketPath = path.join(directory, 'control.sock');
  const sockets = new Set();
  const handlerErrors = [];
  const server = http.createServer((request, response) => {
    Promise.resolve().then(() => handler(request, response)).catch((error) => {
      handlerErrors.push(error);
      response.destroy();
    });
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  const config = testConfig({ host_helper: { enabled: true, socket_path: socketPath } });
  const client = new HostHelperClient(config);
  t.after(async () => {
    client.stop();
    for (const socket of sockets) socket.destroy();
    if (server.listening) await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    fs.rmSync(socketPath, { force: true });
    fs.rmdirSync(directory);
    assert.deepEqual(handlerErrors, [], 'mock handler errors');
  });
  server.listen(socketPath);
  await once(server, 'listening');
  return { client, config, server, sockets };
}

function statusPayload(origin) {
  return { protocol: HOST_PROTOCOL, sampled_at: new Date().toISOString(), managed_ollama_origin: origin,
    service: { active: true, invocation_id: 'instance-before', kill_mode: 'control-group' },
    telemetry: { available: true, gpus: [{ id: '0', name: 'Mock AMD GPU', processes_known: true, processes: [],
      vram_total_bytes: 32 * 1024 ** 3, vram_used_bytes: 57 * 1024 ** 2, vram_free_bytes: 32 * 1024 ** 3 - 57 * 1024 ** 2,
      utilization_percent: 0, temperature_c: 29, power_w: 1 }] } };
}

function sendJson(response, value, status = 200) {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(value));
}

test('host transport reads status over its Unix socket and binds the configured Ollama origin', async (t) => {
  const requests = [];
  let origin = 'http://127.0.0.1:1';
  const { client } = await fixture(t, (request, response) => {
    requests.push({ method: request.method, path: request.url, authorization: request.headers.authorization });
    sendJson(response, statusPayload(origin));
  });
  const snapshot = await client.refresh();
  assert.equal(snapshot.available, true);
  assert.equal(snapshot.bound, true);
  assert.equal(snapshot.gpus[0].vram_used_bytes, 57 * 1024 ** 2);
  assert.deepEqual(requests, [{ method: 'GET', path: '/v1/status', authorization: undefined }]);
  origin = 'http://different-ollama.invalid:11434';
  const mismatch = await client.refresh();
  assert.equal(mismatch.available, false);
  assert.equal(mismatch.bound, false);
  assert.equal(mismatch.error, 'host_backend_mismatch');
});

test('host restart transport sends only the fixed endpoint and operation/incarnation JSON', async (t) => {
  const received = [];
  const { client } = await fixture(t, async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const raw = Buffer.concat(chunks);
    received.push({ method: request.method, path: request.url, contentType: request.headers['content-type'],
      contentLength: request.headers['content-length'], body: JSON.parse(raw.toString('utf8')), rawLength: raw.length,
      authorization: request.headers.authorization });
    sendJson(response, { operation_id: '00000000-0000-0000-0000-000000000001', state: 'completed', restarted: true });
  });
  const operation = '00000000-0000-0000-0000-000000000001';
  const result = await client.restart(operation, 'instance-before', { timeoutMs: 1000 });
  assert.equal(result.restarted, true);
  assert.equal(received.length, 1);
  assert.deepEqual(received[0].body, { operation_id: operation, expected_invocation_id: 'instance-before' });
  assert.equal(received[0].path, '/v1/ollama/restart');
  assert.equal(received[0].method, 'POST');
  assert.equal(received[0].contentType, 'application/json');
  assert.equal(Number(received[0].contentLength), received[0].rawLength);
  assert.equal(received[0].authorization, undefined);
});

test('host transport times out an accepted but unanswered HTTP request', async (t) => {
  let accepted;
  const entered = new Promise((resolve) => { accepted = resolve; });
  const { client } = await fixture(t, () => accepted());
  const result = assert.rejects(client.request('/v1/status', { timeoutMs: 100 }), { code: 'host_request_timeout' });
  await entered;
  await result;
});

test('host transport rejects malformed JSON without returning the response text', async (t) => {
  const privateText = 'private prompt token=this-must-not-appear';
  const { client } = await fixture(t, (_request, response) => response.end(privateText));
  await assert.rejects(client.request('/v1/status'), (error) => {
    assert.equal(error.code, 'host_response_invalid');
    assert.doesNotMatch(error.message, /private prompt|this-must-not-appear/);
    return true;
  });
  const snapshot = await client.refresh();
  assert.equal(snapshot.available, false);
  assert.equal(snapshot.error, 'host_response_invalid');
});

test('host transport enforces its response-size limit for valid oversized JSON', async (t) => {
  const { client } = await fixture(t, (_request, response) => sendJson(response, { private_data: 'x'.repeat(512 * 1024) }));
  await assert.rejects(client.request('/v1/status'), { code: 'host_response_too_large' });
});

test('host HTTP errors preserve only safe machine codes and never raw private details', async (t) => {
  const responses = [
    { error: 'restart_cooldown', private_detail: 'token=private-value' },
    { error: 'Command failed: token=private-value', message: 'a private host path' },
    { error: { code: 'private nested payload' } },
  ];
  const { client } = await fixture(t, (_request, response) => sendJson(response, responses.shift(), 503));
  for (const expected of ['restart_cooldown', 'host_http_503', 'host_http_503']) {
    await assert.rejects(client.request('/v1/status'), (error) => {
      assert.equal(error.code, expected);
      assert.equal(error.message, expected);
      assert.doesNotMatch(error.message, /private|token=|host path/);
      return true;
    });
  }
});

test('host transport rejects a truncated response rather than treating it as success', async (t) => {
  const { client } = await fixture(t, (_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json', 'content-length': '10000' });
    response.write('{"protocol":');
    setImmediate(() => response.destroy());
  });
  await assert.rejects(client.request('/v1/status'), { code: 'host_response_incomplete' });
});

test('caller abort cancels an in-flight restart request without exposing the abort reason', async (t) => {
  let accepted;
  const entered = new Promise((resolve) => { accepted = resolve; });
  const { client } = await fixture(t, () => accepted());
  const controller = new AbortController();
  const result = assert.rejects(client.restart('00000000-0000-0000-0000-000000000002', 'before', { timeoutMs: 1000, signal: controller.signal }),
    { code: 'host_request_aborted', message: 'host_request_aborted' });
  await entered;
  controller.abort(new Error('private caller abort details'));
  await result;
});

test('stopping the host client aborts in-flight reads and rejects future transport work', async (t) => {
  let accepted;
  const entered = new Promise((resolve) => { accepted = resolve; });
  const { client } = await fixture(t, () => accepted());
  const result = assert.rejects(client.request('/v1/status'), { code: 'host_request_aborted' });
  await entered;
  client.stop();
  await result;
  await assert.rejects(client.request('/v1/status'), { code: 'host_request_aborted' });
});
