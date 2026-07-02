// Agent relay: a tiny LAN message board so Claude sessions on different
// machines can talk to each other. Wire-compatible with the original ad-hoc
// python relay, so existing deployments keep working:
//
//   GET  /health                          (no token)  -> {ok, count, port}
//   GET  /messages?since=<id>&token=<t>               -> {messages:[...], last}
//   POST /send?token=<t>  {from,to,text}              -> {ok, id}
//   GET  /peers?token=<t>                             -> {peers:[{name,lastSeen}]}   (extension)
//
// Messages persist to a JSON file so a restart keeps history. Token is a
// shared secret for a TRUSTED home LAN — this is not encryption; do not
// expose the port to the internet.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { readJson, writeJson } from './util.js';

export const DEFAULT_PORT = 8765;
export const DEFAULT_STORE = path.join(os.homedir(), '.claude-sync', 'relay-messages.json');

export class Relay {
  constructor({ port = DEFAULT_PORT, token = 'claude-migrate', store = DEFAULT_STORE } = {}) {
    this.port = port;
    this.token = token;
    this.store = store;
    this.messages = readJson(store, []);
    this.peers = new Map(); // name -> lastSeen epoch ms (in-memory; presence, not history)
    this.server = null;
  }

  _persist() { writeJson(this.store, this.messages); }
  _seen(name) { if (name) this.peers.set(String(name), Date.now()); }

  /** Append a message; returns its id. */
  send(from, to, text) {
    const id = this.messages.length ? this.messages[this.messages.length - 1].id + 1 : 1;
    this.messages.push({ id, from: String(from || '?'), to: String(to || 'all'), text: String(text ?? ''), ts: new Date().toISOString() });
    this._persist();
    this._seen(from);
    return id;
  }

  /** Messages with id > since. Marks `reader` as seen for /peers. */
  read(since = 0, reader = null) {
    this._seen(reader);
    const messages = this.messages.filter((m) => m.id > Number(since || 0));
    const last = this.messages.length ? this.messages[this.messages.length - 1].id : 0;
    return { messages, last };
  }

  listPeers() {
    return [...this.peers.entries()].map(([name, lastSeen]) => ({ name, lastSeen: new Date(lastSeen).toISOString() }));
  }

  _handle(req, res) {
    const url = new URL(req.url, `http://localhost:${this.port}`);
    const reply = (code, obj) => {
      const body = JSON.stringify(obj);
      res.writeHead(code, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
      res.end(body);
    };
    const tokenOk = () => (req.headers['x-relay-token'] || url.searchParams.get('token')) === this.token;

    if (req.method === 'GET' && url.pathname === '/health') {
      return reply(200, { ok: true, count: this.messages.length, port: this.port });
    }
    if (!tokenOk()) return reply(401, { error: 'bad or missing token' });

    if (req.method === 'GET' && url.pathname === '/messages') {
      return reply(200, this.read(url.searchParams.get('since'), url.searchParams.get('for')));
    }
    if (req.method === 'GET' && url.pathname === '/peers') {
      return reply(200, { peers: this.listPeers() });
    }
    if (req.method === 'POST' && url.pathname === '/send') {
      let raw = '';
      req.on('data', (c) => { raw += c; });
      req.on('end', () => {
        try {
          const { from, to, text } = JSON.parse(raw || '{}');
          reply(200, { ok: true, id: this.send(from, to, text) });
        } catch { reply(400, { error: 'bad json body' }); }
      });
      return;
    }
    return reply(404, { error: 'not found' });
  }

  /** Start listening. Resolves with the bound port (use port 0 in tests). */
  start() {
    return new Promise((resolve, reject) => {
      this.server = http.createServer((req, res) => this._handle(req, res));
      this.server.on('error', reject);
      this.server.listen(this.port, '0.0.0.0', () => {
        this.port = this.server.address().port;
        resolve(this.port);
      });
    });
  }

  stop() { return new Promise((r) => (this.server ? this.server.close(r) : r())); }
}

/** One-shot HTTP client helpers (used by the MCP server and the CLI). */
export async function relayApi(baseUrl, token, method, pathAndQuery, body) {
  const res = await fetch(baseUrl.replace(/\/$/, '') + pathAndQuery, {
    method,
    headers: { 'X-Relay-Token': token, 'Content-Type': 'application/json' },
    body: body != null ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`relay ${method} ${pathAndQuery} -> ${res.status} ${await res.text()}`);
  return res.json();
}
