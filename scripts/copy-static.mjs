// Copy the hand-written renderer and preload files next to the compiled main process,
// plus the bundled fonts (latin subsets of Geist and Geist Mono, OFL-1.1).
import { cpSync, mkdirSync } from 'node:fs';
mkdirSync('dist/renderer/fonts', { recursive: true });
cpSync('src/renderer', 'dist/renderer', { recursive: true });
cpSync('src/main/preload.cjs', 'dist/main/preload.cjs');
for (const [font, subsets] of [['geist', ['latin', 'latin-ext']], ['geist-mono', ['latin']]]) {
  for (const subset of subsets) {
    const file = `${font}-${subset}-wght-normal.woff2`;
    cpSync(`node_modules/@fontsource-variable/${font}/files/${file}`, `dist/renderer/fonts/${file}`);
  }
}
