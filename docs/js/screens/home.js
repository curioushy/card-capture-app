import { navigate, app } from '../app.js';
import { listSessions, listContacts } from '../db.js';

export async function renderHome(el) {
  const sessions = await listSessions().catch(() => []);
  const recent = sessions.slice(0, 5);
  const counts = await Promise.all(recent.map(s => listContacts({ session_id: s.id }).catch(() => [])));

  const resumeBanner = app.currentSession
    ? `<div style="margin:0 16px 12px;background:var(--accent-light);border:1px solid #c8e6d8;border-radius:var(--radius);padding:12px 14px;display:flex;align-items:center;justify-content:space-between;">
         <div>
           <div style="font-size:13px;font-weight:700;color:var(--accent);">Session in progress</div>
           <div style="font-size:13px;color:var(--text-muted);">${escHtml(app.currentSession.event_name)}</div>
         </div>
         <button class="btn btn-primary" id="resumeBtn" style="padding:8px 14px;font-size:13px;">Resume →</button>
       </div>`
    : '';

  el.innerHTML = `
    <div style="padding:20px 16px 12px;">
      <h2 style="font-size:22px;font-weight:800;margin-bottom:4px;">Card Capture</h2>
      <p style="color:var(--text-muted);font-size:14px;">Scan business cards from your events</p>
    </div>

    ${resumeBanner}

    <div style="padding:0 16px 16px;">
      <button class="btn btn-primary btn-full" id="newSessionBtn" style="font-size:15px;padding:14px;">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
          <line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>
        </svg>
        New Session
      </button>
    </div>

    ${recent.length > 0 ? `
      <div class="section-title">Recent Sessions</div>
      <div id="sessionsList">
        ${recent.map((s, i) => `
          <div class="session-row" data-session-id="${s.id}">
            <div class="session-row-info">
              <div class="session-row-name">${escHtml(s.event_name)}</div>
              <div class="session-row-meta">${s.date}</div>
            </div>
            <span class="session-row-count">${counts[i].length}</span>
          </div>
        `).join('')}
      </div>
      <div style="padding:12px 16px;">
        <button class="btn btn-secondary btn-full" id="viewAllBtn">View all contacts →</button>
      </div>
    ` : `
      <div class="empty-state">
        <svg width="56" height="56" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.2">
          <rect x="2" y="4" width="20" height="16" rx="2"/>
          <line x1="8" y1="10" x2="16" y2="10"/><line x1="8" y1="14" x2="12" y2="14"/>
        </svg>
        <p>No sessions yet.<br>Tap New Session to start.</p>
      </div>
    `}
  `;

  el.querySelector('#newSessionBtn').addEventListener('click', () => navigate('new-session'));
  el.querySelector('#resumeBtn')?.addEventListener('click', () => navigate('capture'));
  el.querySelector('#viewAllBtn')?.addEventListener('click', () => navigate('contacts'));
  el.querySelectorAll('.session-row').forEach(row => {
    row.addEventListener('click', () => navigate('contacts', { session_id: row.dataset.sessionId }));
  });
}

function escHtml(s) {
  return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
