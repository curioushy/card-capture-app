import { navigate, app, showStatus, hideStatus, showToast } from '../app.js';
import { runOCR, parseFields, loadTesseract, terminateWorker } from '../ocr.js';
import { createContact, compressImage, updateSession } from '../db.js';

export async function renderConfirm(el) {
  if (!app.detectedCards || app.detectedCards.length === 0) {
    navigate('capture'); return;
  }

  const total    = app.detectedCards.length;
  const cardData = app.detectedCards.map(() => null);
  let currentIdx = 0;

  // Three-layer layout: scroll area | token shelf | action bar
  el.innerHTML = `
    <div class="confirm-layout">
      <div class="confirm-scroll" id="confirmScroll">
        <div style="text-align:center;padding:40px 16px;">
          <div class="spinner" style="margin:0 auto 12px;width:28px;height:28px;"></div>
          <p style="color:var(--text-muted);font-size:14px;">Running OCR on ${total} card${total > 1 ? 's' : ''}…</p>
        </div>
      </div>
      <div class="confirm-token-shelf" id="tokenShelf" style="display:none"></div>
      <div class="confirm-actions" id="confirmActions" style="display:none"></div>
    </div>
  `;

  // ── OCR pass ──────────────────────────────────────────────────────────────
  try {
    await loadTesseract();
    for (let i = 0; i < total; i++) {
      const card = app.detectedCards[i];
      showStatus(`Recognising card ${i + 1} of ${total}…`, Math.round(((i + 0.5) / total) * 100));

      let frontResult, backResult = null;
      if (card.backCanvas) {
        [frontResult, backResult] = await Promise.all([
          runOCR(card.cropCanvas, () => {}),
          runOCR(card.backCanvas,  () => {}),
        ]);
      } else {
        frontResult = await runOCR(card.cropCanvas, () => {});
      }

      const parsed = parseFields(frontResult);
      if (backResult) mergeBack(parsed, parseFields(backResult));

      cardData[i] = {
        ...parsed,
        tier: null, intro_by: '', next_action: '', next_action_date: '',
        card_image_front: card.cropCanvas.toDataURL('image/jpeg', 0.7),
        card_image_back:  card.backCanvas ? card.backCanvas.toDataURL('image/jpeg', 0.7) : '',
        ocr_raw_back:     backResult ? (backResult.text || '') : '',
        _skipped: false,
        _tokens: buildTokens(frontResult, backResult, parsed),
      };
    }
  } catch (e) {
    console.warn('OCR error:', e);
    for (let i = 0; i < total; i++) {
      if (!cardData[i]) {
        const card = app.detectedCards[i];
        cardData[i] = {
          name: '', title: '', company: '', emails: [], phones: [],
          linkedin: '', website: '', raw_text: '',
          tier: null, intro_by: '', next_action: '', next_action_date: '',
          card_image_front: card.cropCanvas.toDataURL('image/jpeg', 0.7),
          card_image_back: card.backCanvas ? card.backCanvas.toDataURL('image/jpeg', 0.7) : '',
          ocr_raw_back: '', _skipped: false, _tokens: [],
        };
      }
    }
    showToast('OCR failed — please fill fields manually');
  }

  hideStatus();
  renderCard(currentIdx);

  // ── Render one card ───────────────────────────────────────────────────────
  function renderCard(idx) {
    currentIdx = idx;
    const data    = cardData[idx];
    const scroll  = el.querySelector('#confirmScroll');
    const shelf   = el.querySelector('#tokenShelf');
    const actions = el.querySelector('#confirmActions');

    // Shared swipe-lock: set true while a drag is live so swipe nav doesn't fire
    let swipeLocked = false;

    // ── Scroll area ──────────────────────────────────────────────────────────
    scroll.innerHTML = `
      <div style="padding:16px;display:flex;flex-direction:column;gap:12px;">

        <div class="confirm-card-image">
          <img src="${data.card_image_front}" alt="Card front">
        </div>

        ${data.card_image_back
          ? `<div class="confirm-card-image confirm-card-back">
               <img src="${data.card_image_back}" alt="Card back">
               <div class="confirm-back-label">Back side</div>
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

        <div class="confirm-fields" id="confirmFields"></div>

        <div class="context-section">
          <button class="context-toggle" id="contextToggle">
            <span>▸ Add context</span>
            <svg class="context-toggle-arrow" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"/></svg>
          </button>
          <div class="context-body" id="contextBody">
            <div class="form-group">
              <label class="form-label">Tier</label>
              <div class="tier-selector">
                ${[1,2,3,4].map(t =>
                  `<button class="tier-btn t${t} ${data.tier === t ? 'active' : ''}" data-tier="${t}">T${t}</button>`
                ).join('')}
              </div>
            </div>
            <div class="form-group">
              <label class="form-label" for="introBy">Intro'd by</label>
              <input class="form-input" id="introBy" value="${escHtml(data.intro_by || '')}" placeholder="Who introduced you?">
            </div>
            <div class="form-group">
              <label class="form-label" for="nextAction">Next action</label>
              <input class="form-input" id="nextAction" value="${escHtml(data.next_action || '')}" placeholder="e.g. Send deck, Schedule call">
            </div>
            <div class="form-group">
              <label class="form-label" for="nextActionDate">By date</label>
              <input class="form-input" id="nextActionDate" type="date" value="${data.next_action_date || ''}">
            </div>
          </div>
        </div>

      </div>
    `;

    // Populate the fields section (handles multi email/phone)
    renderFields(idx);

    // ── Token shelf ──────────────────────────────────────────────────────────
    shelf.style.display = '';
    shelf.innerHTML = `
      <div class="shelf-header">
        <span class="shelf-title">FROM CARD</span>
        <span class="shelf-hint">drag to fill · field→field to swap</span>
      </div>
      <div class="shelf-tokens" id="shelfTokens">
        ${(data._tokens || []).map((tok, i) => `
          <div class="ocr-token ${tok.used ? 'used' : ''}"
               data-idx="${i}"
               data-text="${escAttr(tok.text)}"
               style="touch-action:none;user-select:none;">
            ${tok.icon ? `<span class="tok-icon">${tok.icon}</span>` : ''}${escHtml(tok.text)}
          </div>
        `).join('')}
      </div>
    `;

    // ── Action bar ───────────────────────────────────────────────────────────
    actions.style.display = '';
    actions.innerHTML = `
      <button class="btn btn-secondary" id="skipBtn">Skip</button>
      <button class="btn btn-primary"   id="saveNextBtn">
        ${idx === total - 1 ? 'Save & Done ✓' : 'Save & Next →'}
      </button>
    `;

    // ── Wire up events ───────────────────────────────────────────────────────
    const toggle = scroll.querySelector('#contextToggle');
    const body   = scroll.querySelector('#contextBody');
    toggle.addEventListener('click', () => {
      const open = body.classList.toggle('open');
      toggle.classList.toggle('open', open);
      toggle.querySelector('span').textContent = open ? '▾ Add context' : '▸ Add context';
    });

    scroll.querySelectorAll('.tier-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const t = Number(btn.dataset.tier);
        cardData[idx].tier = cardData[idx].tier === t ? null : t;
        scroll.querySelectorAll('.tier-btn').forEach(b => b.classList.remove('active'));
        if (cardData[idx].tier !== null) btn.classList.add('active');
      });
    });

    const addBackBtn = scroll.querySelector('#addBackBtn');
    if (addBackBtn) addBackBtn.addEventListener('click', () => triggerBackCapture(idx));

    actions.querySelector('#skipBtn').addEventListener('click', () => {
      syncFields(idx); cardData[idx]._skipped = true; advance(idx);
    });
    actions.querySelector('#saveNextBtn').addEventListener('click', () => {
      syncFields(idx); advance(idx);
    });

    // Swipe left = skip, right = save (guarded by swipeLocked)
    let swipeStartX = null;
    scroll.addEventListener('touchstart', e => {
      swipeStartX = e.touches[0].clientX;
    }, { passive: true });
    scroll.addEventListener('touchend', e => {
      if (swipeStartX === null || swipeLocked) { swipeStartX = null; return; }
      const dx = e.changedTouches[0].clientX - swipeStartX;
      swipeStartX = null;
      if (Math.abs(dx) < 64) return;
      if (dx < 0) { syncFields(idx); cardData[idx]._skipped = true; advance(idx); }
      else         { syncFields(idx); advance(idx); }
    });

    // ── Drag-and-drop (shelf → replace; field → swap) ────────────────────────
    initTokenDrag(
      el, shelf, scroll, idx,
      (locked) => { swipeLocked = locked; }
    );
  }

  // ── Render the fields section (can be called to refresh) ─────────────────
  function renderFields(idx) {
    const data    = cardData[idx];
    const fieldsEl = el.querySelector('#confirmFields');
    if (!fieldsEl) return;

    // Ensure at least one slot for email and phone
    const emails = (data.emails && data.emails.length) ? data.emails : [''];
    const phones = (data.phones && data.phones.length) ? data.phones : [''];

    const rows = [
      fieldRow('Name',     'name',     data.name),
      fieldRow('Title',    'title',    data.title),
      fieldRow('Company',  'company',  data.company),
      ...emails.map((e, i) => fieldRow(i === 0 ? 'Email' : '', `email-${i}`, e)),
      addMoreRow('email'),
      ...phones.map((p, i) => fieldRow(i === 0 ? 'Phone' : '', `phone-${i}`, p)),
      addMoreRow('phone'),
      fieldRow('LinkedIn', 'linkedin', data.linkedin),
      fieldRow('Website',  'website',  data.website),
    ];

    fieldsEl.innerHTML = rows.join('');

    // Clear (×) buttons
    fieldsEl.querySelectorAll('.field-clear-btn').forEach(btn => {
      btn.addEventListener('click', e => {
        e.stopPropagation();
        const row   = btn.closest('.confirm-field-row');
        const input = row?.querySelector('.confirm-field-input');
        if (input) {
          input.value = '';
          row.classList.add('field-empty');
        }
      });
    });

    // "+ Add" buttons
    fieldsEl.querySelectorAll('.confirm-add-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        syncFields(idx);
        const type = btn.dataset.type;
        if (type === 'email') { cardData[idx].emails = cardData[idx].emails.length ? cardData[idx].emails : []; cardData[idx].emails.push(''); }
        else                  { cardData[idx].phones = cardData[idx].phones.length ? cardData[idx].phones : []; cardData[idx].phones.push(''); }
        renderFields(idx);
        // Focus the newly added input
        const inputs = fieldsEl.querySelectorAll(`input[data-key^="${type}-"]`);
        if (inputs.length) inputs[inputs.length - 1].focus();
      });
    });
  }

  // ── Custom touch drag-and-drop ────────────────────────────────────────────
  //
  //  Two drag sources:
  //    shelf token → field input  : REPLACE the field value
  //    field drag-handle → field  : SWAP the two field values
  //
  function initTokenDrag(rootEl, shelfEl, scrollEl, idx, onLock) {
    let ghost    = null;
    let dragging = null; // { source:'shelf'|'field', text, tokenIdx?, tokenEl?, sourceRow? }
    let lastRow  = null;

    // ── Shelf token drag ──────────────────────────────────────────────────────
    shelfEl.querySelectorAll('.ocr-token').forEach(tok => {
      tok.addEventListener('touchstart', e => {
        if (e.touches.length !== 1) return;
        e.preventDefault();
        dragging = {
          source:   'shelf',
          tokenEl:  tok,
          text:     tok.dataset.text,
          tokenIdx: Number(tok.dataset.idx),
        };
        tok.classList.add('token-dragging');
        startDrag(e.touches[0]);
      }, { passive: false });
    });

    // ── Field handle drag — event delegation on scroll area ───────────────────
    scrollEl.addEventListener('touchstart', e => {
      const handle = e.target.closest('.field-drag-handle');
      if (!handle) return;
      e.preventDefault();
      const row   = handle.closest('.confirm-field-row');
      const input = row?.querySelector('.confirm-field-input');
      if (!input || !input.value.trim()) return; // don't drag empty fields
      dragging = {
        source:    'field',
        sourceRow: row,
        text:      input.value.trim(),
      };
      row.classList.add('field-dragging');
      startDrag(e.touches[0]);
    }, { passive: false });

    // ── Shared drag lifecycle ─────────────────────────────────────────────────
    function startDrag(touch) {
      onLock(true);
      ghost = document.createElement('div');
      ghost.className  = 'drag-ghost';
      ghost.textContent = dragging.text;
      positionGhost(touch.clientX, touch.clientY);
      document.body.appendChild(ghost);
      scrollEl.querySelector('#confirmFields')?.classList.add('drag-active');

      document.addEventListener('touchmove',   onMove,  { passive: false });
      document.addEventListener('touchend',    onEnd);
      document.addEventListener('touchcancel', onEnd);
    }

    function onMove(e) {
      if (!ghost) return;
      e.preventDefault();
      const touch = e.touches[0];
      positionGhost(touch.clientX, touch.clientY);

      const target = fieldRowAt(touch.clientX, touch.clientY);
      if (target !== lastRow) {
        lastRow?.classList.remove('drop-hover');
        // Don't highlight the source row as a drop target
        if (target && target !== dragging?.sourceRow) {
          target.classList.add('drop-hover');
        }
        lastRow = target;
      }
    }

    function onEnd(e) {
      document.removeEventListener('touchmove',   onMove);
      document.removeEventListener('touchend',    onEnd);
      document.removeEventListener('touchcancel', onEnd);

      if (!ghost || !dragging) { cleanup(); return; }

      const touch = e.changedTouches[0];
      const row   = fieldRowAt(touch.clientX, touch.clientY);

      if (row) {
        const targetInput = row.querySelector('.confirm-field-input');
        if (targetInput) {
          if (dragging.source === 'shelf') {
            // ── REPLACE ──────────────────────────────────────────────────────
            targetInput.value = dragging.text;
            row.classList.toggle('field-empty', !dragging.text);
            // Mark token as used in shelf
            if (cardData[idx]._tokens[dragging.tokenIdx]) {
              cardData[idx]._tokens[dragging.tokenIdx].used = true;
            }
            dragging.tokenEl.classList.add('used');
          } else if (dragging.source === 'field' && row !== dragging.sourceRow) {
            // ── SWAP ─────────────────────────────────────────────────────────
            const srcInput = dragging.sourceRow.querySelector('.confirm-field-input');
            const temp = srcInput.value;
            srcInput.value = targetInput.value;
            targetInput.value = temp;
            dragging.sourceRow.classList.toggle('field-empty', !srcInput.value);
            row.classList.toggle('field-empty', !targetInput.value);
          }
        }
      }

      cleanup();
    }

    function cleanup() {
      ghost?.remove();
      ghost = null;
      lastRow?.classList.remove('drop-hover');
      lastRow = null;
      dragging?.tokenEl?.classList.remove('token-dragging');
      dragging?.sourceRow?.classList.remove('field-dragging');
      dragging = null;
      scrollEl.querySelector('#confirmFields')?.classList.remove('drag-active');
      // Release swipe lock after a short delay so the touchend doesn't
      // also trigger the swipe navigation
      setTimeout(() => onLock(false), 60);
    }

    function positionGhost(cx, cy) {
      const w = Math.min(ghost.offsetWidth || 160, 220);
      ghost.style.left = `${cx - w / 2}px`;
      ghost.style.top  = `${cy - 44}px`;
    }

    // Walk up from elementFromPoint to find a .confirm-field-row
    function fieldRowAt(cx, cy) {
      return document.elementFromPoint(cx, cy)?.closest?.('.confirm-field-row') ?? null;
    }
  }

  // ── Field helpers ─────────────────────────────────────────────────────────
  function fieldRow(label, key, value) {
    const empty = !value;
    return `
      <div class="confirm-field-row ${empty ? 'field-empty' : ''}" data-key="${key}">
        <div class="field-drag-handle" title="Drag to swap">
          <svg width="10" height="14" viewBox="0 0 10 14" fill="currentColor" opacity="0.35">
            <circle cx="2.5" cy="2"  r="1.5"/><circle cx="7.5" cy="2"  r="1.5"/>
            <circle cx="2.5" cy="7"  r="1.5"/><circle cx="7.5" cy="7"  r="1.5"/>
            <circle cx="2.5" cy="12" r="1.5"/><circle cx="7.5" cy="12" r="1.5"/>
          </svg>
        </div>
        <span class="confirm-field-label">${label}</span>
        <input class="confirm-field-input" data-key="${key}"
               value="${escHtml(value || '')}" placeholder="drag or type…">
        <button class="field-clear-btn" title="Clear">×</button>
      </div>`;
  }

  function addMoreRow(type) {
    const label = type === 'email' ? 'email' : 'phone';
    return `
      <div class="confirm-add-row">
        <button class="confirm-add-btn" data-type="${type}">
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3">
            <line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>
          </svg>
          Add ${label}
        </button>
      </div>`;
  }

  // ── Sync fields → cardData ────────────────────────────────────────────────
  function syncFields(idx) {
    const scroll = el.querySelector('#confirmScroll');

    // Single-value fields
    for (const key of ['name', 'title', 'company', 'linkedin', 'website']) {
      const input = scroll.querySelector(`input[data-key="${key}"]`);
      if (input) cardData[idx][key] = input.value.trim();
    }

    // Multi-value: collect all email-N / phone-N inputs
    cardData[idx].emails = [...scroll.querySelectorAll('input[data-key^="email-"]')]
      .map(i => i.value.trim()).filter(Boolean);
    cardData[idx].phones = [...scroll.querySelectorAll('input[data-key^="phone-"]')]
      .map(i => i.value.trim()).filter(Boolean);

    // Context fields
    const introBy        = scroll.querySelector('#introBy');
    const nextAction     = scroll.querySelector('#nextAction');
    const nextActionDate = scroll.querySelector('#nextActionDate');
    if (introBy)        cardData[idx].intro_by        = introBy.value.trim();
    if (nextAction)     cardData[idx].next_action      = nextAction.value.trim();
    if (nextActionDate) cardData[idx].next_action_date = nextActionDate.value;
  }

  async function advance(idx) {
    if (idx < total - 1) renderCard(idx + 1);
    else await saveAll();
  }

  // ── Save ──────────────────────────────────────────────────────────────────
  async function saveAll() {
    if (!app.currentSession) { showToast('No active session'); navigate('home'); return; }
    showStatus('Saving contacts…', 50);
    const saved = [];
    for (const data of cardData) {
      if (data._skipped) continue;
      try {
        const contact = await createContact({
          session_id: app.currentSession.id,
          name: data.name, title: data.title, company: data.company,
          emails: data.emails || [], phones: data.phones || [],
          linkedin: data.linkedin || '', website: data.website || '',
          tier: data.tier,
          intro_by: data.intro_by || '', next_action: data.next_action || '',
          next_action_date: data.next_action_date || '',
          ocr_raw_front: data.raw_text || '', ocr_raw_back: data.ocr_raw_back || '',
          card_image_front: data.card_image_front || '',
          card_image_back:  data.card_image_back  || '',
        });
        saved.push(contact);
      } catch (e) { console.warn('Failed to save contact:', e); }
    }
    hideStatus();
    terminateWorker();
    renderSummary(saved);
  }

  // ── Summary ───────────────────────────────────────────────────────────────
  function renderSummary(saved) {
    el.innerHTML = `
      <div class="confirm-layout">
        <div class="confirm-scroll" style="padding:24px 16px;">
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
        </div>
        <div class="confirm-actions" style="display:flex;">
          <button class="btn btn-secondary" id="addMoreBtn" style="flex:1;">+ More photos</button>
          <button class="btn btn-primary"   id="closeSessionBtn" style="flex:2;">Close session</button>
        </div>
      </div>
    `;
    el.querySelector('#addMoreBtn').addEventListener('click', () => {
      app.pendingPhotos = []; app.detectedCards = []; navigate('capture');
    });
    el.querySelector('#closeSessionBtn').addEventListener('click', async () => {
      if (app.currentSession) await updateSession(app.currentSession.id, { is_open: false });
      app.currentSession = null; app.pendingPhotos = []; app.detectedCards = [];
      navigate('home');
    });
  }

  // ── Add back side (post-OCR) ──────────────────────────────────────────────
  async function triggerBackCapture(idx) {
    const input = document.createElement('input');
    input.type = 'file'; input.accept = 'image/*';
    input.onchange = async () => {
      if (!input.files[0]) return;
      showStatus('Processing back side…', 40);
      const dataUrl  = await compressImage(input.files[0], 800, 0.7);
      const tmpCanvas = await dataUrlToCanvas(dataUrl);
      try {
        const ocrResult = await runOCR(tmpCanvas, () => {});
        const parsed    = parseFields(ocrResult);
        mergeBack(cardData[idx], parsed);
        // Append new tokens
        const newToks = buildTokensFromText(ocrResult.text, parsed);
        const existingTexts = new Set((cardData[idx]._tokens || []).map(t => t.text.toLowerCase()));
        newToks.forEach(t => { if (!existingTexts.has(t.text.toLowerCase())) cardData[idx]._tokens.push(t); });
        cardData[idx].card_image_back = dataUrl;
        cardData[idx].ocr_raw_back    = ocrResult.text;
      } catch { cardData[idx].card_image_back = dataUrl; }
      hideStatus();
      renderCard(idx);
    };
    input.click();
  }
}

// ── Token building ─────────────────────────────────────────────────────────

function buildTokens(frontResult, backResult, parsed) {
  const allText = (frontResult?.text || '') + '\n' + (backResult?.text || '');
  return buildTokensFromText(allText, parsed);
}

function buildTokensFromText(rawText, parsed) {
  const tokens = [];
  const seen   = new Set();

  function add(text, icon, used) {
    const key = text.toLowerCase().trim();
    if (!key || key.length < 2 || seen.has(key)) return;
    seen.add(key);
    tokens.push({ text: text.trim(), icon, used });
  }

  // Typed atoms first — pre-used (already assigned to fields)
  (parsed.emails  || []).forEach(t => add(t, '✉', true));
  (parsed.phones  || []).forEach(t => add(t, '📞', true));
  if (parsed.linkedin) add(parsed.linkedin, '🔗', true);
  if (parsed.website)  add(parsed.website,  '🌐', true);

  // Remaining OCR lines — the ones the parser may have missed
  const usedLower = new Set([
    parsed.name, parsed.title, parsed.company,
    ...(parsed.emails  || []),
    ...(parsed.phones  || []),
    parsed.linkedin, parsed.website,
  ].filter(Boolean).map(s => s.toLowerCase().trim()));

  rawText.split('\n')
    .map(l => l.replace(/^\|\s*/, '').trim())
    .filter(l => l.length >= 3 && l.length <= 80)
    .forEach(line => {
      const norm   = line.toLowerCase().trim();
      const isUsed = [...usedLower].some(u => u && (norm === u || norm.includes(u) || u.includes(norm)));
      add(line, '', isUsed);
    });

  return tokens;
}

// ── Back-side merge ────────────────────────────────────────────────────────

function mergeBack(target, src) {
  if (!target.name     && src.name)     target.name     = src.name;
  if (!target.title    && src.title)    target.title    = src.title;
  if (!target.company  && src.company)  target.company  = src.company;
  if (!target.linkedin && src.linkedin) target.linkedin = src.linkedin;
  if (!target.website  && src.website)  target.website  = src.website;
  (src.emails || []).forEach(e => { if (!(target.emails || []).includes(e)) (target.emails = target.emails || []).push(e); });
  (src.phones || []).forEach(p => { if (!(target.phones || []).includes(p)) (target.phones = target.phones || []).push(p); });
}

// ── Misc helpers ───────────────────────────────────────────────────────────

function dataUrlToCanvas(dataUrl) {
  return new Promise(res => {
    const img = new Image();
    img.onload = () => {
      const c = document.createElement('canvas');
      c.width = img.naturalWidth; c.height = img.naturalHeight;
      c.getContext('2d').drawImage(img, 0, 0);
      res(c);
    };
    img.src = dataUrl;
  });
}

function escHtml(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function escAttr(s) {
  return String(s).replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
