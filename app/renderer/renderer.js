// GUI logic. Talks to the engine only through window.api (see preload.cjs).

// Fallback so the shell renders in a plain browser / preview (no Electron engine).
if (!window.api) {
  const demoSettings = { scheduleAt: '03:00', schedulePushOnly: true, autoMergeIfNoConflicts: true, promptOnOpen: true, autoMerge: false, awsDiscovery: '' };
  window.api = {
    status: async () => ({
      machineName: 'this-computer', platform: '(preview)', vaultDir: null, claudeRunning: false,
      paths: { registration: { exists: true }, transcripts: { projectFolders: 15 }, recents: { entries: 14 }, cli: { path: '(bundled)' } },
      projects: [], devices: [], settings: demoSettings,
    }),
    getConfig: async () => ({ projects: [], devices: [], settings: demoSettings }),
    deviceId: async () => ({ deviceId: 'PREVIEW-DEVICEID-NO-SYNCTHING' }),
    pair: async () => ({ ok: true, devices: 2 }),
    shareVault: async () => ({ ok: true }),
    setSetting: async () => {}, setVault: async () => {}, addProject: async () => {},
    push: async () => ({ ok: false }), pull: async () => ({ ok: false }),
    syncAll: async () => ({ push: [], pull: { blocked: false, results: [] } }),
    discover: async () => ([{ name: 'Example Project', localPath: 'C:\\…\\Example Project' }]),
    linkAll: async () => ({ added: 0, total: 0 }),
    openExternal: async () => {}, onAction: () => {},
  };
}

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

// ---- navigation ----
$$('.nav').forEach((btn) => {
  btn.addEventListener('click', () => {
    $$('.nav').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    const target = btn.dataset.screen;
    $$('.screen').forEach((s) => s.classList.toggle('hidden', s.id !== `screen-${target}`));
  });
});

function pill(good, goodText, badText) {
  return `<span class="pill ${good ? 'ok' : 'warn'}">${good ? goodText : badText}</span>`;
}

// ---- Status ----
async function renderStatus() {
  const s = await window.api.status();
  const p = s.paths;
  $('#statusCards').innerHTML = `
    <div class="card">
      <div class="label">This computer</div>
      <div class="kv"><span class="k">Name</span><span class="v">${s.machineName}</span></div>
      <div class="kv"><span class="k">Platform</span><span class="v">${s.platform}</span></div>
      <div class="kv"><span class="k">Vault</span><span class="v">${s.vaultDir || '<span class="muted">not set</span>'}</span></div>
      <div class="kv"><span class="k">Claude running</span><span class="v">${pill(!s.claudeRunning, 'closed (safe)', 'running')}</span></div>
    </div>
    <div class="card">
      <div class="label">Claude data found</div>
      <div class="kv"><span class="k">Registration</span><span class="v">${pill(p.registration.exists, 'found', 'missing')}</span></div>
      <div class="kv"><span class="k">Transcripts</span><span class="v">${p.transcripts.projectFolders ?? 0} project folders</span></div>
      <div class="kv"><span class="k">Recents tiles</span><span class="v">${p.recents.entries ?? 0} entries</span></div>
      <div class="kv"><span class="k">Bundled CLI</span><span class="v">${pill(!!p.cli.path, 'found', 'none')}</span></div>
    </div>
    <div class="card">
      <div class="label">Sync</div>
      <div class="kv"><span class="k">Linked projects</span><span class="v">${s.projects.length}</span></div>
      <div class="kv"><span class="k">Paired devices</span><span class="v">${s.devices.length}</span></div>
      <div class="kv"><span class="k">Daily run</span><span class="v">${s.settings.scheduleAt} ${s.settings.schedulePushOnly ? '(push only)' : '(full)'}</span></div>
    </div>`;
}

// ---- Devices ----
async function renderDevices() {
  $('#thisDevice').textContent = 'starting Syncthing…';
  const d = await window.api.deviceId();
  $('#thisDevice').textContent = d.deviceId || ('unavailable: ' + (d.error || d.note || '?'));
  const cfg = await window.api.getConfig();
  const list = $('#deviceList');
  list.innerHTML = (cfg.devices && cfg.devices.length)
    ? cfg.devices.map((x) => `<div class="kv"><span class="k">${x.name}</span><span class="v mono">${x.syncthingId}</span></div>`).join('')
    : 'None yet.';
}

