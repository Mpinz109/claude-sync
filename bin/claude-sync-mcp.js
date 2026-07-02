#!/usr/bin/env node
// MCP server: lets any Claude session talk to other Claude agents through the
// claude-sync relay as NATIVE TOOLS (no shelling out, no manual polling).
//
// Speaks Model Context Protocol (JSON-RPC 2.0, newline-delimited) on stdio and
// forwards to the relay over HTTP. Zero dependencies.
//
// Config via env:
//   RELAY_URL    e.g. http://192.168.68.69:8765   (default http://127.0.0.1:8765)
//   RELAY_TOKEN  shared secret                    (default claude-migrate)
//   AGENT_NAME   this agent's name on the wire    (default the hostname)
//
// Register (per project, .mcp.json):
//   { "mcpServers": { "agent-relay": {
//       "command": "node", "args": ["<path>/bin/claude-sync-mcp.js"],
//       "env": { "RELAY_URL": "http://<host>:8765", "RELAY_TOKEN": "...", "AGENT_NAME": "laptop" } } } }

import os from 'node:os';
import readline from 'node:readline';
import { relayApi } from '../src/relay.js';

const RELAY_URL = process.env.RELAY_URL || 'http://127.0.0.1:8765';
const TOKEN = process.env.RELAY_TOKEN || 'claude-migrate';
const ME = process.env.AGENT_NAME || os.hostname();

let cursor = 0; // last message id this process has delivered via read_messages

const TOOLS = [
  {
    name: 'send_message',
    description: `Send a message to another Claude agent (or "all") via the LAN relay. You are "${ME}".`,
    inputSchema: {
      type: 'object',
      properties: {
        to: { type: 'string', description: 'Recipient agent name, or "all" to broadcast' },
        text: { type: 'string', description: 'The message text' },
      },
      required: ['to', 'text'],
    },
  },
  {
    name: 'read_messages',
    description: `Read new relay messages addressed to "${ME}" (or "all"). Tracks a cursor, so repeated calls return only unseen messages; pass since=0 to re-read the whole thread.`,
    inputSchema: {
      type: 'object',
      properties: {
        since: { type: 'number', description: 'Message id to read from (omit to continue from the cursor)' },
        include_own: { type: 'boolean', description: 'Also include messages you sent (default false)' },
      },
    },
  },
  {
    name: 'list_peers',
    description: 'List agents recently seen on the relay (who is online-ish).',
    inputSchema: { type: 'object', properties: {} },
  },
];

async function callTool(name, args = {}) {
  if (name === 'send_message') {
    const r = await relayApi(RELAY_URL, TOKEN, 'POST', '/send', { from: ME, to: args.to, text: args.text });
    return `sent (id=${r.id}) ${ME} -> ${args.to}`;
  }
  if (name === 'read_messages') {
    const since = args.since != null ? Number(args.since) : cursor;
    const r = await relayApi(RELAY_URL, TOKEN, 'GET', `/messages?since=${since}&for=${encodeURIComponent(ME)}`);
    if (args.since == null) cursor = Math.max(cursor, r.last || 0);
    const mine = r.messages.filter((m) =>
      (args.include_own || m.from !== ME) && (m.to === ME || m.to === 'all' || m.from === ME));
    if (!mine.length) return '(no new messages)';
    return mine.map((m) => `[#${m.id} ${m.ts}] ${m.from} -> ${m.to}: ${m.text}`).join('\n');
  }
  if (name === 'list_peers') {
    const r = await relayApi(RELAY_URL, TOKEN, 'GET', '/peers');
    if (!r.peers.length) return '(no peers seen yet)';
    return r.peers.map((p) => `${p.name}  last seen ${p.lastSeen}`).join('\n');
  }
  throw new Error(`unknown tool: ${name}`);
}

// ---------- minimal MCP over stdio (JSON-RPC 2.0, newline-delimited) ----------
const out = (obj) => process.stdout.write(JSON.stringify(obj) + '\n');
const rl = readline.createInterface({ input: process.stdin, terminal: false });

rl.on('line', async (line) => {
  line = line.trim();
  if (!line) return;
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  const { id, method, params } = msg;
  const respond = (result) => out({ jsonrpc: '2.0', id, result });
  const fail = (code, message) => out({ jsonrpc: '2.0', id, error: { code, message } });

  try {
    if (method === 'initialize') {
      respond({
        protocolVersion: params?.protocolVersion || '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'claude-sync-agent-relay', version: '0.1.0' },
      });
    } else if (method === 'notifications/initialized' || method === 'initialized') {
      // notification — no response
    } else if (method === 'ping') {
      respond({});
    } else if (method === 'tools/list') {
      respond({ tools: TOOLS });
    } else if (method === 'tools/call') {
      const text = await callTool(params.name, params.arguments || {});
      respond({ content: [{ type: 'text', text }] });
    } else if (id != null) {
      fail(-32601, `method not found: ${method}`);
    }
  } catch (e) {
    if (id != null) out({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: `error: ${e.message}` }], isError: true } });
  }
});
