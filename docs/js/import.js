import { importAll, createSession, createContact } from './db.js';

export async function importFile(file) {
  const ext = file.name.split('.').pop().toLowerCase();
  if (ext === 'json') return importJSON(file);
  if (ext === 'csv') return importCSV(file);
  if (ext === 'vcf') return importVCard(file);
  throw new Error(`Unsupported file type: .${ext}`);
}

// ─── JSON ────────────────────────────────────────────────────────────────────

export async function importJSON(file, mode = 'merge') {
  const text = await readText(file);
  const data = JSON.parse(text);
  if (!data.sessions || !data.contacts) throw new Error('Invalid backup format');
  if (data.schema_version && data.schema_version > 1) throw new Error('Backup is from a newer app version');

  await importAll(data, mode);
  return { sessions: data.sessions.length, contacts: data.contacts.length };
}

// ─── CSV ─────────────────────────────────────────────────────────────────────

export async function importCSV(file) {
  const text = await readText(file);
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
  if (lines.length < 2) throw new Error('CSV is empty');

  const headers = parseCSVRow(lines[0]).map(h => h.toLowerCase().trim());
  const rows = lines.slice(1).map(parseCSVRow);

  const col = name => headers.indexOf(name);

  const sessionName = `CSV Import — ${new Date().toISOString().split('T')[0]}`;
  const session = await createSession({ event_name: sessionName, date: new Date().toISOString().split('T')[0] });

  const contacts = [];
  for (const row of rows) {
    if (row.every(c => !c)) continue;
    const get = i => (i >= 0 ? row[i] || '' : '');
    const contact = await createContact({
      session_id: session.id,
      name:        get(col('name')),
      title:       get(col('title')),
      company:     get(col('company')),
      emails:      get(col('email')).split('|').filter(Boolean),
      phones:      get(col('phone')).split('|').filter(Boolean),
      linkedin:    get(col('linkedin')),
      website:     get(col('website')),
      tier:        parseTier(get(col('tier'))),
      intro_by:    get(col('intro_by')),
      next_action: get(col('next_action')),
      next_action_date: get(col('next_action_date')),
      ocr_raw_front: '',
      ocr_raw_back: '',
      card_image_front: '',
      card_image_back: '',
    });
    contacts.push(contact);
  }

  return { sessions: 1, contacts: contacts.length };
}

function parseTier(val) {
  if (!val) return null;
  const n = parseInt(val.replace(/\D/g, ''));
  return n >= 1 && n <= 4 ? n : null;
}

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

// ─── vCard ───────────────────────────────────────────────────────────────────

export async function importVCard(file) {
  const text = await readText(file);
  const cards = text.split(/BEGIN:VCARD/i).slice(1);
  const sessionName = `vCard Import — ${new Date().toISOString().split('T')[0]}`;
  const session = await createSession({ event_name: sessionName, date: new Date().toISOString().split('T')[0] });

  const contacts = [];
  for (const card of cards) {
    const lines = card.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    const get = (prefix) => {
      const l = lines.find(l => l.toUpperCase().startsWith(prefix.toUpperCase() + ':'));
      return l ? l.slice(prefix.length + 1).replace(/\\,/g,',').replace(/\\;/g,';').replace(/\\n/g,'\n') : '';
    };
    const getAll = (prefix) => lines
      .filter(l => l.toUpperCase().startsWith(prefix.toUpperCase() + ':'))
      .map(l => l.slice(prefix.length + 1).replace(/\\,/g,','));

    const contact = await createContact({
      session_id: session.id,
      name:    get('FN') || get('N').split(';').slice(0,2).reverse().join(' ').trim(),
      title:   get('TITLE'),
      company: get('ORG'),
      emails:  getAll('EMAIL'),
      phones:  getAll('TEL'),
      linkedin: '',
      website: get('URL'),
      tier: null, intro_by: '', next_action: '', next_action_date: '',
      ocr_raw_front: '', ocr_raw_back: '', card_image_front: '', card_image_back: '',
    });
    contacts.push(contact);
  }

  return { sessions: 1, contacts: contacts.length };
}

function readText(file) {
  return new Promise((res, rej) => {
    const reader = new FileReader();
    reader.onload = e => res(e.target.result);
    reader.onerror = rej;
    reader.readAsText(file);
  });
}
