import { authorized } from './observability.js';
import { readBody, sendJson } from './http-utils.js';

const PREFIX = '/_intermediary/v1/frigate';

export class FrigateController {
  constructor({ catchup, readToken = '', controlToken = '' }) {
    this.catchup = catchup;
    this.readToken = readToken;
    this.controlToken = controlToken;
  }

  handles(pathname) {
    return pathname === PREFIX || pathname.startsWith(`${PREFIX}/`);
  }

  async handle(request, response, url, id) {
    response.setHeader('cache-control', 'no-store');
    if (request.method === 'GET' && [PREFIX, `${PREFIX}/status`, `${PREFIX}/jobs`].includes(url.pathname)) {
      if (!authorized(request, this.readToken) && !(this.controlToken && authorized(request, this.controlToken))) {
        return sendJson(response, 401, { error: 'Observability or settings token required.', code: 'unauthorized' }, id);
      }
      if (url.pathname === `${PREFIX}/jobs`) {
        const offset = Number(url.searchParams.get('offset') ?? 0);
        const limit = Number(url.searchParams.get('limit') ?? 30);
        if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 100) {
          return sendJson(response, 400, { error: 'offset must be a nonnegative integer; limit must be 1–100.', code: 'invalid_page' }, id);
        }
        return sendJson(response, 200, this.catchup.jobs({ offset, limit }), id);
      }
      return sendJson(response, 200, this.catchup.status(), id);
    }
    if (url.pathname !== `${PREFIX}/scan`) return sendJson(response, 404, { error: 'Unknown Frigate control route.' }, id);
    if (request.method !== 'POST') {
      response.setHeader('allow', 'POST');
      return sendJson(response, 405, { error: 'Use POST for a historical scan.' }, id);
    }
    if (!this.controlToken) return sendJson(response, 503, { error: 'Configure SETTINGS_TOKEN to use catch-up controls.', code: 'control_unavailable' }, id);
    if (!authorized(request, this.controlToken)) return sendJson(response, 401, { error: 'Settings token required.', code: 'unauthorized' }, id);
    if (!String(request.headers['content-type'] || '').toLowerCase().startsWith('application/json')) {
      return sendJson(response, 415, { error: 'Use application/json.' }, id);
    }
    let body;
    try { body = JSON.parse((await readBody(request, 4096)).toString('utf8')); }
    catch (error) { return sendJson(response, error.statusCode || 400, { error: 'Invalid JSON body.' }, id); }
    if (body?.confirm !== true) return sendJson(response, 400, { error: 'Set confirm:true to scan all retained eligible missing descriptions.' }, id);
    try {
      const status = await this.catchup.scanMissing();
      return sendJson(response, 202, { accepted: true, message: 'Historical discovery requested; descriptions run later when idle.', frigate: status }, id);
    } catch (error) {
      // Do not expose arbitrary upstream text, URLs, credentials, or payloads.
      const code = error.code || 'scan_unavailable';
      return sendJson(response, error.statusCode || error.status || 409, { error: 'The scan could not start. Check catch-up status.', code }, id);
    }
  }
}
