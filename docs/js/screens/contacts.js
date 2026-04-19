import { navigate, showToast } from '../app.js';
import { listContacts, listSessions, softDeleteContact } from '../db.js';

export async function renderContacts(el, params = {}) {
  el.innerHTML = `
    <div class="search-bar" style="display:flex;align-items:center;gap:8px;">
      <div class="search-input-wrap" style="flex:1;">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
        </svg>
        <input class="search-input" id="searchInput" type="search" placeholder="Search name, company, email…">
      </div>
      <button id="sortBtn" style="flex-shrink:0;background:none;border:1px solid var(--border);
        border-radius:var(--radius-sm);padding:7px 10px;cursor:pointer;display:flex;align-items:center;gap:4px;
        font-size:12px;font-weight:600;color:var(--text-muted);font-family:var(--font);">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <line x1="4" y1="6" x2="20" y2="6"/><line x1="4" y1="12" x2="14" y2="12"/><line x1="4" y1="18" x2="8" y2="18"/>
        </svg>
        <span id="sortLabel">New</span>
      </button>
      <button id="selectBtn" style="flex-shrink:0;background:none;border:1px solid var(--border);
        border-radius:var(--radius-sm);padding:7px 10px;cursor:pointer;
        font-size:12px;font-weight:600;color:var(--text-muted);font-family:var(--font);">
        Select
      </button>
    </div>

    <div class="filter-chips" id="filterChips">
      <button class="filter-chip active" data-filter="all">All</button>
      <button class="filter-chip" data-filter="1">T1</button>
      <button class="filter-chip" data-filter="2">T2</button>
      <button class="filter-chip" data-filter="3">T3</button>
      <button class="filter-chip" data-filter="4">T4</button>
    </div>

    <div id="contactsList"></div>

    <div id="selectBar" style="display:none;position:fixed;
      bottom:calc(var(--bottom-nav-h) + env(safe-area-inset-bottom));
      left:0;right:0;background:var(--surface);border-top:2px solid var(--accent);
      padding:12px 16px;align-items:center;justify-content:space-between;z-index:50;">
      <span id="selectCount" style="font-size:14px;font-weight:600;color:var(--text-muted);">0 selected</span>
      <div style="display:flex;gap:8px;">
        <button class="btn btn-secondary" id="selectAllBtn" style="padding:8px 14px;font-size:13px;">All</button>
        <button class="btn btn-danger" id="deleteSelectedBtn" style="padding:8px 14px;font-size:13px;" disabled>Delete</button>
        <button class="btn btn-ghost" id="cancelSelectBtn" style="padding:8px 14px;font-size:13px;">Cancel</button>
      </div>
    </div>
  `;

  const SORT_MODES = ['newest', 'az', 'company'];
  const SORT_LABELS = { newest: 'New', az: 'A–Z', company: 'Co.' };
  let sortMode = 'newest';
  let activeFilter = 'all';
  let searchTerm = '';
  let selectMode = false;
  let selected = new Set();
  let allContacts = [];
  let sessions = {};

  async function load() {
    const [contacts, sess] = await Promise.all([listContacts(), listSessions()]);
    allContacts = contacts;
    sess.forEach(s => { sessions[s.id] = s; });

    const chips = el.querySelector('#filterChips');
    const existing = new Set([...chips.querySelectorAll('.filter-chip')].map(c => c.dataset.filter));
    [...new Set(contacts.map(c => c.session_id).filter(Boolean))].forEach(sid => {
      if (!existing.has(sid) && sessions[sid]) {
        const chip = document.createElement('button');
        chip.className = 'filter-chip';
        chip.dataset.filter = sid;
        chip.textContent = sessions[sid].event_name;
        chips.appendChild(chip);
      }
    });

    if (params.session_id) {
      activeFilter = params.session_id;
      chips.querySelectorAll('.filter-chip').forEach(c =>
        c.classList.toggle('active', c.dataset.filter === activeFilter));
    }

    render();
  }

  function getFiltered() {
    let list = allContacts;

    if (activeFilter !== 'all') {
      if (['1','2','3','4'].includes(activeFilter)) {
        const tier = Number(activeFilter);
        list = list.filter(c => tier === 4 ? (c.tier == null || c.tier === 4) : c.tier === tier);
      } else {
        list = list.filter(c => c.session_id === activeFilter);
      }
    }

    if (searchTerm) {
      const s = searchTerm.toLowerCase();
      list = list.filter(c =>
        (c.name||'').toLowerCase().includes(s) ||
        (c.company||'').toLowerCase().includes(s) ||
        (c.emails||[]).some(e => e.toLowerCase().includes(s)) ||
        (sessions[c.session_id]?.event_name||'').toLowerCase().includes(s)
      );
    }

    if (sortMode === 'az') return [...list].sort((a,b) => (a.name||'').localeCompare(b.name||''));
    if (sortMode === 'company') return [...list].sort((a,b) => (a.company||'').localeCompare(b.company||''));
    return list;
  }

  function render() {
    const list = getFiltered();
    const listEl = el.querySelector('#contactsList');
    listEl.style.paddingBottom = selectMode ? '72px' : '0';

    if (list.length === 0) {
      listEl.innerHTML = `
        <div class="empty-state">
          <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
            <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/>
            <circle cx="9" cy="7" r="4"/>
          </svg>
          <p>No contacts yet.<br>Start a capture session.</p>
        </div>`;
      return;
    }

    listEl.innerHTML = list.map(c => {
      const initial = (c.name || '?').trim()[0].toUpperCase();
      const sub = [c.title, c.company].filter(Boolean).join(' · ');
      const eventName = sessions[c.session_id]?.event_name || '';
      const tierHtml = c.tier ? `<span class="tier-chip t${c.tier}">T${c.tier}</span>` : '';
      const isSelected = selected.has(c.id);
      return `
        <div class="contact-row" data-id="${c.id}" style="${isSelected ? 'background:var(--accent-light);' : ''}">
          ${selectMode
            ? `<div style="width:24px;height:24px;border-radius:50%;flex-shrink:0;
                border:2px solid ${isSelected ? 'var(--accent)' : 'var(--border)'};
                background:${isSelected ? 'var(--accent)' : 'transparent'};
                display:flex;align-items:center;justify-content:center;">
                ${isSelected ? '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="3"><polyline points="20 6 9 17 4 12"/></svg>' : ''}
               </div>`
            : `<div class="avatar">${escHtml(initial)}</div>`
          }
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

    listEl.querySelectorAll('.contact-row').forEach(row => {
      row.addEventListener('click', () => {
        if (selectMode) {
          const id = row.dataset.id;
          selected.has(id) ? selected.delete(id) : selected.add(id);
          updateSelectBar(); render();
        } else {
          navigate('contact-detail', { id: row.dataset.id });
        }
      });

      if (!selectMode) {
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
      }
    });
  }

  function updateSelectBar() {
    el.querySelector('#selectBar').style.display = selectMode ? 'flex' : 'none';
    el.querySelector('#selectCount').textContent = `${selected.size} selected`;
    el.querySelector('#deleteSelectedBtn').disabled = selected.size === 0;
  }

  function enterSelectMode() {
    selectMode = true; selected.clear();
    el.querySelector('#selectBtn').textContent = 'Cancel';
    updateSelectBar(); render();
  }

  function exitSelectMode() {
    selectMode = false; selected.clear();
    el.querySelector('#selectBtn').textContent = 'Select';
    updateSelectBar(); render();
  }

  el.querySelector('#sortBtn').addEventListener('click', () => {
    sortMode = SORT_MODES[(SORT_MODES.indexOf(sortMode) + 1) % SORT_MODES.length];
    el.querySelector('#sortLabel').textContent = SORT_LABELS[sortMode];
    render();
  });

  el.querySelector('#selectBtn').addEventListener('click', () =>
    selectMode ? exitSelectMode() : enterSelectMode());

  el.querySelector('#selectAllBtn').addEventListener('click', () => {
    const list = getFiltered();
    if (selected.size === list.length) selected.clear();
    else list.forEach(c => selected.add(c.id));
    updateSelectBar(); render();
  });

  el.querySelector('#deleteSelectedBtn').addEventListener('click', async () => {
    if (!confirm(`Delete ${selected.size} contact${selected.size !== 1 ? 's' : ''}?`)) return;
    await Promise.all([...selected].map(id => softDeleteContact(id)));
    allContacts = allContacts.filter(c => !selected.has(c.id));
    showToast(`${selected.size} contacts deleted`);
    exitSelectMode();
  });

  el.querySelector('#cancelSelectBtn').addEventListener('click', exitSelectMode);
  el.querySelector('#searchInput').addEventListener('input', e => { searchTerm = e.target.value; render(); });
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
  return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
