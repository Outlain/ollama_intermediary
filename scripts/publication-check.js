import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const root = process.cwd();
const excludedDirectories = new Set(['.git', 'node_modules', 'coverage']);
const forbiddenFiles = new Set(['config.yml', 'secrets.env', '.env']);

function fallbackFiles(directory = root) {
  const result = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && excludedDirectories.has(entry.name)) continue;
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) result.push(...fallbackFiles(absolute));
    else if (entry.isFile()) result.push(path.relative(root, absolute));
  }
  return result;
}

function publicationFiles() {
  try {
    const output = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    if (output) return output.split('\0').filter(Boolean);
  } catch {
    // The pre-publication workspace may not be initialized as a Git repository yet.
  }
  return fallbackFiles().filter((file) => !forbiddenFiles.has(file));
}

const literalPrivatePath = new RegExp('/' + 'Users/' + '[^/\\s]+/');
const literalHomePath = new RegExp('/' + 'home/' + '[^/\\s]+/');
const privateKeyMarker = '-----BEGIN ' + '(?:RSA |OPENSSH |EC |DSA )?PRIVATE KEY-----';
const checks = [
  { label: 'deployment-specific LAN address', pattern: /192\.168\.68\./g },
  { label: 'macOS user path', pattern: new RegExp(literalPrivatePath.source, 'g') },
  { label: 'Linux user path', pattern: new RegExp(literalHomePath.source, 'g') },
  { label: 'GitHub token', pattern: /(?:github_pat_|gh[pousr]_)[A-Za-z0-9_]{16,}/g },
  { label: 'AWS access key', pattern: /(?:AKIA|ASIA)[0-9A-Z]{16}/g },
  { label: 'private key', pattern: new RegExp(privateKeyMarker, 'g') },
];

const findings = [];
for (const file of publicationFiles()) {
  const basename = path.basename(file);
  if (forbiddenFiles.has(file) || forbiddenFiles.has(basename)) {
    findings.push(`${file}: private deployment file must not be tracked`);
    continue;
  }
  const buffer = fs.readFileSync(path.join(root, file));
  if (buffer.includes(0)) continue;
  const text = buffer.toString('utf8');
  for (const check of checks) {
    check.pattern.lastIndex = 0;
    if (check.pattern.test(text)) findings.push(`${file}: contains ${check.label}`);
  }
}

if (findings.length) {
  process.stderr.write(`Publication check failed:\n${findings.map((finding) => `- ${finding}`).join('\n')}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write('Publication check passed: no known private deployment files or secret patterns are publishable.\n');
}
