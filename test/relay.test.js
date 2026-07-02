// Agent relay + MCP server. The relay is exercised over real HTTP on an
// ephemeral port; the MCP server is spawned as a real child process and driven
// through an actual initialize -> tools/list -> tools/call handshake on stdio.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Relay, relayApi } from '../src/relay.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MCP_BIN = path.join(HERE, '..', 'bin', 'claude-sync-mcp.js');
const tmps = [], relays = [], procs = [];
after(async () => {
  for (const p of procs) { try { p.kill(); } catch { /* */ } }
  for (const r of relays) { try { await r.stop(); } catch { /* */ } }
  for (const d of tmps) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* */ } }
});

function tmpStore() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-relay-'));
  tmps.push(d);
  return path.join(d, 'messages.json');
}
async function startRelay(store = tmpStore()) {
  const r = new Relay({ port: 0, token: 'tok', store });
  relays.push(r);
  const port = await r.start();
  return { relay: r, url: `http://127.0.0.1:${port}`, store };
}

// ---------- relay over real HTTP ----------
test('relay: health, send, read-since, peers, token auth', async () => {
  const { url } = await startRelay();

  const health = await (await fetch(`${url}/health`)).json();
  assert.equal(health.ok, true);

  const bad = await fetch(`${url}/messages?since=0&token=WRONG`);
  assert.equal(bad.status, 401);

  const s1 = await relayApi(url, 'tok', 'POST', '/send', { from: 'laptop', to: 'desktop', text: 'hi' });
  const s2 = await relayApi(url, 'tok', 'POST', '/send', { from: 'desktop', to: 'laptop', text: 'yo' });
  assert.deepEqual([s1.id, s2.id], [1, 2]);

  const all = await relayApi(url, 'tok', 'GET', '/messages?since=0');
  assert.equal(all.messages.length, 2);
  assert.equal(all.last, 2);
  const tail = await relayApi(url, 'tok', 'GET', '/messages?since=1&for=laptop');
  assert.deepEqual(tail.messages.map((m) => m.text), ['yo']);

  const peers = await relayApi(url, 'tok', 'GET', '/peers');
  const names = peers.peers.map((p) => p.name).sort();
  assert.deepEqual(names, ['desktop', 'laptop']);
});

test('relay: history survives a restart (same store)', async () => {
  const store = tmpStore();
  const a = await startRelay(store);
  await relayApi(a.url, 'tok', 'POST', '/send', { from: 'x', to: 'all', text: 'persisted' });
  await a.relay.stop();

  const b = await startRelay(store);
  const r = await relayApi(b.url, 'tok', 'GET', '/messages?since=0');
  assert.equal(r.messages.length, 1);
  assert.equal(r.messages[0].text, 'persisted');
  assert.equal((await relayApi(b.url, 'tok', 'POST', '/send', { from: 'x', to: 'all', text: '2' })).id, 2, 'ids continue');
});

// ---------- the MCP server, driven like a real client ----------
function mcpClient(env) {
  const proc = spawn(process.execPath, [MCP_BIN], { env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'inherit'] });
  procs.push(proc);
  let buf = '';
  const pending = new Map();
  proc.stdout.on('data', (c) => {
    buf += c;
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      const msg = JSON.parse(line);
      if (pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
    }
  });
  let nextId = 1;
  const request = (method, params) => new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, resolve);
    proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error(`timeout: ${method}`)); } }, 8000);
  });
  return { proc, request };
}

test('mcp: initialize, tools/list, send + read through the relay', async () => {
  const { url } = await startRelay();
  const A = mcpClient({ RELAY_URL: url, RELAY_TOKEN: 'tok', AGENT_NAME: 'alpha' });
  const B = mcpClient({ RELAY_URL: url, RELAY_TOKEN: 'tok', AGENT_NAME: 'beta' });

  const init = await A.request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '0' } });
  assert.equal(init.result.serverInfo.name, 'claude-sync-agent-relay');
  assert.ok(init.result.capabilities.tools);

  const tools = await A.request('tools/list', {});
  assert.deepEqual(tools.result.tools.map((t) => t.name).sort(), ['list_peers', 'read_messages', 'send_message']);

  // alpha sends; beta reads it as a native tool call.
  const sent = await A.request('tools/call', { name: 'send_message', arguments: { to: 'beta', text: 'hello from alpha' } });
  assert.match(sent.result.content[0].text, /sent \(id=1\)/);

  const read = await B.request('tools/call', { name: 'read_messages', arguments: {} });
  assert.match(read.result.content[0].text, /alpha -> beta: hello from alpha/);

  // cursor advanced: a second read is empty.
  const again = await B.request('tools/call', { name: 'read_messages', arguments: {} });
  assert.equal(again.result.content[0].text, '(no new messages)');

  // both agents visible.
  const peers = await A.request('tools/call', { name: 'list_peers', arguments: {} });
  assert.match(peers.result.content[0].text, /alpha/);
  assert.match(peers.result.content[0].text, /beta/);
});

test('mcp: relay unreachable surfaces as a tool error, not a crash', async () => {
  const A = mcpClient({ RELAY_URL: 'http://127.0.0.1:9', RELAY_TOKEN: 'tok', AGENT_NAME: 'alpha' });
  const r = await A.request('tools/call', { name: 'send_message', arguments: { to: 'x', text: 'y' } });
  assert.equal(r.result.isError, true);
  assert.match(r.result.content[0].text, /error:/);
});
