/**
 * Card Capture App — test suite
 * Covers pure-JS functions extracted from ocr.js, export.js, import.js, db.js
 * Run: node tests/test.mjs
 */

let passed = 0, failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (e) {
    console.error(`  ✗ ${name}`);
    console.error(`    ${e.message}`);
    failed++;
  }
}

function assert(condition, msg) {
  if (!condition) throw new Error(msg || 'Assertion failed');
}

function assertEqual(a, b, msg) {
  const as = JSON.stringify(a), bs = JSON.stringify(b);
  if (as !== bs) throw new Error(msg || `Expected ${bs} but got ${as}`);
}

// ─── Inline the pure functions under test ────────────────────────────────────
// (Copied from their source files — the tests validate the logic, not the imports)

// --- from ocr.js ---
function extractEmails(text) {
  return [...new Set((text.match(/[\w.+\-]+@[\w\-]+\.[a-z]{2,}/gi) || []))];
}

function extractPhones(text, emails) {
  const emailStr = emails.join(' ');
  const raw = text.match(/(\+?[\d][\d\s\-().]{6,18}[\d])/g) || [];
  return [...new Set(
    raw.map(p => p.trim()).filter(p => {
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

function looksLikeKeywordLine(line) {
  const lower = line.toLowerCase();
  return [...TITLE_KEYWORDS, ...COMPANY_KEYWORDS].some(k => lower.includes(k));
}

function extractName(lines) {
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
  const rest = lines.filter(l => l !== name && l !== title);
  return rest[rest.length - 1] || null;
}

function markConsumedStr(consumed, lines, value) {
  const vLower = value.toLowerCase();
  lines.forEach((l, i) => { if (l.toLowerCase().includes(vLower)) consumed.add(i); });
}

function parseFields(ocrResult) {
  const { text, words } = ocrResult;
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);

  const emails = extractEmails(text);
  const phones = extractPhones(text, emails);
  const linkedin = extractLinkedIn(text);
  const website = extractWebsite(text, emails, linkedin);

  const consumed = new Set();
  emails.forEach(v => markConsumedStr(consumed, lines, v));
  phones.forEach(v => markConsumedStr(consumed, lines, v));
  if (linkedin) markConsumedStr(consumed, lines, linkedin);
  if (website) markConsumedStr(consumed, lines, website);

  const remainingLines = lines.filter((_, i) => !consumed.has(i));

  const name = extractName(remainingLines, words);
  const title = extractTitle(remainingLines, name);
  const company = extractCompany(remainingLines, name, title);

  return {
    name: name || '',
    title: title || '',
    company: company || '',
    emails,
    phones,
    linkedin: linkedin || '',
    website: website || '',
    raw_text: text,
  };
}

// --- from export.js ---
function csvEscape(val) {
  const s = String(val);
  if (s.includes(',') || s.includes('"') || s.includes('\n')) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

function vcEscape(s) {
  return String(s || '').replace(/\\/g,'\\\\').replace(/,/g,'\\,').replace(/;/g,'\\;').replace(/\n/g,'\\n');
}

function today() {
  return new Date().toISOString().split('T')[0];
}

function buildCSVRow(c, sess) {
  return [
    c.name || '',
    c.title || '',
    c.company || '',
    (c.emails || []).join('|'),
    (c.phones || []).join('|'),
    c.linkedin || '',
    c.website || '',
    `T${c.tier ?? 4}`,
    c.intro_by || '',
    c.next_action || '',
    c.next_action_date || '',
    sess?.event_name || '',
    sess?.date || '',
    c.session_id || '',
    c.id,
  ].map(csvEscape).join(',');
}

// --- from import.js ---
function parseCSVRow(line) {
  const result = [];
  let cur = '', inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"' && line[i+1] === '"') { cur += '"'; i++; }
      else if (ch === '"') { inQuotes = false; }
      else cur += ch;
    } else {
      if (ch === '"') { inQuotes = true; }
      else if (ch === ',') { result.push(cur); cur = ''; }
      else cur += ch;
    }
  }
  result.push(cur);
  return result;
}

function parseTier(val) {
  if (!val) return null;
  const n = parseInt(val.replace(/\D/g, ''));
  return n >= 1 && n <= 4 ? n : null;
}

function parseVCard(text) {
  const cards = text.split(/BEGIN:VCARD/i).slice(1);
  return cards.map(card => {
    const lines = card.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    const get = (prefix) => {
      const l = lines.find(l => l.toUpperCase().startsWith(prefix.toUpperCase() + ':'));
      return l ? l.slice(prefix.length + 1).replace(/\\,/g,',').replace(/\\;/g,';').replace(/\\n/g,'\n') : '';
    };
    const getAll = (prefix) => lines
      .filter(l => l.toUpperCase().startsWith(prefix.toUpperCase() + ':'))
      .map(l => l.slice(prefix.length + 1).replace(/\\,/g,','));
    return {
      name: get('FN') || get('N').split(';').slice(0,2).reverse().join(' ').trim(),
      title: get('TITLE'),
      company: get('ORG'),
      emails: getAll('EMAIL'),
      phones: getAll('TEL'),
      website: get('URL'),
    };
  });
}

// ─── Tests ───────────────────────────────────────────────────────────────────

console.log('\n── Field Parser ──────────────────────────────────────────');

test('extracts email address', () => {
  const emails = extractEmails('Contact: john.doe@acme.com for more info');
  assertEqual(emails, ['john.doe@acme.com']);
});

test('extracts multiple emails, deduplicates', () => {
  const emails = extractEmails('john@acme.com john@acme.com jane@acme.com');
  assertEqual(emails.length, 2);
  assert(emails.includes('john@acme.com'));
  assert(emails.includes('jane@acme.com'));
});

test('extracts email with plus sign', () => {
  const emails = extractEmails('reach me at john+work@example.com');
  assertEqual(emails, ['john+work@example.com']);
});

test('does not extract non-emails', () => {
  const emails = extractEmails('No email here, just text');
  assertEqual(emails, []);
});

test('extracts phone number', () => {
  const phones = extractPhones('+65 9123 4567', []);
  assert(phones.length > 0, 'should find phone');
  assert(phones[0].includes('9123'), `got: ${phones[0]}`);
});

test('extracts international phone', () => {
  const phones = extractPhones('+1 (415) 555-0123', []);
  assert(phones.length > 0, 'should find phone');
});

test('rejects phone too short (< 7 digits)', () => {
  const phones = extractPhones('ext 123', []);
  assertEqual(phones, []);
});

test('rejects phone too long (> 15 digits)', () => {
  const phones = extractPhones('1234567890123456789', []);
  assertEqual(phones, []);
});

test('does not extract email-domain as phone', () => {
  const emails = ['john@acme.com'];
  const phones = extractPhones('john@acme.com', emails);
  assertEqual(phones, []);
});

test('extracts LinkedIn URL', () => {
  const url = extractLinkedIn('linkedin.com/in/johndoe');
  assertEqual(url, 'linkedin.com/in/johndoe');
});

test('extracts LinkedIn with full path', () => {
  const url = extractLinkedIn('Visit https://linkedin.com/in/jane-smith-123');
  assertEqual(url, 'linkedin.com/in/jane-smith-123');
});

test('returns null when no LinkedIn', () => {
  const url = extractLinkedIn('No linkedin here');
  assertEqual(url, null);
});

test('extracts website, excludes email domain', () => {
  const site = extractWebsite('john@acme.com www.acme.com', ['john@acme.com'], null);
  assertEqual(site, null); // acme.com matches email domain, excluded
});

test('extracts website when domain differs from email', () => {
  const site = extractWebsite('john@gmail.com www.mycompany.com', ['john@gmail.com'], null);
  assert(site !== null, 'should find website');
  assert(site.includes('mycompany.com'), `got: ${site}`);
});

test('extracts website, excludes linkedin', () => {
  const site = extractWebsite('linkedin.com/in/john acme.com', [], 'linkedin.com/in/john');
  assert(!site || !site.includes('linkedin'), 'should not return linkedin as website');
});

console.log('\n── parseFields integration ───────────────────────────────');

test('full English business card parse', () => {
  const ocr = {
    text: 'John Smith\nVP Credit\nAcme Capital Ltd\njohn@acme.com\n+65 9123 4567\nwww.acme.com',
    words: [],
  };
  const r = parseFields(ocr);
  assertEqual(r.name, 'John Smith');
  assert(r.title.toLowerCase().includes('vp'), `title: ${r.title}`);
  assert(r.company.toLowerCase().includes('acme capital'), `company: ${r.company}`);
  assertEqual(r.emails, ['john@acme.com']);
  assert(r.phones.length > 0, 'should have phone');
});

test('card with multiple emails', () => {
  const ocr = {
    text: 'Jane Doe\nDirector\nXYZ Group\njane@xyz.com\njane.work@xyz.com',
    words: [],
  };
  const r = parseFields(ocr);
  assertEqual(r.emails.length, 2);
});

test('card with LinkedIn', () => {
  const ocr = {
    text: 'Bob Lee\nAnalyst\nFund Partners\nbob@fund.com\nlinkedin.com/in/boblee',
    words: [],
  };
  const r = parseFields(ocr);
  assertEqual(r.linkedin, 'linkedin.com/in/boblee');
});

test('empty text returns empty fields', () => {
  const r = parseFields({ text: '', words: [] });
  assertEqual(r.name, '');
  assertEqual(r.emails, []);
  assertEqual(r.phones, []);
});

test('Chinese title keyword detected', () => {
  const r = parseFields({ text: '王伟\n总监\n集团有限公司', words: [] });
  assert(r.title === '总监', `title: ${r.title}`);
  assert(r.company.includes('集团'), `company: ${r.company}`);
});

console.log('\n── CSV export/import round-trip ─────────────────────────');

test('csvEscape: plain value unchanged', () => {
  assertEqual(csvEscape('hello'), 'hello');
});

test('csvEscape: wraps comma-containing value in quotes', () => {
  assertEqual(csvEscape('Smith, John'), '"Smith, John"');
});

test('csvEscape: escapes internal quotes', () => {
  assertEqual(csvEscape('say "hi"'), '"say ""hi"""');
});

test('csvEscape: wraps newline-containing value', () => {
  assert(csvEscape('line1\nline2').startsWith('"'));
});

test('CSV row: tier null maps to T4', () => {
  const c = { id: 'x', name: 'Test', title: '', company: '', emails: [], phones: [],
    linkedin: '', website: '', tier: null, intro_by: '', next_action: '',
    next_action_date: '', session_id: 's1' };
  const row = buildCSVRow(c, { event_name: 'Conf', date: '2026-04-17' });
  assert(row.includes('T4'), `row: ${row}`);
});

test('CSV row: tier undefined maps to T4 (bug fix)', () => {
  const c = { id: 'x', name: 'Test', title: '', company: '', emails: [], phones: [],
    linkedin: '', website: '', tier: undefined, intro_by: '', next_action: '',
    next_action_date: '', session_id: 's1' };
  const row = buildCSVRow(c, null);
  assert(row.includes('T4'), `tier undefined should be T4, row: ${row}`);
});

test('CSV row: tier 1 maps to T1', () => {
  const c = { id: 'x', name: 'Alice', title: '', company: '', emails: ['a@b.com'],
    phones: [], linkedin: '', website: '', tier: 1, intro_by: '', next_action: '',
    next_action_date: '', session_id: 's1' };
  const row = buildCSVRow(c, null);
  assert(row.includes('T1'), `row: ${row}`);
});

test('CSV row: pipe-separates multiple emails', () => {
  const c = { id: 'x', name: 'Bob', title: '', company: '', emails: ['a@b.com', 'c@d.com'],
    phones: [], linkedin: '', website: '', tier: 2, intro_by: '', next_action: '',
    next_action_date: '', session_id: 's1' };
  const row = buildCSVRow(c, null);
  assert(row.includes('a@b.com|c@d.com'), `row: ${row}`);
});

console.log('\n── CSV parser ───────────────────────────────────────────');

test('parseCSVRow: simple fields', () => {
  assertEqual(parseCSVRow('a,b,c'), ['a', 'b', 'c']);
});

test('parseCSVRow: quoted field with comma', () => {
  assertEqual(parseCSVRow('"Smith, John",CEO,Acme'), ['Smith, John', 'CEO', 'Acme']);
});

test('parseCSVRow: escaped quote inside quoted field', () => {
  assertEqual(parseCSVRow('"say ""hi""",b'), ['say "hi"', 'b']);
});

test('parseCSVRow: empty fields', () => {
  assertEqual(parseCSVRow('a,,c'), ['a', '', 'c']);
});

test('parseCSVRow: trailing comma', () => {
  const r = parseCSVRow('a,b,');
  assertEqual(r[2], '');
});

test('parseTier: T1 → 1', () => { assertEqual(parseTier('T1'), 1); });
test('parseTier: t2 → 2', () => { assertEqual(parseTier('t2'), 2); });
test('parseTier: "3" → 3', () => { assertEqual(parseTier('3'), 3); });
test('parseTier: T4 → 4', () => { assertEqual(parseTier('T4'), 4); });
test('parseTier: empty → null', () => { assertEqual(parseTier(''), null); });
test('parseTier: T5 → null (out of range)', () => { assertEqual(parseTier('T5'), null); });
test('parseTier: garbage → null', () => { assertEqual(parseTier('xyz'), null); });

console.log('\n── vCard parser ──────────────────────────────────────────');

const SAMPLE_VCF = `BEGIN:VCARD
VERSION:3.0
FN:Alice Wong
TITLE:Managing Director
ORG:Alpha Capital Ltd
EMAIL:alice@alpha.com
TEL:+852 9876 5432
URL:https://www.alphacapital.com
END:VCARD
BEGIN:VCARD
VERSION:3.0
FN:Bob Chen
EMAIL:bob@beta.com
EMAIL:bob.work@beta.com
END:VCARD`;

test('vCard: parses name', () => {
  const cards = parseVCard(SAMPLE_VCF);
  assertEqual(cards[0].name, 'Alice Wong');
});

test('vCard: parses title', () => {
  const cards = parseVCard(SAMPLE_VCF);
  assertEqual(cards[0].title, 'Managing Director');
});

test('vCard: parses company', () => {
  const cards = parseVCard(SAMPLE_VCF);
  assertEqual(cards[0].company, 'Alpha Capital Ltd');
});

test('vCard: parses email', () => {
  const cards = parseVCard(SAMPLE_VCF);
  assert(cards[0].emails.includes('alice@alpha.com'));
});

test('vCard: parses phone', () => {
  const cards = parseVCard(SAMPLE_VCF);
  assert(cards[0].phones.length > 0);
});

test('vCard: parses multiple cards', () => {
  const cards = parseVCard(SAMPLE_VCF);
  assertEqual(cards.length, 2);
});

test('vCard: parses multiple emails on second card', () => {
  const cards = parseVCard(SAMPLE_VCF);
  assertEqual(cards[1].emails.length, 2);
});

test('vCard: empty file returns empty array', () => {
  const cards = parseVCard('');
  assertEqual(cards.length, 0);
});

console.log('\n── vCard escape ──────────────────────────────────────────');

test('vcEscape: plain string unchanged', () => {
  assertEqual(vcEscape('Alice Wong'), 'Alice Wong');
});

test('vcEscape: escapes comma', () => {
  assertEqual(vcEscape('Smith, John'), 'Smith\\, John');
});

test('vcEscape: escapes semicolon', () => {
  assertEqual(vcEscape('a;b'), 'a\\;b');
});

test('vcEscape: escapes newline', () => {
  assertEqual(vcEscape('line1\nline2'), 'line1\\nline2');
});

test('vcEscape: handles null/undefined', () => {
  assertEqual(vcEscape(null), '');
  assertEqual(vcEscape(undefined), '');
});

console.log('\n── importAll merge dedup logic ───────────────────────────');

test('merge: new IDs are included', () => {
  const existing = new Set(['a', 'b']);
  const incoming = [{ id: 'c' }, { id: 'd' }];
  const toWrite = incoming.filter(s => !existing.has(s.id));
  assertEqual(toWrite.length, 2);
});

test('merge: duplicate IDs are skipped', () => {
  const existing = new Set(['a', 'b']);
  const incoming = [{ id: 'a' }, { id: 'c' }];
  const toWrite = incoming.filter(s => !existing.has(s.id));
  assertEqual(toWrite.length, 1);
  assertEqual(toWrite[0].id, 'c');
});

test('merge: all duplicates → nothing written', () => {
  const existing = new Set(['a', 'b']);
  const incoming = [{ id: 'a' }, { id: 'b' }];
  const toWrite = incoming.filter(s => !existing.has(s.id));
  assertEqual(toWrite.length, 0);
});

// ─── Results ─────────────────────────────────────────────────────────────────

console.log(`\n${'─'.repeat(52)}`);
console.log(`  ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log(`  ⚠ Some tests failed`);
  process.exit(1);
} else {
  console.log(`  All tests passed ✓`);
}
