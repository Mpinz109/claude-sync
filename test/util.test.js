// The cardinal rule of this project: NEVER write a UTF-8 BOM (Claude's JSON
// parser silently skips any file that starts with EF BB BF). These tests guard
// the IO helpers against regressions on both write and read paths.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { writeText, writeJson, readText, readJson, hasBom, stripBom } from '../src/util.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-util-'));
const f = (name) => path.join(tmp, name);
after(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ } });

const BOM = Buffer.from([0xef, 0xbb, 0xbf]);

test('writeText writes NO BOM', () => {
  const p = f('a.txt');
  writeText(p, 'hello');
  const b = fs.readFileSync(p);
  assert.notDeepEqual([b[0], b[1], b[2]], [0xef, 0xbb, 0xbf]);
  assert.equal(hasBom(p), false);
});

test('writeJson writes NO BOM and round-trips via readJson', () => {
  const p = f('b.json');
  const obj = { cliSessionId: 'abc', n: 3, nested: { x: [1, 2] } };
  writeJson(p, obj);
  assert.equal(hasBom(p), false);
  assert.deepEqual(readJson(p), obj);
});

test('writeText creates missing parent dirs', () => {
  const p = f('deep/nested/c.txt');
  writeText(p, 'ok');
  assert.equal(readText(p), 'ok');
});

test('readText / readJson tolerate a pre-existing BOM', () => {
  const p = f('withbom.json');
  fs.writeFileSync(p, Buffer.concat([BOM, Buffer.from(JSON.stringify({ x: 2 }), 'utf8')]));
  assert.equal(hasBom(p), true);
  assert.equal(readText(p).charCodeAt(0) !== 0xfeff, true, 'BOM stripped on read');
  assert.deepEqual(readJson(p), { x: 2 });
});

test('stripBom removes the BOM and leaves the rest of the bytes intact', () => {
  const p = f('strip.json');
  const payload = JSON.stringify({ keep: 'me' });
  fs.writeFileSync(p, Buffer.concat([BOM, Buffer.from(payload, 'utf8')]));
  assert.equal(stripBom(p), true);
  assert.equal(hasBom(p), false);
  assert.equal(fs.readFileSync(p, 'utf8'), payload);
  assert.equal(stripBom(p), false, 'no-op on a file without a BOM');
});

test('readJson returns fallback on bad JSON instead of throwing', () => {
  const p = f('bad.json');
  writeText(p, '{ not valid');
  assert.deepEqual(readJson(p, { fallback: true }), { fallback: true });
  assert.throws(() => readJson(p), 'throws when no fallback given');
});
