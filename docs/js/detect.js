// OpenCV.js card detection pipeline — multi-strategy with agreement-based confidence.
//
// We run three independent detection strategies and merge their results by IoU.
// A card found by multiple strategies is high-confidence; a card found by one is
// low-confidence. The user sees the confidence in the detection UI so they know
// which cards to double-check.
//
// Strategies (each catches different failure modes):
//   1. Otsu threshold          — bright cards on dark/uniform background
//   2. Adaptive threshold      — uneven lighting (shadows, glare)
//   3. Canny edges (3 passes)  — high-contrast edges on busy backgrounds
//
// Detection runs on a downsampled copy (≤1200px long side) for speed, but
// final dewarp crops from the full-resolution source for quality.

export async function detectCards(imageElement) {
  if (!window.cv || !cv.Mat) throw new Error('OpenCV not ready');

  const srcFull = cv.imread(imageElement);
  const fullW = srcFull.cols, fullH = srcFull.rows;

  // Downsample for detection — speeds up every strategy, no quality loss for
  // boundary finding. Scale corners back up before dewarping.
  const DETECT_MAX = 1200;
  const longest = Math.max(fullW, fullH);
  const scale = longest > DETECT_MAX ? DETECT_MAX / longest : 1;
  const detectW = Math.round(fullW * scale);
  const detectH = Math.round(fullH * scale);

  let src;
  if (scale < 1) {
    src = new cv.Mat();
    cv.resize(srcFull, src, new cv.Size(detectW, detectH), 0, 0, cv.INTER_AREA);
  } else {
    src = srcFull;
  }

  const gray = new cv.Mat();
  cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);

  // Cards must be at least 2% of the detection frame. Below that, likely noise.
  const minArea = detectW * detectH * 0.02;

  // Run all three strategies. Tag each candidate with its source so we can
  // count how many strategies agreed on each physical card.
  const cannyCards  = detectViaCanny(gray, minArea).map(c => ({ ...c, source: 'canny' }));
  const otsuCards   = detectViaOtsu(gray, minArea).map(c => ({ ...c, source: 'otsu' }));
  const adaptCards  = detectViaAdaptive(gray, minArea).map(c => ({ ...c, source: 'adaptive' }));

  const merged = mergeByIoU([...cannyCards, ...otsuCards, ...adaptCards]);

  // Scale corners back to full resolution and dewarp from the full-res source.
  const cards = merged.map(m => {
    const corners = m.corners.map(c => ({ x: c.x / scale, y: c.y / scale }));
    const ordered = orderCorners(corners);
    const cropCanvas = dewarp(srcFull, ordered, fullW, fullH);
    return {
      corners: ordered,
      cropCanvas,
      area: m.area / (scale * scale),
      confidence: m.confidence, // 1, 2, or 3 — number of strategies that agreed
      sources: [...m.sources],
    };
  });

  // Rank: higher confidence first, then larger area
  cards.sort((a, b) => b.confidence - a.confidence || b.area - a.area);

  // Fallback: if nothing was found by any strategy, return the full image so
  // the user can manually crop rather than being stuck.
  if (cards.length === 0) {
    const fallbackCanvas = document.createElement('canvas');
    fallbackCanvas.width = fullW;
    fallbackCanvas.height = fullH;
    cv.imshow(fallbackCanvas, srcFull);
    const fullCorners = [
      { x: 0, y: 0 }, { x: fullW - 1, y: 0 },
      { x: fullW - 1, y: fullH - 1 }, { x: 0, y: fullH - 1 },
    ];
    cards.push({
      corners: fullCorners, cropCanvas: fallbackCanvas,
      area: fullW * fullH, confidence: 0, sources: [], isFallback: true,
    });
  }

  // Cleanup
  if (scale < 1) src.delete();
  srcFull.delete();
  gray.delete();

  return cards;
}

// ─── Detection strategies ────────────────────────────────────────────────────

function detectViaOtsu(gray, minArea) {
  // Global Otsu threshold — picks the optimal split point automatically.
  // Excellent for bright cards on dark, uniform backgrounds (event table tops,
  // dark fabric) which Canny edge detection often misses.
  const binary = new cv.Mat();
  cv.threshold(gray, binary, 0, 255, cv.THRESH_BINARY + cv.THRESH_OTSU);

  // Close small gaps inside cards so each card is a single solid blob
  const kernel = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(5, 5));
  const closed = new cv.Mat();
  cv.morphologyEx(binary, closed, cv.MORPH_CLOSE, kernel);

  const cards = extractCandidatesFromBinary(closed, minArea);

  binary.delete(); closed.delete(); kernel.delete();
  return cards;
}

