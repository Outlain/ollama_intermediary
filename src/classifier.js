import { BlockList, isIP } from 'node:net';
import { clientIp } from './http-utils.js';

function getPath(object, path) {
  return path.split('.').reduce((value, part) => value && typeof value === 'object' ? value[part] : undefined, object);
}

export class Classifier {
  constructor(config) {
    this.config = config;
    this.modelClients = new Map();
    this.sources = [];
    for (const [client, policy] of Object.entries(config.clients)) {
      for (const model of policy.models) this.modelClients.set(model, client);
      for (const source of policy.source_ips) {
        const [address, prefixText] = source.split('/');
        const family = isIP(address);
        if (!family) throw new Error(`invalid source IP/subnet ${source} for client ${client}`);
        const prefix = prefixText === undefined ? (family === 4 ? 32 : 128) : Number(prefixText);
        const block = new BlockList();
        block.addSubnet(address, prefix, family === 4 ? 'ipv4' : 'ipv6');
        this.sources.push({ client, block, family: family === 4 ? 'ipv4' : 'ipv6' });
      }
    }
  }

  identify(request, parsedBody, forcedClient = null) {
    if (forcedClient && this.config.clients[forcedClient]) return { client: forcedClient, method: 'listener' };
    const header = request.headers['x-ollama-client'];
    const named = Array.isArray(header) ? header[0] : header;
    if (named && this.config.clients[named]) return { client: named, method: 'header' };
    const model = parsedBody?.model;
    if (model && this.modelClients.has(model)) return { client: this.modelClients.get(model), method: 'model' };
    const address = clientIp(request, this.config.server.trusted_proxy);
    const family = isIP(address);
    if (family) {
      const type = family === 4 ? 'ipv4' : 'ipv6';
      const source = this.sources.find((entry) => entry.family === type && entry.block.check(address, type));
      if (source) return { client: source.client, method: 'source_ip' };
    }
    return { client: this.config.scheduler.default_client, method: 'fallback' };
  }

  dedupeKey(client, request, parsedBody) {
    const policy = this.config.clients[client].deduplication;
    if (!policy.enabled) return null;
    const parts = [];
    for (const name of policy.headers) {
      const value = request.headers[name.toLowerCase()];
      if (value !== undefined) parts.push(`h:${name}=${Array.isArray(value) ? value[0] : value}`);
    }
    for (const path of policy.json_fields) {
      const value = getPath(parsedBody, path);
      if (value !== undefined && typeof value !== 'object') parts.push(`j:${path}=${value}`);
    }
    return parts.length ? `${client}|${parts.join('|')}` : null;
  }
}

export function classifyEndpoint(method, pathname) {
  if (method === 'POST' && [
    '/api/generate', '/api/chat', '/api/embed', '/api/embeddings',
    '/v1/chat/completions', '/v1/embeddings',
  ].includes(pathname)) return 'generation';
  if (['/api/pull', '/api/push', '/api/create', '/api/delete', '/api/copy'].includes(pathname)) return 'management';
  return 'metadata';
}

export function isStreaming(pathname, body) {
  if (pathname === '/api/embed' || pathname === '/api/embeddings' || pathname === '/v1/embeddings') return false;
  if (pathname.startsWith('/v1/')) return body?.stream === true;
  return body?.stream !== false;
}
