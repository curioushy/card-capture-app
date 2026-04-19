// Tesseract.js wrapper + field parser

let worker = null;
let tesseractLoadPromise = null;

export function loadTesseract() {
  if (tesseractLoadPromise) return tesseractLoadPromise;
  tesseractLoadPromise = new Promise((resolve, reject) => {
    if (window.Tesseract) { resolve(); return; }
    const script = document.createElement('script');
    script.src = 'https://unpkg.com/tesseract.js@5/dist/tesseract.min.js';
    script.onload = resolve;
    script.onerror = () => reject(new Error('Tesseract failed to load'));
    document.head.appendChild(script);
  });
  return tesseractLoadPromise;
}

async function getWorker() {
  if (worker) return worker;
  await loadTesseract();
  // v5: createWorker(langs, oem?, options?) — workerPath/corePath auto-resolved from CDN
  worker = await Tesseract.createWorker('eng+chi_sim');
  return worker;
}

export async function runOCR(canvas, onProgress) {
  const w = await getWorker();
  const prepped = preprocessForOCR(canvas);
  const result = await w.recognize(prepped, {}, {
    blocks: false, hocr: false, tsv: false, text: true,
  });

  if (onProgress) onProgress(100);

  return {
    text: result.data.text || '',
    words: (result.data.words || []).map(wrd => ({
      text: wrd.text,
      bbox: wrd.bbox,
      conf: wrd.confidence,
    })),
  };
}

// Boost OCR accuracy: upscale to ~300 DPI equivalent, grayscale, contrast
// stretch, adaptive threshold (binarize). Falls back to plain grayscale if
// OpenCV isn't available.
export function preprocessForOCR(srcCanvas) {
  // Target longest side ≈ 1500px (business card at ~300 DPI)
  const TARGET = 1500;
  const longest = Math.max(srcCanvas.width, srcCanvas.height);
  const scale = longest < TARGET ? TARGET / longest : 1;
  const w = Math.round(srcCanvas.width * scale);
  const h = Math.round(srcCanvas.height * scale);

  // Upscale via canvas (bilinear)
  const upscaled = document.createElement('canvas');
  upscaled.width = w; upscaled.height = h;
  const uctx = upscaled.getContext('2d');
  uctx.imageSmoothingEnabled = true;
  uctx.imageSmoothingQuality = 'high';
  uctx.drawImage(srcCanvas, 0, 0, w, h);

  if (!window.cv || !cv.Mat) return canvasGrayscaleFallback(upscaled);

  try {
    const src = cv.imread(upscaled);
    const gray = new cv.Mat();
    cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);

    // CLAHE: contrast-limited adaptive histogram equalization — handles
    // uneven lighting on glossy or shaded cards.
    const clahe = new cv.CLAHE(2.0, new cv.Size(8, 8));
    const equalized = new cv.Mat();
    clahe.apply(gray, equalized);

    // Light denoise while preserving edges
    const blurred = new cv.Mat();
    cv.medianBlur(equalized, blurred, 3);

    // Adaptive threshold → binary image. blockSize must be odd; tune so
    // it covers ~typical character height. C is bias.
    const binary = new cv.Mat();
    cv.adaptiveThreshold(
      blurred, binary, 255,
      cv.ADAPTIVE_THRESH_GAUSSIAN_C, cv.THRESH_BINARY,
      31, 15
    );

    const out = document.createElement('canvas');
    out.width = w; out.height = h;
    cv.imshow(out, binary);

    src.delete(); gray.delete(); clahe.delete();
    equalized.delete(); blurred.delete(); binary.delete();
    return out;
  } catch (e) {
    console.warn('OCR preprocess failed, falling back to grayscale:', e);
    return canvasGrayscaleFallback(upscaled);
  }
}

function canvasGrayscaleFallback(canvas) {
  const ctx = canvas.getContext('2d');
  const data = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const px = data.data;
  for (let i = 0; i < px.length; i += 4) {
    // Luminance + slight contrast boost around midpoint
    const y = 0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2];
    const boosted = Math.max(0, Math.min(255, (y - 128) * 1.3 + 128));
    px[i] = px[i + 1] = px[i + 2] = boosted;
  }
  ctx.putImageData(data, 0, 0);
  return canvas;
}

export async function terminateWorker() {
  if (worker) {
    await worker.terminate();
    worker = null;
  }
}

// ─── Field Parser ────────────────────────────────────────────────────────────

export function parseFields(ocrResult) {
  const { text, words } = ocrResult;
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);

  const emails = extractEmails(text);
  const phones = extractPhones(text, emails);
  const linkedin = extractLinkedIn(text);
  const website = extractWebsite(text, emails, linkedin);

  // Build a set of "consumed" lines for structural parsing
  const consumed = new Set();
  markConsumed(consumed, lines, emails);
  markConsumed(consumed, lines, phones);
  if (linkedin) markConsumedStr(consumed, lines, linkedin);
  if (website) markConsumedStr(consumed, lines, website);

  const remainingLines = lines.filter((_, i) => !consumed.has(i));

  const name = extractName(remainingLines, words);
  const title = extractTitle(remainingLines, name);
  const company = extractCompany(remainingLines, name, title);

  return {
    name:    name    || '',
    title:   title   || '',
    company: company || '',
    emails,
    phones,
    linkedin: linkedin || '',
    website:  website  || '',
    raw_text: text,
  };
}

