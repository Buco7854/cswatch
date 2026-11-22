import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import test from 'node:test';

const source = new URL('../src/', import.meta.url);
const files = readdirSync(source).filter((name) => name.endsWith('.ts'));
const read = (name: string) => readFileSync(new URL(name, source), 'utf8');

test('runtime modules resolve shared code from dist, because the image has no shared directory', () => {
  for (const name of files)
    for (const [statement, clause] of read(name).matchAll(
      /^(?:import|export)\s+((?!type\b)[^;]*?)\s+from\s+'\.\.\/\.\.\/shared\/[^']+';/gm,
    )) {
      const values = clause
        .replace(/[{}\s]/g, '')
        .split(',')
        .filter(Boolean);
      assert.ok(
        /^\{/.test(clause.trim()) &&
          clause
            .replace(/[{}]/g, '')
            .split(',')
            .map((part) => part.trim())
            .filter(Boolean)
            .every((part) => part.startsWith('type ')),
        `${name} has a runtime import that is absent from the image: ${statement} (${values})`,
      );
    }
});

test('every shared module loaded from dist is copied there by the build', () => {
  const build = readFileSync(new URL('../scripts/build-sandbox.mjs', import.meta.url), 'utf8');
  let wired = 0;
  for (const name of files)
    for (const [, module] of read(name).matchAll(
      /'\.\.\/\.\.\/shared\/([a-z-]+)\.mjs'\s*\n?\s*:/g,
    )) {
      wired++;
      assert.ok(build.includes(`'${module}'`), `${name} loads ${module}.mjs, which is not copied`);
    }
  assert.ok(wired >= 8, 'the wire modules are recognised');
});
