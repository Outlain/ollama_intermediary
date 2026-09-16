import http from 'node:http';
import https from 'node:https';

// Contracts verified against Frigate bb6c2e9. Do not infer support from a version
// string: development images may add/remove routes independently of that string.
const ROUTES = {
  object: '/events/{event_id}/description/regenerate',
  review: '/review/{review_id}/regenerate_description',
};
const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;

export class FrigateError extends Error {
  constructor(code, statusCode = null) {
    super(code);
    this.name = 'FrigateError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

export class FrigateClient {
  constructor(settings) {
    this.settings = settings;
    this.authMode = !settings.auth_mode || settings.auth_mode === 'auto'
      ? settings.auth_token ? 'token' : settings.username ? 'password' : 'none'
      : settings.auth_mode;
    this.base = new URL(settings.url);
    if (!['http:', 'https:'].includes(this.base.protocol) || this.base.username || this.base.password) {
      throw new FrigateError('invalid_frigate_url');
    }
    this.base.search = '';
    this.base.hash = '';
    this.base.pathname = `${this.base.pathname.replace(/\/+$/, '').replace(/\/api$/, '')}/api/`;
    this.cookie = null;
    this.closed = false;
    this.requests = new Set();
    this.httpAgent = new http.Agent({ keepAlive: true, maxSockets: 2 });
    this.httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 2, rejectUnauthorized: settings.verify_tls !== false });
  }

  close() {
    this.closed = true;
    for (const request of this.requests) request.destroy(new FrigateError('stopped'));
    this.httpAgent.destroy();
    this.httpsAgent.destroy();
  }

  async raw(route, { method = 'GET', query, body, discard = false, media = false, authenticated = true } = {}) {
    if (this.closed) throw new FrigateError('stopped');
    const url = new URL(route.replace(/^\//, ''), this.base);
    if (query) for (const [key, value] of Object.entries(query)) {
      if (value !== null && value !== undefined) url.searchParams.set(key, String(value));
    }
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
    // Frigate's nginx otherwise caches successful API GETs for five seconds.
    // A cached empty description can race a live completion and cause overwrite.
    const headers = { accept: discard ? '*/*' : 'application/json', 'x-cache-bypass': '1' };
    if (authenticated) {
      if (this.authMode === 'token' && this.settings.auth_token) headers.authorization = `Bearer ${this.settings.auth_token}`;
      else if (this.authMode === 'password' && this.cookie) headers.cookie = this.cookie;
    }
    if (payload) {
      headers['content-type'] = 'application/json';
      headers['content-length'] = payload.length;
    }
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (error, result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.requests.delete(request);
        if (error) reject(this.closed ? new FrigateError('stopped') : error instanceof FrigateError ? error : new FrigateError('connection_failed'));
        else resolve(result);
      };
      const transport = url.protocol === 'https:' ? https : http;
      const request = transport.request(url, {
        method, headers, agent: url.protocol === 'https:' ? this.httpsAgent : this.httpAgent,
      }, (response) => {
        const statusCode = response.statusCode ?? 502;
        // Never follow redirects: this also prevents forwarding credentials to another host.
        if (statusCode < 200 || statusCode >= 300) {
          finish(new FrigateError(statusCode === 401 || statusCode === 403 ? 'authentication_failed' : `http_${statusCode}`, statusCode));
          response.destroy();
          return;
        }
        if (media && !String(response.headers['content-type'] ?? '').startsWith('image/')) {
          finish(new FrigateError('invalid_media_response'));
          response.destroy();
          return;
        }
        const chunks = [];
        let size = 0;
        response.on('data', (chunk) => {
          size += chunk.length;
          if (size > MAX_RESPONSE_BYTES) {
            request.destroy(new FrigateError('response_too_large'));
          } else if (!discard) chunks.push(chunk);
        });
        response.on('error', (error) => finish(error));
        response.on('aborted', () => finish(new FrigateError('response_interrupted')));
        response.on('end', () => finish(null, {
          statusCode, headers: response.headers,
          text: discard ? '' : Buffer.concat(chunks).toString('utf8'),
        }));
      });
      const timer = setTimeout(() => request.destroy(new FrigateError('request_timeout')), this.settings.requestTimeoutMs ?? 15_000);
      timer.unref?.();
      this.requests.add(request);
      request.on('error', (error) => finish(error));
      request.end(payload);
    });
  }

