import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const html = await readFile(new URL('../../public/index.html', import.meta.url), 'utf8');
const scripts = [...html.matchAll(/<script\b(?![^>]*\bsrc\s*=)[^>]*>([\s\S]*?)<\/script>/gi)];
if (!scripts.length) throw new Error('No inline application scripts were found.');
for (let index = 0; index < scripts.length; index += 1) {
  const source = scripts[index][1] || '';
  if (!source.trim()) continue;
  new vm.Script(source, { filename: `public/index.html:inline-script-${index + 1}` });
}
console.log(`Parsed ${scripts.length} inline script block(s) successfully.`);
