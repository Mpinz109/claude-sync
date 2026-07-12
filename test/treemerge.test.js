// Unit tests for the entry-level transcript merge (src/treemerge.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeTranscripts } from '../src/treemerge.js';

const e = (uuid, parent, ts, extra = {}) =>
  JSON.stringify({ uuid, parentUuid: parent, timestamp: ts, type: 'assistant', ...extra });
const noUuid = (ts, content) => JSON.stringify({ type: 'queue-operation', timestamp: ts, content });

const BASE = [noUuid('t0', 'start'), e('u1', null, 't1'), e('u2', 'u1', 't2')];

test('identical inputs: no changes', () => {
  const t = BASE.join('\n');
  const m = mergeTranscripts(t, t);
  assert.equal(m.identical, true);
  assert.equal(m.aChanged, false);
});

test('fast-forward: one side is a prefix of the other', () => {
  const a = BASE.join('\n');
  const b = [...BASE, e('u3', 'u2', 't3')].join('\n');
  const m1 = mergeTranscripts(a, b);
  assert.equal(m1.related, true);
  assert.equal(m1.text, b, 'a fast-forwards to b');
  assert.equal(m1.aChanged, true);
  assert.equal(m1.bChanged, false);
  const m2 = mergeTranscripts(b, a);
  assert.equal(m2.text, b, 'b already has everything');
  assert.equal(m2.aChanged, false);
});

test('divergence: union of both tails, no entry lost', () => {
  const a = [...BASE, e('u3', 'u2', 't3', { m: 'from A' })].join('\n');
  const b = [...BASE, e('u4', 'u2', 't4', { m: 'from B' })].join('\n');
  const m = mergeTranscripts(a, b);
  assert.equal(m.related, true);
  assert.ok(m.text.includes('from A') && m.text.includes('from B'), 'both branches kept');
  assert.equal(m.text.split('\n').filter(Boolean).length, BASE.length + 2);
});

test('merge is order-independent (machines converge to identical bytes)', () => {
  const a = [...BASE, e('u3', 'u2', 't3'), e('u5', 'u3', 't5')].join('\n');
  const b = [...BASE, e('u4', 'u2', 't4')].join('\n');
  assert.equal(mergeTranscripts(a, b).text, mergeTranscripts(b, a).text);
});

test('merge is idempotent (re-merging changes nothing)', () => {
  const a = [...BASE, e('u3', 'u2', 't3')].join('\n');
  const b = [...BASE, e('u4', 'u2', 't4')].join('\n');
  const once = mergeTranscripts(a, b).text;
  assert.equal(mergeTranscripts(once, a).text, once);
  assert.equal(mergeTranscripts(once, b).text, once);
});

test('same uuid updated on both sides: later timestamp wins, no duplicate', () => {
  const a = [...BASE, e('u3', 'u2', 't3', { v: 'old' })].join('\n');
  const b = [...BASE, e('u3', 'u2', 't9', { v: 'newer' })].join('\n');
  const m = mergeTranscripts(a, b);
  const lines = m.text.split('\n').filter(Boolean);
  assert.equal(lines.filter((l) => l.includes('"u3"')).length, 1, 'one copy of u3');
  assert.ok(m.text.includes('newer'));
});

test('lines without uuid dedupe by content and survive merges', () => {
  const a = [...BASE, noUuid('t3', 'only-a')].join('\n');
  const b = [...BASE, noUuid('t4', 'only-b')].join('\n');
  const m = mergeTranscripts(a, b);
  assert.ok(m.text.includes('only-a') && m.text.includes('only-b'));
  assert.equal(m.text.split('\n').filter((l) => l.includes('start')).length, 1, 'shared no-uuid line not duplicated');
});

test('unrelated content refuses to merge (related:false)', () => {
  const a = [e('x1', null, 't1'), e('x2', 'x1', 't2')].join('\n');
  const b = [e('y1', null, 't1'), e('y2', 'y1', 't2')].join('\n');
  const m = mergeTranscripts(a, b);
  assert.equal(m.related, false);
  assert.equal(m.text, null);
});

test('trailing newline is preserved', () => {
  const a = BASE.join('\n') + '\n';
  const b = [...BASE, e('u3', 'u2', 't3')].join('\n') + '\n';
  assert.ok(mergeTranscripts(a, b).text.endsWith('\n'));
});
