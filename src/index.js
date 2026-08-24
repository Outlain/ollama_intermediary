import process from 'node:process';
import { loadConfig } from './config.js';
import { Logger } from './logger.js';
import { ProxyService } from './proxy.js';

const logger = new Logger();
const configPath = process.env.CONFIG_PATH ?? '/app/config.yml';
let service;

try {
  const config = loadConfig(configPath);
  service = new ProxyService(config, { logger });
  await service.start();
} catch (error) {
  logger.error('proxy startup failed', { error: error.stack ?? error.message, config_path: configPath });
  if (service?.running) await service.stop(0).catch(() => {});
  process.exitCode = 1;
}

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown || !service) return;
  shuttingDown = true;
  logger.info('shutdown requested', { signal });
  try {
    await service.stop();
  } catch (error) {
    logger.error('graceful shutdown failed', { error: error.stack ?? error.message });
    process.exitCode = 1;
  }
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
