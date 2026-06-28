// Download the Syncthing binary for THIS OS/arch into vendor/syncthing/<os>/ so
// electron-builder can bundle it (see package.json build.extraResources). Run per
// OS in CI before `npm run dist`. Uses `tar` for extraction (bsdtar on Windows 10+
// handles .zip too, and GNU/bsd tar handles .tar.gz on macOS/Linux).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const VERSION = process.env.SYNCTHING_VERSION || '2.1.1';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

const osMap = { win32: 'windows', darwin: 'macos', linux: 'linux' };
const archMap = { x64: 'amd64', arm64: 'arm64' };
const stOs = osMap[process.platform];
const stArch = archMap[process.arch];
if (!stOs || !stArch) { console.error(`unsupported platform ${process.platform}/${process.arch}`); process.exit(1); }

const ext = process.platform === 'win32' ? 'zip' : 'tar.gz';
const base = `syncthing-${stOs}-${stArch}-v${VERSION}`;
const url = `https://github.com/syncthing/syncthing/releases/download/v${VERSION}/${base}.${ext}`;
const destDir = path.join(repoRoot, 'vendor', 'syncthing', stOs);
const exe = process.platform === 'win32' ? 'syncthing.exe' : 'syncthing';

if (fs.existsSync(path.join(destDir, exe))) { console.log('syncthing already vendored at', destDir); process.exit(0); }

const tmp = path.join(os.tmpdir(), `${base}.${ext}`);
console.log('downloading', url);
const res = await fetch(url);
if (!res.ok) { console.error('download failed', res.status); process.exit(1); }
fs.writeFileSync(tmp, Buffer.from(await res.arrayBuffer()));

const extractDir = path.join(os.tmpdir(), base + '-x');
fs.rmSync(extractDir, { recursive: true, force: true });
fs.mkdirSync(extractDir, { recursive: true });
const t = spawnSync('tar', ['-xf', tmp, '-C', extractDir], { stdio: 'inherit' });
if (t.status !== 0) { console.error('extract failed'); process.exit(1); }

// archive contains a top-level dir; find the binary inside
let found = null;
const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) {
  const f = path.join(d, e.name);
  if (e.isDirectory()) walk(f); else if (e.name === exe) found = f;
} };
walk(extractDir);
if (!found) { console.error('binary not found in archive'); process.exit(1); }

fs.mkdirSync(destDir, { recursive: true });
fs.copyFileSync(found, path.join(destDir, exe));
if (process.platform !== 'win32') fs.chmodSync(path.join(destDir, exe), 0o755);
console.log('vendored syncthing ->', path.join(destDir, exe));