  async login() {
    const result = await this.raw('login', {
      method: 'POST', authenticated: false,
      body: { user: this.settings.username, password: this.settings.password },
    });
    const cookies = result.headers['set-cookie'];
    if (!Array.isArray(cookies) || !cookies.length) throw new FrigateError('authentication_failed');
    this.cookie = cookies.map((cookie) => cookie.split(';', 1)[0]).join('; ');
  }

  async request(route, options = {}) {
    if (this.authMode === 'password' && !this.cookie) await this.login();
    let response;
    try {
      response = await this.raw(route, options);
    } catch (error) {
      if (error.statusCode !== 401 || this.authMode !== 'password') throw error;
      this.cookie = null;
      await this.login();
      response = await this.raw(route, options);
    }
    if (options.discard) return true;
    if (!response.text) return null;
    try { return JSON.parse(response.text); } catch { throw new FrigateError('invalid_json_response'); }
  }

  async capabilities() {
    const schema = await this.request('openapi.json');
    if (!schema?.paths || typeof schema.paths !== 'object') throw new FrigateError('invalid_api_schema');
    const supports = (route) => Boolean(schema.paths[route]?.put || schema.paths[`/api${route}`]?.put);
    return { object: supports(ROUTES.object), review: supports(ROUTES.review) };
  }

  getConfig() { return this.request('config'); }

  async list(kind, { after, before, limit }) {
    const result = await this.request(kind === 'object' ? 'events' : 'review', {
      query: { after, before, limit, ...(kind === 'object' ? { include_thumbnails: 0, sort: 'date_desc' } : {}) },
    });
    if (!Array.isArray(result)) throw new FrigateError('invalid_event_list');
    return result;
  }

  async get(kind, id) {
    const result = await this.request(`${kind === 'object' ? 'events' : 'review'}/${encodeURIComponent(id)}`);
    if (!result || result.id !== id || typeof result.camera !== 'string' || !Number.isFinite(Number(result.start_time))) {
      throw new FrigateError('invalid_event_response');
    }
    return result;
  }

  async hasMedia(kind, item, source) {
    try {
      if (kind === 'review') {
        const recordings = await this.request(`${encodeURIComponent(item.camera)}/recordings`, {
          query: { after: item.start_time, before: item.end_time },
        });
        if (!Array.isArray(recordings)) throw new FrigateError('invalid_recording_list');
        return recordings.some((row) => Number(row.end_time) > Number(item.start_time) && Number(row.start_time) < Number(item.end_time));
      }
      // Frigate's object regeneration needs a retained thumbnail even in snapshot mode.
      await this.request(`events/${encodeURIComponent(item.id)}/thumbnail.jpg`, { discard: true, media: true });
      if (source === 'snapshot') {
        if (!item.has_snapshot) return false;
        await this.request(`events/${encodeURIComponent(item.id)}/snapshot.jpg`, { discard: true, media: true });
      }
      return true;
    } catch (error) {
      if (error.statusCode === 404) return false;
      throw error;
    }
  }

  async regenerate(kind, id, source) {
    const result = await this.request(kind === 'object'
      ? `events/${encodeURIComponent(id)}/description/regenerate`
      : `review/${encodeURIComponent(id)}/regenerate_description`, {
      method: 'PUT', ...(kind === 'object' ? { query: { source, force: false } } : {}),
    });
    if (result?.success !== true) throw new FrigateError('generation_not_accepted');
    // Both 200 (objects) and 202 (reviews) only acknowledge dispatch, not completion.
    return { accepted: true };
  }
}
