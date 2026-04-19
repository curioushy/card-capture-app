import { navigate, showToast } from '../app.js';
import { listContacts, listSessions, softDeleteContact } from '../db.js';

export async function renderContacts(el, params = {}) {
  el.innerHTML = `
    <div class="search-bar">
      <div class="search-input-wrap">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
        </svg>
        <input class="search-input" id="searchInput" type="search" placeholder="Search name, company, email…" value="">
      </div>
    </div>

    <div class="filter-chips" id="filterChips">
      <button class="filter-chip active" data-filter="all">All</button>
      <button class="filter-chip" data-filter="1">T1</button>
      <button class="filter-chip" data-filter="2">T2</button>
      <button class="filter-chip" data-filter="3">T3</button>
      <button class="filter-chip" data-filter="4">T4</button>
    </div>

    <div id="contactsList"></div>
  `;

  let activeFilter = 'all';
  let searchTerm = '';
  let allContacts = [];
  let sessions = {};

  async function load() {
    try {
      const [contacts, sess] = await Promise.all([listContacts(), listSessions()]);
      allContacts = contacts;
      sess.forEach(s => { sessions[s.id] = s; });

      // Add session filter chips
      const chips = el.querySelector('#filterChips');
      const existing = new Set([...chips.querySelectorAll('.filter-chip')].map(c => c.dataset.filter));
      const uniqueSessions = [...new Set(contacts.map(c => c.session_id).filter(Boolean))];
      uniqueSessions.forEach(sid => {
        if (!existing.has(sid) && sessions[sid]) {
          const chip = document.createElement('button');
          chip.className = 'filter-chip';
          chip.dataset.filter = sid;
          chip.textContent = sessions[sid].event_name;
          chips.appendChild(chip);
        }
      });

      // Apply initial session filter from params
      if (params.session_id) {
        activeFilter = params.session_id;
        chips.querySelectorAll('.filter-chip').forEach(c => {
          c.classList.toggle('active', c.dataset.filter === activeFilter);
        });
      }

      render();
    } catch (e) {
      el.querySelector('#contactsList').innerHTML = `<p style="padding:16px;color:var(--danger);">Failed to load contacts.</p>`;
    }
  }

  function render() {
    let filtered = allContacts;

    if (activeFilter !== 'all') {
      if (['1','2','3','4'].includes(activeFilter)) {
        const tier = Number(activeFilter);
        filtered = filtered.filter(c => tier === 4 ? (c.tier === null || c.tier === 4) : c.tier === tier);
      } else {
        filtered = filtered.filter(c => c.session_id === activeFilter);
      }
    }

    if (searchTerm) {
      const s = searchTerm.toLowerCase();
      filtered = filtered.filter(c =>
        (c.name || '').toLowerCase().includes(s) ||
        (c.company || '').toLowerCase().includes(s) ||
        (c.emails || []).some(e => e.toLowerCase().includes(s)) ||
        (sessions[c.session_id]?.event_name || '').toLowerCase().includes(s)
      );
    }

    const listEl = el.querySelector('#contactsList');
    if (filtered.length === 0) {
      listEl.innerHTML = `
        <div class="empty-state">
          <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
            <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/>
            <circle cx="9" cy="7" r="4"/>
            <path d="M23 21v-2a4 4 0 0 0-3-3.87"/>
            <path d="M16 3.13a4 4 0 0 1 0 7.75"/>
          </svg>
          <p>No contacts yet.<br>Start a capture session.</p>
        </div>`;
      return;
    }

    listEl.innerHTML = filtered.map(c => {
      const initial = (c.name || '?').trim()[0].toUpperCase();
      const sub = [c.title, c.company].filter(Boolean).join(' · ');
      const eventName = sessions[c.session_id]?.event_name || '';
      const tierHtml = c.tier ? `<span class="tier-chip t${c.tier}">T${c.tier}</span>` : '';
      return `
        <div class="contact-row" data-id="${c.id}">
          <div class="avatar">${escHtml(initial)}</div>
          <div class="contact-row-info">
            <div class="contact-row-name">${escHtml(c.name || '(no name)')}</div>
            <div class="contact-row-sub">${escHtml(sub)}</div>
          </div>
          <div class="contact-row-right">
            ${tierHtml}
            <span style="font-size:11px;color:var(--text-muted);">${escHtml(eventName)}</span>
          </div>
        </div>`;
    }).join('');

    // Touch-based swipe-to-delete
    listEl.querySelectorAll('.contact-row').forEach(row => {
      row.addEventListener('click', () => navigate('contact-detail', { id: row.dataset.id }));

      let startX = null;
      row.addEventListener('touchstart', e => { startX = e.touches[0].clientX; }, { passive: true });
      row.addEventListener('touchend', async e => {
        if (startX === null) return;
        const dx = e.changedTouches[0].clientX - startX;
        startX = null;
        if (dx < -80) {
          if (!confirm('Delete this contact?')) return;
          await softDeleteContact(row.dataset.id);
          allContacts = allContacts.filter(c => c.id !== row.dataset.id);
          showToast('Contact deleted');
          render();
        }
      });
    });
  }

  // Search
  el.querySelector('#searchInput').addEventListener('input', e => {
    searchTerm = e.target.value;
    render();
  });

  // Filter chips
  el.querySelector('#filterChips').addEventListener('click', e => {
    const chip = e.target.closest('.filter-chip');
    if (!chip) return;
    activeFilter = chip.dataset.filter;
    el.querySelectorAll('.filter-chip').forEach(c => c.classList.toggle('active', c === chip));
    render();
  });

  load();
}

function escHtml(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
