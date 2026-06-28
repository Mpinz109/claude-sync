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

// Syncthing's release asset OS names vs electron-builder's ${os} dir names differ.
const assetOs = { win32: 'windows', darwin: 'macos', linux: 'linux' }[process.platform];
const vendorOs = { win32: 'win', darwin: 'mac', linux: 'linux' }[process.platform]; // matches electron-builder ${os}
const stArch = { x64: 'amd64', arm64: 'arm64' }[process.arch];
if (!assetOs || !stArch) { console.error(`unsupported platform ${process.platform}/${process.arch}`); process.exit(1); }

const destDir = path.join(repoRoot, 'vendor', 'syncthing', vendorOs);
const exe = process.platform === 'win32' ? 'syncthing.exe' : 'syncthing';
if (fs.existsSync(path.join(destDir, exe))) { console.log('syncthing already vendored at', destDir); process.exit(0); }

// Asset naming varies (esp. macOS); try candidates and use the first that exists.
const rel = `https://github.com/syncthing/syncthing/releases/download/v${VERSION}`;
const candidates = process.platform === 'win32'
  ? [`syncthing-windows-${stArch}-v${VERSION}.zip`]
  : process.platform === 'darwin'
    ? [`syncthing-macos-${stArch}-v${VERSION}.zip`, `syncthing-macos-universal-v${VERSION}.zip`, `syncthing-macos-${stArch}-v${VERSION}.tar.gz`]
    : [`syncthing-linux-${stArch}-v${VERSION}.tar.gz`];

let tmp = null;
for (const name of candidates) {
  const url = `${rel}/${name}`;
  console.log('trying', url);
  const res = await fetch(url);
  if (res.ok) { tmp = path.join(os.tmpdir(), name); fs.writeFileSync(tmp, Buffer.from(await res.arrayBuffer())); break; }
  console.log('  ->', res.status);
}
if (!tmp) { console.error('no syncthing asset found for', assetOs, stArch); process.exit(1); }

const extractDir = path.join(os.tmpdir(), `syncthing-x-${process.pid}`);
fs.rmSync(extractDir, { recursive: true, force: true });
fs.mkdirSync(extractDir, { recursive: true });
const t = spawnSync('tar', ['-xf', tmp, '-C', extractDir], { stdio: 'inherit' });
if (t.status !== 0) { console.error('extract failed'); process.exit(1); }

// archive contains a top-level dir; find the binary inside (statSync, not Dirent — rule #6)
let found = null;
const walk = (d) => { for (const name of fs.readdirSync(d)) {
  const f = path.join(d, name);
  if (fs.statSync(f).isDirectory()) walk(f); else if (name === exe) found = f;
} };
walk(extractDir);
if (!found) { console.error('binary not found in archive'); process.exit(1); }

fs.mkdirSync(destDir, { recursive: true });
fs.copyFileSync(found, path.join(destDir, exe));
if (process.platform !== 'win32') fs.chmodSync(path.join(destDir, exe), 0o755);
console.log('vendored syncthing ->', path.join(destDir, exe));
