// Syncthing manager (Phase 4). claude-sync runs its OWN private Syncthing instance
// in a dedicated home dir (so it never collides with a user's existing Syncthing),
// and drives identity / pairing / vault-sharing through Syncthing's REST API. The
// user never sees or configures Syncthing directly.
//
// Identity = the Syncthing Device ID (a crypto fingerprint of the device cert).
// Pairing  = exchange Device IDs + auto-share the vault folder.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

const DEFAULT_HOME = path.join(os.homedir(), '.claude-sync', 'syncthing');
const DEFAULT_GUI = '127.0.0.1:8384';

export class Syncthing {
  constructor(opts = {}) {
    this.home = opts.home || DEFAULT_HOME;
    this.guiAddress = opts.guiAddress || DEFAULT_GUI;
    this.binPath = opts.binPath || this.findBinary();
    this.apiKey = null;
    this.proc = null;
  }

  get apiBase() { return `http://${this.guiAddress}`; }

  /** Locate a Syncthing binary: explicit, bundled (packaged app), winget, or PATH. */
  findBinary() {
    const exe = process.platform === 'win32' ? 'syncthing.exe' : 'syncthing';
    const candidates = [];
    if (process.resourcesPath) candidates.push(path.join(process.resourcesPath, 'syncthing', exe)); // packaged
    if (process.platform === 'win32') {
      const wg = path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'WinGet', 'Packages');
      try {
        for (const d of fs.readdirSync(wg)) {
          if (/^Syncthing\.Syncthing/i.test(d)) {
            const hit = fs.readdirSync(path.join(wg, d)).map((v) => path.join(wg, d, v, exe)).find((p) => fs.existsSync(p));
            if (hit) candidates.push(hit);
          }
        }
      } catch { /* none */ }
    } else {
      candidates.push('/usr/bin/syncthing', '/usr/local/bin/syncthing', '/opt/homebrew/bin/syncthing');
    }
    for (const c of candidates) { try { if (fs.existsSync(c)) return c; } catch { /* */ } }
    // fall back to PATH lookup
    const which = spawnSync(process.platform === 'win32' ? 'where' : 'which', [exe], { encoding: 'utf8' });
    const line = (which.stdout || '').split(/\r?\n/).find(Boolean);
    return line || null;
  }

  /** First-run: generate config + device certificate in our private home. */
  ensureGenerated() {
    if (fs.existsSync(path.join(this.home, 'config.xml'))) return;
    fs.mkdirSync(this.home, { recursive: true });
    const r = spawnSync(this.binPath, ['generate', '--home', this.home], { encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`syncthing generate failed: ${r.stderr || r.stdout}`);
  }

  /** Read the REST API key Syncthing wrote into its config. */
  readApiKey() {
    const xml = fs.readFileSync(path.join(this.home, 'config.xml'), 'utf8');
    const m = xml.match(/<apikey>([^<]+)<\/apikey>/);
    if (!m) throw new Error('no apikey in syncthing config.xml');
    return m[1];
  }

  /** Start the managed Syncthing and wait for its REST API to answer. */
  async start({ timeoutMs = 25000 } = {}) {
    if (!this.binPath) throw new Error('syncthing binary not found (bundle it or install it)');
    this.ensureGenerated();
    this.apiKey = this.readApiKey();
    this.proc = spawn(this.binPath, [
      'serve', '--home', this.home, '--no-browser', '--no-restart', '--gui-address', this.guiAddress,
    ], { stdio: 'ignore', windowsHide: true });
    await this.waitForApi(timeoutMs);
    return this.getDeviceId();
  }

  async waitForApi(timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        const res = await fetch(`${this.apiBase}/rest/system/ping`, { headers: { 'X-API-Key': this.apiKey } });
        if (res.ok) return true;
      } catch { /* not up yet */ }
      await new Promise((r) => setTimeout(r, 500));
    }
    throw new Error('syncthing REST API did not come up in time');
  }

  async api(method, route, body) {
    const res = await fetch(this.apiBase + route, {
      method,
      headers: { 'X-API-Key': this.apiKey, 'Content-Type': 'application/json' },
      body: body != null ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) throw new Error(`syncthing ${method} ${route} -> ${res.status} ${await res.text()}`);
    const txt = await res.text();
    return txt ? JSON.parse(txt) : null;
  }

  /** This machine's cryptographic identity. */
  async getDeviceId() {
    const s = await this.api('GET', '/rest/system/status');
    return s.myID;
  }

  /** Pair a remote machine by Device ID (idempotent). */
  async addDevice(deviceId, name) {
    const devices = await this.api('GET', '/rest/config/devices');
    if (devices.some((d) => d.deviceID === deviceId)) return;
    await this.api('POST', '/rest/config/devices', {
      deviceID: deviceId, name: name || deviceId.slice(0, 7), addresses: ['dynamic'], autoAcceptFolders: true,
    });
  }

  /** Share (or create + share) the vault folder with the given device(s). */
  async shareVault(folderId, label, folderPath, deviceIds) {
    let folder;
    try { folder = await this.api('GET', `/rest/config/folders/${folderId}`); } catch { folder = null; }
    const devEntries = deviceIds.map((id) => ({ deviceID: id }));
    if (!folder) {
      const me = await this.getDeviceId();
      await this.api('POST', '/rest/config/folders', {
        id: folderId, label: label || folderId, path: folderPath, type: 'sendreceive',
        devices: [{ deviceID: me }, ...devEntries],
      });
    } else {
      const have = new Set(folder.devices.map((d) => d.deviceID));
      folder.devices.push(...devEntries.filter((d) => !have.has(d.deviceID)));
      await this.api('PUT', `/rest/config/folders/${folderId}`, folder);
    }
  }

  async listDevices() { return this.api('GET', '/rest/config/devices'); }

  /** Unpair a remote machine: drop it from every folder share, then delete it. */
  async removeDevice(deviceId) {
    try {
      const folders = await this.api('GET', '/rest/config/folders');
      for (const f of folders) {
        if ((f.devices || []).some((d) => d.deviceID === deviceId)) {
          f.devices = f.devices.filter((d) => d.deviceID !== deviceId);
          await this.api('PUT', `/rest/config/folders/${f.id}`, f);
        }
      }
    } catch { /* folder cleanup is best-effort */ }
    await this.api('DELETE', `/rest/config/devices/${deviceId}`);
  }

  stop() { if (this.proc) { try { this.proc.kill(); } catch { /* */ } this.proc = null; } }
}
