/** Fails when a literal UI message lacks an English/French catalog entry. */
import ts from '../frontend/node_modules/typescript/lib/typescript.js';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
const en = JSON.parse(readFileSync('frontend/src/locales/en.json', 'utf8')),
  fr = JSON.parse(readFileSync('frontend/src/locales/fr.json', 'utf8')),
  missing = new Set();
function message(value) {
  if (!(value in en) && !(value + '_other' in en)) missing.add(value);
}
function leaves(n) {
  if (ts.isStringLiteral(n)) message(n.text);
  else if (ts.isConditionalExpression(n)) {
    leaves(n.whenTrue);
    leaves(n.whenFalse);
  }
}
function files(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? files(join(dir, e.name)) : [join(dir, e.name)],
  );
}
for (const path of files('frontend/src').filter((p) => p.endsWith('.tsx'))) {
  const source = readFileSync(path, 'utf8'),
    sf = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  function walk(n) {
    if (ts.isCallExpression(n) && n.expression.getText(sf) === 't' && n.arguments[0])
      leaves(n.arguments[0]);
    if (ts.isVariableDeclaration(n) && n.name.getText(sf) === 'featureContent' && n.initializer) {
      function content(c) {
        if (ts.isStringLiteral(c) && c.text.includes(' ')) message(c.text);
        ts.forEachChild(c, content);
      }
      content(n.initializer);
    }
    ts.forEachChild(n, walk);
  }
  walk(sf);
}
if (missing.size) {
  console.error('Untranslated UI messages:', [...missing]);
  process.exit(1);
}
if (Object.keys(en).some((k) => !(k in fr)) || Object.keys(fr).some((k) => !(k in en)))
  throw new Error('Catalog keys differ');
console.log('English/French UI message coverage passed.');