function detectViaAdaptive(gray, minArea) {
  // Adaptive threshold handles uneven lighting (a hand shadow, gradient
  // overhead light) where global Otsu splits along the lighting, not the card.
  const binary = new cv.Mat();
  cv.adaptiveThreshold(
    gray, binary, 255,
    cv.ADAPTIVE_THRESH_GAUSSIAN_C, cv.THRESH_BINARY,
    51, 5
  );
  const kernel = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(7, 7));
  const closed = new cv.Mat();
  cv.morphologyEx(binary, closed, cv.MORPH_CLOSE, kernel);

  const cards = extractCandidatesFromBinary(closed, minArea);

  binary.delete(); closed.delete(); kernel.delete();
  return cards;
}

function detectViaCanny(gray, minArea) {
  // Three Canny threshold pairs to handle varying contrast.
  const blurred = new cv.Mat();
  cv.GaussianBlur(gray, blurred, new cv.Size(5, 5), 0);

  const cards = [];
  for (const [lo, hi] of [[30, 90], [50, 150], [80, 200]]) {
    const edges = new cv.Mat();
    cv.Canny(blurred, edges, lo, hi);

    const kernel = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(3, 3));
    const dilated = new cv.Mat();
    cv.dilate(edges, dilated, kernel);

    cards.push(...extractCandidatesFromBinary(dilated, minArea));

    edges.delete(); dilated.delete(); kernel.delete();
  }
  blurred.delete();
  return cards;
}

// Shared: given a binary mask, find contours that look like cards (4-sided
// shapes with card-like aspect ratio). Tries polygon approximation first;
// falls back to minAreaRect for noisy / rounded-corner contours.
function extractCandidatesFromBinary(binary, minArea) {
  const contours = new cv.MatVector();
  const hierarchy = new cv.Mat();
  cv.findContours(binary, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);

  const cards = [];
  for (let i = 0; i < contours.size(); i++) {
    const cnt = contours.get(i);
    const area = cv.contourArea(cnt);
    if (area < minArea) { cnt.delete(); continue; }

    const peri = cv.arcLength(cnt, true);
    const approx = new cv.Mat();
    cv.approxPolyDP(cnt, approx, 0.03 * peri, true);

    let corners4 = null;
    if (approx.rows >= 4 && approx.rows <= 8) {
      const raw = [];
      for (let j = 0; j < approx.rows; j++) {
        raw.push({ x: approx.data32S[j * 2], y: approx.data32S[j * 2 + 1] });
      }
      corners4 = approx.rows === 4 ? raw : reduceToFourCorners(raw);
    } else {
      // Rounded corners / noisy edges often produce 9+ vertices. Use the
      // minimum-area rotated bounding rectangle instead.
      const rect = cv.minAreaRect(cnt);
      const w = rect.size.width, h = rect.size.height;
      if (w > 0 && h > 0) {
        const aspect = Math.max(w, h) / Math.min(w, h);
        if (aspect >= 1.3 && aspect <= 2.5) {
          const box = cv.RotatedRect.points(rect);
          corners4 = box.map(p => ({ x: p.x, y: p.y }));
        }
      }
    }

    if (corners4) {
      // Also validate aspect ratio on the bounding box (catches degenerate
      // approxPolyDP results that aren't actually card-shaped).
      const bb = boundingBox(corners4);
      const bw = bb.x2 - bb.x1, bh = bb.y2 - bb.y1;
      if (bw > 0 && bh > 0) {
        const aspect = Math.max(bw, bh) / Math.min(bw, bh);
        if (aspect >= 1.3 && aspect <= 2.8) {
          cards.push({ corners: corners4, area });
        }
      }
    }

    approx.delete();
    cnt.delete();
  }

  contours.delete();
  hierarchy.delete();
  return cards;
}

// ─── Merging & confidence ────────────────────────────────────────────────────

// Group candidates from different strategies by IoU overlap. Each group
// represents one physical card; confidence = number of distinct strategies
// that found it (1-3).
function mergeByIoU(allCandidates) {
  const sorted = [...allCandidates].sort((a, b) => b.area - a.area);
  const groups = [];

  for (const cand of sorted) {
    const box = boundingBox(cand.corners);
    let match = null;
    for (const g of groups) {
      if (iou(box, g.box) > 0.5) { match = g; break; }
    }
    if (match) {
      match.sources.add(cand.source);
    } else {
      groups.push({
        corners: cand.corners,
        area: cand.area,
        box,
        sources: new Set([cand.source]),
      });
    }
  }

  return groups.map(g => ({
    corners: g.corners,
    area: g.area,
    sources: g.sources,
    confidence: g.sources.size,
  }));
}

