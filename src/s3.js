// Zero-dependency S3 client: AWS Signature V4 over global fetch (Node 18+).
// Just the three ops the vault mirror needs: put, get, list. Credentials come
// from the environment or ~/.aws/credentials (INI, no SDK).

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const sha256hex = (data) => crypto.createHash('sha256').update(data).digest('hex');
const hmac = (key, data) => crypto.createHmac('sha256', key).update(data).digest();

/** AWS-style URI encoding (RFC 3986, '/' preserved in object keys). */
export function uriEncode(str, encodeSlash) {
  let out = '';
  for (const ch of str) {
    if (/[A-Za-z0-9\-._~]/.test(ch)) out += ch;
    else if (ch === '/' && !encodeSlash) out += '/';
    else out += Array.from(Buffer.from(ch, 'utf8')).map((b) => '%' + b.toString(16).toUpperCase().padStart(2, '0')).join('');
  }
  return out;
}

/** Read credentials: env vars first, then ~/.aws/credentials INI. */
export function loadAwsCreds(profile = 'default') {
  const { AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_SESSION_TOKEN } = process.env;
  if (AWS_ACCESS_KEY_ID && AWS_SECRET_ACCESS_KEY) {
    return { accessKeyId: AWS_ACCESS_KEY_ID, secretAccessKey: AWS_SECRET_ACCESS_KEY, sessionToken: AWS_SESSION_TOKEN || null };
  }
  const file = path.join(os.homedir(), '.aws', 'credentials');
  if (!fs.existsSync(file)) return null;
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
  let section = null; const acc = {};
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith(';')) continue;
    const sec = /^\[(.+)\]$/.exec(line);
    if (sec) { section = sec[1]; continue; }
    const kv = /^([\w_]+)\s*=\s*(.+)$/.exec(line);
    if (kv && section === profile) acc[kv[1].toLowerCase()] = kv[2].trim();
  }
  if (!acc.aws_access_key_id || !acc.aws_secret_access_key) return null;
  return { accessKeyId: acc.aws_access_key_id, secretAccessKey: acc.aws_secret_access_key, sessionToken: acc.aws_session_token || null };
}

export class S3 {
  constructor({ bucket, region, creds, fetchImpl }) {
    if (!bucket || !region) throw new Error('S3 needs bucket + region');
    this.bucket = bucket;
    this.region = region;
    this.creds = creds;
    this.fetch = fetchImpl || globalThis.fetch;
    this.host = `${bucket}.s3.${region}.amazonaws.com`;
  }

  /** Build the SigV4 headers for one request. Exposed for tests. */
  signRequest({ method, key = '', query = '', body = null, now = new Date() }) {
    const amzDate = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
    const date = amzDate.slice(0, 8);
    const payloadHash = sha256hex(body || '');
    const canonicalUri = '/' + uriEncode(key, false);
    const headers = { host: this.host, 'x-amz-content-sha256': payloadHash, 'x-amz-date': amzDate };
    if (this.creds.sessionToken) headers['x-amz-security-token'] = this.creds.sessionToken;
    const signedHeaderNames = Object.keys(headers).sort();
    const canonicalHeaders = signedHeaderNames.map((h) => `${h}:${headers[h]}\n`).join('');
    const signedHeaders = signedHeaderNames.join(';');
    const canonicalRequest = [method, canonicalUri, query, canonicalHeaders, signedHeaders, payloadHash].join('\n');
    const scope = `${date}/${this.region}/s3/aws4_request`;
    const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256hex(canonicalRequest)].join('\n');
    let k = hmac(`AWS4${this.creds.secretAccessKey}`, date);
    k = hmac(k, this.region); k = hmac(k, 's3'); k = hmac(k, 'aws4_request');
    const signature = crypto.createHmac('sha256', k).update(stringToSign).digest('hex');
    headers.authorization = `AWS4-HMAC-SHA256 Credential=${this.creds.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
    return headers;
  }

  async request(method, key, { query = '', body = null } = {}) {
    const headers = this.signRequest({ method, key, query, body });
    const url = `https://${this.host}/${uriEncode(key, false)}${query ? `?${query}` : ''}`;
    const res = await this.fetch(url, { method, headers, body: body || undefined });
    return res;
  }

  async putObject(key, buf) {
    const res = await this.request('PUT', key, { body: buf });
    if (!res.ok) throw new Error(`S3 PUT ${key} -> ${res.status} ${await res.text()}`);
  }

  /** Returns a Buffer, or null on 404. */
  async getObject(key) {
    const res = await this.request('GET', key);
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`S3 GET ${key} -> ${res.status} ${await res.text()}`);
    return Buffer.from(await res.arrayBuffer());
  }

  /** List every key under a prefix (paginated ListObjectsV2). */
  async listAll(prefix = '') {
    const out = [];
    let token = null;
    do {
      const q = ['list-type=2', `prefix=${uriEncode(prefix, true)}`, token ? `continuation-token=${uriEncode(token, true)}` : '']
        .filter(Boolean).sort().join('&');
      const res = await this.request('GET', '', { query: q });
      if (!res.ok) throw new Error(`S3 LIST -> ${res.status} ${await res.text()}`);
      const xml = await res.text();
      for (const m of xml.matchAll(/<Key>([^<]+)<\/Key>/g)) out.push(decodeXml(m[1]));
      const t = /<NextContinuationToken>([^<]+)<\/NextContinuationToken>/.exec(xml);
      token = t ? decodeXml(t[1]) : null;
    } while (token);
    return out;
  }
}

function decodeXml(s) {
  return s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'");
}
