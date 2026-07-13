// Cloud vault mirror: local vault folder <-> S3 bucket. The bucket is the
// durable store-and-forward copy; the local vault dir stays the engine's
// working set. Change detection is a manifest of sha256 hashes kept in the
// bucket, so a sync moves only what changed. Additive: the mirror never
// deletes (the vault itself is additive; sessions converge via treemerge).
//
// Optional privacy: settings.vaultPassphrase encrypts every object (and the
// manifest) client-side with AES-256-GCM; the bucket only ever holds
// ciphertext. The scrypt salt is the one plaintext object.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const META_PREFIX = '_claude-sync/';
const MANIFEST_KEY = `${META_PREFIX}manifest.json`;
const SALT_KEY = `${META_PREFIX}salt`;

const sha256hex = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

// ---------- optional encryption ----------
async function getKey(s3, prefix, passphrase) {
  if (!passphrase) return null;
  let salt = await s3.getObject(prefix + SALT_KEY);
  if (!salt) {
    salt = crypto.randomBytes(16);
    await s3.putObject(prefix + SALT_KEY, salt);
  }
  return crypto.scryptSync(passphrase, salt, 32);
}
export function encrypt(buf, key) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([c.update(buf), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), ct]);
}
export function decrypt(buf, key) {
  const iv = buf.subarray(0, 12), tag = buf.subarray(12, 28), ct = buf.subarray(28);
  const d = crypto.createDecipheriv('aes-256-gcm', key, iv);
  d.setAuthTag(tag);
  try { return Buffer.concat([d.update(ct), d.final()]); }
  catch { throw new Error('decryption failed — wrong vault passphrase?'); }
}
const seal = (buf, key) => (key ? encrypt(buf, key) : buf);
const open = (buf, key) => (key ? decrypt(buf, key) : buf);

// ---------- local walk ----------
function walkFiles(dir, base = dir, out = []) {
  let entries = [];
  try { entries = fs.readdirSync(dir); } catch { return out; }
  for (const name of entries) {
    const full = path.join(dir, name);
    // statSync, not Dirent.isDirectory() — OneDrive reparse points (rule #6).
    const st = fs.statSync(full);
    if (st.isDirectory()) walkFiles(full, base, out);
    else out.push(path.relative(base, full).split(path.sep).join('/'));
  }
  return out;
}
function localManifest(vaultDir) {
  const m = {};
  for (const rel of walkFiles(vaultDir)) m[rel] = sha256hex(fs.readFileSync(path.join(vaultDir, rel)));
  return m;
}
async function remoteManifest(s3, prefix, key) {
  const raw = await s3.getObject(prefix + MANIFEST_KEY);
  if (!raw) return {};
  return JSON.parse(open(raw, key).toString('utf8'));
}

/** Upload everything the bucket is missing or has stale. */
export async function cloudPush({ vaultDir, s3, prefix = 'vault/', passphrase = '' }) {
  const key = await getKey(s3, prefix, passphrase);
  const localM = localManifest(vaultDir);
  const remoteM = await remoteManifest(s3, prefix, key);
  const uploaded = [];
  for (const [rel, hash] of Object.entries(localM)) {
    if (remoteM[rel] === hash) continue;
    await s3.putObject(prefix + rel, seal(fs.readFileSync(path.join(vaultDir, rel)), key));
    remoteM[rel] = hash;
    uploaded.push(rel);
  }
  if (uploaded.length) await s3.putObject(prefix + MANIFEST_KEY, seal(Buffer.from(JSON.stringify(remoteM)), key));
  return { uploaded, unchanged: Object.keys(localM).length - uploaded.length };
}

/** Download everything the bucket has that we lack or differ on. */
export async function cloudPull({ vaultDir, s3, prefix = 'vault/', passphrase = '' }) {
  const key = await getKey(s3, prefix, passphrase);
  const remoteM = await remoteManifest(s3, prefix, key);
  const downloaded = [];
  for (const [rel, hash] of Object.entries(remoteM)) {
    const full = path.join(vaultDir, rel);
    if (fs.existsSync(full) && sha256hex(fs.readFileSync(full)) === hash) continue;
    const raw = await s3.getObject(prefix + rel);
    if (!raw) continue; // manifest ahead of objects; next sync heals
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, open(raw, key));
    downloaded.push(rel);
  }
  return { downloaded, unchanged: Object.keys(remoteM).length - downloaded.length };
}

/** Pull then push: after this, local vault and bucket agree. */
export async function cloudSync(opts) {
  const pull = await cloudPull(opts);
  const push = await cloudPush(opts);
  return { pull, push };
}

/**
 * Rotate the vault passphrase: decrypt every object with the old key and
 * re-encrypt with a new one under a FRESH salt. Also covers enabling
 * encryption (old '' -> new set) and disabling it (new ''). Everything is
 * downloaded and decrypted FIRST, so a wrong old passphrase fails before a
 * single object is rewritten.
 */
export async function rekeyCloud({ s3, prefix = 'vault/', oldPassphrase = '', newPassphrase = '' }) {
  const oldKey = await getKey(s3, prefix, oldPassphrase);
  const remoteM = await remoteManifest(s3, prefix, oldKey); // throws on wrong old passphrase
  const files = [];
  for (const rel of Object.keys(remoteM)) {
    const raw = await s3.getObject(prefix + rel);
    if (raw) files.push([rel, open(raw, oldKey)]); // decrypt-all before write-any
  }
  let newKey = null;
  if (newPassphrase) {
    const salt = crypto.randomBytes(16);
    await s3.putObject(prefix + SALT_KEY, salt);
    newKey = crypto.scryptSync(newPassphrase, salt, 32);
  }
  for (const [rel, plain] of files) await s3.putObject(prefix + rel, seal(plain, newKey));
  await s3.putObject(prefix + MANIFEST_KEY, seal(Buffer.from(JSON.stringify(remoteM)), newKey));
  return { rekeyed: files.length, encrypted: !!newKey };
}