function extractEmails(text) {
  return [...new Set((text.match(/[\w.+\-]+@[\w\-]+\.[a-z]{2,}/gi) || []))];
}

function extractPhones(text, emails) {
  const emailStr = emails.join(' ');
  const raw = text.match(/(\+?[\d][\d\s\-().]{6,18}[\d])/g) || [];
  return [...new Set(
    raw
      .map(p => p.trim())
      .filter(p => {
        const digits = p.replace(/\D/g, '');
        return digits.length >= 7 && digits.length <= 15 && !emailStr.includes(p);
      })
  )];
}

function extractLinkedIn(text) {
  const m = text.match(/linkedin\.com\/in\/[\w\-]+/i);
  return m ? m[0] : null;
}

function extractWebsite(text, emails, linkedin) {
  const emailDomains = emails.map(e => e.split('@')[1]).filter(Boolean);
  const candidates = text.match(/(https?:\/\/)?[\w\-]+\.(com|co|io|net|org|hk|sg|cn|com\.cn|com\.hk)(\/[\w.\-/?=&#%]*)?/gi) || [];
  for (const c of candidates) {
    const clean = c.replace(/^https?:\/\//, '').toLowerCase();
    if (linkedin && clean.includes('linkedin')) continue;
    if (emailDomains.some(d => clean.startsWith(d) || d.startsWith(clean.split('/')[0]))) continue;
    return c;
  }
  return null;
}

function markConsumed(consumed, lines, values) {
  values.forEach(v => markConsumedStr(consumed, lines, v));
}

function markConsumedStr(consumed, lines, value) {
  const vLower = value.toLowerCase();
  lines.forEach((l, i) => { if (l.toLowerCase().includes(vLower)) consumed.add(i); });
}

const TITLE_KEYWORDS = [
  'director', 'manager', 'vp ', 'v.p.', 'ceo', 'cfo', 'coo', 'cto', 'cmo',
  'founder', 'partner', 'head ', 'senior', 'associate', 'analyst', 'officer',
  'president', 'principal', 'vice', 'managing', 'executive', 'lead', 'specialist',
  '总监', '经理', '总裁', '董事', '主任', '首席',
];

const COMPANY_KEYWORDS = [
  'ltd', 'llc', 'pte', 'inc', 'corp', 'group', 'capital', 'fund', 'partners',
  'holdings', 'ventures', 'management', 'advisory', 'consulting', 'securities',
  'investments', 'financial', 'bank', 'asset', 'equity', 'solutions',
  '有限公司', '集团', '基金', '证券', '投资', '资产',
];

function extractName(lines, words) {
  // Prefer line with biggest avg word height (proxy for largest font) among short lines
  if (words && words.length > 0) {
    const candidates = lines.filter(l => {
      const wc = l.split(/\s+/).length;
      return wc >= 1 && wc <= 5 && !looksLikeKeywordLine(l);
    });
    if (candidates.length > 0) {
      const scored = candidates.map(l => {
        const lineWords = words.filter(w => l.includes(w.text) && w.conf > 40);
        const avgH = lineWords.length
          ? lineWords.reduce((s, w) => s + (w.bbox.y1 - w.bbox.y0), 0) / lineWords.length
          : 0;
        return { l, avgH };
      });
      scored.sort((a, b) => b.avgH - a.avgH);
      if (scored[0].avgH > 0) return scored[0].l;
    }
  }

  // Fallback: first non-empty short line
  for (const line of lines) {
    const words = line.split(/\s+/);
    if (words.length >= 1 && words.length <= 5 && !looksLikeKeywordLine(line)) {
      return line;
    }
  }
  return null;
}

function extractTitle(lines, name) {
  for (const line of lines) {
    if (name && line === name) continue;
    const lower = line.toLowerCase();
    if (TITLE_KEYWORDS.some(k => lower.includes(k))) return line;
  }
  // Line immediately after name
  if (name) {
    const nameIdx = lines.indexOf(name);
    if (nameIdx >= 0 && lines[nameIdx + 1]) return lines[nameIdx + 1];
  }
  return null;
}

function extractCompany(lines, name, title) {
  for (const line of lines) {
    if (name && line === name) continue;
    if (title && line === title) continue;
    const lower = line.toLowerCase();
    if (COMPANY_KEYWORDS.some(k => lower.includes(k))) return line;
  }
  // Last substantive line
  const rest = lines.filter(l => l !== name && l !== title);
  return rest[rest.length - 1] || null;
}

function looksLikeKeywordLine(line) {
  const lower = line.toLowerCase();
  return [...TITLE_KEYWORDS, ...COMPANY_KEYWORDS].some(k => lower.includes(k));
}
