// Path tokenization is the heart of cross-machine portability: a transcript
// written on one machine must round-trip byte-exact, and re-materialize with the
// SECOND machine's paths. These tests pin both.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tokenize, detokenize } from '../src/tokens.js';

// Machine A: real profile under C:\Users\mpinz, project a few levels down.
const A = {
  home: 'C:\\Users\\mpinz',
  projectRoot: 'C:\\Users\\mpinz\\OneDrive\\Desktop\\Random Claude Projects\\Chrynobl investigation',
};
// Machine B: different user home AND a different project root layout.
const B = {
  home: 'C:\\Users\\USER',
  projectRoot: 'C:\\Users\\USER\\Desktop\\projects\\Chrynobl investigation',
};

// A realistic transcript line: JSON with the project cwd, a nested file path, and
// a bare home reference. Paths appear JSON-escaped, which is what tokenize sees.
function sampleTranscript({ home, projectRoot }) {
  return JSON.stringify({
    type: 'user',
    cwd: projectRoot,
    file: projectRoot + '\\src\\reactor.py',
    homeNote: home + '\\.claude.json',
  });
}

test('round-trips byte-exact on the same machine', () => {
  const original = sampleTranscript(A);
  const restored = detokenize(tokenize(original, A), A);
  assert.equal(restored, original);
});

test('tokenized form contains tokens, not machine-specific paths', () => {
  const t = tokenize(sampleTranscript(A), A);
  assert.ok(t.includes('{{PROJECT_ROOT}}'), 'should have project token');
  assert.ok(t.includes('{{HOME}}'), 'should have home token');
  // No raw machine path should survive (escaped backslash form).
  assert.ok(!t.includes('C:\\\\Users\\\\mpinz'), 'no raw home path leaks');
});

test('cross-machine: A -> vault -> B remaps to B paths', () => {
  const canonical = tokenize(sampleTranscript(A), A);
  const onB = detokenize(canonical, B);
  assert.equal(onB, sampleTranscript(B));
  assert.ok(onB.includes('C:\\\\Users\\\\USER'), 'B home present');
  assert.ok(!onB.includes('mpinz'), 'A home fully gone');
});

test('projectRoot is replaced before home (most-specific-first)', () => {
  // projectRoot is under home; ensure the nested project path does not get half
  // eaten by the home replacement.
  const t = tokenize(sampleTranscript(A), A);
  // The project file path should be entirely under PROJECT_ROOT, no stray HOME.
  assert.ok(t.includes('{{PROJECT_ROOT}}\\\\src\\\\reactor.py'));
});

test('handles text with no paths unchanged', () => {
  const plain = JSON.stringify({ type: 'assistant', text: 'hello world' });
  assert.equal(tokenize(plain, A), plain);
  assert.equal(detokenize(plain, A), plain);
});
