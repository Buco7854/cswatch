/** Public upstream parser fixture. Not included in release images or committed here. */
import { mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
const commit = 'fb2baab1e1e9e3d5c63ae782c38025fcaef45766';
const expected = '84a1a4191302bdd2a3bbb5a727842093744b1fb1a228aeec630369e44b622cb2';
const response = await fetch(
  `https://raw.githubusercontent.com/LaihoE/demoparser/${commit}/src/parser/test_demo.dem`,
);
if (!response.ok) throw new Error('Could not fetch upstream fixture');
const buffer = Buffer.from(await response.arrayBuffer());
if (createHash('sha256').update(buffer).digest('hex') !== expected)
  throw new Error('Fixture checksum mismatch');
await mkdir('var/fixture', { recursive: true });
await writeFile('var/fixture/input.dem', buffer);
console.log('Downloaded verified upstream demo fixture to var/fixture/input.dem');
