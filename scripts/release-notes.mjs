// Print the CHANGELOG.md section for a version (e.g. v1.2.0) to use as GitHub release notes.
// Fails when there is no section, so every release says what changed.
import { readFileSync } from 'node:fs';

const version = (process.argv[2] ?? '').replace(/^v/, '');
const lines = readFileSync(new URL('../CHANGELOG.md', import.meta.url), 'utf8').split('\n');
const start = lines.findIndex((l) => new RegExp(`^## \\[?${version.replace(/\./g, '\\.')}\\]?( |$)`).test(l));
if (!version || start < 0) {
  console.error(`CHANGELOG.md has no "## ${version || '<version>'}" section`);
  process.exit(1);
}
const end = lines.findIndex((l, i) => i > start && l.startsWith('## '));
process.stdout.write(`${lines.slice(start + 1, end < 0 ? undefined : end).join('\n').trim()}\n`);
