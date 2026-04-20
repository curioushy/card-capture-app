import { navigate, app, showToast, showStatus, hideStatus } from '../app.js';
import { compressImage } from '../db.js';

export function renderCapture(el) {
  const session = app.currentSession;

  el.innerHTML = `
    ${session
      ? `<div class="session-banner">
           <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
           ${session.event_name} · ${session.date}
         </div>`
      : `<div class="session-banner">
           <span class="no-session">No active session —</span>
           <button class="btn-ghost" id="startSessionLink" style="font-size:13px;padding:0;margin-left:4px;">start one first</button>
         </div>`
    }

    <div class="mode-toggle-bar">
      <button class="mode-toggle-btn ${app.captureMode === 'batch' ? 'active' : ''}" data-mode="batch">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><rect x="2" y="3" width="20" height="14" rx="2"/><rect x="5" y="6" width="4" height="8" rx="1" fill="currentColor" stroke="none" opacity=".4"/><rect x="10" y="6" width="4" height="8" rx="1" fill="currentColor" stroke="none" opacity=".4"/><rect x="15" y="6" width="4" height="8" rx="1" fill="currentColor" stroke="none" opacity=".4"/></svg>
        Batch
      </button>
      <button class="mode-toggle-btn ${app.captureMode === 'single' ? 'active' : ''}" data-mode="single">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><rect x="3" y="3" width="18" height="18" rx="2"/><line x1="12" y1="8" x2="12" y2="16"/><line x1="8" y1="12" x2="16" y2="12"/></svg>
        Single Card
      </button>
    </div>

    <!-- ── BATCH MODE ─────────────────────────────────── -->
    <div id="batchContent" ${app.captureMode !== 'batch' ? 'style="display:none"' : ''}>
      <div class="tab-bar">
        <button class="tab-btn active" data-tab="camera">Camera</button>
        <button class="tab-btn" data-tab="library">Library</button>
      </div>

      <div class="tab-panel" id="tab-camera">
        <div class="capture-area">
          <label class="photo-input-btn" for="cameraInput">
            <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
              <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/>
              <circle cx="12" cy="13" r="4"/>
            </svg>
            <span>Take Photo</span>
            <small>Lay multiple cards flat, shoot one photo</small>
          </label>
          <input type="file" id="cameraInput" accept="image/*" capture="environment" style="display:none">
        </div>
      </div>

      <div class="tab-panel" id="tab-library" style="display:none">
        <div class="capture-area">
          <label class="photo-input-btn" for="libraryInput">
            <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
              <rect x="3" y="3" width="18" height="18" rx="2"/>
              <circle cx="8.5" cy="8.5" r="1.5"/>
              <polyline points="21 15 16 10 5 21"/>
            </svg>
            <span>Choose Photos</span>
            <small>Select one or more</small>
          </label>
          <input type="file" id="libraryInput" accept="image/*" multiple style="display:none">
        </div>
      </div>

      <div class="photo-queue" id="photoQueue" style="display:none">
        <div class="queue-header">
          <span class="queue-count" id="queueCount">0 PHOTOS</span>
          <button class="btn-ghost" id="clearQueueBtn" style="font-size:13px;color:var(--danger);">Clear all</button>
        </div>
        <div class="queue-strip" id="queueStrip"></div>
        <button class="btn btn-primary btn-full" id="processBtn" disabled>
          Process 0 Photos →
        </button>
      </div>
    </div>

    <!-- ── SINGLE CARD MODE ───────────────────────────── -->
    <div id="singleContent" ${app.captureMode !== 'single' ? 'style="display:none"' : ''}>
      <div class="single-mode-hint">
        Scan each card's front — then add the back before processing
      </div>

      <div id="singleQueue"></div>

      <button class="btn btn-secondary btn-full" id="addCardBtn" style="margin:12px 16px 4px;width:calc(100% - 32px);">
        + Scan card front
      </button>

      <!-- Hidden file inputs for front/back capture -->
      <input type="file" id="frontInput" accept="image/*" capture="environment" style="display:none">
      <input type="file" id="backInput"  accept="image/*" capture="environment" style="display:none">

      <div style="padding:0 16px 16px;">
        <button class="btn btn-primary btn-full" id="processSingleBtn" disabled>
          Process 0 cards →
        </button>
      </div>
    </div>
  `;

  // ── Session guard ─────────────────────────────────────────────────────────────
  const linkBtn = el.querySelector('#startSessionLink');
  if (linkBtn) linkBtn.addEventListener('click', () => navigate('new-session'));

  // ── Mode toggle ───────────────────────────────────────────────────────────────
  el.querySelectorAll('.mode-toggle-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const mode = btn.dataset.mode;
      if (mode === app.captureMode) return;
      app.captureMode = mode;
      el.querySelectorAll('.mode-toggle-btn').forEach(b => b.classList.toggle('active', b.dataset.mode === mode));
      el.querySelector('#batchContent').style.display  = mode === 'batch'  ? '' : 'none';
      el.querySelector('#singleContent').style.display = mode === 'single' ? '' : 'none';
    });
  });

  // ══════════════════════════════════════════════════════════════════════════════
  // BATCH MODE
  // ══════════════════════════════════════════════════════════════════════════════

  // Tabs
  el.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      el.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      el.querySelectorAll('.tab-panel').forEach(p => p.style.display = 'none');
      el.querySelector(`#tab-${btn.dataset.tab}`).style.display = 'block';
    });
  });

  el.querySelector('#cameraInput').addEventListener('change', e => handleBatchFiles(e.target.files));
  el.querySelector('#libraryInput').addEventListener('change', e => handleBatchFiles(e.target.files));

  el.querySelector('#clearQueueBtn').addEventListener('click', () => {
    app.pendingPhotos = [];
    updateBatchQueue();
  });

  el.querySelector('#processBtn').addEventListener('click', () => {
    if (!app.currentSession) { showToast('Please start a session first'); return; }
    if (app.pendingPhotos.length === 0) return;
    navigate('detection');
  });

  if (app.pendingPhotos.length > 0) updateBatchQueue();

  async function handleBatchFiles(fileList) {
    if (!fileList || fileList.length === 0) return;
    if (!app.currentSession) { showToast('Please start a session first'); return; }
    for (const file of Array.from(fileList)) {
      if (!file.type.startsWith('image/')) continue;
      try {
        const dataUrl = await compressImage(file, 1600, 0.85);
        app.pendingPhotos.push({ dataUrl, file });
      } catch {
        const dataUrl = await readAsDataURL(file);
        app.pendingPhotos.push({ dataUrl, file });
      }
    }
    updateBatchQueue();
  }

  function updateBatchQueue() {
    const queueEl = el.querySelector('#photoQueue');
    const strip    = el.querySelector('#queueStrip');
    const countEl  = el.querySelector('#queueCount');
    const btn      = el.querySelector('#processBtn');
    const n = app.pendingPhotos.length;

    if (n === 0) { queueEl.style.display = 'none'; return; }

    queueEl.style.display = 'block';
    countEl.textContent = `${n} PHOTO${n === 1 ? '' : 'S'}`;
    btn.textContent = `Process ${n} Photo${n === 1 ? '' : 's'} →`;
    btn.disabled = false;

    strip.innerHTML = app.pendingPhotos.map((p, i) => `
      <div class="queue-thumb">
        <img src="${p.dataUrl}" alt="Photo ${i + 1}">
        <button class="queue-thumb-remove" data-index="${i}" aria-label="Remove">×</button>
      </div>
    `).join('');

    strip.querySelectorAll('.queue-thumb-remove').forEach(btn => {
      btn.addEventListener('click', () => {
        app.pendingPhotos.splice(Number(btn.dataset.index), 1);
        updateBatchQueue();
      });
    });
  }

  // ══════════════════════════════════════════════════════════════════════════════
  // SINGLE CARD MODE
  // ══════════════════════════════════════════════════════════════════════════════

  let pendingBackIdx = null; // which card we're adding a back side for

  renderSingleQueue();

  el.querySelector('#addCardBtn').addEventListener('click', () => {
    if (!app.currentSession) { showToast('Please start a session first'); return; }
    el.querySelector('#frontInput').value = '';
    el.querySelector('#frontInput').click();
  });

  el.querySelector('#frontInput').addEventListener('change', async e => {
    if (!e.target.files[0]) return;
    const dataUrl = await compress(e.target.files[0]);
    app.singleCards.push({ frontDataUrl: dataUrl, backDataUrl: null });
    renderSingleQueue();
    // Prompt for back side immediately after adding front
    pendingBackIdx = app.singleCards.length - 1;
    // Brief delay so the card renders first
    setTimeout(() => {
      const backBtns = el.querySelectorAll('.sc-back-btn');
      const btn = backBtns[backBtns.length - 1];
      if (btn) btn.classList.add('pulse');
    }, 100);
  });

  el.querySelector('#backInput').addEventListener('change', async e => {
    if (pendingBackIdx === null || !e.target.files[0]) return;
    const dataUrl = await compress(e.target.files[0]);
    app.singleCards[pendingBackIdx].backDataUrl = dataUrl;
    pendingBackIdx = null;
    renderSingleQueue();
  });

  el.querySelector('#processSingleBtn').addEventListener('click', async () => {
    if (!app.currentSession) { showToast('Please start a session first'); return; }
    if (app.singleCards.length === 0) return;
    await processSingleCards();
  });

  function renderSingleQueue() {
    const queueEl = el.querySelector('#singleQueue');
    const processBtn = el.querySelector('#processSingleBtn');
    const cards = app.singleCards;

    if (cards.length === 0) {
      queueEl.innerHTML = '';
      processBtn.disabled = true;
      processBtn.textContent = 'Process 0 cards →';
      return;
    }

    processBtn.disabled = false;
    processBtn.textContent = `Process ${cards.length} card${cards.length === 1 ? '' : 's'} →`;

    queueEl.innerHTML = `
      <div class="sc-list">
        ${cards.map((c, i) => `
          <div class="sc-row" data-idx="${i}">
            <div class="sc-faces">
              <div class="sc-face sc-front">
                <img src="${c.frontDataUrl}" alt="Front">
                <span class="sc-face-label">Front</span>
              </div>
              ${c.backDataUrl
                ? `<div class="sc-face sc-back-filled">
                     <img src="${c.backDataUrl}" alt="Back">
                     <span class="sc-face-label">Back</span>
                   </div>`
                : `<button class="sc-face sc-back-btn" data-idx="${i}">
                     <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
                     <span class="sc-face-label">Add back</span>
                   </button>`
              }
            </div>
            <button class="sc-remove" data-idx="${i}" aria-label="Remove card">×</button>
          </div>
        `).join('')}
      </div>
    `;

    queueEl.querySelectorAll('.sc-back-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        pendingBackIdx = Number(btn.dataset.idx);
        el.querySelector('#backInput').value = '';
        el.querySelector('#backInput').click();
      });
    });

    queueEl.querySelectorAll('.sc-remove').forEach(btn => {
      btn.addEventListener('click', () => {
        app.singleCards.splice(Number(btn.dataset.idx), 1);
        if (pendingBackIdx !== null && pendingBackIdx >= app.singleCards.length) pendingBackIdx = null;
        renderSingleQueue();
      });
    });
  }

  async function processSingleCards() {
    showStatus('Preparing cards…', 10);
    app.detectedCards = [];
    for (let i = 0; i < app.singleCards.length; i++) {
      const card = app.singleCards[i];
      showStatus(`Preparing card ${i + 1} of ${app.singleCards.length}…`, 10 + Math.round((i / app.singleCards.length) * 70));
      const frontCanvas = await dataUrlToCanvas(card.frontDataUrl);
      const entry = { cropCanvas: frontCanvas, accepted: true, isSingleCard: true };
      if (card.backDataUrl) {
        entry.backCanvas = await dataUrlToCanvas(card.backDataUrl);
      }
      app.detectedCards.push(entry);
    }
    hideStatus();
    // Clear the single-card queue so a fresh session starts clean
    app.singleCards = [];
    navigate('confirm');
  }

  async function compress(file) {
    try { return await compressImage(file, 1600, 0.85); }
    catch { return readAsDataURL(file); }
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function readAsDataURL(file) {
  return new Promise((res, rej) => {
    const reader = new FileReader();
    reader.onload = e => res(e.target.result);
    reader.onerror = rej;
    reader.readAsDataURL(file);
  });
}

function dataUrlToCanvas(dataUrl) {
  return new Promise(res => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      canvas.getContext('2d').drawImage(img, 0, 0);
      res(canvas);
    };
    img.src = dataUrl;
  });
}
