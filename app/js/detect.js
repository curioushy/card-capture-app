// OpenCV.js card detection pipeline
// Requires cv global (loaded lazily by capture screen)

export async function detectCards(imageElement) {
  if (!window.cv || !cv.Mat) throw new Error('OpenCV not ready');

  const src = cv.imread(imageElement);
  const imgW = src.cols, imgH = src.rows;
  const minArea = imgW * imgH * 0.05;

  const gray = new cv.Mat();
  cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);

  const blurred = new cv.Mat();
  cv.GaussianBlur(gray, blurred, new cv.Size(5, 5), 0);

  const edges = new cv.Mat();
  cv.Canny(blurred, edges, 50, 150);

  // Dilate slightly to close gaps in card edges
  const dilated = new cv.Mat();
  const kernel = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(3, 3));
  cv.dilate(edges, dilated, kernel);

  const contours = new cv.MatVector();
  const hierarchy = new cv.Mat();
  cv.findContours(dilated, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);

  const cards = [];

  for (let i = 0; i < contours.size(); i++) {
    const cnt = contours.get(i);
    const area = cv.contourArea(cnt);
    if (area < minArea) { cnt.delete(); continue; }

    const peri = cv.arcLength(cnt, true);
    const approx = new cv.Mat();
    cv.approxPolyDP(cnt, approx, 0.02 * peri, true);

    if (approx.rows === 4) {
      const corners = [];
      for (let j = 0; j < 4; j++) {
        corners.push({ x: approx.data32S[j * 2], y: approx.data32S[j * 2 + 1] });
      }
      const ordered = orderCorners(corners);
      const cropCanvas = dewarp(src, ordered, imgW, imgH);
      cards.push({ corners: ordered, cropCanvas, area });
    }

    approx.delete();
    cnt.delete();
  }

  src.delete(); gray.delete(); blurred.delete(); edges.delete();
  dilated.delete(); kernel.delete(); contours.delete(); hierarchy.delete();

  // Sort by area descending, deduplicate overlapping regions
  cards.sort((a, b) => b.area - a.area);
  return deduplicate(cards, imgW, imgH);
}

// Order corners: top-left, top-right, bottom-right, bottom-left
function orderCorners(pts) {
  const sorted = [...pts].sort((a, b) => a.y - b.y);
  const top = sorted.slice(0, 2).sort((a, b) => a.x - b.x);
  const bottom = sorted.slice(2).sort((a, b) => a.x - b.x);
  return [top[0], top[1], bottom[1], bottom[0]]; // TL, TR, BR, BL
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
      return intersection / smallerArea > 0.5;
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
    if (window.cv && cv.Mat) { resolve(); return; }
    const script = document.createElement('script');
    script.src = 'https://docs.opencv.org/4.8.0/opencv.js';
    script.async = true;
    script.onload = () => {
      if (window.cv) {
        cv['onRuntimeInitialized'] = resolve;
        // If already initialized
        if (cv.Mat) resolve();
      } else {
        reject(new Error('OpenCV failed to load'));
      }
    };
    script.onerror = () => reject(new Error('OpenCV script failed'));
    document.head.appendChild(script);
  });
  return cvLoadPromise;
}
