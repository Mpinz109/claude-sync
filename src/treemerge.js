// Entry-level transcript merge (v0.2). Approach inspired by the message-tree
// merge in perfectra1n/claude-code-sync (MIT): Claude transcripts are JSONL
// where most entries carry a `uuid` (and `parentUuid`), so two divergent copies
// of the same session can be merged LOSSLESSLY as a union of entries — the
// parentUuid links keep the conversation tree intact regardless of line order.
//
// Model:
//   - identical            -> nothing to do
//   - one side is a prefix -> fast-forward to the longer side
//   - related divergence   -> union: common prefix + both tails, deduped by
//                             entry key, ordered canonically by (timestamp, key)
//                             so merge(a,b) === merge(b,a) and all machines
//                             converge to the same bytes
//   - UNRELATED content    -> refuse (related:false); the caller falls back to
//                             the conflict path (newest/primary wins + .fork).
//                             Same session id with nothing in common is a red
//                             flag, and mixing those would help nobody.

import crypto from 'node:crypto';

function parseLine(line) {
  try { return JSON.parse(line); } catch { return null; }
}
function keyOf(line) {
  const o = parseLine(line);
  if (o && typeof o.uuid === 'string' && o.uuid) return `u:${o.uuid}`;
  return `r:${crypto.createHash('sha1').update(line).digest('hex')}`;
}
function tsOf(line) {
  const o = parseLine(line);
  return o && typeof o.timestamp === 'string' ? o.timestamp : '';
}

/**
 * Merge two versions of the same session transcript.
 * Returns { text, related, identical, aChanged, bChanged }.
 * `related:false` means the sides share no common prefix and no common entry
 * keys — the caller should treat that as a true conflict, not merge it.
 */
export function mergeTranscripts(aText, bText) {
  if (aText === bText) return { text: aText, related: true, identical: true, aChanged: false, bChanged: false };

  const trailingNl = aText.endsWith('\n') || bText.endsWith('\n');
  const A = aText.split('\n').filter((l) => l.length);
  const B = bText.split('\n').filter((l) => l.length);

  let p = 0;
  while (p < A.length && p < B.length && A[p] === B[p]) p++;

  const keysA = new Set(A.map(keyOf));
  const keysB = new Set(B.map(keyOf));
  const shared = p > 0 || A.some((l) => keysB.has(keyOf(l)));
  if (!shared) return { text: null, related: false, identical: false, aChanged: false, bChanged: false };

  // Fast-forward: one side is a pure prefix of the other.
  let lines;
  if (p === A.length) lines = B;
  else if (p === B.length) lines = A;
  else {
    // True divergence: union the tails, dedupe by key. When BOTH tails carry
    // the same key with different bytes, keep the later timestamp (tie: longer).
    const byKey = new Map(); // key -> { line, ts, seq }
    let seq = 0;
    for (const line of [...A.slice(p), ...B.slice(p)]) {
      const k = keyOf(line);
      const cand = { line, ts: tsOf(line), seq: seq++ };
      const prev = byKey.get(k);
      if (!prev) byKey.set(k, cand);
      else if (cand.line !== prev.line) {
        const newer = cand.ts > prev.ts || (cand.ts === prev.ts && cand.line.length > prev.line.length);
        if (newer) byKey.set(k, { ...cand, seq: prev.seq }); // keep original position weight
      }
    }
    // Canonical order: timestamp, then key, then arrival — deterministic for
    // either argument order, so every machine converges to identical bytes.
    const tail = [...byKey.entries()]
      .map(([k, v]) => ({ k, ...v }))
      .sort((x, y) => (x.ts < y.ts ? -1 : x.ts > y.ts ? 1 : x.k < y.k ? -1 : x.k > y.k ? 1 : x.seq - y.seq))
      .map((e) => e.line);
    lines = [...A.slice(0, p), ...tail];
  }

  const text = lines.join('\n') + (trailingNl ? '\n' : '');
  return { text, related: true, identical: false, aChanged: text !== aText, bChanged: text !== bText };
}
