import assert from 'node:assert/strict';
import test from 'node:test';
import { classifyEndpoint, isSafeMetadataEndpoint, isStreaming } from '../src/classifier.js';

test('all supported inference endpoints enter the generation gate', () => {
  for (const path of ['/api/generate', '/api/chat', '/api/embed', '/api/embeddings', '/v1/chat/completions', '/v1/completions', '/v1/responses', '/v1/embeddings']) {
    assert.equal(classifyEndpoint('POST', path), 'generation', path);
    assert.equal(isSafeMetadataEndpoint('POST', path), false, path);
    assert.equal(classifyEndpoint('GET', path), 'unknown', path);
  }
  assert.equal(isStreaming('/v1/responses', { stream: true }), true);
  assert.equal(isStreaming('/v1/completions', {}), false);
});

test('only harmless metadata endpoints bypass scheduling', () => {
  for (const [method, path] of [
    ['GET', '/'], ['HEAD', '/'], ['GET', '/api/tags'], ['GET', '/api/ps'], ['GET', '/api/version'],
    ['GET', '/v1/models'], ['GET', '/v1/models/test-model'], ['POST', '/api/show'], ['HEAD', `/api/blobs/sha256:${'a'.repeat(64)}`],
  ]) {
    assert.equal(classifyEndpoint(method, path), 'metadata', path);
    assert.equal(isSafeMetadataEndpoint(method, path), true, path);
  }
});

test('unknown or new compute endpoints cannot silently become metadata passthrough', () => {
  for (const [method, path] of [
    ['POST', '/v1/future-inference'], ['POST', '/api/new-generation'], ['GET', '/api/not-known'],
    ['POST', '/api/tags'], ['POST', '/api/chat/'], ['PUT', '/api/chat'], ['HEAD', '/api/blobs/not-a-digest'],
  ]) assert.equal(classifyEndpoint(method, path), 'unknown', path);
});

test('model mutation endpoints are explicitly classified as management', () => {
  for (const path of ['/api/pull', '/api/push', '/api/create', '/api/copy', `/api/blobs/sha256:${'b'.repeat(64)}`]) {
    assert.equal(classifyEndpoint('POST', path), 'management', path);
  }
  assert.equal(classifyEndpoint('DELETE', '/api/delete'), 'management');
  assert.equal(classifyEndpoint('GET', '/api/pull'), 'unknown');
});
