import { navigate, app, showStatus, hideStatus, showToast } from '../app.js';
import { runOCR, parseFields, loadTesseract, terminateWorker } from '../ocr.js';
import { createContact, compressImage, updateSession } from '../db.js';

export async function renderConfirm(el) {
  if (!app.detectedCards || app.detectedCards.length === 0) {
    navigate('capture'); return;
  }

  const total = app.detectedCards.length;
  // cardData: parsed OCR results + user edits
  const cardData = app.detectedCards.map(() => null);
  let currentIdx = 0;
  let ocrDone = false;

  el.innerHTML = `
    <div id="confirmInner" style="min-height:100%;display:flex;flex-direction:column;">
      <div id="confirmCardArea" style="flex:1;overflow-y:auto;padding:16px;display:flex;flex-direction:column;gap:12px;">
        <div style="text-align:center;padding:40px 16px;">
          <div class="spinner" style="margin:0 auto 12px;width:28px;height:28px;"></div>
          <p style="color:var(--text-muted);font-size:14px;">Running OCR on ${total} card${total > 1 ? 's' : ''}…</p>
        </div>
      </div>
    </div>
  `;

  // Run OCR on all cards
  try {
    await loadTesseract();
    for (let i = 0; i < total; i++) {
      showStatus(`Recognising card ${i + 1} of ${total}…`, Math.round(((i + 0.5) / total) * 100));
      const ocrResult = await runOCR(app.detectedCards[i].cropCanvas, () => {});
      const parsed = parseFields(ocrResult);
      cardData[i] = {
        ...parsed,
        tier: null,
        intro_by: '',
        next_action: '',
        next_action_date: '',
        card_image_front: app.detectedCards[i].cropCanvas.toDataURL('image/jpeg', 0.7),
        card_image_back: '',
        ocr_raw_back: '',
        _skipped: false,
      };
    }
  } catch (e) {
    console.warn('OCR error:', e);
    // Fill empty data so user can still type manually
    for (let i = 0; i < total; i++) {
      if (!cardData[i]) {
        cardData[i] = {
          name: '', title: '', company: '', emails: [], phones: [],
          linkedin: '', website: '', raw_text: '',
          tier: null, intro_by: '', next_action: '', next_action_date: '',
          card_image_front: app.detectedCards[i].cropCanvas.toDataURL('image/jpeg', 0.7),
          card_image_back: '', ocr_raw_back: '', _skipped: false,
        };
      }
    }
    showToast('OCR failed — please fill fields manually');
  }

  hideStatus();
  ocrDone = true;
  renderCard(currentIdx);

  function renderCard(idx) {
    currentIdx = idx;
    const data = cardData[idx];
    const area = el.querySelector('#confirmCardArea');

    area.innerHTML = `
      <div class="confirm-card-image">
        <img src="${data.card_image_front}" alt="Card front" style="width:100%;max-height:180px;object-fit:contain;background:#f0f0f0;">
      </div>

      ${data.card_image_back
        ? `<div style="background:var(--surface);border-radius:var(--radius);overflow:hidden;border:1px solid var(--border);">
             <img src="${data.card_image_back}" alt="Card back" style="width:100%;max-height:120px;object-fit:contain;background:#f0f0f0;">
             <div style="padding:6px 10px;font-size:12px;color:var(--text-muted);text-align:center;">Back side</div>
           </div>`
        : `<button class="add-back-btn" id="addBackBtn">+ Add back side</button>`
      }

      <div class="progress-dots">
        <span class="progress-dots-label">Card ${idx + 1} of ${total}</span>
        <div class="progress-dots-row">
          ${Array.from({ length: Math.min(total, 10) }, (_, i) =>
            `<div class="progress-dot ${i < idx ? 'done' : i === idx ? 'current' : ''}"></div>`
          ).join('')}
        </div>
      </div>

      <div class="confirm-fields">
        ${fieldRow('Name',     'name',    data.name)}
        ${fieldRow('Title',    'title',   data.title)}
        ${fieldRow('Company',  'company', data.company)}
        ${fieldRow('Email',    'email',   (data.emails || []).join(', '))}
        ${fieldRow('Phone',    'phone',   (data.phones || []).join(', '))}
        ${fieldRow('LinkedIn', 'linkedin',data.linkedin)}
        ${fieldRow('Website',  'website', data.website)}
      </div>

      <div class="context-section">
        <button class="context-toggle" id="contextToggle">
          <span>▸ Add context</span>
          <svg class="context-toggle-arrow" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"/></svg>
        </button>
        <div class="context-body" id="contextBody">
          <div class="form-group">
            <label class="form-label">Tier</label>
            <div class="tier-selector">
              ${[1,2,3,4].map(t => `<button class="tier-btn t${t} ${data.tier === t ? 'active' : ''}" data-tier="${t}">T${t}</button>`).join('')}
            </div>
          </div>
          <div class="form-group">
            <label class="form-label" for="introBy">Intro'd by</label>
            <input class="form-input" id="introBy" value="${data.intro_by || ''}" placeholder="Who introduced you?">
          </div>
          <div class="form-group">
            <label class="form-label" for="nextAction">Next action</label>
            <input class="form-input" id="nextAction" value="${data.next_action || ''}" placeholder="e.g. Send deck, Schedule call">
          </div>
          <div class="form-group">
            <label class="form-label" for="nextActionDate">By date</label>
            <input class="form-input" id="nextActionDate" type="date" value="${data.next_action_date || ''}">
          </div>
        </div>
      </div>

      <div style="display:flex;gap:10px;padding-top:4px;padding-bottom:8px;">
        <button class="btn btn-secondary" id="skipBtn" style="flex:1;">Skip</button>
        <button class="btn btn-primary" id="saveNextBtn" style="flex:2;">
          ${idx === total - 1 ? 'Save & Done ✓' : 'Save & Next →'}
        </button>
      </div>
    `;

    // Context toggle
    const toggle = area.querySelector('#contextToggle');
    const body = area.querySelector('#contextBody');
    toggle.addEventListener('click', () => {
      const open = body.classList.toggle('open');
      toggle.classList.toggle('open', open);
      toggle.querySelector('span').textContent = open ? '▾ Add context' : '▸ Add context';
    });

    // Tier buttons
    area.querySelectorAll('.tier-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const t = Number(btn.dataset.tier);
        cardData[idx].tier = cardData[idx].tier === t ? null : t;
        area.querySelectorAll('.tier-btn').forEach(b => b.classList.remove('active'));
        if (cardData[idx].tier !== null) btn.classList.add('active');
      });
    });

    // Add back side
    const addBackBtn = area.querySelector('#addBackBtn');
    if (addBackBtn) {
      addBackBtn.addEventListener('click', () => triggerBackCapture(idx));
    }

    // Skip
    area.querySelector('#skipBtn').addEventListener('click', () => {
      syncFieldsToData(idx);
      cardData[idx]._skipped = true;
      advance(idx);
    });

    // Save & Next
    area.querySelector('#saveNextBtn').addEventListener('click', () => {
      syncFieldsToData(idx);
      advance(idx);
    });

    // Swipe support
    setupSwipe(area, () => {
      syncFieldsToData(idx); cardData[idx]._skipped = true; advance(idx);
    }, () => {
      syncFieldsToData(idx); advance(idx);
    });
  }

  function fieldRow(label, key, value) {
    return `
      <div class="confirm-field-row">
        <span class="confirm-field-label">${label}</span>
        <input class="confirm-field-input" data-key="${key}" value="${escHtml(value || '')}" placeholder="${label}">
      </div>`;
  }

  function syncFieldsToData(idx) {
    const area = el.querySelector('#confirmCardArea');
    area.querySelectorAll('.confirm-field-input').forEach(input => {
      const key = input.dataset.key;
      const val = input.value.trim();
      if (key === 'email') cardData[idx].emails = val ? val.split(/[,;]\s*/) : [];
      else if (key === 'phone') cardData[idx].phones = val ? val.split(/[,;]\s*/) : [];
      else cardData[idx][key] = val;
    });
    const introBy = area.querySelector('#introBy');
    const nextAction = area.querySelector('#nextAction');
    const nextActionDate = area.querySelector('#nextActionDate');
    if (introBy) cardData[idx].intro_by = introBy.value.trim();
    if (nextAction) cardData[idx].next_action = nextAction.value.trim();
    if (nextActionDate) cardData[idx].next_action_date = nextActionDate.value;
  }

  async function advance(idx) {
    if (idx < total - 1) {
      renderCard(idx + 1);
    } else {
      await saveAll();
    }
  }

  async function saveAll() {
    if (!app.currentSession) { showToast('No active session'); navigate('home'); return; }

    showStatus('Saving contacts…', 50);
    const saved = [];
    for (const data of cardData) {
      if (data._skipped) continue;
      try {
        const contact = await createContact({
          session_id: app.currentSession.id,
          name: data.name,
          title: data.title,
          company: data.company,
          emails: data.emails || [],
          phones: data.phones || [],
          linkedin: data.linkedin || '',
          website: data.website || '',
          tier: data.tier,
          intro_by: data.intro_by || '',
          next_action: data.next_action || '',
          next_action_date: data.next_action_date || '',
          ocr_raw_front: data.raw_text || '',
          ocr_raw_back: data.ocr_raw_back || '',
          card_image_front: data.card_image_front || '',
          card_image_back: data.card_image_back || '',
        });
        saved.push(contact);
      } catch (e) {
        console.warn('Failed to save contact:', e);
      }
    }
    hideStatus();
    terminateWorker();
    renderSummary(saved);
  }

  function renderSummary(saved) {
    el.querySelector('#confirmInner').innerHTML = `
      <div style="padding:24px 16px;">
        <div style="text-align:center;margin-bottom:24px;">
          <div style="font-size:48px;margin-bottom:8px;">✓</div>
          <h2 style="font-size:22px;font-weight:800;">${saved.length} contact${saved.length === 1 ? '' : 's'} saved</h2>
          <p style="color:var(--text-muted);font-size:14px;margin-top:4px;">${app.currentSession?.event_name || ''}</p>
        </div>

        <div class="summary-list">
          ${saved.map(c => `
            <div class="summary-row">
              <div class="summary-row-left">
                <div class="summary-row-name">${escHtml(c.name || '(no name)')}</div>
                <div class="summary-row-company">${escHtml(c.company || '')}</div>
              </div>
              ${c.tier ? `<span class="tier-chip t${c.tier}">T${c.tier}</span>` : ''}
            </div>
          `).join('')}
        </div>

        <div style="display:flex;flex-direction:column;gap:10px;margin-top:24px;">
          <button class="btn btn-secondary btn-full" id="addMoreBtn">+ Add more photos</button>
          <button class="btn btn-primary btn-full" id="closeSessionBtn">Close session</button>
        </div>
      </div>
    `;

    el.querySelector('#addMoreBtn').addEventListener('click', () => {
      app.pendingPhotos = [];
      app.detectedCards = [];
      navigate('capture');
    });
    el.querySelector('#closeSessionBtn').addEventListener('click', async () => {
      if (app.currentSession) {
        await updateSession(app.currentSession.id, { is_open: false });
      }
      app.currentSession = null;
      app.pendingPhotos = [];
      app.detectedCards = [];
      navigate('home');
    });
  }

  async function triggerBackCapture(idx) {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.onchange = async () => {
      if (!input.files[0]) return;
      showStatus('Processing back side…', 40);
      const dataUrl = await compressImage(input.files[0], 800, 0.7);
      const tmpImg = new Image();
      await new Promise(res => { tmpImg.onload = res; tmpImg.src = dataUrl; if (tmpImg.complete) res(); });
      const tmpCanvas = document.createElement('canvas');
      tmpCanvas.width = tmpImg.naturalWidth;
      tmpCanvas.height = tmpImg.naturalHeight;
      tmpCanvas.getContext('2d').drawImage(tmpImg, 0, 0);

      try {
        const ocrResult = await runOCR(tmpCanvas, () => {});
        const parsed = parseFields(ocrResult);
        // Merge: only fill empty fields, append emails/phones
        const d = cardData[idx];
        if (!d.name && parsed.name) d.name = parsed.name;
        if (!d.title && parsed.title) d.title = parsed.title;
        if (!d.company && parsed.company) d.company = parsed.company;
        if (!d.linkedin && parsed.linkedin) d.linkedin = parsed.linkedin;
        if (!d.website && parsed.website) d.website = parsed.website;
        parsed.emails.forEach(e => { if (!d.emails.includes(e)) d.emails.push(e); });
        parsed.phones.forEach(p => { if (!d.phones.includes(p)) d.phones.push(p); });
        d.card_image_back = dataUrl;
        d.ocr_raw_back = parsed.raw_text;
      } catch (e) {
        cardData[idx].card_image_back = dataUrl;
      }

      hideStatus();
      renderCard(idx);
    };
    input.click();
  }
}

function setupSwipe(el, onLeft, onRight) {
  let startX = null;
  el.addEventListener('touchstart', e => { startX = e.touches[0].clientX; }, { passive: true });
  el.addEventListener('touchend', e => {
    if (startX === null) return;
    const dx = e.changedTouches[0].clientX - startX;
    startX = null;
    if (Math.abs(dx) < 60) return;
    if (dx < 0) onLeft();
    else onRight();
  });
}

function escHtml(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
