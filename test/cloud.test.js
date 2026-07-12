// Cloud vault mirror (src/cloud.js) against an in-memory fake S3, plus the
// SigV4 client's encoding/signing/list-parsing (src/s3.js) with a fake fetch.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { cloudPush, cloudPull, cloudSync, encrypt, decrypt } from '../src/cloud.js';
import { S3, uriEncode } from '../src/s3.js';
import crypto from 'node:crypto';

const tmps = [];
after(() => { for (const d of tmps) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ } } });
const mkVault = (files) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-cloud-'));
  tmps.push(d);
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(d, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  return d;
};

/** In-memory stand-in implementing the S3 surface cloud.js uses. */
class FakeS3 {
  constructor() { this.objects = new Map(); this.puts = 0; }
  async putObject(key, buf) { this.objects.set(key, Buffer.from(buf)); this.puts++; }
  async getObject(key) { return this.objects.has(key) ? Buffer.from(this.objects.get(key)) : null; }
  async listAll(prefix) { return [...this.objects.keys()].filter((k) => k.startsWith(prefix)); }
}

test('push then pull mirrors the vault byte-exact to a second machine', async () => {
  const s3 = new FakeS3();
  const a = mkVault({ 'vault.json': '{"v":1}', 'projects/p1/sessions/s1/transcript.jsonl': '{"line":1}\n{"line":2}' });
  const rPush = await cloudPush({ vaultDir: a, s3 });
  assert.equal(rPush.uploaded.length, 2);

  const b = mkVault({});
  const rPull = await cloudPull({ vaultDir: b, s3 });
  assert.equal(rPull.downloaded.length, 2);
  assert.equal(
    fs.readFileSync(path.join(b, 'projects/p1/sessions/s1/transcript.jsonl'), 'utf8'),
    '{"line":1}\n{"line":2}',
  );
});

test('mirror is incremental: unchanged files move zero bytes', async () => {
  const s3 = new FakeS3();
  const a = mkVault({ 'x.json': 'one', 'y.json': 'two' });
  await cloudPush({ vaultDir: a, s3 });
  const putsAfterFirst = s3.puts;
  const r2 = await cloudPush({ vaultDir: a, s3 });
  assert.equal(r2.uploaded.length, 0);
  assert.equal(s3.puts, putsAfterFirst, 'no re-uploads');
  fs.writeFileSync(path.join(a, 'x.json'), 'one-changed');
  const r3 = await cloudPush({ vaultDir: a, s3 });
  assert.deepEqual(r3.uploaded, ['x.json']);
});

test('cloudSync converges two machines through the bucket', async () => {
  const s3 = new FakeS3();
  const a = mkVault({ 'from-a.json': 'A' });
  const b = mkVault({ 'from-b.json': 'B' });
  await cloudSync({ vaultDir: a, s3 });
  await cloudSync({ vaultDir: b, s3 });
  await cloudSync({ vaultDir: a, s3 });
  assert.ok(fs.existsSync(path.join(a, 'from-b.json')));
  assert.ok(fs.existsSync(path.join(b, 'from-a.json')));
});

test('encryption: bucket holds only ciphertext; second machine decrypts; wrong passphrase fails', async () => {
  const s3 = new FakeS3();
  const secret = '{"very":"private transcript"}';
  const a = mkVault({ 'projects/p/sessions/s/transcript.jsonl': secret });
  await cloudPush({ vaultDir: a, s3, passphrase: 'correct horse' });
  for (const [key, buf] of s3.objects) {
    if (key.endsWith('/salt')) continue;
    assert.ok(!buf.toString('utf8').includes('private transcript'), `plaintext leaked in ${key}`);
  }
  const b = mkVault({});
  const r = await cloudPull({ vaultDir: b, s3, passphrase: 'correct horse' });
  assert.equal(r.downloaded.length, 1);
  assert.equal(fs.readFileSync(path.join(b, 'projects/p/sessions/s/transcript.jsonl'), 'utf8'), secret);

  const c2 = mkVault({});
  await assert.rejects(() => cloudPull({ vaultDir: c2, s3, passphrase: 'wrong' }), /passphrase/);
});

test('encrypt/decrypt round-trips and tampers loudly', () => {
  const key = crypto.randomBytes(32);
  const sealed = encrypt(Buffer.from('payload'), key);
  assert.equal(decrypt(sealed, key).toString(), 'payload');
  sealed[sealed.length - 1] ^= 0xff;
  assert.throws(() => decrypt(sealed, key), /passphrase/);
});

// ---------- S3 client internals ----------

test('uriEncode follows the AWS rules', () => {
  assert.equal(uriEncode('a b*c~d/e', false), 'a%20b%2Ac~d/e');
  assert.equal(uriEncode('a/b', true), 'a%2Fb');
});

test('signRequest produces a well-formed, deterministic SigV4 header set', () => {
  const s3 = new S3({ bucket: 'b', region: 'eu-west-1', creds: { accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'secret' } });
  const now = new Date('2026-01-02T03:04:05.000Z');
  const h1 = s3.signRequest({ method: 'PUT', key: 'vault/a b.json', body: Buffer.from('x'), now });
  const h2 = s3.signRequest({ method: 'PUT', key: 'vault/a b.json', body: Buffer.from('x'), now });
  assert.equal(h1.authorization, h2.authorization, 'deterministic');
  assert.equal(h1['x-amz-date'], '20260102T030405Z');
  assert.match(h1.authorization, /^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/20260102\/eu-west-1\/s3\/aws4_request, SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature=[0-9a-f]{64}$/);
});

test('listAll paginates and decodes XML entities', async () => {
  const pages = [
    '<r><Key>vault/a.json</Key><Key>vault/b&amp;c.json</Key><NextContinuationToken>tok1</NextContinuationToken></r>',
    '<r><Key>vault/d.json</Key></r>',
  ];
  let call = 0;
  const fetchImpl = async (url) => {
    const body = pages[call++];
    if (call === 2) assert.ok(String(url).includes('continuation-token=tok1'));
    return { ok: true, status: 200, text: async () => body };
  };
  const s3 = new S3({ bucket: 'b', region: 'r', creds: { accessKeyId: 'k', secretAccessKey: 's' }, fetchImpl });
  const keys = await s3.listAll('vault/');
  assert.deepEqual(keys, ['vault/a.json', 'vault/b&c.json', 'vault/d.json']);
});
