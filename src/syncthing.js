// Syncthing manager (skeleton). The app bundles a Syncthing binary per OS,
// supervises it as a child process, and drives identity/pairing/sharing through
// its REST API. The user never sees or configures Syncthing directly.
//
// Phase 4 fills these in. Structure + the API shape are defined here so the GUI
// and engine can be built against it.

import fs from 'node:fs';
import path from 'node:path';
import { resolvePaths } from './platform.js';

export class Syncthing {
  constructor(opts = {}) {
    this.binPath = opts.binPath || null;     // bundled binary, set at packaging time
    this.apiKey = opts.apiKey || null;
    this.apiBase = opts.apiBase || 'http://127.0.0.1:8384';
    this.proc = null;
  }

  /** Locate the bundled binary (or a system install as a dev fallback). */
  findBinary() {
    const exe = process.platform === 'win32' ? 'syncthing.exe' : 'syncthing';
    const candidates = [
      this.binPath,
      path.join(process.resourcesPath || '', 'syncthing', exe), // packaged location
      path.join(resolvePaths().home, 'AppData', 'Local', 'Microsoft', 'WinGet', 'Links', exe),
    ].filter(Boolean);
    for (const c of candidates) { try { if (fs.existsSync(c)) return c; } catch { /* */ } }
    return null;
  }

  async start() { throw new Error('TODO(phase4): spawn syncthing, read config/apikey, wait for API'); }
  async stop() { if (this.proc) { this.proc.kill(); this.proc = null; } }

  async api(method, route, body) {
    const res = await fetch(this.apiBase + route, {
      method,
      headers: { 'X-API-Key': this.apiKey, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) throw new Error(`syncthing api ${route} -> ${res.status}`);
    return res.status === 204 ? null : res.json();
  }

  /** This machine's cryptographic identity (Syncthing Device ID). */
  async getDeviceId() {
    const s = await this.api('GET', '/rest/system/status');
    return s.myID;
  }

  /** Pair a remote machine by its Device ID, then auto-share the vault folder. */
  async addDevice(/* deviceId, name */) { throw new Error('TODO(phase4): /rest/config/devices'); }
  async shareVault(/* folderId, deviceId */) { throw new Error('TODO(phase4): /rest/config/folders'); }
  async setDiscoveryRelay(/* url */) { throw new Error('TODO(phase4): configure custom discovery/relay (AWS)'); }
}
