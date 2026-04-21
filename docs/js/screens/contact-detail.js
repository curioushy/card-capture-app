import { navigate, showToast, setSyncDot } from '../app.js';
import { getContact, updateContact, softDeleteContact, getSession } from '../db.js';
import { exportVCard } from '../export.js';

export async function renderContactDetail(el, params = {}) {
  if (!params.id) { navigate('contacts'); return; }

  let contact = await getContact(params.id);
  if (!contact) { navigate('contacts'); return; }

  const session = contact.session_id ? await getSession(contact.session_id) : null;

  // ── Inline-add state ──────────────────────────────────────────────────────
  let addingEmail = false;
  let addingPhone = false;
  let addingTag   = false;

  // ── Render ────────────────────────────────────────────────────────────────
  function render() {
    const tierNum  = contact.tier || 4;
    const initial  = (contact.name || '?').trim()[0].toUpperCase();
    const email0   = (contact.emails || [])[0] || '';
    const phone0   = (contact.phones || [])[0] || '';
    const liHandle = contact.linkedin
      ? contact.linkedin.replace(/^https?:\/\/(www\.)?linkedin\.com\/in\//,'').replace(/\/$/,'')
      : '';
    const liUrl    = liHandle
      ? `https://www.linkedin.com/in/${liHandle}`
      : (contact.linkedin || '');

    el.innerHTML = `
      <div class="cd-wrap">

        <!-- ── Top bar ─────────────────────────────────────────── -->
        <div class="cd-top-bar">
          <button class="cd-back-btn" id="cdBack">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
              <polyline points="15 18 9 12 15 6"/>
            </svg>
          </button>
          <div class="cd-top-name">${escHtml(contact.name || 'Contact')}</div>
          <div class="cd-top-tier">
            ${contact.tier ? `<span class="tier-chip t${contact.tier}">T${contact.tier}</span>` : ''}
          </div>
        </div>

        <!-- ── Hero: avatar + card image ──────────────────────── -->
        <div class="cd-hero">
          <div class="cd-avatar avatar-t${tierNum}">${escHtml(initial)}</div>
          ${contact.card_image_front ? `
            <div class="cd-card-img-wrap" id="cdFrontWrap">
              <img src="${contact.card_image_front}" alt="Card" class="cd-card-img">
            </div>
            ${contact.card_image_back ? `
              <div class="cd-card-img-wrap cd-card-back-wrap" id="cdBackWrap" style="display:none;">
                <img src="${contact.card_image_back}" alt="Card back" class="cd-card-img">
              </div>
              <button class="cd-toggle-back btn btn-secondary" id="cdToggleBack" style="margin:0 16px 8px;font-size:13px;">
                Show back side
              </button>
            ` : ''}
          ` : ''}
        </div>

        <!-- ── Quick-action row ────────────────────────────────── -->
        <div class="cd-action-row">
          ${phone0 ? `
            <a class="cd-action-btn" href="tel:${escAttr(phone0.replace(/\s/g,''))}">
              <div class="cd-action-icon">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07A19.5 19.5 0 0 1 4.69 13 19.79 19.79 0 0 1 1.61 4.46 2 2 0 0 1 3.6 2.27h3a2 2 0 0 1 2 1.72c.127.96.361 1.903.7 2.81a2 2 0 0 1-.45 2.11L7.91 9.91a16 16 0 0 0 6.16 6.16l.95-.95a2 2 0 0 1 2.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0 1 22 16.92z"/>
                </svg>
              </div>
              <span>Call</span>
            </a>` : `<div class="cd-action-btn cd-action-disabled">
              <div class="cd-action-icon">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07A19.5 19.5 0 0 1 4.69 13 19.79 19.79 0 0 1 1.61 4.46 2 2 0 0 1 3.6 2.27h3a2 2 0 0 1 2 1.72c.127.96.361 1.903.7 2.81a2 2 0 0 1-.45 2.11L7.91 9.91a16 16 0 0 0 6.16 6.16l.95-.95a2 2 0 0 1 2.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0 1 22 16.92z"/>
                </svg>
              </div>
              <span>Call</span>
            </div>`}

          ${email0 ? `
            <a class="cd-action-btn" href="mailto:${escAttr(email0)}">
              <div class="cd-action-icon">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/>
                  <polyline points="22,6 12,13 2,6"/>
                </svg>
              </div>
              <span>Email</span>
            </a>` : `<div class="cd-action-btn cd-action-disabled">
              <div class="cd-action-icon">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/>
                  <polyline points="22,6 12,13 2,6"/>
                </svg>
              </div>
              <span>Email</span>
            </div>`}

          ${liUrl ? `
            <a class="cd-action-btn" href="${escAttr(liUrl)}" target="_blank" rel="noopener">
              <div class="cd-action-icon">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <path d="M16 8a6 6 0 0 1 6 6v7h-4v-7a2 2 0 0 0-2-2 2 2 0 0 0-2 2v7h-4v-7a6 6 0 0 1 6-6z"/>
                  <rect x="2" y="9" width="4" height="12"/><circle cx="4" cy="4" r="2"/>
                </svg>
              </div>
              <span>LinkedIn</span>
            </a>` : `<div class="cd-action-btn cd-action-disabled">
              <div class="cd-action-icon">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <path d="M16 8a6 6 0 0 1 6 6v7h-4v-7a2 2 0 0 0-2-2 2 2 0 0 0-2 2v7h-4v-7a6 6 0 0 1 6-6z"/>
                  <rect x="2" y="9" width="4" height="12"/><circle cx="4" cy="4" r="2"/>
                </svg>
              </div>
              <span>LinkedIn</span>
            </div>`}

          <button class="cd-action-btn" id="cdAddToContacts">
            <div class="cd-action-icon">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/>
                <circle cx="12" cy="7" r="4"/>
                <line x1="19" y1="8" x2="19" y2="14"/><line x1="16" y1="11" x2="22" y2="11"/>
              </svg>
            </div>
            <span>Add</span>
          </button>
        </div>

        <!-- ── Session context ─────────────────────────────────── -->
        ${session ? `
          <div class="cd-session-badge">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
              <rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/>
              <line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/>
            </svg>
            ${escHtml(session.event_name)} · ${session.date}
          </div>` : ''}

        <!-- ── Core fields ─────────────────────────────────────── -->
        <div class="cd-section-title">Contact info</div>
        <div class="confirm-fields cd-fields-card">
          ${editField('Name',     'name',     contact.name)}
          ${editField('Title',    'title',    contact.title)}
          ${editField('Company',  'company',  contact.company)}
          ${editField('LinkedIn', 'linkedin', contact.linkedin)}
          ${editField('Website',  'website',  contact.website)}
        </div>

        <!-- ── Emails ──────────────────────────────────────────── -->
        <div class="cd-section-title">Email</div>
        <div class="cd-chip-section">
          <div class="chip-input-wrap" id="emailChips">
            ${(contact.emails || []).map((e, i) => chipHtml(e, i, 'email')).join('')}
          </div>
          ${addingEmail ? `
            <div class="cd-inline-add" id="emailAddRow">
              <input class="cd-inline-input" id="emailAddInput" type="email"
                inputmode="email" placeholder="name@example.com" autocomplete="email">
              <button class="cd-inline-confirm" id="emailAddConfirm">Add</button>
              <button class="cd-inline-cancel"  id="emailAddCancel">✕</button>
            </div>` : `
            <button class="cd-add-link" id="addEmailBtn">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3">
                <line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>
              </svg>
              Add email
            </button>`}
        </div>

        <!-- ── Phones ──────────────────────────────────────────── -->
        <div class="cd-section-title">Phone</div>
        <div class="cd-chip-section">
          <div class="chip-input-wrap" id="phoneChips">
            ${(contact.phones || []).map((p, i) => chipHtml(p, i, 'phone')).join('')}
          </div>
          ${addingPhone ? `
            <div class="cd-inline-add" id="phoneAddRow">
              <input class="cd-inline-input" id="phoneAddInput" type="tel"
                inputmode="tel" placeholder="+1 555 000 0000" autocomplete="tel">
              <button class="cd-inline-confirm" id="phoneAddConfirm">Add</button>
              <button class="cd-inline-cancel"  id="phoneAddCancel">✕</button>
            </div>` : `
            <button class="cd-add-link" id="addPhoneBtn">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3">
                <line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>
              </svg>
              Add phone
            </button>`}
        </div>

        <!-- ── Tier ────────────────────────────────────────────── -->
        <div class="cd-section-title">Tier</div>
        <div class="cd-chip-section">
          <div class="tier-selector">
            ${[1,2,3,4].map(t => `
              <button class="tier-btn t${t} ${contact.tier === t ? 'active' : ''}" data-tier="${t}">T${t}</button>
            `).join('')}
          </div>
        </div>

        <!-- ── Context fields ──────────────────────────────────── -->
        <div class="cd-section-title">Context</div>
        <div class="confirm-fields cd-fields-card">
          ${editField('Intro\'d by', 'intro_by',    contact.intro_by)}
          ${editField('Next action', 'next_action',  contact.next_action)}
          <div class="confirm-field-row">
            <span class="confirm-field-label">By date</span>
            <input class="confirm-field-input" data-key="next_action_date" type="date"
              value="${escHtml(contact.next_action_date || '')}">
          </div>
        </div>

        <!-- ── Tags ───────────────────────────────────────────── -->
        <div class="cd-section-title">Tags</div>
        <div class="cd-chip-section">
          <div class="chip-input-wrap" id="tagChips">
            ${(contact.tags || []).map((t, i) => chipHtml(t, i, 'tag')).join('')}
          </div>
          ${addingTag ? `
            <div class="cd-inline-add" id="tagAddRow">
              <input class="cd-inline-input" id="tagAddInput" type="text"
                placeholder="tag name" autocomplete="off">
              <button class="cd-inline-confirm" id="tagAddConfirm">Add</button>
              <button class="cd-inline-cancel"  id="tagAddCancel">✕</button>
            </div>` : `
            <button class="cd-add-link" id="addTagBtn">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3">
                <line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>
              </svg>
              Add tag
            </button>`}
        </div>

        <!-- ── Notes ──────────────────────────────────────────── -->
        <div class="cd-section-title">Notes</div>
        <div class="cd-chip-section">
          <textarea class="cd-notes-input" data-key="notes"
            placeholder="Notes…" rows="3">${escHtml(contact.notes || '')}</textarea>
        </div>

        <!-- ── History + delete ────────────────────────────────── -->
        <div class="cd-meta">
          Captured ${new Date(contact.created_at).toLocaleDateString('en-GB', { day:'numeric', month:'short', year:'numeric' })}
          ${session ? ' · ' + escHtml(session.event_name) : ''}
          ${contact.updated_at !== contact.created_at
            ? ' · Edited ' + new Date(contact.updated_at).toLocaleDateString('en-GB', { day:'numeric', month:'short' })
            : ''}
        </div>

        <div class="cd-footer-actions">
          <button class="btn btn-danger btn-full" id="cdDeleteBtn">Delete contact</button>
        </div>
      </div>
    `;

    attachHandlers();
  }

  // ── Event handlers ────────────────────────────────────────────────────────
  function attachHandlers() {

    // Back
    el.querySelector('#cdBack').addEventListener('click', () => navigate('contacts'));

    // Front image expand
    const frontWrap = el.querySelector('#cdFrontWrap');
    if (frontWrap) frontWrap.addEventListener('click', () => showFullImage(contact.card_image_front));

    // Back toggle
    const toggleBackBtn = el.querySelector('#cdToggleBack');
    if (toggleBackBtn) {
      toggleBackBtn.addEventListener('click', () => {
        const backWrap = el.querySelector('#cdBackWrap');
        const show = backWrap.style.display === 'none';
        backWrap.style.display   = show ? 'block' : 'none';
        toggleBackBtn.textContent = show ? 'Hide back side' : 'Show back side';
        if (show) backWrap.addEventListener('click',
          () => showFullImage(contact.card_image_back), { once: true });
      });
    }

    // Add to iPhone Contacts — export single vCard and trigger download
    el.querySelector('#cdAddToContacts').addEventListener('click', () => {
      exportVCard([contact]);
      showToast('vCard exported — open to add to Contacts');
    });

    // Auto-save on blur for all [data-key] inputs/textareas
    el.querySelectorAll('[data-key]').forEach(input => {
      input.addEventListener('blur',   () => save());
      input.addEventListener('change', () => save());
    });

    // Tier buttons
    el.querySelectorAll('.tier-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const t = Number(btn.dataset.tier);
        contact.tier = contact.tier === t ? null : t;
        el.querySelectorAll('.tier-btn').forEach(b => b.classList.remove('active'));
        if (contact.tier !== null) btn.classList.add('active');
        // Also update hero tier ring and top chip without full re-render
        el.querySelector('.cd-avatar').className = `cd-avatar avatar-t${contact.tier || 4}`;
        el.querySelector('.cd-top-tier').innerHTML = contact.tier
          ? `<span class="tier-chip t${contact.tier}">T${contact.tier}</span>` : '';
        save();
      });
    });

    // Chip remove
    el.querySelectorAll('.chip-remove').forEach(btn => {
      btn.addEventListener('click', () => {
        const { type, index } = btn.dataset;
        const i = Number(index);
        if (type === 'email') contact.emails.splice(i, 1);
        else if (type === 'phone') contact.phones.splice(i, 1);
        else if (type === 'tag')   contact.tags.splice(i, 1);
        save().then(() => { addingEmail = false; addingPhone = false; addingTag = false; render(); });
      });
    });

    // ── Inline add email ──
    const addEmailBtn = el.querySelector('#addEmailBtn');
    if (addEmailBtn) {
      addEmailBtn.addEventListener('click', () => { addingEmail = true; render(); requestAnimationFrame(() => el.querySelector('#emailAddInput')?.focus()); });
    }
    const emailAddConfirm = el.querySelector('#emailAddConfirm');
    if (emailAddConfirm) {
      const commitEmail = () => {
        const v = el.querySelector('#emailAddInput')?.value.trim();
        if (v) { contact.emails = [...(contact.emails || []), v]; save().then(() => { addingEmail = false; render(); }); }
        else   { addingEmail = false; render(); }
      };
      emailAddConfirm.addEventListener('click', commitEmail);
      el.querySelector('#emailAddInput')?.addEventListener('keydown', e => { if (e.key === 'Enter') commitEmail(); });
      el.querySelector('#emailAddCancel')?.addEventListener('click', () => { addingEmail = false; render(); });
    }

    // ── Inline add phone ──
    const addPhoneBtn = el.querySelector('#addPhoneBtn');
    if (addPhoneBtn) {
      addPhoneBtn.addEventListener('click', () => { addingPhone = true; render(); requestAnimationFrame(() => el.querySelector('#phoneAddInput')?.focus()); });
    }
    const phoneAddConfirm = el.querySelector('#phoneAddConfirm');
    if (phoneAddConfirm) {
      const commitPhone = () => {
        const v = el.querySelector('#phoneAddInput')?.value.trim();
        if (v) { contact.phones = [...(contact.phones || []), v]; save().then(() => { addingPhone = false; render(); }); }
        else   { addingPhone = false; render(); }
      };
      phoneAddConfirm.addEventListener('click', commitPhone);
      el.querySelector('#phoneAddInput')?.addEventListener('keydown', e => { if (e.key === 'Enter') commitPhone(); });
      el.querySelector('#phoneAddCancel')?.addEventListener('click', () => { addingPhone = false; render(); });
    }

    // ── Inline add tag ──
    const addTagBtn = el.querySelector('#addTagBtn');
    if (addTagBtn) {
      addTagBtn.addEventListener('click', () => { addingTag = true; render(); requestAnimationFrame(() => el.querySelector('#tagAddInput')?.focus()); });
    }
    const tagAddConfirm = el.querySelector('#tagAddConfirm');
    if (tagAddConfirm) {
      const commitTag = () => {
        const v = el.querySelector('#tagAddInput')?.value.trim();
        if (v) {
          contact.tags = [...(contact.tags || []), v];
          save().then(() => { addingTag = false; render(); });
        } else { addingTag = false; render(); }
      };
      tagAddConfirm.addEventListener('click', commitTag);
      el.querySelector('#tagAddInput')?.addEventListener('keydown', e => { if (e.key === 'Enter') commitTag(); });
      el.querySelector('#tagAddCancel')?.addEventListener('click', () => { addingTag = false; render(); });
    }

    // Delete (with undo toast instead of confirm())
    el.querySelector('#cdDeleteBtn').addEventListener('click', () => {
      showDeleteToast();
    });
  }

  // ── Save ──────────────────────────────────────────────────────────────────
  async function save() {
    const changes = {};
    el.querySelectorAll('[data-key]').forEach(input => {
      changes[input.dataset.key] = input.value.trim ? input.value.trim() : input.value;
    });
    changes.tier   = contact.tier;
    changes.emails = contact.emails || [];
    changes.phones = contact.phones || [];
    changes.tags   = contact.tags   || [];

    setSyncDot('yellow');
    contact = await updateContact(contact.id, changes);
    setSyncDot('green');
  }

  // ── Delete toast ──────────────────────────────────────────────────────────
  function showDeleteToast() {
    // Optimistic: navigate away immediately, then soft-delete after delay
    navigate('contacts');

    let toastEl = document.querySelector('.undo-toast');
    if (!toastEl) {
      toastEl = document.createElement('div');
      toastEl.className = 'undo-toast';
      document.body.appendChild(toastEl);
    }

    const name = contact.name || 'Contact';
    const id   = contact.id;

    toastEl.innerHTML = `
      <span>${escHtml(name)} deleted</span>
      <button class="undo-toast-btn" id="cdUndoDeleteBtn">Undo</button>
    `;
    toastEl.classList.add('show');

    const timer = setTimeout(() => {
      softDeleteContact(id);
      toastEl.classList.remove('show');
    }, 3500);

    toastEl.querySelector('#cdUndoDeleteBtn').addEventListener('click', () => {
      clearTimeout(timer);
      toastEl.classList.remove('show');
      // Was already navigated away; stay on contacts list (nothing deleted)
      showToast('Delete cancelled');
    });
  }

  // ── Helpers ───────────────────────────────────────────────────────────────
  function editField(label, key, value) {
    return `
      <div class="confirm-field-row">
        <span class="confirm-field-label">${label}</span>
        <input class="confirm-field-input" data-key="${key}" value="${escHtml(value || '')}" placeholder="${label}">
      </div>`;
  }

  render();
}

// ── Module-level helpers ───────────────────────────────────────────────────
function chipHtml(value, index, type) {
  return `<span class="chip">${escHtml(value)}<button class="chip-remove" data-type="${type}" data-index="${index}" aria-label="Remove">×</button></span>`;
}

function showFullImage(src) {
  const overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.92);z-index:300;display:flex;align-items:center;justify-content:center;';
  overlay.innerHTML = `<img src="${src}" style="max-width:96%;max-height:90vh;object-fit:contain;border-radius:8px;">`;
  overlay.addEventListener('click', () => overlay.remove());
  document.body.appendChild(overlay);
}

function escHtml(s) {
  return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function escAttr(s) {
  return String(s || '').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}