// ---- Projects ----
async function renderProjects() {
  const cfg = await window.api.getConfig();
  const list = $('#projectList');
  list.innerHTML = cfg.projects.length
    ? cfg.projects.map((p) => `<div class="card"><div class="kv"><span class="k">${p.name}</span><span class="v">${p.localPath}</span></div></div>`).join('')
    : 'No projects linked yet.';
  const discovered = await window.api.discover();
  const dl = $('#discoverList');
  dl.innerHTML = discovered.length
    ? discovered.map((p) => `<div class="card"><div class="kv"><span class="k">${p.name}</span><span class="v">${p.localPath}</span></div></div>`).join('')
    : 'None — all detected projects are linked.';
  $('#addAll').disabled = discovered.length === 0;
}

function summarizeSync(res) {
  const pushed = (res.push || []).reduce((a, r) => a + (r.pushed?.length || 0), 0);
  if (res.pull?.blocked) return `Pushed ${pushed}. Pull skipped: ${res.pull.reason}`;
  const results = res.pull?.results || [];
  const sum = (key) => results.reduce((a, r) => a + ((r[key]?.length) || 0), 0);
  const pulled = sum('pulled'), forks = sum('forks'), conflicts = sum('conflicts'), available = sum('available');
  let s = `Pushed ${pushed}, pulled ${pulled} across all projects.`;
  if (forks) s += ` Auto-merged ${forks} conflict(s) (older copy kept as .fork).`;
  if (conflicts) s += ` ${conflicts} unresolved conflict(s) — turn on auto-merge or resolve manually.`;
  if (available) s += ` ${available} change(s) available, not applied.`;
  return s;
}

// ---- Schedule + Settings (two-way bound to config) ----
async function renderSettings() {
  const cfg = await window.api.getConfig();
  const st = cfg.settings;
  $('#scheduleAt').value = st.scheduleAt;
  $('#schedulePushOnly').checked = st.schedulePushOnly;
  $('#autoMergeIfNoConflicts').checked = st.autoMergeIfNoConflicts;
  $('#promptOnOpen').checked = st.promptOnOpen;
  $('#autoMerge').checked = st.autoMerge;
  $('#awsDiscovery').value = st.awsDiscovery || '';
}
function bindSetting(id, key, kind = 'check') {
  const el = $(`#${id}`);
  const ev = kind === 'check' ? 'change' : 'change';
  el.addEventListener(ev, async () => {
    const val = kind === 'check' ? el.checked : el.value;
    await window.api.setSetting(key, val);
  });
}

// ---- init ----
(async function init() {
  await renderStatus();
  await renderDevices();
  await renderProjects();
  await renderSettings();
  bindSetting('scheduleAt', 'scheduleAt', 'value');
  bindSetting('schedulePushOnly', 'schedulePushOnly');
  bindSetting('autoMergeIfNoConflicts', 'autoMergeIfNoConflicts');
  bindSetting('promptOnOpen', 'promptOnOpen');
  bindSetting('autoMerge', 'autoMerge');
  bindSetting('awsDiscovery', 'awsDiscovery', 'value');

  $('#copyId').addEventListener('click', () => {
    navigator.clipboard?.writeText($('#thisDevice').textContent);
  });

  $('#pairBtn')?.addEventListener('click', async () => {
    const id = $('#pairId').value.trim();
    if (!id) { $('#pairResult').textContent = 'Paste the other computer\'s Device ID first.'; return; }
    $('#pairBtn').disabled = true; $('#pairResult').textContent = 'Pairing…';
    const r = await window.api.pair(id, $('#pairName').value.trim());
    $('#pairResult').textContent = r.ok ? `Paired. ${r.devices} device(s) known.` : `Failed: ${r.error}`;
    $('#pairId').value = ''; $('#pairName').value = '';
    $('#pairBtn').disabled = false;
    await renderDevices();
  });

  $('#shareVaultBtn')?.addEventListener('click', async () => {
    const r = await window.api.shareVault();
    $('#pairResult').textContent = r.ok ? 'Vault shared with paired devices.' : `Share failed: ${r.error}`;
  });

  async function doSyncAll(btn) {
    const labels = { '#syncNow': 'Sync all projects', '#syncAll': 'Sync all projects' };
    const orig = btn.textContent;
    btn.textContent = 'Syncing…'; btn.disabled = true;
    const res = await window.api.syncAll();
    $('#syncResult').textContent = summarizeSync(res);
    await renderStatus();
    btn.textContent = orig; btn.disabled = false;
  }
  $('#syncNow').addEventListener('click', (e) => doSyncAll(e.target));
  $('#syncAll').addEventListener('click', (e) => doSyncAll(e.target));
  $('#addAll').addEventListener('click', async () => {
    const discovered = await window.api.discover();
    const r = await window.api.linkAll(discovered);
    $('#syncResult').textContent = `Linked ${r.added} project(s).`;
    await renderProjects();
    await renderStatus();
  });
  window.api.onAction?.((name) => { if (name === 'sync-now') $('#syncNow').click(); });
})();
