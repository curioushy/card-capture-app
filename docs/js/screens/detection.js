import { navigate, app, showStatus, hideStatus, showToast } from '../app.js';
import { detectCards, loadOpenCV } from '../detect.js';

// ── Detection screen ──────────────────────────────────────────────────────────
//
// Layout:
//  1. Full photo with coloured border overlays (active card = bright + thick)
//  2. Card carousel: dewarped crop, ‹ card N of M ›, swipe or arrow nav
//  3. Per-card  [Skip this card]  [✓ Include]  buttons
//  4. Footer: + Add manually  +  Confirm N cards →
//
// photoCards[i] = array of card objects for photo i (null = not yet processed)
// allCards      = flat list across all photos  { photoIdx, card }
// currentCardIdx indexes into allCards.

export async function renderDetection(el) {
  if (!app.pendingPhotos || app.pendingPhotos.length === 0) {
    navigate('capture'); return;
  }

  app.detectedCards = [];

  const photoCards = app.pendingPhotos.map(() => null); // null = pending
  let allCards     = [];   // { photoIdx, card }
  let currentCardIdx = 0;
  let currentPhotoIdx = 0;

  // ── Shell ─────────────────────────────────────────────────────────────────
  el.innerHTML = `
    <div class="det-wrap">

      ${app.pendingPhotos.length > 1 ? `
        <div class="det-photo-nav">
          <button class="det-nav-btn" id="prevPhoto" disabled>‹</button>
          <span id="photoLabel" class="det-label">Photo 1 of ${app.pendingPhotos.length}</span>
          <button class="det-nav-btn" id="nextPhoto">›</button>
        </div>` : ''}

      <!-- Photo + border overlay -->
      <div class="det-img-wrap" id="detImgWrap">
        <img class="det-img" id="detectionImg" alt="">
        <canvas class="det-canvas" id="overlayCanvas"></canvas>
      </div>

      <!-- Card carousel -->
      <div class="det-carousel" id="detCarousel">

        <!-- Loading state -->
        <div class="det-loading" id="detLoading">
          <div class="spinner det-spinner"></div>
          <span>Scanning card borders…</span>
        </div>

        <!-- Card viewer (shown after processing) -->
        <div class="det-card-viewer" id="detCardViewer" style="display:none;">
          <div class="det-card-nav-row">
            <button class="det-card-arrow" id="prevCard" disabled>‹</button>
            <span class="det-label" id="cardCounter">Card 1 of 1</span>
            <button class="det-card-arrow" id="nextCard" disabled>›</button>
          </div>
          <div class="det-crop-wrap" id="detCropWrap">
            <canvas class="det-crop-canvas" id="cropCanvas"></canvas>
          </div>
          <div class="det-conf-badge" id="detConfBadge"></div>
          <div class="det-card-btns">
            <button class="det-skip-btn" id="skipCardBtn">Skip</button>
            <button class="det-include-btn" id="includeCardBtn">✓ Include</button>
          </div>
        </div>

        <!-- No-cards state -->
        <div class="det-empty" id="detEmpty" style="display:none;">
          No cards found — draw one manually below
        </div>

      </div><!-- /carousel -->

      <!-- Footer -->
      <div class="det-footer">
        <button class="det-manual-btn" id="addManualBtn">+ Add card manually</button>
        <button class="btn btn-primary btn-full" id="confirmBtn" disabled>Confirm 0 cards →</button>
      </div>

    </div>
  `;

  // ── Element refs ──────────────────────────────────────────────────────────
  const detImg       = el.querySelector('#detectionImg');
  const overlayCvs   = el.querySelector('#overlayCanvas');
  const cropCvs      = el.querySelector('#cropCanvas');
  const detLoading   = el.querySelector('#detLoading');
  const detViewer    = el.querySelector('#detCardViewer');
  const detEmpty     = el.querySelector('#detEmpty');
  const cardCounter  = el.querySelector('#cardCounter');
  const confBadge    = el.querySelector('#detConfBadge');
  const confirmBtn   = el.querySelector('#confirmBtn');
  const prevCardBtn  = el.querySelector('#prevCard');
  const nextCardBtn  = el.querySelector('#nextCard');
  const includeBtn   = el.querySelector('#includeCardBtn');
  const skipBtn      = el.querySelector('#skipCardBtn');

  // ── Load photo into img element ───────────────────────────────────────────
  async function loadPhoto(idx) {
    currentPhotoIdx = idx;
    if (app.pendingPhotos.length > 1) {
      el.querySelector('#photoLabel').textContent = `Photo ${idx + 1} of ${app.pendingPhotos.length}`;
      el.querySelector('#prevPhoto').disabled = idx === 0;
      el.querySelector('#nextPhoto').disabled = idx === app.pendingPhotos.length - 1;
    }
    detImg.src = app.pendingPhotos[idx].dataUrl;
    await new Promise(res => {
      if (detImg.complete && detImg.naturalWidth) { res(); return; }
      detImg.onload = res;
    });
    // Set canvas pixel dims = natural image dims so drawing coords are 1:1.
    // CSS (width:100%; height:100%) then scales both img and canvas to match.
    overlayCvs.width  = detImg.naturalWidth;
    overlayCvs.height = detImg.naturalHeight;
  }

  // ── Process one photo ─────────────────────────────────────────────────────
  async function processPhoto(idx) {
    showStatus(`Detecting cards in photo ${idx + 1}…`, 30);

    try {
      await loadOpenCV();
      showStatus(`Photo ${idx + 1}: tracing edges…`, 60);

      const tmpImg = new Image();
      tmpImg.src = app.pendingPhotos[idx].dataUrl;
      await new Promise(res => { tmpImg.onload = res; if (tmpImg.complete) res(); });

      const cards = await detectCards(tmpImg);
      photoCards[idx] = cards.map(c => ({ ...c, accepted: !c.isFallback }));

      if (cards.length === 1 && cards[0].isFallback) {
        showToast('No card edges found — add manually');
      } else {
        const low = cards.filter(c => (c.confidence || 0) < 2).length;
        if (low > 0) showToast(`${low} low-confidence border${low > 1 ? 's' : ''} — please verify`);
      }
    } catch (e) {
      console.warn('Detection error:', e);
      photoCards[idx] = [];
    }

    // Universal fallback so the user is never stranded
    if (!photoCards[idx] || photoCards[idx].length === 0) {
      const full = await makeFullCard(app.pendingPhotos[idx].dataUrl);
      photoCards[idx] = [{ ...full, accepted: false, isFallback: true }];
    }

    hideStatus();
    rebuildFlatList();

    // Only update the UI if this is the photo currently on screen
    if (idx === currentPhotoIdx) showCurrent();
  }

  // ── Rebuild flat card list ────────────────────────────────────────────────
  function rebuildFlatList() {
    allCards = [];
    app.pendingPhotos.forEach((_, pIdx) => {
      const cards = photoCards[pIdx];
      if (cards) cards.forEach(card => allCards.push({ photoIdx: pIdx, card }));
    });
    updateConfirmBtn();
  }

  // ── Draw overlay on the photo ─────────────────────────────────────────────
  function renderOverlay() {
    const ctx = overlayCvs.getContext('2d');
    ctx.clearRect(0, 0, overlayCvs.width, overlayCvs.height);

    const cards = photoCards[currentPhotoIdx];
    if (!cards) return;

    const activeItem = allCards[currentCardIdx];

    cards.forEach((card, i) => {
      const isActive = activeItem &&
        activeItem.photoIdx === currentPhotoIdx &&
        activeItem.card === card;

      const corners = card.corners;
      if (!corners || corners.length < 4) return;

      ctx.beginPath();
      ctx.moveTo(corners[0].x, corners[0].y);
      for (let j = 1; j < corners.length; j++) ctx.lineTo(corners[j].x, corners[j].y);
      ctx.closePath();

      if (card.accepted) {
        ctx.strokeStyle = isActive ? '#2ecc71' : 'rgba(46,204,113,0.5)';
        ctx.fillStyle   = isActive ? 'rgba(46,204,113,0.18)' : 'rgba(46,204,113,0.06)';
      } else {
        ctx.strokeStyle = isActive ? '#e74c3c' : 'rgba(231,76,60,0.4)';
        ctx.fillStyle   = isActive ? 'rgba(231,76,60,0.15)' : 'rgba(231,76,60,0.04)';
      }
      ctx.lineWidth = isActive ? 5 : 2;
      ctx.stroke();
      ctx.fill();

      // Numbered circle in the centre of each card
      const cx = corners.reduce((s, c) => s + c.x, 0) / 4;
      const cy = corners.reduce((s, c) => s + c.y, 0) / 4;
      const r  = isActive ? 22 : 15;
      ctx.fillStyle = card.accepted
        ? (isActive ? '#2ecc71' : 'rgba(46,204,113,0.65)')
        : (isActive ? '#e74c3c' : 'rgba(231,76,60,0.55)');
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#fff';
      ctx.font = `bold ${isActive ? 16 : 12}px sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(i + 1, cx, cy);
    });
  }

  // ── Show current card in the carousel ─────────────────────────────────────
  async function showCurrent() {
    // If no cards at all yet (still loading)
    if (allCards.length === 0) {
      detLoading.style.display = 'flex';
      detViewer.style.display  = 'none';
      detEmpty.style.display   = 'none';
      return;
    }

    detLoading.style.display = 'none';

    // Clamp index
    currentCardIdx = Math.max(0, Math.min(currentCardIdx, allCards.length - 1));
    const item = allCards[currentCardIdx];

    if (!item) {
      detEmpty.style.display  = 'flex';
      detViewer.style.display = 'none';
      return;
    }

    detEmpty.style.display  = 'none';
    detViewer.style.display = 'flex';

    // If this card belongs to a different photo, switch the photo overlay
    if (item.photoIdx !== currentPhotoIdx) {
      await loadPhoto(item.photoIdx);
    }
    renderOverlay();

    // ── Card nav arrows ──────────────────────────────────────────────────────
    cardCounter.textContent = `Card ${currentCardIdx + 1} of ${allCards.length}`;
    prevCardBtn.disabled = currentCardIdx === 0;
    nextCardBtn.disabled = currentCardIdx === allCards.length - 1;

    // ── Draw dewarped crop ───────────────────────────────────────────────────
    const card = item.card;
    if (card.cropCanvas) {
      cropCvs.width  = card.cropCanvas.width;
      cropCvs.height = card.cropCanvas.height;
      cropCvs.getContext('2d').drawImage(card.cropCanvas, 0, 0);
    }

    // ── Include / Skip state ─────────────────────────────────────────────────
    if (card.accepted) {
      includeBtn.classList.add('active');
      includeBtn.textContent = '✓ Included';
      skipBtn.classList.remove('active');
      skipBtn.textContent    = 'Skip';
    } else {
      includeBtn.classList.remove('active');
      includeBtn.textContent = '+ Include';
      skipBtn.classList.add('active');
      skipBtn.textContent    = '✗ Skipped';
    }

    // ── Confidence badge ─────────────────────────────────────────────────────
    if (card.isFallback) {
      confBadge.textContent = 'No card detected — showing full photo';
      confBadge.style.color = '#e67e22';
    } else if (card.isManual) {
      confBadge.textContent = '✎ Manually drawn';
      confBadge.style.color = '#888';
    } else {
      const c = card.confidence || 1;
      if (c >= 3) { confBadge.textContent = '●●● High confidence';       confBadge.style.color = '#2ecc71'; }
      else if (c === 2) { confBadge.textContent = '●●○ Medium — verify'; confBadge.style.color = '#aaa'; }
      else              { confBadge.textContent = '●○○ Low — verify';    confBadge.style.color = '#e67e22'; }
    }

    updateConfirmBtn();
  }

  function updateConfirmBtn() {
    const n = allCards.filter(a => a.card.accepted).length;
    confirmBtn.textContent = `Confirm ${n} card${n === 1 ? '' : 's'} →`;
    confirmBtn.disabled    = n === 0;
  }

  // ── Card navigation ───────────────────────────────────────────────────────
  prevCardBtn.addEventListener('click', () => {
    if (currentCardIdx > 0) { currentCardIdx--; showCurrent(); }
  });
  nextCardBtn.addEventListener('click', () => {
    if (currentCardIdx < allCards.length - 1) { currentCardIdx++; showCurrent(); }
  });

  // Swipe left/right on the crop area
  let swipeX = null;
  el.querySelector('#detCropWrap').addEventListener('touchstart', e => {
    swipeX = e.touches[0].clientX;
  }, { passive: true });
  el.querySelector('#detCropWrap').addEventListener('touchend', e => {
    if (swipeX === null) return;
    const dx = e.changedTouches[0].clientX - swipeX;
    swipeX = null;
    if (Math.abs(dx) < 45) return;
    if (dx < 0 && currentCardIdx < allCards.length - 1) { currentCardIdx++; showCurrent(); }
    if (dx > 0 && currentCardIdx > 0)                   { currentCardIdx--; showCurrent(); }
  });

  // ── Include / Skip buttons ────────────────────────────────────────────────
  includeBtn.addEventListener('click', () => {
    if (!allCards[currentCardIdx]) return;
    allCards[currentCardIdx].card.accepted = true;
    showCurrent();
  });
  skipBtn.addEventListener('click', () => {
    if (!allCards[currentCardIdx]) return;
    allCards[currentCardIdx].card.accepted = false;
    showCurrent();
  });

  // ── Photo navigation (multi-photo batch) ──────────────────────────────────
  if (app.pendingPhotos.length > 1) {
    el.querySelector('#prevPhoto').addEventListener('click', async () => {
      if (currentPhotoIdx <= 0) return;
      await loadPhoto(currentPhotoIdx - 1);
      // Jump carousel to first card from this photo
      const idx = allCards.findIndex(a => a.photoIdx === currentPhotoIdx);
      if (idx >= 0) { currentCardIdx = idx; showCurrent(); } else renderOverlay();
    });
    el.querySelector('#nextPhoto').addEventListener('click', async () => {
      if (currentPhotoIdx >= app.pendingPhotos.length - 1) return;
      await loadPhoto(currentPhotoIdx + 1);
      const idx = allCards.findIndex(a => a.photoIdx === currentPhotoIdx);
      if (idx >= 0) { currentCardIdx = idx; showCurrent(); } else renderOverlay();
    });
  }

  // ── Manual crop ───────────────────────────────────────────────────────────
  let manualActive = false;
  el.querySelector('#addManualBtn').addEventListener('click', () => {
    if (manualActive) return;
    manualActive = true;
    showToast('Draw a rectangle around the card on the photo above');
    startManualCrop(currentPhotoIdx, () => { manualActive = false; });
  });

  function startManualCrop(pIdx, onDone) {
    let sx, sy, drawing = false;
    const ctx = overlayCvs.getContext('2d');
    overlayCvs.style.pointerEvents = 'auto';
    overlayCvs.style.cursor = 'crosshair';

    function coords(e) {
      const pt = (e.touches || e.changedTouches) ? (e.touches || e.changedTouches)[0] : e;
      const r  = detImg.getBoundingClientRect();
      return {
        x: Math.round((pt.clientX - r.left) * (detImg.naturalWidth  / r.width)),
        y: Math.round((pt.clientY - r.top)  * (detImg.naturalHeight / r.height)),
      };
    }

    function onStart(e) { e.preventDefault(); const p = coords(e); sx = p.x; sy = p.y; drawing = true; }
    function onMove(e) {
      if (!drawing) return; e.preventDefault();
      const p = coords(e);
      renderOverlay();
      ctx.strokeStyle = '#f39c12'; ctx.lineWidth = 3;
      ctx.setLineDash([8, 4]);
      ctx.strokeRect(sx, sy, p.x - sx, p.y - sy);
      ctx.setLineDash([]);
    }
    function onEnd(e) {
      if (!drawing) return; drawing = false;
      const p = coords(e);
      const x1 = Math.min(sx, p.x), y1 = Math.min(sy, p.y);
      const x2 = Math.max(sx, p.x), y2 = Math.max(sy, p.y);
      if ((x2-x1) < 20 || (y2-y1) < 10) { finish(); return; }

      const corners = [{x:x1,y:y1},{x:x2,y:y1},{x:x2,y:y2},{x:x1,y:y2}];
      const cropC   = document.createElement('canvas');
      cropC.width = x2-x1; cropC.height = y2-y1;
      const tmp = new Image(); tmp.src = app.pendingPhotos[pIdx].dataUrl;
      tmp.onload = () => {
        cropC.getContext('2d').drawImage(tmp, x1, y1, x2-x1, y2-y1, 0, 0, x2-x1, y2-y1);
        if (!photoCards[pIdx]) photoCards[pIdx] = [];
        photoCards[pIdx].push({ corners, cropCanvas: cropC, accepted: true,
                                area: (x2-x1)*(y2-y1), isManual: true });
        rebuildFlatList();
        currentCardIdx = allCards.length - 1; // jump to new card
        showCurrent();
      };
      finish();
    }

    function finish() {
      overlayCvs.style.pointerEvents = 'none';
      overlayCvs.style.cursor = '';
      overlayCvs.removeEventListener('mousedown',  onStart);
      overlayCvs.removeEventListener('mousemove',  onMove);
      overlayCvs.removeEventListener('mouseup',    onEnd);
      overlayCvs.removeEventListener('touchstart', onStart);
      overlayCvs.removeEventListener('touchmove',  onMove);
      overlayCvs.removeEventListener('touchend',   onEnd);
      if (onDone) onDone();
    }

    overlayCvs.addEventListener('mousedown',  onStart);
    overlayCvs.addEventListener('mousemove',  onMove);
    overlayCvs.addEventListener('mouseup',    onEnd);
    overlayCvs.addEventListener('touchstart', onStart, { passive: false });
    overlayCvs.addEventListener('touchmove',  onMove,  { passive: false });
    overlayCvs.addEventListener('touchend',   onEnd);
  }

  // ── Confirm ───────────────────────────────────────────────────────────────
  confirmBtn.addEventListener('click', () => {
    app.detectedCards  = allCards.filter(a => a.card.accepted).map(a => a.card);
    app.confirmedCards = [];
    navigate('confirm');
  });

  // ── Boot: load + process first photo, background-process the rest ─────────
  await loadPhoto(0);
  await processPhoto(0);

  for (let i = 1; i < app.pendingPhotos.length; i++) {
    setTimeout(() => processPhoto(i), 300 * i);
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

async function makeFullCard(dataUrl) {
  const img = new Image(); img.src = dataUrl;
  await new Promise(res => { img.onload = res; if (img.complete) res(); });
  const c = document.createElement('canvas');
  c.width = img.naturalWidth; c.height = img.naturalHeight;
  c.getContext('2d').drawImage(img, 0, 0);
  return {
    corners:    [{ x:0,y:0 },{ x:c.width-1,y:0 },{ x:c.width-1,y:c.height-1 },{ x:0,y:c.height-1 }],
    cropCanvas: c,
    area:       c.width * c.height,
  };
}
