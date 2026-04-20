import { navigate, app, showStatus, hideStatus, showToast } from '../app.js';
import { runOCR, parseFields, loadTesseract, terminateWorker } from '../ocr.js';
import { createContact, compressImage, updateSession } from '../db.js';

export async function renderConfirm(el) {
  if (!app.detectedCards || app.detectedCards.length === 0) {
    navigate('capture'); return;
  }

  const total = app.detectedCards.length;
  const cardData = app.detectedCards.map(() => null);
  let currentIdx = 0;

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

  // ─── Run OCR on all cards ─────────────────────────────────────────────────
  try {
    await loadTesseract();
    for (let i = 0; i < total; i++) {
      const card = app.detectedCards[i];
      showStatus(`Recognising card ${i + 1} of ${total}…`, Math.round(((i + 0.5) / total) * 100));

      let frontResult, backResult = null;

      if (card.backCanvas) {
        // Single-card mode: OCR both sides in parallel
        [frontResult, backResult] = await Promise.all([
          runOCR(card.cropCanvas, () => {}),
          runOCR(card.backCanvas, () => {}),
        ]);
      } else {
        frontResult = await runOCR(card.cropCanvas, () => {});
      }

      const parsed = parseFields(frontResult);

      // Auto-merge back-side OCR (only fill empty fields, append arrays)
      if (backResult) {
        const backParsed = parseFields(backResult);
        if (!parsed.name    && backParsed.name)    parsed.name    = backParsed.name;
        if (!parsed.title   && backParsed.title)   parsed.title   = backParsed.title;
        if (!parsed.company && backParsed.company) parsed.company = backParsed.company;
        if (!parsed.linkedin && backParsed.linkedin) parsed.linkedin = backParsed.linkedin;
        if (!parsed.website  && backParsed.website)  parsed.website  = backParsed.website;
        backParsed.emails.forEach(e => { if (!parsed.emails.includes(e)) parsed.emails.push(e); });
        backParsed.phones.forEach(p => { if (!parsed.phones.includes(p)) parsed.phones.push(p); });
        parsed.raw_text_back = backResult.text;
      }

      cardData[i] = {
        ...parsed,
        tier: null,
        intro_by: '',
        next_action: '',
        next_action_date: '',
        card_image_front: card.cropCanvas.toDataURL('image/jpeg', 0.7),
        card_image_back:  card.backCanvas ? card.backCanvas.toDataURL('image/jpeg', 0.7) : '',
        ocr_raw_back:     backResult ? (backResult.text || '') : '',
        _skipped: false,
        // Source atoms for chip shelf
        _chips: buildChips(frontResult, backResult, parsed),
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
          card_image_back:  card.backCanvas ? card.backCanvas.toDataURL('image/jpeg', 0.7) : '',
          ocr_raw_back: '', _skipped: false, _chips: [],
        };
      }
    }
    showToast('OCR failed — please fill fields manually');
  }

  hideStatus();
  renderCard(currentIdx);

  // ─── Render a single card for review ─────────────────────────────────────
  function renderCard(idx) {
    currentIdx = idx;
    const data = cardData[idx];
    const area = el.querySelector('#confirmCardArea');

    area.innerHTML = `
      <!-- Card images -->
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

      <!-- Progress -->
      <div class="progress-dots">
        <span class="progress-dots-label">Card ${idx + 1} of ${total}</span>
        <div class="progress-dots-row">
          ${Array.from({ length: Math.min(total, 10) }, (_, i) =>
            `<div class="progress-dot ${i < idx ? 'done' : i === idx ? 'current' : ''}"></div>`
          ).join('')}
        </div>
      </div>

      <!-- OCR chip shelf -->
      ${renderChipShelf(data._chips || [])}

      <!-- Fields -->
      <div class="confirm-fields" id="confirmFields">
        ${fieldRow('Name',     'name',     data.name)}
        ${fieldRow('Title',    'title',    data.title)}
        ${fieldRow('Company',  'company',  data.company)}
        ${fieldRow('Email',    'email',    (data.emails || []).join(', '))}
        ${fieldRow('Phone',    'phone',    (data.phones || []).join(', '))}
        ${fieldRow('LinkedIn', 'linkedin', data.linkedin)}
        ${fieldRow('Website',  'website',  data.website)}
      </div>

      <!-- Context section -->
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

      <!-- Actions -->
      <div style="display:flex;gap:10px;padding-top:4px;padding-bottom:8px;">
        <button class="btn btn-secondary" id="skipBtn" style="flex:1;">Skip</button>
        <button class="btn btn-primary" id="saveNextBtn" style="flex:2;">
          ${idx === total - 1 ? 'Save & Done ✓' : 'Save & Next →'}
        </button>
      </div>
    `;

    // Context toggle
    const toggle = area.querySelector('#contextToggle');
    const body   = area.querySelector('#contextBody');
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

    // Add back side (only shown when no back side yet)
    const addBackBtn = area.querySelector('#addBackBtn');
    if (addBackBtn) addBackBtn.addEventListener('click', () => triggerBackCapture(idx));

    // Skip / Save
    area.querySelector('#skipBtn').addEventListener('click', () => {
      syncFieldsToData(idx);
      cardData[idx]._skipped = true;
      advance(idx);
    });
    area.querySelector('#saveNextBtn').addEventListener('click', () => {
      syncFieldsToData(idx);
      advance(idx);
    });

    // Swipe support
    setupSwipe(area,
      () => { syncFieldsToData(idx); cardData[idx]._skipped = true; advance(idx); },
      () => { syncFieldsToData(idx); advance(idx); }
    );

    // Wire up chip-shelf tap-to-assign
    wireChipShelf(area, idx);
  }

  // ─── Chip shelf ────────────────────────────────────────────────────────────
  function renderChipShelf(chips) {
    if (!chips || chips.length === 0) return '';
    return `
      <div class="chip-shelf" id="chipShelf">
        <div class="chip-shelf-header">
          <span class="chip-shelf-title">FROM CARD</span>
          <span class="chip-shelf-hint" id="chipHint">tap a chip to assign it to a field</span>
        </div>
        <div class="chip-shelf-row" id="chipRow">
          ${chips.map((c, i) => `
            <button class="ocr-chip ${c.used ? 'used' : ''}" data-chip-idx="${i}" data-chip-text="${escHtml(c.text)}">
              ${c.icon ? `<span class="ocr-chip-icon">${c.icon}</span>` : ''}${escHtml(c.text)}
            </button>
          `).join('')}
        </div>
      </div>
    `;
  }

  function wireChipShelf(area, idx) {
    const shelf = area.querySelector('#chipShelf');
    if (!shelf) return;

    const fieldsEl = area.querySelector('#confirmFields');
    const hintEl   = area.querySelector('#chipHint');
    let selectedChipIdx = null;
    let selectedChipText = null;

    area.querySelectorAll('.ocr-chip').forEach(chipBtn => {
      chipBtn.addEventListener('click', e => {
        e.stopPropagation();
        const ci = Number(chipBtn.dataset.chipIdx);
        if (selectedChipIdx === ci) {
          // Deselect on second tap
          clearSelection();
          return;
        }
        // Select this chip
        area.querySelectorAll('.ocr-chip').forEach(b => b.classList.remove('selected'));
        chipBtn.classList.add('selected');
        selectedChipIdx  = ci;
        selectedChipText = chipBtn.dataset.chipText;
        fieldsEl.classList.add('assign-mode');
        hintEl.textContent = `← tap a field below to assign`;
      });
    });

    // Tap a field row to assign
    area.querySelectorAll('.confirm-field-row').forEach(row => {
      row.addEventListener('click', e => {
        if (selectedChipText === null) return;
        const key   = row.dataset.key;
        const input = row.querySelector('.confirm-field-input');
        if (!input) return;

        // Multi-value fields: append; single-value: replace
        if (key === 'email' || key === 'phone') {
          const cur = input.value.trim();
          input.value = cur ? `${cur}, ${selectedChipText}` : selectedChipText;
        } else {
          input.value = selectedChipText;
        }

        // Mark chip as used
        if (cardData[idx]._chips && cardData[idx]._chips[selectedChipIdx]) {
          cardData[idx]._chips[selectedChipIdx].used = true;
        }
        const chipBtn = area.querySelector(`.ocr-chip[data-chip-idx="${selectedChipIdx}"]`);
        if (chipBtn) chipBtn.classList.add('used');

        clearSelection();
        e.preventDefault();
        e.stopPropagation();
      });
    });

    // Tap anywhere else to deselect
    area.addEventListener('click', () => clearSelection(), { capture: false });

    function clearSelection() {
      area.querySelectorAll('.ocr-chip').forEach(b => b.classList.remove('selected'));
      fieldsEl.classList.remove('assign-mode');
      hintEl.textContent = 'tap a chip to assign it to a field';
      selectedChipIdx = null;
      selectedChipText = null;
    }
  }

  // ─── Field helpers ────────────────────────────────────────────────────────
  function fieldRow(label, key, value) {
    return `
      <div class="confirm-field-row" data-key="${key}">
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
    const introBy        = area.querySelector('#introBy');
    const nextAction     = area.querySelector('#nextAction');
    const nextActionDate = area.querySelector('#nextActionDate');
    if (introBy)        cardData[idx].intro_by        = introBy.value.trim();
    if (nextAction)     cardData[idx].next_action      = nextAction.value.trim();
    if (nextActionDate) cardData[idx].next_action_date = nextActionDate.value;
  }

  async function advance(idx) {
    if (idx < total - 1) renderCard(idx + 1);
    else await saveAll();
  }

  // ─── Save all ─────────────────────────────────────────────────────────────
  async function saveAll() {
    if (!app.currentSession) { showToast('No active session'); navigate('home'); return; }
    showStatus('Saving contacts…', 50);
    const saved = [];
    for (const data of cardData) {
      if (data._skipped) continue;
      try {
        const contact = await createContact({
          session_id:       app.currentSession.id,
          name:             data.name,
          title:            data.title,
          company:          data.company,
          emails:           data.emails || [],
          phones:           data.phones || [],
          linkedin:         data.linkedin || '',
          website:          data.website || '',
          tier:             data.tier,
          intro_by:         data.intro_by || '',
          next_action:      data.next_action || '',
          next_action_date: data.next_action_date || '',
          ocr_raw_front:    data.raw_text || '',
          ocr_raw_back:     data.ocr_raw_back || '',
          card_image_front: data.card_image_front || '',
          card_image_back:  data.card_image_back || '',
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

  // ─── Session summary ──────────────────────────────────────────────────────
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
      if (app.currentSession) await updateSession(app.currentSession.id, { is_open: false });
      app.currentSession  = null;
      app.pendingPhotos   = [];
      app.detectedCards   = [];
      navigate('home');
    });
  }

  // ─── Add back side (post-OCR, from confirm screen) ───────────────────────
  async function triggerBackCapture(idx) {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.onchange = async () => {
      if (!input.files[0]) return;
      showStatus('Processing back side…', 40);
      const dataUrl = await compressImage(input.files[0], 800, 0.7);
      const tmpCanvas = await dataUrlToCanvas(dataUrl);
      try {
        const ocrResult = await runOCR(tmpCanvas, () => {});
        const parsed    = parseFields(ocrResult);
        const d = cardData[idx];
        if (!d.name    && parsed.name)    d.name    = parsed.name;
        if (!d.title   && parsed.title)   d.title   = parsed.title;
        if (!d.company && parsed.company) d.company = parsed.company;
        if (!d.linkedin && parsed.linkedin) d.linkedin = parsed.linkedin;
        if (!d.website  && parsed.website)  d.website  = parsed.website;
        parsed.emails.forEach(e => { if (!d.emails.includes(e)) d.emails.push(e); });
        parsed.phones.forEach(p => { if (!d.phones.includes(p)) d.phones.push(p); });
        // Add back-side lines to chip shelf
        const backChips = buildChipsFromText(ocrResult.text, parsed);
        d._chips = [...(d._chips || []), ...backChips.filter(bc =>
          !(d._chips || []).some(ec => ec.text === bc.text)
        )];
        d.card_image_back = dataUrl;
        d.ocr_raw_back    = ocrResult.text;
      } catch {
        cardData[idx].card_image_back = dataUrl;
      }
      hideStatus();
      renderCard(idx);
    };
    input.click();
  }
}

// ─── Chip building ─────────────────────────────────────────────────────────

function buildChips(frontResult, backResult, parsed) {
  const allText = [
    frontResult?.text || '',
    backResult?.text  || '',
  ].join('\n');
  return buildChipsFromText(allText, parsed);
}

function buildChipsFromText(rawText, parsed) {
  const usedTexts = new Set([
    parsed.name, parsed.title, parsed.company, parsed.linkedin, parsed.website,
    ...(parsed.emails || []), ...(parsed.phones || []),
  ].filter(Boolean).map(s => s.toLowerCase()));

  const chips = [];
  const seen  = new Set();

  // Typed atoms first (emails, phones, URLs)
  (parsed.emails || []).forEach(t => addChip(t, '✉', true));
  (parsed.phones || []).forEach(t => addChip(t, '📞', true));
  if (parsed.linkedin) addChip(parsed.linkedin, '🔗', true);
  if (parsed.website)  addChip(parsed.website,  '🌐', true);

  // Remaining lines from raw OCR
  const lines = rawText.split('\n')
    .map(l => l.replace(/^\|\s*/, '').trim())  // strip leading pipe artefact
    .filter(l => l.length >= 3 && l.length <= 80);

  for (const line of lines) {
    const norm = line.toLowerCase();
    // Skip if already a typed-atom chip
    if ([...usedTexts].some(u => u && norm.includes(u.toLowerCase().slice(0, 10)))) {
      addChip(line, '', true);
    } else {
      addChip(line, '', false);
    }
  }

  return chips;

  function addChip(text, icon, used) {
    const key = text.toLowerCase().trim();
    if (!key || seen.has(key)) return;
    seen.add(key);
    chips.push({ text: text.trim(), icon, used });
  }
}

// ─── Misc helpers ──────────────────────────────────────────────────────────

function setupSwipe(el, onLeft, onRight) {
  let startX = null;
  el.addEventListener('touchstart', e => { startX = e.touches[0].clientX; }, { passive: true });
  el.addEventListener('touchend', e => {
    if (startX === null) return;
    const dx = e.changedTouches[0].clientX - startX;
    startX = null;
    if (Math.abs(dx) < 60) return;
    if (dx < 0) onLeft(); else onRight();
  });
}

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
