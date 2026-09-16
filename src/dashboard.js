import { readFileSync } from 'node:fs';

export const DASHBOARD_HTML = readFileSync(new URL('./ui/dashboard.html', import.meta.url), 'utf8');
export const DASHBOARD_CSS = readFileSync(new URL('./ui/dashboard.css', import.meta.url), 'utf8');
export const DASHBOARD_JS = readFileSync(new URL('./ui/dashboard.js', import.meta.url), 'utf8');
