// Tesseract.js wrapper + field parser
//
// Worker strategy (mobile-first):
//   - Single worker, reused across all cards in a session.
//   - Sequential PSM 6 → PSM 11 on the same worker (halves RAM vs two parallel
//     workers, critical on mid-range Android with 4 GB shared with OS).
//   - Language defaults to 'eng' (~10 MB model). 'chi_sim' (~20 MB) is opt-in
//     via Settings and stored in localStorage key 'cc-lang'.
//   - jsDelivr CDN is more reliable than unpkg for global mobile users.

// ─── Language helper ──────────────────────────────────────────────────────────

export function getOCRLang() {
  return localStorage.getItem('cc-lang') || 'eng';
}

export function setOCRLang(lang) {
  localStorage.setItem('cc-lang', lang);
  // Terminate any existing worker so next session picks up new language
  terminateWorkers();
}

// ─── Tesseract script loader ──────────────────────────────────────────────────

let tesseractLoadPromise = null;

export function loadTesseract() {
  if (tesseractLoadPromise) return tesseractLoadPromise;
  tesseractLoadPromise = new Promise((resolve, reject) => {
    if (window.Tesseract) { resolve(); return; }
    const script = document.createElement('script');
    // jsDelivr is more reliable than unpkg for mobile users globally
    script.src = 'https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js';
    script.onload = resolve;
    script.onerror = () => reject(new Error('Tesseract failed to load'));
    document.head.appendChild(script);
  });
  return tesseractLoadPromise;
}

// ─── Worker management ────────────────────────────────────────────────────────

// One worker per language string — reused across all cards in a session.
const workers = {};

function _updateLoadingUI(msg) {
  // Direct DOM update avoids importing from app.js (circular dep).
  // The status bar elements are always present in the HTML shell.
  const bar    = document.getElementById('statusBar');
  const textEl = document.getElementById('statusBarText');
  if (bar && textEl) { bar.hidden = false; textEl.textContent = msg; }
}

async function getWorker(lang) {
  if (workers[lang]) return workers[lang];
  await loadTesseract();

  const w = await Tesseract.createWorker(lang, 1, {
    // Show model-download progress in the status bar.
    // Language models are cached in the browser after first download
    // (Tesseract.js uses IndexedDB), so this only appears on first use.
    logger: m => {
      if (m.status === 'loading tesseract core') {
        _updateLoadingUI('Loading OCR engine…');
      } else if (m.status === 'loading language traineddata') {
        const pct = Math.round((m.progress || 0) * 100);
        const hint = lang.includes('chi_sim') ? ' (~30 MB, first time only)' : ' (~10 MB, first time only)';
        _updateLoadingUI(`Downloading language model… ${pct}%${pct < 5 ? hint : ''}`);
      } else if (m.status === 'initialized api') {
        _updateLoadingUI('OCR ready');
      }
    },
  });
  workers[lang] = w;
  return w;
}

// ─── OCR entry point ──────────────────────────────────────────────────────────

export async function runOCR(canvas, onProgress) {
  const prepped = preprocessForOCR(canvas);
  const lang = getOCRLang();
  const w = await getWorker(lang);

  // Sequential PSM 6 → PSM 11 on the same worker.
  // PSM 6 (single uniform block) handles cards with clean grid layouts.
  // PSM 11 (sparse text) recovers scattered contact details that PSM 6 misses.
  // Sequential rather than parallel = half the RAM, ~same total time.

  await w.setParameters({ tessedit_pageseg_mode: '6' });
  const r6 = await w.recognize(prepped, {}, {
    blocks: false, hocr: false, tsv: false, text: true, words: true,
  });
  if (onProgress) onProgress(55);

  await w.setParameters({ tessedit_pageseg_mode: '11' });
  const r11 = await w.recognize(prepped, {}, {
    blocks: false, hocr: false, tsv: false, text: true,
  });
  if (onProgress) onProgress(100);

  return {
    text:      (r6.data.text || '') + '\n' + (r11.data.text || ''),
    text_psm6:  r6.data.text  || '',
    text_psm11: r11.data.text || '',
    // Word bboxes from PSM 6 — more reliable for font-size heuristics
    words: (r6.data.words || []).map(wrd => ({
      text: wrd.text,
      bbox: wrd.bbox,
      conf: wrd.confidence,
    })),
  };
}

