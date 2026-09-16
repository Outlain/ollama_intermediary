import { readFileSync } from 'node:fs';

export const SETTINGS_DASHBOARD_HTML = readFileSync(new URL('./ui/settings.html', import.meta.url), 'utf8');
export const SETTINGS_DASHBOARD_CSS = readFileSync(new URL('./ui/settings.css', import.meta.url), 'utf8');
export const SETTINGS_DASHBOARD_JS = readFileSync(new URL('./ui/settings.js', import.meta.url), 'utf8');
