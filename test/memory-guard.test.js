import assert from 'node:assert/strict';
import test from 'node:test';
import { memoryBlock } from '../src/memory-guard.js';

const settings = { enabled: true, min_available_mb: 2048, rescue_min_available_mb: 4096, max_pressure_full_percent: 10 };
const host = () => ({ enabled: true, stale: false, bound: true,
  memory: { available: true, total_bytes: 30 * 1024 ** 3, available_bytes: 8 * 1024 ** 3,
    swap_total_bytes: 4 * 1024 ** 3, swap_used_bytes: 4 * 1024 ** 3, pressure_full_avg10: 0 } });

test('RAM headroom and active pressure block admission; occupied swap alone does not', () => {
  const h = host();
  assert.equal(memoryBlock(h, settings), null);
  h.memory.available_bytes = 3 * 1024 ** 3;
  assert.equal(memoryBlock(h, settings), null);
  assert.equal(memoryBlock(h, settings, { rescue: true }), 'host_memory_low');
  h.memory.available_bytes = 1024 ** 3;
  assert.equal(memoryBlock(h, settings), 'host_memory_low');
  h.memory.available_bytes = 8 * 1024 ** 3;
  h.memory.pressure_full_avg10 = 10;
  assert.equal(memoryBlock(h, settings), 'host_memory_pressure');
  h.memory.pressure_full_avg10 = null;
  assert.equal(memoryBlock(h, settings), null);
});

test('unknown, stale, wrong host and malformed RAM never become zero-risk readings', () => {
  for (const change of [h => { h.enabled = false; }, h => { h.stale = true; },
    h => { h.bound = false; }, h => { delete h.memory; }, h => { h.memory.available = false; },
    h => { h.memory.available_bytes = null; }, h => { h.memory.available_bytes = -1; },
    h => { h.memory.available_bytes = h.memory.total_bytes + 1; }]) {
    const h = host(); change(h);
    assert.equal(memoryBlock(h, settings), 'host_memory_unavailable');
    assert.equal(memoryBlock(h, { ...settings, enabled: false }), null);
  }
});