// Boost OCR accuracy: deskew, upscale to ~300 DPI equivalent, shadow-normalise,
// local contrast boost (CLAHE). Falls back to plain grayscale if OpenCV isn't
// available. Research shows deskew alone can give +10% OCR accuracy.
export function preprocessForOCR(srcCanvas) {
  // Step 1: Deskew the crop before anything else. Business cards photographed
  // on a tabletop often have residual tilt (camera not perfectly overhead,
  // imperfect corner detection during dewarp). Tesseract doesn't auto-rotate
  // below ~2° and text baselines tilting by even 3-5° confuse its segmentation.
  const deskewed = deskewCanvas(srcCanvas);

  // Step 2: Upscale bilinear to a 1500px floor — OCR benefits from ≥300 DPI,
  // and many crops from far-away cards come in under 1000px.
  const TARGET = 1500;
  const longest = Math.max(deskewed.width, deskewed.height);
  const scale = longest < TARGET ? TARGET / longest : 1;
  const w = Math.round(deskewed.width * scale);
  const h = Math.round(deskewed.height * scale);

  const upscaled = document.createElement('canvas');
  upscaled.width = w; upscaled.height = h;
  const uctx = upscaled.getContext('2d');
  uctx.imageSmoothingEnabled = true;
  uctx.imageSmoothingQuality = 'high';
  uctx.drawImage(deskewed, 0, 0, w, h);

  if (!window.cv || !cv.Mat) return canvasGrayscaleFallback(upscaled);

  try {
    const src = cv.imread(upscaled);
    const gray = new cv.Mat();
    cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);

    // Shadow normalisation: divide each pixel by a heavily-blurred version of
    // itself. This removes uneven lighting (shadows cast by hands, gradient
    // overhead light, the dark diagonal on a card tilted near a window) while
    // preserving local contrast between ink and paper.
    // kernel size must be odd and large enough to cover the shadow gradient.
    const blurKSize = Math.round(w / 8) | 1; // ~1/8 of width, forced odd
    const bg = new cv.Mat();
    cv.GaussianBlur(gray, bg, new cv.Size(blurKSize, blurKSize), 0);
    // normalized = gray * 128 / bg  (avoids integer overflow via float path)
    const grayF = new cv.Mat(); gray.convertTo(grayF, cv.CV_32F);
    const bgF   = new cv.Mat(); bg.convertTo(bgF,   cv.CV_32F);
    const normF = new cv.Mat();
    cv.divide(grayF, bgF, normF, 128);
    const normalized = new cv.Mat();
    normF.convertTo(normalized, cv.CV_8U);
    bg.delete(); grayF.delete(); bgF.delete(); normF.delete();

    // CLAHE for local contrast boost after shadow removal — gentle settings
    // (clipLimit 1.5) so QR codes don't blow out into noise.
    const clahe = new cv.CLAHE(1.5, new cv.Size(8, 8));
    const equalized = new cv.Mat();
    clahe.apply(normalized, equalized);

    // NOTE: we do NOT run adaptiveThreshold here. It destroys subtle gray
    // text and QR codes. Tesseract's internal Otsu binarization does better
    // when given a clean, shadow-free grayscale image.

    const out = document.createElement('canvas');
    out.width = w; out.height = h;
    cv.imshow(out, equalized);

    src.delete(); gray.delete(); normalized.delete(); clahe.delete(); equalized.delete();
    return out;
  } catch (e) {
    console.warn('OCR preprocess failed, falling back to grayscale:', e);
    return canvasGrayscaleFallback(upscaled);
  }
}

