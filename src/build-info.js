import { readFileSync } from 'node:fs';

const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
export const BUILD_INFO = Object.freeze({
  version: manifest.version,
  revision: String(process.env.INTERMEDIARY_BUILD || 'local').replace(/[^A-Za-z0-9._-]/g, '').slice(0,64),
});
