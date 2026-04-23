import { navigate, showToast, getTheme, setTheme } from '../app.js';
import { getMeta, listContacts, listSessions, deleteSession, clearAll } from '../db.js';
import { exportJSON, exportCSV, exportVCard } from '../export.js';
import { importFile, importJSON } from '../import.js';
import { getOCRLang, setOCRLang } from '../ocr.js';

export async function renderSettings(el) {
  el.innerHTML = `<div id="settingsInner" style="padding-bottom:24px;"></div>`;
  await renderSettingsInner();

  async function renderSettingsInner() {
    const [meta, contacts, sessions, swVersion] = await Promise.all([
      getMeta(), listContacts(), listSessions(), getSWVersion(),
    ]);
    const dbSizeMB = (JSON.stringify({ contacts, sessions }).length / 1024 / 1024).toFixed(2);
    const withImages = contacts.filter(c => c.card_image_front).length;

    const lastExport = meta?.last_export_at;
    const daysSince = lastExport ? Math.floor((Date.now() - lastExport) / 86400000) : null;
    const backupWarning = contacts.length > 0 && (daysSince === null || daysSince >= 7);
    const lastExportStr = lastExport
      ? `Last backup ${daysSince === 0 ? 'today' : daysSince === 1 ? 'yesterday' : `${daysSince} days ago`}`
      : 'Never backed up';

    el.querySelector('#settingsInner').innerHTML = `

      <!-- Quick Backup -->
      ${backupWarning ? `
        <div style="margin:12px 16px 0;background:#fff3cd;border:1px solid #ffc107;border-radius:var(--radius);padding:12px 14px;display:flex;align-items:center;justify-content:space-between;gap:12px;">
          <div>
            <div style="font-size:13px;font-weight:700;color:#856404;">Back up your data</div>
            <div style="font-size:12px;color:#856404;margin-top:2px;">${lastExportStr}</div>
          </div>
          <button class="btn btn-primary" id="quickBackupBannerBtn" style="padding:8px 14px;font-size:13px;flex-shrink:0;">
            Back up now
          </button>
        </div>` : ''}

      <!-- Storage -->
      <div class="section-title">Storage</div>
      <div class="settings-list">
        <div class="settings-row" style="cursor:default;">
          <span class="settings-row-label">Total contacts</span>
          <span class="settings-row-value">${contacts.length}</span>
        </div>
        <div class="settings-row" style="cursor:default;">
          <span class="settings-row-label">Total sessions</span>
          <span class="settings-row-value">${sessions.length}</span>
        </div>
        <div class="settings-row" style="cursor:default;">
          <span class="settings-row-label">DB size estimate</span>
          <span class="settings-row-value">~${dbSizeMB} MB</span>
        </div>
        <div class="settings-row" style="cursor:default;">
          <span class="settings-row-label">Card images stored</span>
          <span class="settings-row-value">${withImages}</span>
        </div>
      </div>

      <!-- Export -->
      <div class="section-title">Export</div>
      <div class="settings-list">
        <div class="settings-row" id="quickBackupBtn" style="background:var(--accent-light);">
          <span class="settings-row-label" style="color:var(--accent);font-weight:700;">
            ⚡ Quick backup — all data as JSON
          </span>
          <span style="font-size:11px;color:var(--text-muted);">${lastExportStr}</span>
        </div>
        <div class="settings-row" id="exportJSONBtn">
          <span class="settings-row-label">Export JSON (custom scope…)</span>
          <span class="settings-row-arrow">›</span>
        </div>
        <div class="settings-row" id="exportCSVBtn">
          <span class="settings-row-label">Export as CSV</span>
          <span class="settings-row-arrow">›</span>
        </div>
        <div class="settings-row" id="exportVCardBtn">
          <span class="settings-row-label">Export as vCard (.vcf)</span>
          <span class="settings-row-arrow">›</span>
        </div>
      </div>

      <!-- Import -->
      <div class="section-title">Import</div>
      <div class="settings-list">
        <div class="settings-row" id="importMergeBtn">
          <span class="settings-row-label">Import & Merge (JSON / CSV / vCard)</span>
          <span class="settings-row-arrow">›</span>
        </div>
        <div class="settings-row" id="importReplaceBtn">
          <span class="settings-row-label" style="color:var(--danger);">Import & Replace all data</span>
          <span class="settings-row-arrow">›</span>
        </div>
      </div>

      <!-- Clear -->
      <div class="section-title">Clear Data</div>
      <div class="settings-list">
        <div class="settings-row" id="clearSessionBtn">
          <span class="settings-row-label" style="color:var(--danger);">Clear a session…</span>
          <span class="settings-row-arrow">›</span>
        </div>
        <div class="settings-row" id="clearAllBtn">
          <span class="settings-row-label" style="color:var(--danger);">Clear all data (factory reset)</span>
          <span class="settings-row-arrow">›</span>
        </div>
      </div>

      <!-- Google Drive placeholder -->
      <div class="section-title">Google Drive Sync</div>
      <div class="settings-list" style="opacity:0.45;pointer-events:none;">
        <div class="settings-row">
          <span class="settings-row-label">Connect Google Drive</span>
          <span class="settings-row-value">Coming in v2</span>
        </div>
      </div>

      <!-- OCR Language -->
      <div class="section-title">OCR Language</div>
      <div class="settings-list">
        <div class="settings-row" style="cursor:default;gap:12px;flex-wrap:wrap;">
          <div style="flex:1;min-width:0;">
            <div class="settings-row-label">Recognition language</div>
            <div style="font-size:12px;color:var(--text-muted);margin-top:2px;">
              English only is faster and uses ~10 MB. Add Chinese if you scan
              cards with Simplified Chinese text (~30 MB extra on first use).
            </div>
          </div>
          <div style="display:flex;gap:6px;flex-shrink:0;" id="langSelector">
            <button class="lang-btn ${getOCRLang()==='eng'?'active':''}" data-lang="eng"
              style="padding:7px 12px;border-radius:var(--radius-sm);border:2px solid ${getOCRLang()==='eng'?'var(--accent)':'var(--border)'};
              background:${getOCRLang()==='eng'?'var(--accent-light)':'var(--surface)'};
              color:${getOCRLang()==='eng'?'var(--accent)':'var(--text-muted)'};
              font-size:13px;font-weight:600;cursor:pointer;font-family:var(--font);">
              English
            </button>
            <button class="lang-btn ${getOCRLang()==='eng+chi_sim'?'active':''}" data-lang="eng+chi_sim"
              style="padding:7px 12px;border-radius:var(--radius-sm);border:2px solid ${getOCRLang()==='eng+chi_sim'?'var(--accent)':'var(--border)'};
              background:${getOCRLang()==='eng+chi_sim'?'var(--accent-light)':'var(--surface)'};
              color:${getOCRLang()==='eng+chi_sim'?'var(--accent)':'var(--text-muted)'};
              font-size:13px;font-weight:600;cursor:pointer;font-family:var(--font);">
              EN + 中文
            </button>
          </div>
        </div>
      </div>

      <!-- Appearance -->
      <div class="section-title">Appearance</div>
      <div class="settings-list" style="margin:0 16px;">
        <div class="settings-row" style="cursor:default;gap:12px;">
          <span class="settings-row-label">Theme</span>
          <div style="display:flex;gap:6px;" id="themeSelector">
            ${['system','light','dark'].map(t => `
              <button class="theme-btn ${getTheme()===t?'active':''}" data-theme="${t}"
                style="flex:1;padding:7px 0;border-radius:var(--radius-sm);border:2px solid ${getTheme()===t?'var(--accent)':'var(--border)'};
                background:${getTheme()===t?'var(--accent-light)':'var(--surface)'};
                color:${getTheme()===t?'var(--accent)':'var(--text-muted)'};
                font-size:13px;font-weight:600;cursor:pointer;font-family:var(--font);">
                ${t[0].toUpperCase()+t.slice(1)}
              </button>`).join('')}
          </div>
        </div>
      </div>

      <!-- About -->
      <div class="section-title">About</div>
      <div class="settings-list">
        <div class="settings-row" style="cursor:default;">
          <span class="settings-row-label">App version</span>
          <span class="settings-row-value">1.0.0</span>
        </div>
        <div class="settings-row" style="cursor:default;">
          <span class="settings-row-label">Cache version</span>
          <span class="settings-row-value">${swVersion}</span>
        </div>
        <div class="settings-row" id="checkUpdateBtn" style="background:var(--accent-light);">
          <span class="settings-row-label" style="color:var(--accent);font-weight:700;">Force update (clear cache)</span>
          <span class="settings-row-arrow" style="color:var(--accent);">›</span>
        </div>
        <div class="settings-row" style="cursor:default;">
          <span class="settings-row-label">Schema version</span>
          <span class="settings-row-value">${meta?.schema_version || 1}</span>
        </div>
        <div class="settings-row" style="cursor:default;">
          <span class="settings-row-label">Device ID</span>
          <span class="settings-row-value" style="font-size:12px;">${(meta?.device_id || '').slice(0,12)}…</span>
        </div>
        <div class="settings-row" id="githubBtn">
          <span class="settings-row-label">View on GitHub</span>
          <span class="settings-row-arrow">›</span>
        </div>
      </div>
    `;

    bindActions(sessions);
  }

  function bindActions(sessions) {
    // Quick backup
    el.querySelector('#quickBackupBtn').addEventListener('click', async () => {
      await exportJSON();
      showToast('Backup downloaded ✓');
      renderSettingsInner(); // refresh "last backup" label
    });
    el.querySelector('#quickBackupBannerBtn')?.addEventListener('click', async () => {
      await exportJSON();
      showToast('Backup downloaded ✓');
      renderSettingsInner();
    });

    // Export
    el.querySelector('#exportJSONBtn').addEventListener('click', () => showExportModal('json'));
    el.querySelector('#exportCSVBtn').addEventListener('click', () => showExportModal('csv'));
    el.querySelector('#exportVCardBtn').addEventListener('click', async () => {
      await exportVCard();
      showToast('vCard exported');
    });

    // Import
    el.querySelector('#importMergeBtn').addEventListener('click', () => triggerImport('merge'));
    el.querySelector('#importReplaceBtn').addEventListener('click', () => triggerImport('replace'));

    // Clear session
    el.querySelector('#clearSessionBtn').addEventListener('click', () => showClearSessionModal(sessions));

    // Clear all
    el.querySelector('#clearAllBtn').addEventListener('click', () => showClearAllModal());

    // OCR Language
    el.querySelector('#langSelector').addEventListener('click', e => {
      const btn = e.target.closest('.lang-btn');
      if (!btn) return;
      setOCRLang(btn.dataset.lang);
      el.querySelectorAll('.lang-btn').forEach(b => {
        const active = b.dataset.lang === btn.dataset.lang;
        b.style.borderColor = active ? 'var(--accent)' : 'var(--border)';
        b.style.background  = active ? 'var(--accent-light)' : 'var(--surface)';
        b.style.color       = active ? 'var(--accent)' : 'var(--text-muted)';
      });
      showToast(btn.dataset.lang === 'eng+chi_sim'
        ? 'Chinese enabled — will download ~30 MB on next scan'
        : 'English only — faster and lighter');
    });

    // Theme
    el.querySelector('#themeSelector').addEventListener('click', e => {
      const btn = e.target.closest('.theme-btn');
      if (!btn) return;
      setTheme(btn.dataset.theme);
      // Update button styles in-place
      el.querySelectorAll('.theme-btn').forEach(b => {
        const active = b.dataset.theme === btn.dataset.theme;
        b.classList.toggle('active', active);
        b.style.borderColor = active ? 'var(--accent)' : 'var(--border)';
        b.style.background  = active ? 'var(--accent-light)' : 'var(--surface)';
        b.style.color       = active ? 'var(--accent)' : 'var(--text-muted)';
      });
    });

    // GitHub
    el.querySelector('#githubBtn').addEventListener('click', () => {
      window.open('https://github.com/curioushy/card-capture-app', '_blank');
    });

    // Force update — unregisters all SWs, clears all caches, hard-reloads.
    // This is the nuclear option for when the SW is stuck on an old version.
    el.querySelector('#checkUpdateBtn')?.addEventListener('click', async () => {
      showToast('Clearing cache…');
      try {
        // 1. Unregister every SW for this origin
        if ('serviceWorker' in navigator) {
          const regs = await navigator.serviceWorker.getRegistrations();
          await Promise.all(regs.map(r => r.unregister()));
        }
        // 2. Delete every cache entry
        if ('caches' in window) {
          const keys = await caches.keys();
          await Promise.all(keys.map(k => caches.delete(k)));
        }
        showToast('Done — reloading…');
        // reload(true) is deprecated/ignored in Chrome — use URL bust instead
        // which forces a genuine fresh fetch of all resources.
        setTimeout(() => {
          window.location.replace(window.location.pathname + '?bust=' + Date.now());
        }, 700);
      } catch (e) {
        showToast('Error: ' + e.message);
        setTimeout(() => {
          window.location.replace(window.location.pathname + '?bust=' + Date.now());
        }, 1000);
      }
    });
  }

  async function getSWVersion() {
    try {
      if (!('caches' in window)) return 'n/a';
      const keys = await caches.keys();
      const ours = keys.find(k => k.startsWith('card-capture-'));
      return ours || 'no cache';
    } catch {
      return 'unknown';
    }
  }

  function showExportModal(format) {
    const modal = createModal(`Export as ${format.toUpperCase()}`, `
      <div class="form-group">
        <label class="form-label">Scope</label>
        <div style="display:flex;flex-direction:column;gap:8px;">
          <label style="display:flex;align-items:center;gap:8px;font-size:15px;">
            <input type="radio" name="scope" value="all" checked> All contacts
          </label>
          <label style="display:flex;align-items:center;gap:8px;font-size:15px;">
            <input type="radio" name="scope" value="tier"> By tier
          </label>
        </div>
      </div>
      <div id="tierPicker" style="display:none;margin-top:8px;">
        <div class="tier-selector">
          ${[1,2,3,4].map(t => `<button class="tier-btn t${t}" data-tier="${t}" type="button">T${t}</button>`).join('')}
        </div>
      </div>
      <button class="btn btn-primary btn-full" id="doExportBtn" style="margin-top:16px;">Download</button>
    `);

    const selectedTiers = new Set();

    modal.querySelectorAll('[name="scope"]').forEach(r => {
      r.addEventListener('change', () => {
        modal.querySelector('#tierPicker').style.display = r.value === 'tier' ? 'block' : 'none';
      });
    });

    modal.querySelectorAll('.tier-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const t = Number(btn.dataset.tier);
        if (selectedTiers.has(t)) { selectedTiers.delete(t); btn.classList.remove('active'); }
        else { selectedTiers.add(t); btn.classList.add('active'); }
      });
    });

    modal.querySelector('#doExportBtn').addEventListener('click', async () => {
      const scope = modal.querySelector('[name="scope"]:checked').value;
      closeModal(modal);
      try {
        if (format === 'json') await exportJSON(scope, null, scope === 'tier' ? [...selectedTiers] : null);
        else if (format === 'csv') await exportCSV(scope, null, scope === 'tier' ? [...selectedTiers] : null);
        showToast(`${format.toUpperCase()} exported`);
      } catch (e) {
        showToast(`Export failed: ${e.message}`);
      }
    });
  }

  function triggerImport(mode) {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json,.csv,.vcf';
    input.onchange = async () => {
      if (!input.files[0]) return;
      const file = input.files[0];

      if (mode === 'replace') {
        if (!confirm('This will DELETE all current data and replace with the imported file. Continue?')) return;
        // Force export first
        try { await exportJSON(); } catch (_) {}
      }

      try {
        let result;
        if (file.name.endsWith('.json') && mode === 'replace') {
          result = await importJSON(file, 'replace');
        } else {
          result = await importFile(file);
        }
        showToast(`Imported ${result.contacts} contacts`);
        renderSettingsInner();
      } catch (e) {
        showToast(`Import failed: ${e.message}`);
      }
    };
    input.click();
  }

  function showClearSessionModal(sessions) {
    if (sessions.length === 0) { showToast('No sessions to clear'); return; }
    const modal = createModal('Clear a Session', `
      <div style="display:flex;flex-direction:column;gap:8px;">
        ${sessions.map(s => `
          <div style="display:flex;align-items:center;justify-content:space-between;padding:10px;border:1px solid var(--border);border-radius:var(--radius-sm);">
            <div>
              <div style="font-size:14px;font-weight:600;">${escHtml(s.event_name)}</div>
              <div style="font-size:12px;color:var(--text-muted);">${s.date}</div>
            </div>
            <button class="btn btn-danger" style="font-size:13px;padding:6px 12px;" data-session-id="${s.id}">Delete</button>
          </div>
        `).join('')}
      </div>
    `);

    modal.querySelectorAll('[data-session-id]').forEach(btn => {
      btn.addEventListener('click', async () => {
        if (!confirm('Delete this session and all its contacts?')) return;
        await deleteSession(btn.dataset.sessionId);
        closeModal(modal);
        showToast('Session deleted');
        renderSettingsInner();
      });
    });
  }

  async function showClearAllModal() {
    const modal = createModal('Factory Reset', `
      <p style="font-size:14px;color:var(--text-muted);margin-bottom:16px;">
        This will permanently delete ALL contacts, sessions, and data.
        A JSON backup will be downloaded first.
      </p>
      <div class="form-group">
        <label class="form-label">Type CLEAR to confirm</label>
        <input class="form-input" id="clearConfirmInput" type="text" placeholder="CLEAR" autocomplete="off">
      </div>
      <button class="btn btn-danger btn-full" id="doClearBtn" disabled>Delete everything</button>
    `);

    modal.querySelector('#clearConfirmInput').addEventListener('input', e => {
      modal.querySelector('#doClearBtn').disabled = e.target.value !== 'CLEAR';
    });

    modal.querySelector('#doClearBtn').addEventListener('click', async () => {
      closeModal(modal);
      // Force JSON backup first
      try { await exportJSON(); } catch (_) {}
      await clearAll();
      showToast('All data cleared');
      renderSettingsInner();
    });
  }

  function createModal(title, bodyHtml) {
    const backdrop = document.createElement('div');
    backdrop.className = 'modal-backdrop';
    backdrop.innerHTML = `
      <div class="modal-sheet">
        <div class="modal-handle"></div>
        <div class="modal-title">${escHtml(title)}</div>
        ${bodyHtml}
        <button class="btn btn-ghost btn-full" id="modalCancelBtn" style="margin-top:8px;">Cancel</button>
      </div>
    `;
    backdrop.querySelector('#modalCancelBtn').addEventListener('click', () => closeModal(backdrop));
    backdrop.addEventListener('click', e => { if (e.target === backdrop) closeModal(backdrop); });
    document.body.appendChild(backdrop);
    return backdrop;
  }

  function closeModal(el) { el.remove(); }
}

function escHtml(s) {
  return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
