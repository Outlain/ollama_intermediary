import { randomUUID } from 'node:crypto';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

export class Logger {
  constructor({ level = process.env.LOG_LEVEL ?? 'info', output = process.stdout } = {}) {
    this.level = LEVELS[level] ?? LEVELS.info;
    this.output = output;
  }

  log(level, message, fields = {}) {
    if ((LEVELS[level] ?? LEVELS.info) < this.level) return;
    const entry = { timestamp: new Date().toISOString(), level, message, ...fields };
    this.output.write(`${JSON.stringify(entry)}\n`);
  }

  debug(message, fields) { this.log('debug', message, fields); }
  info(message, fields) { this.log('info', message, fields); }
  warn(message, fields) { this.log('warn', message, fields); }
  error(message, fields) { this.log('error', message, fields); }
}

export function requestId(headers) {
  const supplied = headers['x-request-id'];
  return typeof supplied === 'string' && supplied.length <= 128 ? supplied : randomUUID();
}
