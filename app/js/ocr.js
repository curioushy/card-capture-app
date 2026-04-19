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
  const result = await w.recognize(canvas, {}, {
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