function iou(a, b) {
  const ix = Math.max(0, Math.min(a.x2, b.x2) - Math.max(a.x1, b.x1));
  const iy = Math.max(0, Math.min(a.y2, b.y2) - Math.max(a.y1, b.y1));
  const inter = ix * iy;
  const aA = (a.x2 - a.x1) * (a.y2 - a.y1);
  const bA = (b.x2 - b.x1) * (b.y2 - b.y1);
  const union = aA + bA - inter;
  return union > 0 ? inter / union : 0;
}

// ─── Geometry helpers ────────────────────────────────────────────────────────

// Reduce a 5-to-8 point polygon to the 4 extreme corners
function reduceToFourCorners(pts) {
  const xs = pts.map(p => p.x), ys = pts.map(p => p.y);
  const minX = Math.min(...xs), maxX = Math.max(...xs);
  const minY = Math.min(...ys), maxY = Math.max(...ys);

  const dist = (p, cx, cy) => Math.hypot(p.x - cx, p.y - cy);
  const closest = (cx, cy) => pts.reduce((best, p) =>
    dist(p, cx, cy) < dist(best, cx, cy) ? p : best, pts[0]);

  return [
    closest(minX, minY),
    closest(maxX, minY),
    closest(maxX, maxY),
    closest(minX, maxY),
  ];
}

function orderCorners(pts) {
  const sorted = [...pts].sort((a, b) => a.y - b.y);
  const top = sorted.slice(0, 2).sort((a, b) => a.x - b.x);
  const bottom = sorted.slice(2).sort((a, b) => a.x - b.x);
  return [top[0], top[1], bottom[1], bottom[0]];
}

function dewarp(src, corners, imgW, imgH) {
  const [tl, tr, br, bl] = corners;
  const wTop = Math.hypot(tr.x - tl.x, tr.y - tl.y);
  const wBot = Math.hypot(br.x - bl.x, br.y - bl.y);
  const hLeft = Math.hypot(bl.x - tl.x, bl.y - tl.y);
  const hRight = Math.hypot(br.x - tr.x, br.y - tr.y);
  const maxW = Math.round(Math.max(wTop, wBot));
  const maxH = Math.round(Math.max(hLeft, hRight));

  if (maxW < 10 || maxH < 10) {
    const canvas = document.createElement('canvas');
    canvas.width = imgW; canvas.height = imgH;
    cv.imshow(canvas, src);
    return canvas;
  }

  const srcPts = cv.matFromArray(4, 1, cv.CV_32FC2,
    [tl.x, tl.y, tr.x, tr.y, br.x, br.y, bl.x, bl.y]);
  const dstPts = cv.matFromArray(4, 1, cv.CV_32FC2,
    [0, 0, maxW - 1, 0, maxW - 1, maxH - 1, 0, maxH - 1]);

  const M = cv.getPerspectiveTransform(srcPts, dstPts);
  const dst = new cv.Mat();
  cv.warpPerspective(src, dst, M, new cv.Size(maxW, maxH));

  const canvas = document.createElement('canvas');
  canvas.width = maxW; canvas.height = maxH;
  cv.imshow(canvas, dst);

  srcPts.delete(); dstPts.delete(); M.delete(); dst.delete();
  return canvas;
}

function boundingBox(corners) {
  const xs = corners.map(c => c.x), ys = corners.map(c => c.y);
  return { x1: Math.min(...xs), y1: Math.min(...ys), x2: Math.max(...xs), y2: Math.max(...ys) };
}

// ─── OpenCV loader ───────────────────────────────────────────────────────────

let cvLoadPromise = null;
export function loadOpenCV() {
  if (cvLoadPromise) return cvLoadPromise;
  cvLoadPromise = new Promise((resolve, reject) => {
    if (window.cv && cv.Mat) { resolve(); return; }
    const script = document.createElement('script');
    script.src = 'https://docs.opencv.org/4.8.0/opencv.js';
    script.async = true;
    script.onload = () => {
      if (!window.cv) { reject(new Error('OpenCV failed to load')); return; }
      if (cv.Mat) {
        resolve();
      } else {
        cv['onRuntimeInitialized'] = resolve;
        const check = setInterval(() => {
          if (cv.Mat) { clearInterval(check); resolve(); }
        }, 100);
        setTimeout(() => { clearInterval(check); reject(new Error('OpenCV init timeout')); }, 30000);
      }
    };
    script.onerror = () => reject(new Error('OpenCV script failed'));
    document.head.appendChild(script);
  });
  return cvLoadPromise;
}
