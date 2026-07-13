// GUI logic. Talks to the engine only through window.api (see preload.cjs).

// Fallback so the shell renders in a plain browser / preview (no Electron engine).
if (!window.api) {
  const demoSettings = { scheduleAt: '03:00', schedulePushOnly: true, autoMergeIfNoConflicts: true, incomingPolicy: 'merge', syncMode: 'push', promptOnOpen: true, autoMerge: false, awsDiscovery: '' };
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
    runSync: async () => ({ mode: 'push', steps: [{ step: 'push', results: [] }] }),
    setProjectSync: async () => ({ ok: true }),
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

// ---- saved-feedback toast ----
let toastTimer = null;
function flash(msg) {
  const t = $('#toast');
  if (!t) return;
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2200);
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
      <div class="kv"><span class="k">Daily run</span><span class="v">${s.settings.scheduleAt} (${{ push: 'publish only', pull: 'pull only', 'push-cloud': 'publish + cloud', full: 'full two-way' }[s.settings.syncMode] || s.settings.syncMode})</span></div>
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
    ? cfg.projects.map((p, i) => `
      <div class="card proj-row">
        <div class="info">
          <div>${p.name}</div>
          <div class="path">${p.localPath}</div>
        </div>
        <label class="switch" title="Sync this project">
          <input type="checkbox" data-proj="${encodeURIComponent(p.localPath)}" data-name="${p.name.replace(/"/g, '&quot;')}" ${p.syncEnabled !== false ? 'checked' : ''} />
          <span class="slider"></span>
        </label>
      </div>`).join('')
    : 'No projects linked yet.';
  list.querySelectorAll('input[data-proj]').forEach((el) => el.addEventListener('change', async () => {
    const r = await window.api.setProjectSync(decodeURIComponent(el.dataset.proj), el.checked);
    flash(r ? `${el.dataset.name}: sync ${el.checked ? 'on' : 'off'}` : 'Could not update project');
    await renderStatus();
  }));
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
const MODE_LABELS = { push: 'Publish only', pull: 'Pull only', 'push-cloud': 'Publish + cloud', full: 'Full two-way' };
const POLICY_LABELS = { 'ff-only': 'Apply only if unchanged here', merge: 'Merge lossless', manual: 'Tell me only' };
const POLICY_HINTS = {
  'ff-only': 'Incoming updates apply only when this computer hasn’t touched that conversation. If both sides changed it, yours is left alone and it’s reported instead.',
  merge: 'Divergent conversations are combined losslessly — nothing from either side is ever discarded, and an undo snapshot is written first.',
  manual: 'Nothing is ever applied automatically; incoming changes are only reported.',
};
const MODE_HINTS = {
  push: 'Uploads this computer’s new conversations. Never touches Claude’s local data.',
  pull: 'Receives other computers’ conversations; publishes nothing. The merge step skips itself if Claude is open.',
  'push-cloud': 'Publishes, plus mirrors the vault to your S3 bucket both ways. Never touches Claude’s local data.',
  full: 'Publishes AND merges incoming conversations into Claude. The merge step skips itself if Claude is open.',
};

async function renderSettings() {
  const cfg = await window.api.getConfig();
  const st = cfg.settings;
  $('#scheduleAt').value = st.scheduleAt;
  const mode = st.syncMode || 'push';
  $('#syncMode').value = mode;
  $('#syncModeHint').textContent = MODE_HINTS[mode] || '';
  const policy = st.incomingPolicy || (st.autoMergeIfNoConflicts === false ? 'manual' : 'merge');
  $('#incomingPolicy').value = policy;
  $('#incomingPolicyHint').textContent = POLICY_HINTS[policy] || '';
  $('#promptOnOpen').checked = st.promptOnOpen;
  $('#autoMerge').checked = st.autoMerge;
  $('#awsDiscovery').value = st.awsDiscovery || '';
}
const SETTING_LABELS = {
  scheduleAt: 'Daily run time', autoMergeIfNoConflicts: 'Auto-merge clean changes',
  promptOnOpen: 'Ask on open', autoMerge: 'Auto-resolve conflicts', awsDiscovery: 'Self-hosted relay',
};
function bindSetting(id, key, kind = 'check') {
  const el = $(`#${id}`);
  if (!el) return;
  el.addEventListener('change', async () => {
    const val = kind === 'check' ? el.checked : el.value;
    await window.api.setSetting(key, val);
    const label = SETTING_LABELS[key] || key;
    flash(kind === 'check' ? `${label}: ${val ? 'on' : 'off'} — saved` : `${label} saved`);
    await renderStatus();
  });
}

// ---- init ----
(async function init() {
  await renderStatus();
  await renderDevices();
  await renderProjects();
  await renderSettings();
  bindSetting('scheduleAt', 'scheduleAt', 'value');
  $('#syncMode').addEventListener('change', async () => {
    const mode = $('#syncMode').value;
    await window.api.setSetting('syncMode', mode);
    $('#syncModeHint').textContent = MODE_HINTS[mode] || '';
    flash(`Sync mode: ${MODE_LABELS[mode]} — saved`);
    await renderStatus();
  });
  $('#incomingPolicy').addEventListener('change', async () => {
    const policy = $('#incomingPolicy').value;
    await window.api.setSetting('incomingPolicy', policy);
    $('#incomingPolicyHint').textContent = POLICY_HINTS[policy] || '';
    flash(`Incoming changes: ${POLICY_LABELS[policy]} — saved`);
    await renderStatus();
  });
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
    const orig = btn.textContent;
    btn.textContent = 'Syncing…'; btn.disabled = true;
    try {
      const report = await window.api.runSync();
      $('#syncResult').textContent = summarizeRun(report);
    } catch (e) {
      $('#syncResult').textContent = `Sync failed: ${e.message || e}`;
    }
    await renderStatus();
    btn.textContent = orig; btn.disabled = false;
  }

  function summarizeRun(report) {
    const parts = [];
    for (const s of report.steps || []) {
      if (s.skipped) { parts.push(`${s.step} skipped (${s.skipped})`); continue; }
      if (s.step === 'cloud-pull') parts.push(`cloud: got ${s.downloaded.length}`);
      else if (s.step === 'cloud-push') parts.push(`cloud: sent ${s.uploaded.length}`);
      else if (s.step === 'push') {
        const n = s.results.reduce((a, r) => a + r.pushed.length, 0);
        const u = s.results.reduce((a, r) => a + (r.updated?.length || 0), 0);
        parts.push(`published ${n}${u ? ` (+${u} updated)` : ''}`);
      } else if (s.step === 'pull') {
        const n = s.results.reduce((a, r) => a + r.pulled.length, 0);
        const m = s.results.reduce((a, r) => a + (r.merged?.length || 0), 0);
        const c2 = s.results.reduce((a, r) => a + (r.conflicts?.length || 0), 0);
        parts.push(`pulled ${n}${m ? `, merged ${m}` : ''}${c2 ? `, ${c2} conflict(s)` : ''}`);
      }
    }
    return `Done (${report.mode}): ${parts.join(' · ') || 'nothing to do'}.`;
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
