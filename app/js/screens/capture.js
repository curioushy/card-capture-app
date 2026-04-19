import { navigate, app, showToast } from '../app.js';
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
          <small>Tap to open camera</small>
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
      <button class="btn btn-primary btn-full" id="processBtn">
        Process 0 Photos →
      </button>
    </div>
  `;

  // No session guard
  const linkBtn = el.querySelector('#startSessionLink');
  if (linkBtn) linkBtn.addEventListener('click', () => navigate('new-session'));

  // Tabs
  el.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      el.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      el.querySelectorAll('.tab-panel').forEach(p => p.style.display = 'none');
      el.querySelector(`#tab-${btn.dataset.tab}`).style.display = 'block';
    });
  });

  // File inputs
  el.querySelector('#cameraInput').addEventListener('change', e => handleFiles(e.target.files));
  el.querySelector('#libraryInput').addEventListener('change', e => handleFiles(e.target.files));

  el.querySelector('#clearQueueBtn').addEventListener('click', () => {
    app.pendingPhotos = [];
    updateQueue();
  });

  el.querySelector('#processBtn').addEventListener('click', () => {
    if (!app.currentSession) {
      showToast('Please start a session first');
      return;
    }
    if (app.pendingPhotos.length === 0) return;
    navigate('detection');
  });

  // Restore existing queue if navigating back
  if (app.pendingPhotos.length > 0) updateQueue();

  async function handleFiles(fileList) {
    if (!fileList || fileList.length === 0) return;
    if (!app.currentSession) {
      showToast('Please start a session first');
      return;
    }

    for (const file of Array.from(fileList)) {
      if (!file.type.startsWith('image/')) continue;
      try {
        const dataUrl = await compressImage(file, 1600, 0.85);
        app.pendingPhotos.push({ dataUrl, file });
      } catch (e) {
        // fallback: read as-is
        const dataUrl = await readAsDataURL(file);
        app.pendingPhotos.push({ dataUrl, file });
      }
    }
    updateQueue();
  }

  function updateQueue() {
    const queueEl = el.querySelector('#photoQueue');
    const strip = el.querySelector('#queueStrip');
    const countEl = el.querySelector('#queueCount');
    const processBtn = el.querySelector('#processBtn');
    const n = app.pendingPhotos.length;

    if (n === 0) {
      queueEl.style.display = 'none';
      return;
    }

    queueEl.style.display = 'block';
    countEl.textContent = `${n} PHOTO${n === 1 ? '' : 'S'}`;
    processBtn.textContent = `Process ${n} Photo${n === 1 ? '' : 's'} →`;
    processBtn.disabled = false;

    strip.innerHTML = app.pendingPhotos.map((p, i) => `
      <div class="queue-thumb">
        <img src="${p.dataUrl}" alt="Photo ${i + 1}">
        <button class="queue-thumb-remove" data-index="${i}" aria-label="Remove">×</button>
      </div>
    `).join('');

    strip.querySelectorAll('.queue-thumb-remove').forEach(btn => {
      btn.addEventListener('click', () => {
        app.pendingPhotos.splice(Number(btn.dataset.index), 1);
        updateQueue();
      });
    });
  }
}

function readAsDataURL(file) {
  return new Promise((res, rej) => {
    const reader = new FileReader();
    reader.onload = e => res(e.target.result);
    reader.onerror = rej;
    reader.readAsDataURL(file);
  });
}
