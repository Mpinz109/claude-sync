// Small IO helpers. The cardinal rule: never write a BOM (it makes Claude's
// JSON parser silently skip the file).

import fs from 'node:fs';
import path from 'node:path';

const UTF8_NO_BOM = 'utf8'; // Node's 'utf8' writer never adds a BOM

export function readText(file) {
  let s = fs.readFileSync(file, 'utf8');
  if (s.charCodeAt(0) === 0xfeff) s = s.slice(1); // tolerate a BOM on read
  return s;
}

export function readJson(file, fallback = undefined) {
  try { return JSON.parse(readText(file)); }
  catch (e) { if (fallback !== undefined) return fallback; throw e; }
}

/** Write text as UTF-8 with NO BOM, creating parent dirs. */
export function writeText(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text, UTF8_NO_BOM);
}

export function writeJson(file, obj) {
  writeText(file, JSON.stringify(obj, null, 2));
}

/** True if the file begins with a UTF-8 BOM. */
export function hasBom(file) {
  const b = fs.readFileSync(file);
  return b.length >= 3 && b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf;
}

/** Strip a UTF-8 BOM in place, leaving the rest of the bytes untouched. */
export function stripBom(file) {
  const b = fs.readFileSync(file);
  if (b.length >= 3 && b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) {
    fs.writeFileSync(file, b.subarray(3));
    return true;
  }
  return false;
}

export const c = {
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  cyan: (s) => `\x1b[36m${s}\x1b[0m`,
};

export function ok(s) { return `${c.green('✓')} ${s}`; }
export function warn(s) { return `${c.yellow('!')} ${s}`; }
export function bad(s) { return `${c.red('✗')} ${s}`; }
