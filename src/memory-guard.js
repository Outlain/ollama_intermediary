// Host MemAvailable, not container RSS and not physical GPU VRAM. This is
// admission headroom, not a promise that a request's unknown peak will fit.
export function memoryBlock(host, settings, { rescue = false } = {}) {
  if (!settings?.enabled) return null;
  if (host?.enabled !== true || host.stale !== false || host.bound !== true || host.memory?.available !== true) {
    return 'host_memory_unavailable';
  }
  const m = host.memory;
  const required = (rescue ? settings.rescue_min_available_mb : settings.min_available_mb) * 1024 ** 2;
  if (!Number.isFinite(m.available_bytes) || !Number.isFinite(m.total_bytes)
    || m.total_bytes <= 0 || m.available_bytes < 0 || m.available_bytes > m.total_bytes) return 'host_memory_unavailable';
  if (m.available_bytes < required) return 'host_memory_low';
  if (Number.isFinite(m.pressure_full_avg10) && m.pressure_full_avg10 >= settings.max_pressure_full_percent) {
    return 'host_memory_pressure';
  }
  // Swap occupancy alone is not a block: cold pages can stay swapped out
  // long after pressure ends. MemAvailable and PSI determine admission.
  return null;
}
