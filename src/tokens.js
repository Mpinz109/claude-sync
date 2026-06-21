// Make session data machine-independent by replacing machine-specific path
// prefixes with tokens, and back. Transcripts/recents are JSON, so paths appear
// JSON-escaped (on Windows: C:\\Users\\... with doubled backslashes); we operate
// on that escaped form, which keeps the text valid JSON throughout.

const PROJECT = '{{PROJECT_ROOT}}';
const HOME = '{{HOME}}';

/** JSON-escaped form of a path, e.g. C:\Users\x -> C:\\Users\\x */
function esc(p) {
  return JSON.stringify(p).slice(1, -1);
}
function replaceAll(s, find, to) {
  return find ? s.split(find).join(to) : s;
}

/** Local -> canonical. projectRoot must be the project's absolute local path. */
export function tokenize(text, { home, projectRoot }) {
  let o = text;
  o = replaceAll(o, esc(projectRoot), PROJECT); // most specific first (projectRoot is under home)
  o = replaceAll(o, esc(home), HOME);
  return o;
}

/** Canonical -> local, using THIS machine's home/projectRoot. */
export function detokenize(text, { home, projectRoot }) {
  let o = text;
  o = replaceAll(o, PROJECT, esc(projectRoot));
  o = replaceAll(o, HOME, esc(home));
  return o;
}

/** True if any machine-specific path leaked through (diagnostic for tests). */
export function looksTokenized(text) {
  return text.includes(PROJECT) || !/[A-Za-z]:\\\\Users\\\\/.test(text);
}
