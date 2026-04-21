import { navigate, showToast } from '../app.js';
import { listContacts, listSessions, softDeleteContact, updateContact } from '../db.js';

export async function renderContacts(el, params = {}) {
  el.innerHTML = `
    <div class="search-bar" style="display:flex;align-items:center;gap:8px;">
      <div class="search-input-wrap" style="flex:1;">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
        </svg>
        <input class="search-input" id="searchInput" type="search" placeholder="Name, company, email…" autocomplete="off">
      </div>
      <button id="sortBtn" class="sort-btn">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
          <line x1="4" y1="6" x2="20" y2="6"/><line x1="4" y1="12" x2="14" y2="12"/><line x1="4" y1="18" x2="8" y2="18"/>
        </svg>
        <span id="sortLabel">Event</span>
      </button>
      <button id="selectBtn" class="sort-btn">Select</button>
    </div>

    <div class="filter-chips" id="filterChips">
      <button class="filter-chip active" data-filter="all">All</button>
      <button class="filter-chip t1-chip" data-filter="1">T1</button>
      <button class="filter-chip t2-chip" data-filter="2">T2</button>
      <button class="filter-chip t3-chip" data-filter="3">T3</button>
      <button class="filter-chip t4-chip" data-filter="4">T4</button>
    </div>

    <div id="contactsList"></div>

    <!-- Multi-select action bar -->
    <div id="selectBar" style="display:none;position:fixed;
      bottom:calc(var(--bottom-nav-h) + env(safe-area-inset-bottom));
      left:0;right:0;background:var(--surface);border-top:2px solid var(--accent);
      padding:12px 16px;align-items:center;justify-content:space-between;z-index:50;">
      <span id="selectCount" style="font-size:14px;font-weight:600;color:var(--text-muted);">0 selected</span>
      <div style="display:flex;gap:8px;">
        <button class="btn btn-secondary" id="selectAllBtn" style="padding:8px 14px;font-size:13px;">All</button>
        <button class="btn btn-danger"    id="deleteSelectedBtn" style="padding:8px 14px;font-size:13px;" disabled>Delete</button>
        <button class="btn btn-ghost"     id="cancelSelectBtn"   style="padding:8px 14px;font-size:13px;">Cancel</button>
      </div>
    </div>
  `;

  const SORT_MODES  = ['event', 'az', 'company'];
  const SORT_LABELS = { event: 'Event', az: 'A–Z', company: 'Co.' };
  let sortMode    = 'event';
  let activeFilter = 'all';
  let searchTerm   = '';
  let selectMode   = false;
  let selected     = new Set();
  let allContacts  = [];
  let sessions     = {};

  // Pending-undo delete state
  let undoPending  = null; // { id, timer }

  // ── Load ──────────────────────────────────────────────────────────────────
  async function load() {
    const [contacts, sess] = await Promise.all([listContacts(), listSessions()]);
    allContacts = contacts;
    sess.forEach(s => { sessions[s.id] = s; });

    // Add per-event chips
    const chips = el.querySelector('#filterChips');
    const existing = new Set([...chips.querySelectorAll('.filter-chip')].map(c => c.dataset.filter));
    sess.sort((a,b) => b.created_at - a.created_at).forEach(s => {
      if (!existing.has(s.id) && contacts.some(c => c.session_id === s.id)) {
        const chip = document.createElement('button');
        chip.className = 'filter-chip';
        chip.dataset.filter = s.id;
        chip.textContent = s.event_name;
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

  // ── Filter + sort ─────────────────────────────────────────────────────────
  function getFiltered() {
    let list = allContacts;

    if (activeFilter !== 'all') {
      if (['1','2','3','4'].includes(activeFilter)) {
        const t = Number(activeFilter);
        // T4 catches both explicit tier=4 and untiered (null)
        list = list.filter(c => t === 4 ? (!c.tier || c.tier === 4) : c.tier === t);
      } else {
        list = list.filter(c => c.session_id === activeFilter);
      }
    }

    if (searchTerm) {
      const s = searchTerm.toLowerCase();
      list = list.filter(c =>
        (c.name    || '').toLowerCase().includes(s) ||
        (c.company || '').toLowerCase().includes(s) ||
        (c.emails  || []).some(e => e.toLowerCase().includes(s)) ||
        (sessions[c.session_id]?.event_name || '').toLowerCase().includes(s) ||
        (c.tags    || []).some(t => t.toLowerCase().includes(s))
      );
    }

    if (sortMode === 'az')      return [...list].sort((a,b) => (a.name||'').localeCompare(b.name||''));
    if (sortMode === 'company') return [...list].sort((a,b) => (a.company||'').localeCompare(b.company||''));
    return list; // 'event' — stays in DB order (newest-first from listContacts)
  }

  // ── Render ────────────────────────────────────────────────────────────────
  function render() {
    const list   = getFiltered();
    const listEl = el.querySelector('#contactsList');
    listEl.style.paddingBottom = selectMode ? '72px' : '0';

    if (list.length === 0) {
      listEl.innerHTML = `
        <div class="empty-state">
          <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
            <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/>
          </svg>
          <p>No contacts yet.<br>Start a capture session.</p>
        </div>`;
      return;
    }

    // Group by session when sorting by event; flat for A-Z / Company
    const rows = sortMode === 'event'
      ? renderGrouped(list)
      : list.map(c => contactRowHtml(c)).join('');

    listEl.innerHTML = rows;
    attachRowHandlers(listEl);
  }

  function renderGrouped(list) {
    // Build session order: sessions with contacts, newest first
    const sessionOrder = Object.values(sessions)
      .sort((a,b) => b.created_at - a.created_at)
      .filter(s => list.some(c => c.session_id === s.id));

    const assignedIds = new Set(sessionOrder.flatMap(s => list.filter(c => c.session_id === s.id).map(c => c.id)));
    const orphans     = list.filter(c => !assignedIds.has(c.id));

    const parts = [];

    for (const sess of sessionOrder) {
      const group = list.filter(c => c.session_id === sess.id);
      parts.push(sectionHeaderHtml(sess, group.length));
      group.forEach(c => parts.push(contactRowHtml(c)));
    }

    if (orphans.length) {
      parts.push(sectionHeaderHtml(null, orphans.length));
      orphans.forEach(c => parts.push(contactRowHtml(c)));
    }

    return parts.join('');
  }

  function sectionHeaderHtml(sess, count) {
    const label = sess ? escHtml(sess.event_name) : 'Uncategorised';
    const date  = sess ? `· ${sess.date}` : '';
    return `
      <div class="contact-section-header">
        <span class="contact-section-name">${label} <span class="contact-section-date">${date}</span></span>
        <span class="contact-section-count">${count}</span>
      </div>`;
  }

  function contactRowHtml(c) {
    const tierNum   = c.tier || 4;
    const initial   = (c.name || '?').trim()[0].toUpperCase();
    const sub       = [c.title, c.company].filter(Boolean).join(' · ');
    const tierHtml  = c.tier ? `<span class="tier-chip t${c.tier}">T${c.tier}</span>` : '';
    const badge     = nextActionBadge(c);
    const isSelected = selected.has(c.id);

    return `
      <div class="contact-row cl-row" data-id="${c.id}"
           style="${isSelected ? 'background:var(--accent-light);' : ''}">
        <div class="cl-swipe-bg">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.5">
            <polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/>
          </svg>
          Delete
        </div>
        <div class="cl-row-inner">
          ${selectMode
            ? `<div class="cl-select-circle ${isSelected ? 'checked' : ''}">
                 ${isSelected ? '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="3"><polyline points="20 6 9 17 4 12"/></svg>' : ''}
               </div>`
            : `<div class="avatar avatar-t${tierNum}">${escHtml(initial)}</div>`
          }
          <div class="contact-row-info">
            <div class="contact-row-name">${escHtml(c.name || '(no name)')}</div>
            <div class="contact-row-sub">${escHtml(sub)}</div>
            ${badge}
          </div>
          <div class="cl-row-right">
            ${tierHtml}
            ${!selectMode ? quickActionsHtml(c) : ''}
          </div>
        </div>
      </div>`;
  }

  function quickActionsHtml(c) {
    const email = (c.emails || [])[0];
    const phone = (c.phones || [])[0];
    return `<div class="cl-quick-actions" data-stop="1">
      ${email ? `<a class="cl-qa-btn" href="mailto:${escAttr(email)}" data-stop="1">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/>
            <polyline points="22,6 12,13 2,6"/>
          </svg>
        </a>` : ''}
      ${phone ? `<a class="cl-qa-btn" href="tel:${escAttr(phone.replace(/\s/g,''))}" data-stop="1">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07A19.5 19.5 0 0 1 4.69 13 19.79 19.79 0 0 1 1.61 4.46 2 2 0 0 1 3.6 2.27h3a2 2 0 0 1 2 1.72c.127.96.361 1.903.7 2.81a2 2 0 0 1-.45 2.11L7.91 9.91a16 16 0 0 0 6.16 6.16l.95-.95a2 2 0 0 1 2.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0 1 22 16.92z"/>
          </svg>
        </a>` : ''}
    </div>`;
  }

  function nextActionBadge(c) {
    if (!c.next_action_date) return '';
    const due  = new Date(c.next_action_date);
    const now  = new Date(); now.setHours(0,0,0,0);
    const diff = Math.round((due - now) / 86400000);
    if (diff < 0)  return `<div class="na-badge na-overdue">⚡ ${c.next_action || 'Action'} — overdue</div>`;
    if (diff <= 7) return `<div class="na-badge na-soon">⚡ ${c.next_action || 'Action'} in ${diff === 0 ? 'today' : diff + 'd'}</div>`;
    return '';
  }

  // ── Row event handlers ────────────────────────────────────────────────────
  function attachRowHandlers(listEl) {
    listEl.querySelectorAll('.cl-row').forEach(row => {
      const inner = row.querySelector('.cl-row-inner');

      // Quick-action links — stop propagation so they don't trigger row tap
      row.querySelectorAll('[data-stop]').forEach(el => {
        el.addEventListener('click', e => e.stopPropagation());
      });

      // Tap to open detail or toggle select
      inner.addEventListener('click', () => {
        if (selectMode) {
          const id = row.dataset.id;
          selected.has(id) ? selected.delete(id) : selected.add(id);
          updateSelectBar(); render();
        } else {
          navigate('contact-detail', { id: row.dataset.id });
        }
      });

      // Swipe-to-delete (not in select mode)
      if (!selectMode) attachSwipeDelete(row);
    });
  }

  function attachSwipeDelete(row) {
    const inner = row.querySelector('.cl-row-inner');
    let startX = null, startY = null, swiping = false;
    const THRESHOLD = -72;

    row.addEventListener('touchstart', e => {
      startX = e.touches[0].clientX;
      startY = e.touches[0].clientY;
      swiping = false;
      inner.style.transition = 'none';
    }, { passive: true });

    row.addEventListener('touchmove', e => {
      if (startX === null) return;
      const dx = e.touches[0].clientX - startX;
      const dy = e.touches[0].clientY - startY;
      // Only commit to horizontal swipe if mostly horizontal
      if (!swiping && Math.abs(dy) > Math.abs(dx)) { startX = null; return; }
      if (dx > 0) return; // only left swipe
      swiping = true;
      const clamped = Math.max(dx, THRESHOLD * 1.5);
      inner.style.transform = `translateX(${clamped}px)`;
    }, { passive: true });

    row.addEventListener('touchend', e => {
      if (startX === null || !swiping) return;
      const dx = e.changedTouches[0].clientX - startX;
      startX = null; swiping = false;

      if (dx <= THRESHOLD) {
        // Commit delete — animate out, show undo toast
        inner.style.transition = 'transform 0.2s ease, opacity 0.2s ease';
        inner.style.transform  = 'translateX(-100%)';
        inner.style.opacity    = '0';
        setTimeout(() => {
          const id   = row.dataset.id;
          const name = allContacts.find(c => c.id === id)?.name || 'Contact';
          // Remove from live array immediately (optimistic)
          allContacts = allContacts.filter(c => c.id !== id);
          render();
          showUndoToast(name, id);
        }, 180);
      } else {
        // Snap back
        inner.style.transition = 'transform 0.2s ease';
        inner.style.transform  = '';
      }
    });
  }

  function showUndoToast(name, id) {
    // Cancel any in-flight undo
    if (undoPending) {
      clearTimeout(undoPending.timer);
      softDeleteContact(undoPending.id);
      undoPending = null;
    }

    // Show toast with Undo button
    let toastEl = document.querySelector('.undo-toast');
    if (!toastEl) {
      toastEl = document.createElement('div');
      toastEl.className = 'undo-toast';
      document.body.appendChild(toastEl);
    }
    toastEl.innerHTML = `
      <span>${escHtml(name)} deleted</span>
      <button class="undo-toast-btn" id="undoDeleteBtn">Undo</button>
    `;
    toastEl.classList.add('show');

    const timer = setTimeout(() => {
      softDeleteContact(id);
      toastEl.classList.remove('show');
      undoPending = null;
    }, 3500);

    undoPending = { id, timer };

    toastEl.querySelector('#undoDeleteBtn').addEventListener('click', () => {
      clearTimeout(timer);
      undoPending = null;
      toastEl.classList.remove('show');
      // Restore: remove _deleted flag
      updateContact(id, { _deleted: false }).then(() => load());
    });
  }

  // ── Select mode ───────────────────────────────────────────────────────────
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

  // ── Event wiring ──────────────────────────────────────────────────────────
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
    const count = selected.size;
    await Promise.all([...selected].map(id => softDeleteContact(id)));
    allContacts = allContacts.filter(c => !selected.has(c.id));
    showToast(`${count} contact${count !== 1 ? 's' : ''} deleted`);
    exitSelectMode();
  });

  el.querySelector('#cancelSelectBtn').addEventListener('click', exitSelectMode);

  el.querySelector('#searchInput').addEventListener('input', e => {
    searchTerm = e.target.value; render();
  });

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

function escAttr(s) {
  return String(s || '').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}
