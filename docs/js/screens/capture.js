import { navigate, app, showToast } from '../app.js';
import { compressImage } from '../db.js';

// ─── Module-level camera state ────────────────────────────────────────────────
let cameraStream  = null;
let facingMode    = 'environment';  // 'environment' | 'user'
let cameraOverlay = null;           // the DOM node while camera is open
let singleState   = 'front';        // 'front' | 'back' — for single-card mode

// ─── Main screen render ───────────────────────────────────────────────────────
export function renderCapture(el) {
  stopCamera(); // clean up if somehow re-rendered while camera was open

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

    <!-- Entry buttons -->
    <div class="cap-entry-wrap">
      <button class="cap-entry-btn cap-entry-primary" id="openCameraBtn">
        <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
          <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/>
          <circle cx="12" cy="13" r="4"/>
        </svg>
        <span>Camera</span>
        <small>Live viewfinder</small>
      </button>

      <button class="cap-entry-btn cap-entry-secondary" id="openLibraryBtn">
        <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
          <rect x="3" y="3" width="18" height="18" rx="2"/>
          <circle cx="8.5" cy="8.5" r="1.5"/>
          <polyline points="21 15 16 10 5 21"/>
        </svg>
        <span>Library</span>
        <small>Choose from photos</small>
      </button>

      <input type="file" id="libraryInput" accept="image/*" multiple style="display:none">
    </div>

    <!-- ── BATCH queue ────────────────────────────────── -->
    <div id="batchQueue" style="display:none">
      <div class="photo-queue">
        <div class="queue-header">
          <span class="queue-count" id="queueCount">0 PHOTOS</span>
          <button class="btn-ghost" id="clearQueueBtn" style="font-size:13px;color:var(--danger);">Clear all</button>
        </div>
        <div class="queue-strip" id="queueStrip"></div>
        <button class="btn btn-primary btn-full" id="processBtn" disabled>Process 0 Photos →</button>
      </div>
    </div>

    <!-- ── SINGLE queue ───────────────────────────────── -->
    <div id="singleQueue" style="display:none">
      <div class="photo-queue">
        <div class="queue-header">
          <span class="queue-count" id="singleCount">0 CARDS</span>
          <button class="btn-ghost" id="clearSingleBtn" style="font-size:13px;color:var(--danger);">Clear all</button>
        </div>
        <div id="singleList"></div>
        <button class="btn btn-primary btn-full" id="processSingleBtn" disabled>Process 0 cards →</button>
      </div>
    </div>
  `;

  // Session link
  el.querySelector('#startSessionLink')?.addEventListener('click', () => navigate('new-session'));

  // Mode toggle
  el.querySelectorAll('.mode-toggle-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const mode = btn.dataset.mode;
      if (mode === app.captureMode) return;
      app.captureMode = mode;
      el.querySelectorAll('.mode-toggle-btn').forEach(b => b.classList.toggle('active', b.dataset.mode === mode));
      refreshQueues();
    });
  });

  // Camera button
  el.querySelector('#openCameraBtn').addEventListener('click', () => {
    if (!app.currentSession) { showToast('Please start a session first'); return; }
    openCameraOverlay();
  });

  // Library button
  el.querySelector('#openLibraryBtn').addEventListener('click', () => {
    if (!app.currentSession) { showToast('Please start a session first'); return; }
    el.querySelector('#libraryInput').click();
  });

  el.querySelector('#libraryInput').addEventListener('change', async e => {
    await handleLibraryFiles(e.target.files);
    e.target.value = '';
    refreshQueues();
  });

  // Batch queue buttons
  el.querySelector('#clearQueueBtn').addEventListener('click', () => {
    app.pendingPhotos = [];
    refreshQueues();
  });

  el.querySelector('#processBtn').addEventListener('click', () => {
    if (app.pendingPhotos.length === 0) return;
    navigate('detection');
  });

  // Single queue buttons
  el.querySelector('#clearSingleBtn').addEventListener('click', () => {
    app.singleCards = [];
    refreshQueues();
  });

  el.querySelector('#processSingleBtn').addEventListener('click', () => {
    if (app.singleCards.length === 0) return;
    processSingleCards();
  });

  refreshQueues();

  // ── Queue helpers ────────────────────────────────────────────────────────────

  function refreshQueues() {
    if (app.captureMode === 'batch') {
      renderBatchQueue();
      el.querySelector('#batchQueue').style.display  = app.pendingPhotos.length ? '' : 'none';
      el.querySelector('#singleQueue').style.display = 'none';
    } else {
      renderSingleQueue();
      el.querySelector('#singleQueue').style.display = app.singleCards.length ? '' : 'none';
      el.querySelector('#batchQueue').style.display  = 'none';
    }
  }

  function renderBatchQueue() {
    const n = app.pendingPhotos.length;
    el.querySelector('#queueCount').textContent = `${n} PHOTO${n === 1 ? '' : 'S'}`;
    el.querySelector('#processBtn').disabled = n === 0;
    el.querySelector('#processBtn').textContent = `Process ${n} Photo${n === 1 ? '' : 's'} →`;

    const strip = el.querySelector('#queueStrip');
    strip.innerHTML = app.pendingPhotos.map((p, i) => `
      <div class="queue-thumb">
        <img src="${p.dataUrl}" alt="Photo ${i+1}">
        <button class="queue-thumb-remove" data-i="${i}" aria-label="Remove">×</button>
      </div>
    `).join('');

    strip.querySelectorAll('.queue-thumb-remove').forEach(btn => {
      btn.addEventListener('click', () => {
        app.pendingPhotos.splice(Number(btn.dataset.i), 1);
        refreshQueues();
      });
    });
  }

  function renderSingleQueue() {
    const cards = app.singleCards;
    const n = cards.length;
    el.querySelector('#singleCount').textContent = `${n} CARD${n === 1 ? '' : 'S'}`;
    el.querySelector('#processSingleBtn').disabled = n === 0;
    el.querySelector('#processSingleBtn').textContent = `Process ${n} card${n === 1 ? '' : 's'} →`;

    const list = el.querySelector('#singleList');
    if (n === 0) { list.innerHTML = ''; return; }

    list.innerHTML = `
      <div class="sc-list">
        ${cards.map((c, i) => `
          <div class="sc-row">
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
                : `<div class="sc-face sc-face-empty">
                     <span class="sc-face-label" style="top:50%;transform:translateY(-50%);font-size:11px;font-weight:500;color:#888;">No back</span>
                   </div>`
              }
            </div>
            <button class="sc-remove" data-i="${i}" aria-label="Remove">×</button>
          </div>
        `).join('')}
      </div>
    `;

    list.querySelectorAll('.sc-remove').forEach(btn => {
      btn.addEventListener('click', () => {
        app.singleCards.splice(Number(btn.dataset.i), 1);
        refreshQueues();
      });
    });
  }

  async function handleLibraryFiles(fileList) {
    if (!fileList || fileList.length === 0) return;
    for (const file of Array.from(fileList)) {
      if (!file.type.startsWith('image/')) continue;
      const dataUrl = await compressWith(file);
      if (app.captureMode === 'batch') {
        app.pendingPhotos.push({ dataUrl, file });
      } else {
        // In single mode: library files treated as fronts
        app.singleCards.push({ frontDataUrl: dataUrl, backDataUrl: null });
      }
    }
  }

  async function processSingleCards() {
    const { showStatus, hideStatus } = await import('../app.js');
    app.detectedCards = [];
    for (let i = 0; i < app.singleCards.length; i++) {
      const card = app.singleCards[i];
      showStatus(`Preparing card ${i+1} of ${app.singleCards.length}…`, 10 + Math.round((i / app.singleCards.length) * 70));
      const frontCanvas = await dataUrlToCanvas(card.frontDataUrl);
      const entry = { cropCanvas: frontCanvas, accepted: true, isSingleCard: true };
      if (card.backDataUrl) entry.backCanvas = await dataUrlToCanvas(card.backDataUrl);
      app.detectedCards.push(entry);
    }
    hideStatus();
    app.singleCards = [];
    navigate('confirm');
  }
}

// ─── Camera overlay ───────────────────────────────────────────────────────────

function openCameraOverlay() {
  if (cameraOverlay) return; // already open

  singleState = 'front'; // reset single-card state

  const overlay = document.createElement('div');
  overlay.className = 'cam-overlay';
  overlay.innerHTML = buildOverlayHTML();
  document.body.appendChild(overlay);
  document.body.classList.add('camera-active');
  cameraOverlay = overlay;

  // Start video stream
  startStream(overlay);

  // ── Controls ────────────────────────────────────────────────────────────────

  overlay.querySelector('#camClose').addEventListener('click', () => {
    stopCamera();
    // Refresh the screen queue display
    const captureEl = document.getElementById('screen-capture');
    if (captureEl) {
      // Trigger a re-render by re-calling the capture screen
      import('./capture.js').then(m => m.renderCapture(captureEl));
    }
  });

  overlay.querySelector('#camShutter').addEventListener('click', () => captureFrame(overlay));

  overlay.querySelector('#camFlip').addEventListener('click', () => {
    facingMode = facingMode === 'environment' ? 'user' : 'environment';
    restartStream(overlay);
  });

  overlay.querySelector('#camLibrary').addEventListener('click', () => {
    overlay.querySelector('#camLibInput').click();
  });

  overlay.querySelector('#camLibInput').addEventListener('change', async e => {
    const files = e.target.files;
    if (!files || files.length === 0) return;
    for (const file of Array.from(files)) {
      if (!file.type.startsWith('image/')) continue;
      const dataUrl = await compressWith(file);
      addPhotoToQueue(dataUrl, overlay);
    }
    e.target.value = '';
    updateOverlayState(overlay);
  });

  overlay.querySelector('#camProcessBtn')?.addEventListener('click', () => {
    stopCamera();
    if (app.captureMode === 'batch') {
      navigate('detection');
    } else {
      // Process single cards
      processSingleFromOverlay();
    }
  });
}

function buildOverlayHTML() {
  const session = app.currentSession;
  const isSingle = app.captureMode === 'single';
  const singleLabel = singleState === 'front' ? 'FRONT' : 'BACK (optional)';

  return `
    <div class="cam-top">
      <button class="cam-close-btn" id="camClose" aria-label="Close">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
          <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
        </svg>
      </button>
      <span class="cam-session-label">${session ? session.event_name : '—'}</span>
      ${isSingle
        ? `<span class="cam-mode-label">SCAN ${singleLabel}</span>`
        : `<span class="cam-mode-label">BATCH</span>`}
    </div>

    <div class="cam-viewfinder" id="camViewfinder">
      <video id="camVideo" autoplay playsinline muted></video>
      <div class="cam-corners">
        <span class="cam-corner tl"></span>
        <span class="cam-corner tr"></span>
        <span class="cam-corner bl"></span>
        <span class="cam-corner br"></span>
      </div>
      <div class="cam-no-access" id="camNoAccess" style="display:none">
        <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="#666" stroke-width="1.5">
          <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/>
          <line x1="1" y1="1" x2="23" y2="23"/>
        </svg>
        <p>Camera access denied</p>
        <small>Use Library instead, or allow camera in Settings</small>
      </div>
    </div>

    <div class="cam-thumb-strip" id="camThumbStrip"></div>

    <div class="cam-controls">
      <button class="cam-ctrl-btn" id="camLibrary" aria-label="Choose from library">
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <rect x="3" y="3" width="18" height="18" rx="2"/>
          <circle cx="8.5" cy="8.5" r="1.5"/>
          <polyline points="21 15 16 10 5 21"/>
        </svg>
        <span>Library</span>
      </button>

      <div class="cam-shutter-wrap">
        <button class="cam-shutter-btn" id="camShutter" aria-label="Take photo">
          <span class="cam-shutter-inner"></span>
        </button>
        ${(app.captureMode === 'batch' && app.pendingPhotos.length > 0)
          ? `<div class="cam-count-badge">${app.pendingPhotos.length}</div>`
          : (app.captureMode === 'single' && app.singleCards.length > 0)
          ? `<div class="cam-count-badge">${app.singleCards.length}</div>`
          : ''}
      </div>

      <button class="cam-ctrl-btn" id="camFlip" aria-label="Flip camera">
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M1 4v6h6"/><path d="M23 20v-6h-6"/>
          <path d="M20.49 9A9 9 0 0 0 5.64 5.64L1 10m22 4l-4.64 4.36A9 9 0 0 1 3.51 15"/>
        </svg>
        <span>Flip</span>
      </button>
    </div>

    ${(app.pendingPhotos.length > 0 || app.singleCards.length > 0)
      ? `<button class="cam-process-btn" id="camProcessBtn">
           Process ${app.captureMode === 'batch' ? app.pendingPhotos.length + ' photo' + (app.pendingPhotos.length === 1 ? '' : 's') : app.singleCards.length + ' card' + (app.singleCards.length === 1 ? '' : 's')} →
         </button>`
      : `<button class="cam-process-btn cam-process-btn-hidden" id="camProcessBtn">Process →</button>`}

    <input type="file" id="camLibInput" accept="image/*" multiple style="display:none">
  `;
}

async function startStream(overlay) {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        facingMode: { ideal: facingMode },
        width:  { ideal: 3840 },
        height: { ideal: 2160 },
      }
    });
    cameraStream = stream;
    const video = overlay.querySelector('#camVideo');
    if (!video) { stopCamera(); return; }
    video.srcObject = stream;
    await video.play().catch(() => {});
  } catch (err) {
    console.warn('[Camera] getUserMedia failed:', err.name, err.message);
    const noAccess = overlay.querySelector('#camNoAccess');
    if (noAccess) noAccess.style.display = 'flex';
  }
}

async function restartStream(overlay) {
  if (cameraStream) {
    cameraStream.getTracks().forEach(t => t.stop());
    cameraStream = null;
  }
  const video = overlay.querySelector('#camVideo');
  if (video) video.srcObject = null;
  await startStream(overlay);
}

function captureFrame(overlay) {
  const video = overlay.querySelector('#camVideo');
  if (!video || !video.videoWidth) {
    // No live stream — can't capture
    showToast('Camera not ready — use Library');
    return;
  }

  // Draw full-res frame to canvas
  const canvas = document.createElement('canvas');
  canvas.width  = video.videoWidth;
  canvas.height = video.videoHeight;
  canvas.getContext('2d').drawImage(video, 0, 0);

  // Flash animation
  overlay.classList.add('cam-flash');
  setTimeout(() => overlay.classList.remove('cam-flash'), 180);

  // Haptic if available
  if (navigator.vibrate) navigator.vibrate(30);

  // Compress and store
  const dataUrl = compressCanvas(canvas, 1600, 0.88);

  addPhotoToQueue(dataUrl, overlay);
  updateOverlayState(overlay);
}

function addPhotoToQueue(dataUrl, overlay) {
  if (app.captureMode === 'batch') {
    app.pendingPhotos.push({ dataUrl, file: null });
  } else {
    // Single-card mode: alternate front → back
    if (singleState === 'front') {
      app.singleCards.push({ frontDataUrl: dataUrl, backDataUrl: null });
      singleState = 'back';
    } else {
      // Add back to the last card
      if (app.singleCards.length > 0) {
        app.singleCards[app.singleCards.length - 1].backDataUrl = dataUrl;
      }
      singleState = 'front'; // next capture is a new card's front
    }
  }
  renderOverlayThumbs(overlay);
}

function renderOverlayThumbs(overlay) {
  const strip = overlay.querySelector('#camThumbStrip');
  if (!strip) return;

  const items = app.captureMode === 'batch'
    ? app.pendingPhotos.map(p => ({ src: p.dataUrl, label: '' }))
    : app.singleCards.flatMap(c => [
        { src: c.frontDataUrl, label: 'F' },
        ...(c.backDataUrl ? [{ src: c.backDataUrl, label: 'B' }] : [])
      ]);

  if (items.length === 0) { strip.innerHTML = ''; return; }

  strip.innerHTML = items.map(item => `
    <div class="cam-thumb">
      <img src="${item.src}" alt="">
      ${item.label ? `<span class="cam-thumb-label">${item.label}</span>` : ''}
    </div>
  `).join('');

  // Scroll to end to show most recent
  setTimeout(() => { strip.scrollLeft = strip.scrollWidth; }, 50);
}

function updateOverlayState(overlay) {
  if (!overlay) return;
  const isSingle  = app.captureMode === 'single';
  const batchCount  = app.pendingPhotos.length;
  const singleCount = app.singleCards.length;
  const count = isSingle ? singleCount : batchCount;

  // Update process button
  const btn = overlay.querySelector('#camProcessBtn');
  if (btn) {
    if (count > 0) {
      btn.classList.remove('cam-process-btn-hidden');
      const noun = isSingle ? `card${count === 1 ? '' : 's'}` : `photo${count === 1 ? '' : 's'}`;
      btn.textContent = `Process ${count} ${noun} →`;
    } else {
      btn.classList.add('cam-process-btn-hidden');
    }
    // Re-attach listener (simple: replace button)
    const newBtn = btn.cloneNode(true);
    btn.parentNode.replaceChild(newBtn, btn);
    newBtn.addEventListener('click', () => {
      stopCamera();
      if (!isSingle) navigate('detection');
      else processSingleFromOverlay();
    });
  }

  // Update count badge
  const wrap = overlay.querySelector('.cam-shutter-wrap');
  if (wrap) {
    let badge = wrap.querySelector('.cam-count-badge');
    if (count > 0) {
      if (!badge) {
        badge = document.createElement('div');
        badge.className = 'cam-count-badge';
        wrap.appendChild(badge);
      }
      badge.textContent = count;
    } else {
      badge?.remove();
    }
  }

  // Update single-mode label
  if (isSingle) {
    const modeLabel = overlay.querySelector('.cam-mode-label');
    if (modeLabel) modeLabel.textContent = `SCAN ${singleState === 'front' ? 'FRONT' : 'BACK (optional)'}`;
  }
}

async function processSingleFromOverlay() {
  const { showStatus, hideStatus } = await import('../app.js');
  app.detectedCards = [];
  for (let i = 0; i < app.singleCards.length; i++) {
    const card = app.singleCards[i];
    showStatus(`Preparing card ${i+1} of ${app.singleCards.length}…`, 10 + Math.round((i / app.singleCards.length) * 80));
    const frontCanvas = await dataUrlToCanvas(card.frontDataUrl);
    const entry = { cropCanvas: frontCanvas, accepted: true, isSingleCard: true };
    if (card.backDataUrl) entry.backCanvas = await dataUrlToCanvas(card.backDataUrl);
    app.detectedCards.push(entry);
  }
  hideStatus();
  app.singleCards = [];
  navigate('confirm');
}

// ─── Stop camera + remove overlay ────────────────────────────────────────────

function stopCamera() {
  if (cameraStream) {
    cameraStream.getTracks().forEach(t => t.stop());
    cameraStream = null;
  }
  if (cameraOverlay) {
    cameraOverlay.remove();
    cameraOverlay = null;
  }
  document.body.classList.remove('camera-active');
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function compressCanvas(canvas, maxDim = 1600, quality = 0.88) {
  const { width, height } = canvas;
  const ratio = Math.min(1, maxDim / Math.max(width, height));
  if (ratio >= 1 && quality >= 0.95) return canvas.toDataURL('image/jpeg', quality);
  const c = document.createElement('canvas');
  c.width  = Math.round(width  * ratio);
  c.height = Math.round(height * ratio);
  c.getContext('2d').drawImage(canvas, 0, 0, c.width, c.height);
  return c.toDataURL('image/jpeg', quality);
}

async function compressWith(file) {
  try   { return await compressImage(file, 1600, 0.85); }
  catch { return readAsDataURL(file); }
}

function readAsDataURL(file) {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = e => res(e.target.result);
    r.onerror = rej;
    r.readAsDataURL(file);
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
