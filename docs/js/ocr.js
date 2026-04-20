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
  worker = await Tesseract.createWorker('eng+chi_sim');
  // PSM 6: assume single uniform block of text. Much better than the default
  // auto-segmentation (PSM 3) for compact business cards.
  await worker.setParameters({ tessedit_pageseg_mode: '6' });
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
  // Capture multi-part TLDs like .edu.sg, .com.my, .co.uk in addition to
  // standard 2-6 char TLDs.
  return [...new Set((text.match(/[\w.+\-]+@[\w\-.]+\.[a-z]{2,6}/gi) || []))];
}

function extractPhones(text, emails) {
  const emailStr = emails.join(' ');
  // Look at line-by-line context so we can reject company registration numbers
  // that typically appear in patterns like "BERHAD 200601032342 (752101-D)".
  const lines = text.split('\n');
  const found = [];

  for (const line of lines) {
    // Skip lines that look like a company registration: digits followed by
    // parentheses with another id ("(752101-D)").
    if (/\d{6,}\s*\(\s*[\w-]+\s*\)/.test(line)) continue;

    const matches = line.match(/(\+?[\d][\d\s\-().]{6,18}[\d])/g) || [];
    for (const m of matches) {
      const cleaned = m.trim();
      const digits = cleaned.replace(/\D/g, '');

      if (digits.length < 7 || digits.length > 15) continue;
      if (emailStr.includes(cleaned)) continue;

      // Reject pure digit blobs ≥10 digits with no spaces / dashes / plus —
      // these are almost always reg numbers, not phones.
      if (digits.length >= 10 && !/[\s\-+()]/.test(cleaned)) continue;

      // Phones almost always have a + or a country/area code structure.
      // Accept if: starts with +, OR contains a space/dash separator.
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
