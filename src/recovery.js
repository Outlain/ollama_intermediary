import http from 'node:http';
import { once } from 'node:events';
import { parseListen } from './config.js';
import { sendJson } from './http-utils.js';
import { requestId } from './logger.js';

export class RecoveryService {
  constructor({
    listen = '0.0.0.0:11434',
    settingsController,
    logger,
  } = {}) {
    this.listen = listen;
    this.settingsController = settingsController;
    this.logger = logger;
    this.server = null;
    this.running = false;
  }

  async start() {
    if (this.running) return this.address();
    const { host, port } = parseListen(this.listen);
    this.server = http.createServer((request, response) => {
      this.handle(request, response).catch((error) => {
        this.logger?.error('unhandled configuration recovery request error', { error: error.stack ?? error.message });
        sendJson(response, 500, { error: 'configuration recovery request failed', code: 'recovery_error' }, requestId(request.headers));
      });
    });
    this.server.requestTimeout = 0;
    this.server.headersTimeout = 60_000;
    this.server.keepAliveTimeout = 65_000;
    this.server.listen(port, host);
    await once(this.server, 'listening');
    this.running = true;
    this.logger?.warn('configuration recovery listener started', {
      address: this.server.address(),
      settings_path: '/settings',
    });
    return this.address();
  }

  address() {
    return this.server?.address() ?? null;
  }

  async handle(request, response) {
    const id = requestId(request.headers);
    response.setHeader('x-request-id', id);
    const url = new URL(request.url, 'http://recovery.local');
    if (this.settingsController?.handles(url.pathname)) {
      return this.settingsController.handle(request, response, url, id);
    }
    if (request.method === 'GET' && url.pathname === '/healthz') {
      return sendJson(response, 200, {
        status: 'ok',
        mode: 'configuration_error',
        settings_path: '/settings',
      }, id);
    }
    if (request.method === 'GET' && (url.pathname === '/readyz' || url.pathname === '/status')) {
      return sendJson(response, 503, {
        status: 'not_ready',
        mode: 'configuration_error',
        code: 'configuration_invalid',
        settings_path: '/settings',
      }, id);
    }
    response.setHeader('retry-after', '30');
    return sendJson(response, 503, {
      error: 'The intermediary configuration is invalid. Open /settings to repair safe settings.',
      code: 'configuration_invalid',
      settings_path: '/settings',
    }, id);
  }

  async stop() {
    if (!this.server || !this.running) return;
    this.running = false;
    const closed = once(this.server, 'close').catch(() => {});
    this.server.close();
    this.server.closeAllConnections?.();
    await closed;
    this.logger?.info('configuration recovery listener stopped');
  }
}
