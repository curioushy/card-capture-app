import { navigate, app, showToast } from '../app.js';
import { listSessions, listContacts, updateSession, deleteSession } from '../db.js';
import { exportJSON } from '../export.js';

export async function renderSessions(el) {
  el.innerHTML = `
    <div style="padding:16px 16px 8px;display:flex;align-items:center;justify-content:space-between;">
      <h2 style="font-size:20px;font-weight:800;">Sessions</h2>
      <button class="btn btn-primary" id="newSessionBtn" style="padding:8px 14px;font-size:13px;">+ New</button>
    </div>
    <div id="sessionsList" style="padding-bottom:16px;"></div>
  `;

  el.querySelector('#newSessionBtn').addEventListener('click', () => navigate('new-session'));
  await loadSessions();

  async function loadSessions() {
    const [sessions, allContacts] = await Promise.all([listSessions(), listContacts()]);
    const listEl = el.querySelector('#sessionsList');

    if (sessions.length === 0) {
      listEl.innerHTML = `
        <div class="empty-state">
          <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
            <rect x="3" y="4" width="18" height="18" rx="2"/>
            <line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/>
            <line x1="3" y1="10" x2="21" y2="10"/>
          </svg>
          <p>No sessions yet.<br>Start a capture session.</p>
        </div>`;
      return;
    }

    // Count contacts per session
    const counts = {};
    allContacts.forEach(c => { counts[c.session_id] = (counts[c.session_id] || 0) + 1; });

    listEl.innerHTML = sessions.map(s => `
      <div class="session-card" data-id="${s.id}" style="
        margin:0 16px 10px;background:var(--surface);border-radius:var(--radius);
        border:1px solid var(--border);overflow:hidden;">

        <div style="display:flex;align-items:center;padding:14px 14px 10px;gap:12px;">
          <div style="flex:1;min-width:0;">
            <div class="session-name" data-id="${s.id}" style="
              font-size:16px;font-weight:700;color:var(--text);
              white-space:nowrap;overflow:hidden;text-overflow:ellipsis;"
              contenteditable="false">${escHtml(s.event_name)}</div>
            <div style="font-size:13px;color:var(--text-muted);margin-top:2px;">${s.date}</div>
          </div>
          ${s.is_open ? `<span style="font-size:11px;font-weight:700;color:var(--accent);
            background:var(--accent-light);padding:3px 8px;border-radius:20px;">OPEN</span>` : ''}
          <span style="font-size:13px;font-weight:600;color:var(--text-muted);
            background:var(--bg);border-radius:12px;padding:3px 10px;flex-shrink:0;">
            ${counts[s.id] || 0} contacts
          </span>
        </div>

        <div style="display:flex;border-top:1px solid var(--border);">
          <button class="session-action-btn view-btn" data-id="${s.id}"
            style="flex:1;padding:10px;border:none;background:none;font-size:13px;
            font-weight:600;color:var(--accent);cursor:pointer;font-family:var(--font);">
            View contacts
          </button>
          <div style="width:1px;background:var(--border);"></div>
          <button class="session-action-btn rename-btn" data-id="${s.id}"
            style="flex:1;padding:10px;border:none;background:none;font-size:13px;
            font-weight:600;color:var(--text-muted);cursor:pointer;font-family:var(--font);">
            Rename
          </button>
          <div style="width:1px;background:var(--border);"></div>
          <button class="session-action-btn export-btn" data-id="${s.id}"
            style="flex:1;padding:10px;border:none;background:none;font-size:13px;
            font-weight:600;color:var(--text-muted);cursor:pointer;font-family:var(--font);">
            Export
          </button>
          <div style="width:1px;background:var(--border);"></div>
          <button class="session-action-btn delete-btn" data-id="${s.id}"
            style="flex:1;padding:10px;border:none;background:none;font-size:13px;
            font-weight:600;color:var(--danger);cursor:pointer;font-family:var(--font);">
            Delete
          </button>
        </div>
      </div>
    `).join('');

    // View contacts
    listEl.querySelectorAll('.view-btn').forEach(btn => {
      btn.addEventListener('click', () => navigate('contacts', { session_id: btn.dataset.id }));
    });

    // Rename — inline edit
    listEl.querySelectorAll('.rename-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const nameEl = listEl.querySelector(`.session-name[data-id="${btn.dataset.id}"]`);
        nameEl.contentEditable = 'true';
        nameEl.focus();
        // Select all text
        const range = document.createRange();
        range.selectNodeContents(nameEl);
        window.getSelection().removeAllRanges();
        window.getSelection().addRange(range);
        btn.textContent = 'Done';

        async function save() {
          const newName = nameEl.textContent.trim();
          nameEl.contentEditable = 'false';
          btn.textContent = 'Rename';
          if (newName && newName !== sessions.find(s => s.id === btn.dataset.id)?.event_name) {
            await updateSession(btn.dataset.id, { event_name: newName });
            showToast('Session renamed');
          }
        }

        nameEl.addEventListener('blur', save, { once: true });
        nameEl.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); nameEl.blur(); } });
      });
    });

    // Export session as JSON
    listEl.querySelectorAll('.export-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        try {
          await exportJSON('session', btn.dataset.id);
          showToast('Session exported');
        } catch (e) {
          showToast('Export failed');
        }
      });
    });

    // Delete
    listEl.querySelectorAll('.delete-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        const session = sessions.find(s => s.id === btn.dataset.id);
        const count = counts[btn.dataset.id] || 0;
        if (!confirm(`Delete "${session?.event_name}"? This will also delete ${count} contact${count !== 1 ? 's' : ''}.`)) return;
        await deleteSession(btn.dataset.id);
        if (app.currentSession?.id === btn.dataset.id) app.currentSession = null;
        showToast('Session deleted');
        await loadSessions();
      });
    });
  }
}

function escHtml(s) {
  return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
