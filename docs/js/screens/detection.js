import { navigate, app, showStatus, hideStatus, showToast } from '../app.js';
import { detectCards, loadOpenCV } from '../detect.js';

export async function renderDetection(el) {
  if (!app.pendingPhotos || app.pendingPhotos.length === 0) {
    navigate('capture'); return;
  }

  app.detectedCards = [];
  let currentPhotoIndex = 0;

  el.innerHTML = `
    <div style="background:#000;min-height:100%">
      <div id="photoNav" style="display:flex;align-items:center;justify-content:space-between;padding:10px 16px;background:#111;color:#fff;">
        <button id="prevPhoto" class="icon-btn" style="color:#fff;opacity:0.5;" disabled>‹</button>
        <span id="photoLabel" style="font-size:14px;font-weight:600;">Photo 1 of ${app.pendingPhotos.length}</span>
        <button id="nextPhoto" class="icon-btn" style="color:#fff;opacity:0.5;" ${app.pendingPhotos.length < 2 ? 'disabled' : ''}>›</button>
      </div>

      <div id="imageWrap" class="detection-image-wrap">
        <img id="detectionImg" style="width:100%;display:block;max-height:55vw;object-fit:contain;background:#000;">
        <canvas id="overlayCanvas" class="detection-canvas"></canvas>
      </div>

      <div id="cardList" class="detection-card-list"></div>

      <div class="detection-actions" style="background:#111;border-top:1px solid #333;padding:12px 16px;display:flex;flex-direction:column;gap:8px;">
        <button id="addManualBtn" class="btn btn-secondary btn-full" style="color:#fff;background:transparent;border-color:#444;">
          + Add card manually
        </button>
        <button id="confirmBtn" class="btn btn-primary btn-full" disabled>
          Confirm 0 cards →
        </button>
      </div>
    </div>
  `;

  const img = el.querySelector('#detectionImg');
  const canvas = el.querySelector('#overlayCanvas');
  const cardList = el.querySelector('#cardList');
  const confirmBtn = el.querySelector('#confirmBtn');
  const photoLabel = el.querySelector('#photoLabel');

  // Per-photo state: array of arrays of card objects
  const photoCards = app.pendingPhotos.map(() => []);
  // Accepted state per card: photoCards[i][j].accepted = bool
  let processingDone = [];

  async function loadPhoto(idx) {
    currentPhotoIndex = idx;
    photoLabel.textContent = `Photo ${idx + 1} of ${app.pendingPhotos.length}`;
    el.querySelector('#prevPhoto').disabled = idx === 0;
    el.querySelector('#nextPhoto').disabled = idx === app.pendingPhotos.length - 1;

    img.src = app.pendingPhotos[idx].dataUrl;
    await new Promise(res => { img.onload = res; if (img.complete) res(); });

    // Resize canvas to match image display
    const rect = img.getBoundingClientRect();
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    canvas.style.width = rect.width + 'px';
    canvas.style.height = rect.height + 'px';

    if (!processingDone[idx]) {
      await processPhoto(idx);
    } else {
      renderOverlay(idx);
      renderCardList(idx);
    }
  }

  async function makeFullImageCard(dataUrl) {
    const img = new Image();
    img.src = dataUrl;
    await new Promise(res => { img.onload = res; if (img.complete) res(); });
    const canvas = document.createElement('canvas');
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    canvas.getContext('2d').drawImage(img, 0, 0);
    const corners = [
      { x: 0, y: 0 }, { x: img.naturalWidth - 1, y: 0 },
      { x: img.naturalWidth - 1, y: img.naturalHeight - 1 }, { x: 0, y: img.naturalHeight - 1 },
    ];
    return { corners, cropCanvas: canvas, area: img.naturalWidth * img.naturalHeight };
  }

  async function processPhoto(idx) {
    showStatus(`Detecting cards in photo ${idx + 1}…`, 20);
    let opencvError = null;
    try {
      await loadOpenCV();
      showStatus(`Detecting cards in photo ${idx + 1}…`, 60);

      const tmpImg = new Image();
      tmpImg.src = app.pendingPhotos[idx].dataUrl;
      await new Promise(res => { tmpImg.onload = res; if (tmpImg.complete) res(); });

      const cards = await detectCards(tmpImg);
      photoCards[idx] = cards.map(c => ({ ...c, accepted: true }));

      if (cards.length === 1 && cards[0].isFallback) {
        showToast('Card edges unclear — showing full image. Crop manually if needed.');
      }
    } catch (e) {
      console.warn('Detection error:', e);
      opencvError = e;
      photoCards[idx] = [];
    }

    // Universal fallback: if no cards (detection threw OR returned nothing),
    // synthesize a full-image card so the user is never stranded.
    if (photoCards[idx].length === 0) {
      const fallback = await makeFullImageCard(app.pendingPhotos[idx].dataUrl);
      photoCards[idx] = [{ ...fallback, accepted: true, isFallback: true }];
      showToast(opencvError
        ? 'Card detection unavailable — showing full image'
        : 'No card edges found — showing full image');
    }

    processingDone[idx] = true;
    hideStatus();

    renderOverlay(idx);
    renderCardList(idx);
    updateConfirmBtn();
  }

  function renderOverlay(idx) {
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    const scaleX = canvas.width / img.naturalWidth;
    const scaleY = canvas.height / img.naturalHeight;

    photoCards[idx].forEach((card, i) => {
      const corners = card.corners;
      ctx.beginPath();
      ctx.moveTo(corners[0].x, corners[0].y);
      for (let j = 1; j < corners.length; j++) ctx.lineTo(corners[j].x, corners[j].y);
      ctx.closePath();
      ctx.strokeStyle = card.accepted ? '#1d6f42' : '#e74c3c';
      ctx.lineWidth = 3;
      ctx.stroke();
      ctx.fillStyle = card.accepted ? 'rgba(29,111,66,0.15)' : 'rgba(231,76,60,0.15)';
      ctx.fill();

      // Card number badge
      const cx = corners.reduce((s, c) => s + c.x, 0) / 4;
      const cy = corners.reduce((s, c) => s + c.y, 0) / 4;
      ctx.fillStyle = card.accepted ? '#1d6f42' : '#e74c3c';
      ctx.beginPath();
      ctx.arc(cx, cy, 20, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#fff';
      ctx.font = 'bold 18px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(i + 1, cx, cy);
    });
  }

  function renderCardList(idx) {
    const cards = photoCards[idx];
    if (cards.length === 0) {
      cardList.innerHTML = `<p style="color:#888;font-size:13px;padding:12px 0;text-align:center;">No cards detected. Add manually or move to next photo.</p>`;
      return;
    }

    cardList.innerHTML = cards.map((card, i) => `
      <div class="detection-card-item ${card.accepted ? 'accepted' : 'rejected'}" data-index="${i}">
        <canvas class="detection-card-thumb" id="thumb-${i}"></canvas>
        <span class="detection-card-num">Card ${i + 1}${card.isFallback ? ' (full image)' : ''}</span>
        <div class="detection-toggle-btns">
          <button class="${card.accepted ? 'accept' : ''}" data-action="accept" data-index="${i}">✓</button>
          <button class="${!card.accepted ? 'reject' : ''}" data-action="reject" data-index="${i}">✕</button>
        </div>
      </div>
    `).join('');

    // Draw thumbnails
    cards.forEach((card, i) => {
      const thumbCanvas = cardList.querySelector(`#thumb-${i}`);
      if (card.cropCanvas && thumbCanvas) {
        thumbCanvas.width = card.cropCanvas.width;
        thumbCanvas.height = card.cropCanvas.height;
        thumbCanvas.getContext('2d').drawImage(card.cropCanvas, 0, 0);
      }
    });

    cardList.querySelectorAll('.detection-toggle-btns button').forEach(btn => {
      btn.addEventListener('click', () => {
        const i = Number(btn.dataset.index);
        photoCards[idx][i].accepted = btn.dataset.action === 'accept';
        renderOverlay(idx);
        renderCardList(idx);
        updateConfirmBtn();
      });
    });
  }

  function updateConfirmBtn() {
    const accepted = photoCards.flat().filter(c => c.accepted);
    confirmBtn.textContent = `Confirm ${accepted.length} card${accepted.length === 1 ? '' : 's'} →`;
    confirmBtn.disabled = accepted.length === 0;
  }

  // Manual crop tool — guard flag prevents listener stacking on repeated clicks
  let manualCropActive = false;
  el.querySelector('#addManualBtn').addEventListener('click', () => {
    if (manualCropActive) return;
    manualCropActive = true;
    showToast('Drag on the image to select a card area');
    startManualCrop(currentPhotoIndex, () => { manualCropActive = false; });
  });

  function startManualCrop(idx, onDone) {
    let startX, startY, drawing = false;
    const rect = img.getBoundingClientRect();
    const scaleX = img.naturalWidth / rect.width;
    const scaleY = img.naturalHeight / rect.height;
    const ctx = canvas.getContext('2d');

    function toNatural(clientX, clientY) {
      return {
        x: Math.round((clientX - rect.left) * scaleX),
        y: Math.round((clientY - rect.top) * scaleY),
      };
    }

    function onStart(e) {
      e.preventDefault();
      const pt = e.touches ? e.touches[0] : e;
      const n = toNatural(pt.clientX, pt.clientY);
      startX = n.x; startY = n.y; drawing = true;
    }

    function onMove(e) {
      if (!drawing) return;
      e.preventDefault();
      const pt = e.touches ? e.touches[0] : e;
      const n = toNatural(pt.clientX, pt.clientY);
      renderOverlay(idx);
      ctx.strokeStyle = '#f39c12';
      ctx.lineWidth = 2;
      ctx.setLineDash([6, 3]);
      ctx.strokeRect(startX, startY, n.x - startX, n.y - startY);
      ctx.setLineDash([]);
    }

    function onEnd(e) {
      if (!drawing) return;
      drawing = false;
      const pt = e.changedTouches ? e.changedTouches[0] : e;
      const n = toNatural(pt.clientX, pt.clientY);
      const x1 = Math.min(startX, n.x), y1 = Math.min(startY, n.y);
      const x2 = Math.max(startX, n.x), y2 = Math.max(startY, n.y);
      if ((x2 - x1) < 20 || (y2 - y1) < 10) return;

      const corners = [
        { x: x1, y: y1 }, { x: x2, y: y1 },
        { x: x2, y: y2 }, { x: x1, y: y2 },
      ];

      // Crop from the source image
      const cropCanvas = document.createElement('canvas');
      cropCanvas.width = x2 - x1; cropCanvas.height = y2 - y1;
      const tmpImg = new Image();
      tmpImg.src = app.pendingPhotos[idx].dataUrl;
      tmpImg.onload = () => {
        cropCanvas.getContext('2d').drawImage(tmpImg, x1, y1, x2-x1, y2-y1, 0, 0, x2-x1, y2-y1);
        photoCards[idx].push({ corners, cropCanvas, accepted: true, area: (x2-x1)*(y2-y1) });
        renderOverlay(idx);
        renderCardList(idx);
        updateConfirmBtn();
      };

      canvas.removeEventListener('mousedown', onStart);
      canvas.removeEventListener('mousemove', onMove);
      canvas.removeEventListener('mouseup', onEnd);
      canvas.removeEventListener('touchstart', onStart);
      canvas.removeEventListener('touchmove', onMove);
      canvas.removeEventListener('touchend', onEnd);
      canvas.style.pointerEvents = 'none';
      if (onDone) onDone();
    }

    canvas.style.pointerEvents = 'auto';
    canvas.addEventListener('mousedown', onStart);
    canvas.addEventListener('mousemove', onMove);
    canvas.addEventListener('mouseup', onEnd);
    canvas.addEventListener('touchstart', onStart, { passive: false });
    canvas.addEventListener('touchmove', onMove, { passive: false });
    canvas.addEventListener('touchend', onEnd);
  }

  // Photo navigation
  el.querySelector('#prevPhoto').addEventListener('click', () => {
    if (currentPhotoIndex > 0) loadPhoto(currentPhotoIndex - 1);
  });
  el.querySelector('#nextPhoto').addEventListener('click', () => {
    if (currentPhotoIndex < app.pendingPhotos.length - 1) loadPhoto(currentPhotoIndex + 1);
  });

  // Confirm: flatten accepted cards, pass to confirm screen
  confirmBtn.addEventListener('click', () => {
    app.detectedCards = photoCards.flat().filter(c => c.accepted);
    app.confirmedCards = [];
    navigate('confirm');
  });

  // Start processing first photo
  loadPhoto(0);
  // Pre-process remaining photos in background
  setTimeout(async () => {
    for (let i = 1; i < app.pendingPhotos.length; i++) {
      if (!processingDone[i]) await processPhoto(i);
    }
  }, 500);
}
