// OpenCV.js card detection pipeline
// Requires cv global (loaded lazily by capture screen)

export async function detectCards(imageElement) {
  if (!window.cv || !cv.Mat) throw new Error('OpenCV not ready');

  const src = cv.imread(imageElement);
  const imgW = src.cols, imgH = src.rows;
  const minArea = imgW * imgH * 0.02; // was 0.05 — 2% works for cards at distance

  const gray = new cv.Mat();
  cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);

  const blurred = new cv.Mat();
  cv.GaussianBlur(gray, blurred, new cv.Size(5, 5), 0);

  // Try multiple Canny threshold pairs to handle varying lighting
  const cannyPasses = [
    [30, 90],   // low contrast / soft light
    [50, 150],  // standard
    [80, 200],  // high contrast
  ];

  const cards = [];
  const seenAreas = new Set();

  for (const [lo, hi] of cannyPasses) {
    const edges = new cv.Mat();
    cv.Canny(blurred, edges, lo, hi);

    const dilated = new cv.Mat();
    const kernel = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(3, 3));
    cv.dilate(edges, dilated, kernel);

    const contours = new cv.MatVector();
    const hierarchy = new cv.Mat();
    cv.findContours(dilated, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);

    for (let i = 0; i < contours.size(); i++) {
      const cnt = contours.get(i);
      const area = cv.contourArea(cnt);
      if (area < minArea) { cnt.delete(); continue; }

      // Strategy 1: try approxPolyDP for clean 4–8 corner shapes
      const peri = cv.arcLength(cnt, true);
      const approx = new cv.Mat();
      cv.approxPolyDP(cnt, approx, 0.03 * peri, true);

      let corners4 = null;
      if (approx.rows >= 4 && approx.rows <= 8) {
        const rawCorners = [];
        for (let j = 0; j < approx.rows; j++) {
          rawCorners.push({ x: approx.data32S[j * 2], y: approx.data32S[j * 2 + 1] });
        }
        corners4 = approx.rows === 4 ? rawCorners : reduceToFourCorners(rawCorners);
      } else {
        // Strategy 2: fall back to minAreaRect for rounded / noisy contours
        // Cards with rounded corners or shadow halos can approximate to 9+ vertices.
        const rect = cv.minAreaRect(cnt);
        const w = rect.size.width, h = rect.size.height;
        const aspect = Math.max(w, h) / Math.min(w, h);
        // Business cards are roughly 1.4–2.0 aspect. Reject squares & long strips.
        if (aspect >= 1.3 && aspect <= 2.5) {
          const box = cv.RotatedRect.points(rect);
          corners4 = box.map(p => ({ x: p.x, y: p.y }));
        }
      }

      if (corners4) {
        const ordered = orderCorners(corners4);
        const areaKey = Math.round(area / (imgW * imgH * 0.005));
        if (!seenAreas.has(areaKey)) {
          seenAreas.add(areaKey);
          const cropCanvas = dewarp(src, ordered, imgW, imgH);
          cards.push({ corners: ordered, cropCanvas, area });
        }
      }

      approx.delete();
      cnt.delete();
    }

    edges.delete(); dilated.delete(); kernel.delete(); contours.delete(); hierarchy.delete();
  }

  gray.delete(); blurred.delete();

  // Sort by area descending, deduplicate overlapping
  cards.sort((a, b) => b.area - a.area);
  const deduped = deduplicate(cards, imgW, imgH);

  // Fallback: if nothing detected, return the full image as one card
  if (deduped.length === 0) {
    const fallbackCanvas = document.createElement('canvas');
    fallbackCanvas.width = imgW;
    fallbackCanvas.height = imgH;
    cv.imshow(fallbackCanvas, src);
    const fullCorners = [
      { x: 0, y: 0 }, { x: imgW - 1, y: 0 },
      { x: imgW - 1, y: imgH - 1 }, { x: 0, y: imgH - 1 },
    ];
    deduped.push({ corners: fullCorners, cropCanvas: fallbackCanvas, area: imgW * imgH, isFallback: true });
  }

  src.delete();
  return deduped;
}

