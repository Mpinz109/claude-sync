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
    deviceId: async () => ({ deviceId: null, note: '(preview) — real Device ID appears once Syncthing is bundled' }),
    setSetting: async () => {}, setVault: async () => {}, addProject: async () => {},
    push: async () => ({ ok: false }), pull: async () => ({ ok: false }),
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
  const d = await window.api.deviceId();
  $('#thisDevice').textContent = d.deviceId || d.note || 'unavailable';
}

// ---- Projects ----
async function renderProjects() {
  const cfg = await window.api.getConfig();
  const list = $('#projectList');
  if (!cfg.projects.length) { list.innerHTML = 'No projects linked yet.'; return; }
  list.innerHTML = cfg.projects.map((p) =>
    `<div class="card"><div class="kv"><span class="k">${p.name}</span><span class="v">${p.localPath}</span></div></div>`).join('');
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
    const txt = $('#thisDevice').textContent;
    navigator.clipboard?.writeText(txt);
  });
  $('#syncNow').addEventListener('click', async () => {
    $('#syncNow').textContent = 'Syncing…';
    await window.api.push();
    await renderStatus();
    $('#syncNow').textContent = 'Sync now';
  });
  window.api.onAction?.((name) => { if (name === 'sync-now') $('#syncNow').click(); });
})();