// Deskew: detect the dominant text angle and counter-rotate so baselines are
// horizontal. We binarise the card, dilate horizontally to turn text lines
// into bars, run minAreaRect over each bar, and take the median angle.
// This is much more robust than Hough lines for noisy card backgrounds.
export function deskewCanvas(srcCanvas) {
  if (!window.cv || !cv.Mat) return srcCanvas;
  try {
    const src = cv.imread(srcCanvas);
    const gray = new cv.Mat();
    cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);

    // Invert-Otsu so text is white on black (needed for contour finding).
    const binary = new cv.Mat();
    cv.threshold(gray, binary, 0, 255, cv.THRESH_BINARY_INV + cv.THRESH_OTSU);

    // Dilate horizontally — turn each text line into one solid bar. The bar's
    // minAreaRect angle gives the baseline tilt.
    const kW = Math.max(15, Math.round(srcCanvas.width / 30));
    const kernel = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(kW, 3));
    const dilated = new cv.Mat();
    cv.dilate(binary, dilated, kernel);

    const contours = new cv.MatVector();
    const hierarchy = new cv.Mat();
    cv.findContours(dilated, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);

    const angles = [];
    const minBarArea = (srcCanvas.width * srcCanvas.height) * 0.002;
    for (let i = 0; i < contours.size(); i++) {
      const cnt = contours.get(i);
      const area = cv.contourArea(cnt);
      if (area < minBarArea) { cnt.delete(); continue; }

      const rect = cv.minAreaRect(cnt);
      const { width: rw, height: rh } = rect.size;
      // OpenCV returns angle in [-90, 0]. Normalise so horizontal bars report
      // an angle near 0 regardless of width vs height orientation.
      let angle = rect.angle;
      if (rw < rh) angle += 90;
      // Clip to near-horizontal candidates only — drop vertical decorations.
      if (angle > 45) angle -= 90;
      if (angle < -45) angle += 90;
      if (Math.abs(angle) <= 15) angles.push(angle);
      cnt.delete();
    }

    let medianAngle = 0;
    if (angles.length > 0) {
      angles.sort((a, b) => a - b);
      medianAngle = angles[Math.floor(angles.length / 2)];
    }

    // Skip the rotate if tilt is trivial — avoids unnecessary interpolation blur.
    if (Math.abs(medianAngle) < 0.5) {
      src.delete(); gray.delete(); binary.delete(); dilated.delete();
      kernel.delete(); contours.delete(); hierarchy.delete();
      return srcCanvas;
    }

    const center = new cv.Point(src.cols / 2, src.rows / 2);
    const M = cv.getRotationMatrix2D(center, medianAngle, 1);
    const rotated = new cv.Mat();
    cv.warpAffine(
      src, rotated, M, new cv.Size(src.cols, src.rows),
      cv.INTER_CUBIC, cv.BORDER_REPLICATE
    );

    const out = document.createElement('canvas');
    out.width = src.cols; out.height = src.rows;
    cv.imshow(out, rotated);

    src.delete(); gray.delete(); binary.delete(); dilated.delete();
    kernel.delete(); contours.delete(); hierarchy.delete();
    M.delete(); rotated.delete();
    return out;
  } catch (e) {
    console.warn('Deskew failed, continuing with original crop:', e);
    return srcCanvas;
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

export async function terminateWorkers() {
  for (const lang of Object.keys(workers)) {
    try { await workers[lang].terminate(); } catch {}
    delete workers[lang];
  }
}

// Legacy alias — retained so existing imports keep working.
export { terminateWorkers as terminateWorker };


// ─── Field Parser ────────────────────────────────────────────────────────────

// Strip common business-card design artifacts from OCR text. Modern cards
// often have single-letter markers like "| E" / "| T" / "| F" next to email/
// telephone/fax fields — these are decorative labels, not data. Tesseract
// reads them as part of the adjacent line.
function scrubLayoutMarkers(text) {
  return text.split('\n').map(line => {
    let l = line;
    // Trailing pipe + 1-2 letters: "krishna@...com |E|" or "+60... | T"
    l = l.replace(/\s*\|\s*[a-zA-Z]{1,2}\s*\|?\s*$/g, '');
    // Orphan single letter at end — run twice so "VICE PRESIDENT fF" → "VICE PRESIDENT"
    // (most OCR tail-noise is 1-2 stray chars from decorative stripes / logos).
    // Risk: strips legitimate initial like "John A" — acceptable since business
    // cards almost always use periods: "John A.", which has a period we don't match.
    l = l.replace(/\s+[a-zA-Z]\s*$/, '');
    l = l.replace(/\s+[a-zA-Z]\s*$/, '');
    // Leading punctuation garbage: "Vv", ": " etc.
    l = l.replace(/^[:;,.\s]+/, '');
    return l;
  }).join('\n');
}

export function parseFields(ocrResult) {
  const { words } = ocrResult;
  const rawText = ocrResult.text;
  const text = scrubLayoutMarkers(rawText);
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
  // Capture multi-part TLDs like .edu.sg, .com.my, .co.uk in addition to
  // standard 2-6 char TLDs.
  return [...new Set((text.match(/[\w.+\-]+@[\w\-.]+\.[a-z]{2,6}/gi) || []))];
}

function extractPhones(text, emails) {
  const emailStr = emails.join(' ');
  // Work per-line so we can reject company reg numbers (pattern: digits +
  // parenthesised code) and restore the "+" that OCR often misreads.
  const lines = text.split('\n');
  const found = [];

  for (let rawLine of lines) {
    // Skip company registration lines: "200601032342 (752101-D)"
    if (/\d{6,}\s*\(\s*[\w-]+\s*\)/.test(rawLine)) continue;

    // OCR "+ confusion": Tesseract regularly misreads the "+" glyph as "4",
    // "T", "F", "#" or "$". Whenever one of these appears immediately before
    // a phone-shaped digit run (e.g. "46012'2096693" → "+6012 209 8693"),
    // normalise it to "+" before parsing.
    let line = rawLine;
    // Only substitute when the char is followed by a plausible country-code
    // digit run (3+ digits) — avoids mangling legitimate text like "4 pages".
    line = line.replace(/(^|[\s(])[4TFH#$](\d{2,3})/g, '$1+$2');

    const matches = line.match(/(\+?[\d][\d\s\-().'']{6,20}[\d])/g) || [];
    for (const m of matches) {
      // Strip layout-marker tails: "+60... | T" or "... | E"
      let cleaned = m.replace(/\s*\|\s*[a-zA-Z]+\s*\|?\s*$/, '').trim();
      // Strip stray punctuation that OCR injects (apostrophes, colons)
      cleaned = cleaned.replace(/['`:]/g, ' ').replace(/\s+/g, ' ').trim();
      const digits = cleaned.replace(/\D/g, '');

      if (digits.length < 7 || digits.length > 15) continue;
      if (emailStr.includes(cleaned)) continue;

      // Reject pure digit blobs ≥10 chars with no separators — these are
      // almost always registration numbers, not phones.
      if (digits.length >= 10 && !/[\s\-+()]/.test(cleaned)) continue;

      // Require + prefix OR a separator — phones have structure, reg numbers
      // are solid digit strings.
      if (!cleaned.startsWith('+') && !/[\s\-]/.test(cleaned)) continue;

      found.push(cleaned);
    }
  }

  return [...new Set(found)];
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
  // Candidates: short lines (1–5 words) that don't look like a job title or
  // company descriptor. We score each candidate and pick the highest scorer.
  const candidates = lines.filter(l => {
    // Names never contain digits — any digit is a sign this is a phone,
    // address, reg number, or OCR noise bleeding in.
    if (/\d/.test(l)) return false;
    // Count only "real" tokens (len > 1) — single-letter OCR artifacts like
    // a stray "Z" or "|" don't count as words.
    const realWc = l.split(/\s+/).filter(t => t.length > 1).length;
    return realWc >= 1 && realWc <= 5 && !looksLikeKeywordLine(l);
  });
  if (candidates.length === 0) return null;

  function nameScore(line, idx) {
    // Score using real word count (> 1 char) to ignore OCR-noise tokens.
    const realWc = line.split(/\s+/).filter(t => t.length > 1).length;
    let score = 0;

    // Prefer multi-word lines — person names usually have 2–5 parts.
    // Single-word lines are often company logos (ISKANDAR, NUS, IRDA).
    if (realWc >= 2 && realWc <= 5) score += 10;
    else if (realWc === 1) {
      score -= 3;
      // Tiebreaker for single-word candidates: company logos appear at the
      // TOP of a card; names appear BELOW the logo. Give a small position
      // bonus so a name like "KRISHNAMOORTHY" (index 1) beats the logo
      // "ISKANDAR" (index 0) when both would otherwise score the same.
      score += Math.min(3, idx * 0.5);
    }

    // Boost by avg font height from Tesseract word bboxes (proxy for font size)
    if (words && words.length > 0) {
      const lineWords = words.filter(w => line.includes(w.text) && w.conf > 40);
      if (lineWords.length > 0) {
        const avgH = lineWords.reduce((s, w) => s + (w.bbox.y1 - w.bbox.y0), 0) / lineWords.length;
        score += Math.min(8, avgH / 5);
      }
    }

    // Lines that mix Latin + CJK with at least 2 CJK chars are very likely a
    // bilingual name (e.g. "Belinda Tan Lai May 来美"). A single stray CJK
    // glyph from OCR noise doesn't qualify.
    const cjkChars = (line.match(/[\u4e00-\u9fff]/g) || []).length;
    if (cjkChars >= 2 && /[A-Za-z]/.test(line)) score += 5;

    return score;
  }

  const scored = candidates.map((l, i) => ({ l, score: nameScore(l, lines.indexOf(l)) }));
  scored.sort((a, b) => b.score - a.score);
  return scored[0].l;
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