// Reduce a 5- or 6-point polygon to 4 corners via convex hull extremes
function reduceToFourCorners(pts) {
  // Find the 4 extreme points: top-left, top-right, bottom-right, bottom-left
  // scored by distance from each corner of the image bounding box
  const xs = pts.map(p => p.x), ys = pts.map(p => p.y);
  const minX = Math.min(...xs), maxX = Math.max(...xs);
  const minY = Math.min(...ys), maxY = Math.max(...ys);

  const score = (pt, cx, cy) => Math.hypot(pt.x - cx, pt.y - cy);
  const closest = (cx, cy) => pts.reduce((best, p) =>
    score(p, cx, cy) < score(best, cx, cy) ? p : best, pts[0]);

  return [
    closest(minX, minY), // top-left
    closest(maxX, minY), // top-right
    closest(maxX, maxY), // bottom-right
    closest(minX, maxY), // bottom-left
  ];
}

// Order corners: top-left, top-right, bottom-right, bottom-left
function orderCorners(pts) {
  const sorted = [...pts].sort((a, b) => a.y - b.y);
  const top = sorted.slice(0, 2).sort((a, b) => a.x - b.x);
  const bottom = sorted.slice(2).sort((a, b) => a.x - b.x);
  return [top[0], top[1], bottom[1], bottom[0]];
}

// Perspective dewarp
function dewarp(src, corners, imgW, imgH) {
  const [tl, tr, br, bl] = corners;
  const wTop = Math.hypot(tr.x - tl.x, tr.y - tl.y);
  const wBot = Math.hypot(br.x - bl.x, br.y - bl.y);
  const hLeft = Math.hypot(bl.x - tl.x, bl.y - tl.y);
  const hRight = Math.hypot(br.x - tr.x, br.y - tr.y);
  const maxW = Math.round(Math.max(wTop, wBot));
  const maxH = Math.round(Math.max(hLeft, hRight));

  if (maxW < 10 || maxH < 10) {
    // Degenerate — return plain crop
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
  const dsize = new cv.Size(maxW, maxH);
  cv.warpPerspective(src, dst, M, dsize);

  const canvas = document.createElement('canvas');
  canvas.width = maxW; canvas.height = maxH;
  cv.imshow(canvas, dst);

  srcPts.delete(); dstPts.delete(); M.delete(); dst.delete();
  return canvas;
}

// Remove cards whose bounding box overlaps heavily with a larger card
function deduplicate(cards, imgW, imgH) {
  const result = [];
  for (const card of cards) {
    const box = boundingBox(card.corners);
    const overlapping = result.some(existing => {
      const eBox = boundingBox(existing.corners);
      const ix = Math.max(0, Math.min(box.x2, eBox.x2) - Math.max(box.x1, eBox.x1));
      const iy = Math.max(0, Math.min(box.y2, eBox.y2) - Math.max(box.y1, eBox.y1));
      const intersection = ix * iy;
      const smallerArea = Math.min(
        (box.x2 - box.x1) * (box.y2 - box.y1),
        (eBox.x2 - eBox.x1) * (eBox.y2 - eBox.y1)
      );
      return smallerArea > 0 && intersection / smallerArea > 0.5;
    });
    if (!overlapping) result.push(card);
  }
  return result;
}

function boundingBox(corners) {
  const xs = corners.map(c => c.x), ys = corners.map(c => c.y);
  return { x1: Math.min(...xs), y1: Math.min(...ys), x2: Math.max(...xs), y2: Math.max(...ys) };
}

// Load OpenCV.js lazily — returns promise that resolves when cv is ready
let cvLoadPromise = null;
export function loadOpenCV() {
  if (cvLoadPromise) return cvLoadPromise;
  cvLoadPromise = new Promise((resolve, reject) => {
    // Already loaded and initialized
    if (window.cv && cv.Mat) { resolve(); return; }

    const script = document.createElement('script');
    script.src = 'https://docs.opencv.org/4.8.0/opencv.js';
    script.async = true;
    script.onload = () => {
      if (!window.cv) { reject(new Error('OpenCV failed to load')); return; }
      // WASM may already be initialized (sync load path) or still pending
      if (cv.Mat) {
        resolve();
      } else {
        cv['onRuntimeInitialized'] = resolve;
        // Belt-and-suspenders: poll in case callback was already called before we set it
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
