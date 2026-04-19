import { navigate, showToast, setSyncDot } from '../app.js';
import { getContact, updateContact, softDeleteContact, getSession } from '../db.js';
import { exportVCard } from '../export.js';

export async function renderContactDetail(el, params = {}) {
  if (!params.id) { navigate('contacts'); return; }

  let contact = await getContact(params.id);
  if (!contact) { navigate('contacts'); return; }

  const session = contact.session_id ? await getSession(contact.session_id) : null;

  function render() {
    el.innerHTML = `
      <div style="padding:0 0 32px;">

        <!-- Back button -->
        <div style="padding:12px 16px 0;display:flex;align-items:center;gap:8px;">
          <button id="backBtn" class="btn btn-ghost" style="padding:4px 0;">← Back</button>
        </div>

        <!-- Card image -->
        ${contact.card_image_front ? `
          <div style="margin:12px 16px;border-radius:var(--radius);overflow:hidden;background:#eee;cursor:pointer;" id="frontImgWrap">
            <img src="${contact.card_image_front}" alt="Card front"
              style="width:100%;max-height:200px;object-fit:contain;background:#f5f5f5;display:block;">
          </div>
          ${contact.card_image_back ? `
            <button id="showBackBtn" class="btn btn-secondary btn-full" style="margin:0 16px;width:calc(100% - 32px);">Show back side</button>
            <div id="backImgWrap" style="display:none;margin:12px 16px;border-radius:var(--radius);overflow:hidden;">
              <img src="${contact.card_image_back}" alt="Card back"
                style="width:100%;max-height:200px;object-fit:contain;background:#f5f5f5;display:block;">
            </div>` : ''}
        ` : ''}

        <!-- Session context -->
        ${session ? `
          <div style="padding:4px 16px 8px;">
            <span style="font-size:12px;color:var(--text-muted);">
              ${escHtml(session.event_name)} · ${session.date}
            </span>
          </div>` : ''}

        <!-- Editable fields -->
        <div style="padding:0 16px;">
          <div class="confirm-fields" style="margin-bottom:12px;">
            ${editField('Name',     'name',    contact.name)}
            ${editField('Title',    'title',   contact.title)}
            ${editField('Company',  'company', contact.company)}
            ${editField('LinkedIn', 'linkedin',contact.linkedin)}
            ${editField('Website',  'website', contact.website)}
          </div>

          <!-- Emails -->
          <div style="margin-bottom:12px;">
            <div class="form-label" style="padding:0 0 6px;">Emails</div>
            <div class="chip-input-wrap" id="emailChips">
              ${(contact.emails || []).map((e, i) => chipHtml(e, i, 'email')).join('')}
              <button class="chip-add-btn" id="addEmailBtn">+ Add</button>
            </div>
          </div>

          <!-- Phones -->
          <div style="margin-bottom:16px;">
            <div class="form-label" style="padding:0 0 6px;">Phones</div>
            <div class="chip-input-wrap" id="phoneChips">
              ${(contact.phones || []).map((p, i) => chipHtml(p, i, 'phone')).join('')}
              <button class="chip-add-btn" id="addPhoneBtn">+ Add</button>
            </div>
          </div>

          <!-- Tier -->
          <div class="form-group">
            <label class="form-label">Tier</label>
            <div class="tier-selector">
              ${[1,2,3,4].map(t => `<button class="tier-btn t${t} ${contact.tier === t ? 'active' : ''}" data-tier="${t}">T${t}</button>`).join('')}
            </div>
          </div>

          ${editField('Intro\'d by', 'intro_by', contact.intro_by)}
          ${editField('Next action', 'next_action', contact.next_action)}

          <div class="form-group">
            <label class="form-label">By date</label>
            <input class="form-input" data-key="next_action_date" type="date" value="${contact.next_action_date || ''}">
          </div>

          <!-- History -->
          <div style="padding:8px 0;font-size:12px;color:var(--text-muted);">
            Captured ${new Date(contact.created_at).toLocaleDateString()}
            ${session ? ' · ' + escHtml(session.event_name) : ''}
          </div>

          <!-- Actions -->
          <div style="display:flex;gap:10px;margin-top:8px;">
            <button class="btn btn-secondary" id="exportVCardBtn" style="flex:1;">Export vCard</button>
            <button class="btn btn-danger" id="deleteBtn" style="flex:1;">Delete</button>
          </div>
        </div>
      </div>
    `;

    el.querySelector('#backBtn').addEventListener('click', () => navigate('contacts'));

    // Image expand
    const frontWrap = el.querySelector('#frontImgWrap');
    if (frontWrap) {
      frontWrap.addEventListener('click', () => showFullImage(contact.card_image_front));
    }
    const showBackBtn = el.querySelector('#showBackBtn');
    if (showBackBtn) {
      showBackBtn.addEventListener('click', () => {
        const wrap = el.querySelector('#backImgWrap');
        const show = wrap.style.display === 'none';
        wrap.style.display = show ? 'block' : 'none';
        showBackBtn.textContent = show ? 'Hide back side' : 'Show back side';
      });
    }

    // Auto-save on blur for text fields
    el.querySelectorAll('[data-key]').forEach(input => {
      input.addEventListener('change', () => save());
      input.addEventListener('blur', () => save());
    });

    // Tier
    el.querySelectorAll('.tier-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const t = Number(btn.dataset.tier);
        contact.tier = contact.tier === t ? null : t;
        el.querySelectorAll('.tier-btn').forEach(b => b.classList.remove('active'));
        if (contact.tier !== null) btn.classList.add('active');
        save();
      });
    });

    // Chip remove
    el.querySelectorAll('.chip-remove').forEach(btn => {
      btn.addEventListener('click', () => {
        const { type, index } = btn.dataset;
        if (type === 'email') contact.emails.splice(Number(index), 1);
        else contact.phones.splice(Number(index), 1);
        save().then(render);
      });
    });

    // Add email
    el.querySelector('#addEmailBtn').addEventListener('click', () => {
      const v = prompt('Add email:');
      if (v && v.trim()) {
        contact.emails = [...(contact.emails || []), v.trim()];
        save().then(render);
      }
    });

    // Add phone
    el.querySelector('#addPhoneBtn').addEventListener('click', () => {
      const v = prompt('Add phone:');
      if (v && v.trim()) {
        contact.phones = [...(contact.phones || []), v.trim()];
        save().then(render);
      }
    });

    // Export vCard
    el.querySelector('#exportVCardBtn').addEventListener('click', () => {
      exportVCard([contact]);
    });

    // Delete
    el.querySelector('#deleteBtn').addEventListener('click', async () => {
      if (!confirm('Delete this contact?')) return;
      await softDeleteContact(contact.id);
      showToast('Contact deleted');
      navigate('contacts');
    });
  }

  async function save() {
    // Read all field inputs
    const changes = {};
    el.querySelectorAll('[data-key]').forEach(input => {
      changes[input.dataset.key] = input.type === 'date' ? input.value : input.value.trim();
    });
    changes.tier = contact.tier;
    changes.emails = contact.emails || [];
    changes.phones = contact.phones || [];

    setSyncDot('yellow');
    contact = await updateContact(contact.id, changes);
    setSyncDot('green');
  }

  function editField(label, key, value) {
    return `
      <div class="confirm-field-row">
        <span class="confirm-field-label">${label}</span>
        <input class="confirm-field-input" data-key="${key}" value="${escHtml(value || '')}" placeholder="${label}">
      </div>`;
  }

  render();
}

function chipHtml(value, index, type) {
  return `<span class="chip">${escHtml(value)}<button class="chip-remove" data-type="${type}" data-index="${index}">×</button></span>`;
}

function showFullImage(src) {
  const overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.9);z-index:300;display:flex;align-items:center;justify-content:center;';
  overlay.innerHTML = `<img src="${src}" style="max-width:95%;max-height:90vh;object-fit:contain;border-radius:8px;">`;
  overlay.addEventListener('click', () => overlay.remove());
  document.body.appendChild(overlay);
}

function escHtml(s) {
  return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
