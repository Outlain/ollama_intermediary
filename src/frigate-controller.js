import { authorized } from './observability.js';
import { readBody, sendJson } from './http-utils.js';

const PREFIX = '/_intermediary/v1/frigate';
const VIEWS = new Set(['all', 'waiting', 'awaiting', 'retrying', 'attention', 'completed', 'skipped']);
const ACTIONS = new Map([
  [`${PREFIX}/refresh`, { method: 'refreshCapabilities', message: 'Frigate capabilities rechecked. Existing work and safety guards are unchanged.' }],
  [`${PREFIX}/scan`, { method: 'scanMissing', message: 'Historical discovery requested; descriptions run later when idle.' }],
  [`${PREFIX}/retry`, { method: 'retryJob', message: 'Retry queued; live priority, pause, and GPU safety still apply.' }],
  [`${PREFIX}/recheck`, { method: 'recheckJob', message: 'Availability recheck queued; saved descriptions and media will be checked before generation.' }],
]);
const ACTION_ERRORS = new Set([
  'job_not_found', 'job_not_retryable', 'job_not_recheckable', 'handoff_outstanding',
  'operation_in_progress', 'backlog_capacity_reached', 'catchup_unavailable',
  'capability_refresh_cooldown',
]);

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
    if (url.pathname === `${PREFIX}/attempt`) return this.handleAttempt(request, response, id);
    if (request.method === 'GET' && [PREFIX, `${PREFIX}/status`, `${PREFIX}/jobs`].includes(url.pathname)) {
      if (!authorized(request, this.readToken) && !(this.controlToken && authorized(request, this.controlToken))) {
        return sendJson(response, 401, { error: 'Observability or settings token required.', code: 'unauthorized' }, id);
      }
      if (url.pathname === `${PREFIX}/jobs`) {
        const offset = Number(url.searchParams.get('offset') ?? 0);
        const limit = Number(url.searchParams.get('limit') ?? 30);
        const view = url.searchParams.get('view') ?? 'all';
        if (!VIEWS.has(view)) {
          return sendJson(response, 400, { error: 'Unknown catch-up view.', code: 'invalid_view' }, id);
        }
        if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 100) {
          return sendJson(response, 400, { error: 'offset must be a nonnegative integer; limit must be 1–100.', code: 'invalid_page' }, id);
        }
        return sendJson(response, 200, this.catchup.jobs({ offset, limit, view }), id);
      }
      return sendJson(response, 200, this.catchup.status(), id);
    }
    const action = ACTIONS.get(url.pathname);
    if (!action) return sendJson(response, 404, { error: 'Unknown Frigate control route.' }, id);
    if (request.method !== 'POST') {
      response.setHeader('allow', 'POST');
      return sendJson(response, 405, { error: 'Use POST for catch-up controls.' }, id);
    }
    if (!this.controlToken) return sendJson(response, 503, { error: 'Configure SETTINGS_TOKEN to use catch-up controls.', code: 'control_unavailable' }, id);
    if (!authorized(request, this.controlToken)) return sendJson(response, 401, { error: 'Settings token required.', code: 'unauthorized' }, id);
    if (!String(request.headers['content-type'] || '').toLowerCase().startsWith('application/json')) {
      return sendJson(response, 415, { error: 'Use application/json.' }, id);
    }
    let body;
    try { body = JSON.parse((await readBody(request, 4096)).toString('utf8')); }
    catch (error) { return sendJson(response, error.statusCode || 400, { error: 'Invalid JSON body.' }, id); }
    if (body?.confirm !== true) return sendJson(response, 400, { error: 'Set confirm:true to request this catch-up action.' }, id);
    if (!['scanMissing', 'refreshCapabilities'].includes(action.method) && (!['object', 'review'].includes(body.kind)
      || typeof body.id !== 'string' || !body.id.trim() || body.id.length > 256 || /[\u0000-\u001f\u007f]/.test(body.id))) {
      return sendJson(response, 400, { error: 'Provide an object/review kind and a valid saved job ID.', code: 'invalid_job' }, id);
    }
    try {
      const status = await this.catchup[action.method](body.kind, body.id);
      return sendJson(response, 202, { accepted: true, message: action.message, frigate: status }, id);
    } catch (error) {
      // Do not expose arbitrary upstream text, URLs, credentials, or payloads.
      const code = ACTION_ERRORS.has(error.code) ? error.code : 'catchup_action_unavailable';
      const status = [404, 409, 429, 503].includes(error.statusCode || error.status) ? error.statusCode || error.status : 409;
      return sendJson(response, status, { error: 'The action could not be scheduled. Check the job state and catch-up status.', code }, id);
    }
  }

  async handleAttempt(request, response, id) {
    if (request.method !== 'POST') {
      response.setHeader('allow', 'POST');
      return sendJson(response, 405, { error: 'Use POST.' }, id);
    }
    const ticket = request.headers['x-ollama-intermediary-attempt'];
    if (typeof ticket !== 'string' || !/^[a-f0-9]{64}$/.test(ticket)) {
      return sendJson(response, 401, { error: 'A valid attempt ticket is required.', code: 'invalid_attempt_ticket' }, id);
    }
    if (!String(request.headers['content-type'] || '').toLowerCase().startsWith('application/json')) {
      return sendJson(response, 415, { error: 'Use application/json.' }, id);
    }
    let body;
    try { body = JSON.parse((await readBody(request, 1024)).toString('utf8')); }
    catch (error) { return sendJson(response, error.statusCode || 400, { error: 'Invalid attempt report.' }, id); }
    if (!body || !['success', 'failed'].includes(body.outcome)
      || (body.reason !== undefined && (typeof body.reason !== 'string' || !/^(?:[a-z_]{1,64}|http_[1-5][0-9]{2})$/.test(body.reason)))) {
      return sendJson(response, 400, { error: 'Invalid attempt outcome.' }, id);
    }
    try {
      await this.catchup.reportAttempt(ticket, { outcome: body.outcome, reason: body.reason });
      return sendJson(response, 202, { accepted: true }, id);
    } catch (error) {
      const status = [401, 409, 503].includes(error.statusCode) ? error.statusCode : 503;
      return sendJson(response, status, { error: 'Attempt report rejected; it is unknown, expired, or unavailable.', code: 'attempt_report_rejected' }, id);
    }
  }
}
