import { exportAll, getMeta, listContacts, listSessions, setMeta } from './db.js';

function download(content, filename, mime) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function today() {
  return new Date().toISOString().split('T')[0];
}

// ─── JSON ────────────────────────────────────────────────────────────────────

export async function exportJSON(scope = 'all', sessionId = null, tiers = null) {
  const meta = await getMeta();
  let { sessions, contacts } = await exportAll();

  if (scope === 'session' && sessionId) {
    sessions = sessions.filter(s => s.id === sessionId);
    contacts = contacts.filter(c => c.session_id === sessionId);
  } else if (scope === 'tier' && tiers) {
    const tierSet = new Set(tiers);
    contacts = contacts.filter(c => tierSet.has(c.tier ?? 4));
    const sessionIds = new Set(contacts.map(c => c.session_id));
    sessions = sessions.filter(s => sessionIds.has(s.id));
  }

  const payload = {
    schema_version: 1,
    app_version: '1.0.0',
    exported_at: new Date().toISOString(),
    device_id: meta?.device_id || '',
    sessions,
    contacts,
  };

  await setMeta({ last_export_at: Date.now() });
  download(JSON.stringify(payload, null, 2), `card-capture-export-${today()}.json`, 'application/json');
}

// ─── CSV ─────────────────────────────────────────────────────────────────────

export async function exportCSV(scope = 'all', sessionId = null, tiers = null) {
  let contacts = await listContacts();
  const sessions = await listSessions();
  const sessionMap = {};
  sessions.forEach(s => { sessionMap[s.id] = s; });

  if (scope === 'session' && sessionId) {
    contacts = contacts.filter(c => c.session_id === sessionId);
  } else if (scope === 'tier' && tiers) {
    const tierSet = new Set(tiers);
    contacts = contacts.filter(c => tierSet.has(c.tier ?? 4));
  }

  const headers = ['name','title','company','email','phone','linkedin','website','tier','intro_by','next_action','next_action_date','event','date_met','session_id','contact_id'];
  const rows = contacts.map(c => {
    const sess = sessionMap[c.session_id];
    return [
      c.name || '',
      c.title || '',
      c.company || '',
      (c.emails || []).join('|'),
      (c.phones || []).join('|'),
      c.linkedin || '',
      c.website || '',
      c.tier !== null && c.tier !== undefined ? `T${c.tier}` : 'T4',
      c.intro_by || '',
      c.next_action || '',
      c.next_action_date || '',
      sess?.event_name || '',
      sess?.date || '',
      c.session_id || '',
      c.id,
    ].map(csvEscape).join(',');
  });

  const csv = [headers.join(','), ...rows].join('\n');
  download(csv, `card-capture-export-${today()}.csv`, 'text/csv');
}

function csvEscape(val) {
  const s = String(val);
  if (s.includes(',') || s.includes('"') || s.includes('\n')) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

// ─── vCard ───────────────────────────────────────────────────────────────────

export async function exportVCard(contacts) {
  if (!contacts) {
    contacts = await listContacts();
  }

  const vcards = contacts.map(c => {
    const lines = ['BEGIN:VCARD', 'VERSION:3.0'];
    if (c.name) lines.push(`FN:${vcEscape(c.name)}`);
    if (c.title || c.company) lines.push(`ORG:${vcEscape(c.company || '')}`);
    if (c.title) lines.push(`TITLE:${vcEscape(c.title)}`);
    (c.emails || []).forEach(e => lines.push(`EMAIL:${vcEscape(e)}`));
    (c.phones || []).forEach(p => lines.push(`TEL:${vcEscape(p)}`));
    if (c.linkedin) lines.push(`URL:https://${c.linkedin.replace(/^https?:\/\//,'')}`);
    else if (c.website) lines.push(`URL:${vcEscape(c.website)}`);
    if (c.next_action) lines.push(`NOTE:${vcEscape(c.next_action)}`);
    lines.push('END:VCARD');
    return lines.join('\r\n');
  });

  download(vcards.join('\r\n\r\n'), `card-capture-export-${today()}.vcf`, 'text/vcard');
}

function vcEscape(s) {
  return String(s || '').replace(/\\/g,'\\\\').replace(/,/g,'\\,').replace(/;/g,'\\;').replace(/\n/g,'\\n');
}
