const DB_NAME = 'card-capture-db';
const DB_VERSION = 1;

let db;

export async function initDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);

    req.onupgradeneeded = (e) => {
      const d = e.target.result;

      if (!d.objectStoreNames.contains('sessions')) {
        d.createObjectStore('sessions', { keyPath: 'id' })
          .createIndex('created_at', 'created_at');
      }

      if (!d.objectStoreNames.contains('contacts')) {
        const cs = d.createObjectStore('contacts', { keyPath: 'id' });
        cs.createIndex('session_id', 'session_id');
        cs.createIndex('company', 'company');
        cs.createIndex('tier', 'tier');
        cs.createIndex('created_at', 'created_at');
        cs.createIndex('_deleted', '_deleted');
      }

      if (!d.objectStoreNames.contains('meta')) {
        d.createObjectStore('meta', { keyPath: 'key' });
      }
    };

    req.onsuccess = (e) => {
      db = e.target.result;
      _ensureMeta();
      resolve(db);
    };

    req.onerror = () => reject(req.error);
  });
}

function _ensureMeta() {
  const tx = db.transaction('meta', 'readwrite');
  const store = tx.objectStore('meta');
  const req = store.get('app');
  req.onsuccess = () => {
    if (!req.result) {
      store.put({
        key: 'app',
        schema_version: 1,
        app_version: '1.0.0',
        device_id: crypto.randomUUID(),
        last_export_at: null,
      });
    }
  };
}

function tx(storeName, mode = 'readonly') {
  return db.transaction(storeName, mode).objectStore(storeName);
}

function req2promise(r) {
  return new Promise((res, rej) => {
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}

function cursorAll(store, indexName, query) {
  return new Promise((res, rej) => {
    const src = indexName ? store.index(indexName) : store;
    const req = src.openCursor(query);
    const results = [];
    req.onsuccess = (e) => {
      const cursor = e.target.result;
      if (cursor) { results.push(cursor.value); cursor.continue(); }
      else res(results);
    };
    req.onerror = () => rej(req.error);
  });
}

// Sessions
export async function createSession(data) {
  const session = { id: crypto.randomUUID(), is_open: true, created_at: Date.now(), updated_at: Date.now(), ...data };
  await req2promise(tx('sessions', 'readwrite').add(session));
  return session;
}

export async function getOpenSession() {
  const all = await cursorAll(tx('sessions'));
  return all.find(s => s.is_open) || null;
}

export async function getSession(id) {
  return req2promise(tx('sessions').get(id));
}

export async function listSessions() {
  const all = await cursorAll(tx('sessions'));
  return all.sort((a, b) => b.created_at - a.created_at);
}

export async function updateSession(id, changes) {
  const session = await getSession(id);
  if (!session) return;
  const updated = { ...session, ...changes, updated_at: Date.now() };
  await req2promise(tx('sessions', 'readwrite').put(updated));
  return updated;
}

export async function deleteSession(id) {
  const contacts = await listContacts({ session_id: id });
  const storeTx = db.transaction(['sessions', 'contacts'], 'readwrite');
  storeTx.objectStore('sessions').delete(id);
  contacts.forEach(c => storeTx.objectStore('contacts').delete(c.id));
  return new Promise((res, rej) => {
    storeTx.oncomplete = res;
    storeTx.onerror = () => rej(storeTx.error);
  });
}

// Contacts
export async function createContact(data) {
  const contact = {
    id: crypto.randomUUID(),
    _deleted: false,
    created_at: Date.now(),
    updated_at: Date.now(),
    ...data,
  };
  await req2promise(tx('contacts', 'readwrite').add(contact));
  return contact;
}

export async function getContact(id) {
  return req2promise(tx('contacts').get(id));
}

export async function listContacts(filters = {}) {
  let results;

  if (filters.session_id) {
    results = await cursorAll(tx('contacts'), 'session_id', IDBKeyRange.only(filters.session_id));
  } else {
    results = await cursorAll(tx('contacts'));
  }

  if (!filters.deleted) results = results.filter(c => !c._deleted);
  if (filters.tier !== undefined) results = results.filter(c => c.tier === filters.tier);
  if (filters.search) {
    const s = filters.search.toLowerCase();
    results = results.filter(c =>
      (c.name || '').toLowerCase().includes(s) ||
      (c.company || '').toLowerCase().includes(s) ||
      (c.emails || []).some(e => e.toLowerCase().includes(s))
    );
  }

  return results.sort((a, b) => b.created_at - a.created_at);
}

export async function updateContact(id, changes) {
  const contact = await getContact(id);
  if (!contact) return;
  const updated = { ...contact, ...changes, updated_at: Date.now() };
  await req2promise(tx('contacts', 'readwrite').put(updated));
  return updated;
}

export async function softDeleteContact(id) {
  return updateContact(id, { _deleted: true });
}

export async function purgeDeleted() {
  const deleted = await listContacts({ deleted: true });
  const store = tx('contacts', 'readwrite');
  await Promise.all(deleted.filter(c => c._deleted).map(c => req2promise(store.delete(c.id))));
}

// Meta
export async function getMeta() {
  return req2promise(tx('meta').get('app'));
}

export async function setMeta(changes) {
  const meta = await getMeta();
  const updated = { ...meta, ...changes };
  await req2promise(tx('meta', 'readwrite').put(updated));
  return updated;
}

// Export / Import / Clear
export async function exportAll() {
  const [sessions, contacts, meta] = await Promise.all([
    cursorAll(tx('sessions')),
    cursorAll(tx('contacts')),
    getMeta(),
  ]);
  return { sessions, contacts, meta };
}

export async function importAll(data, mode = 'merge') {
  if (mode === 'replace') await clearAll();

  let existingSessionIds = new Set();
  let existingContactIds = new Set();

  if (mode === 'merge') {
    // Fetch existing IDs in a separate readonly transaction BEFORE opening the
    // readwrite transaction — a readwrite tx auto-commits once all pending
    // requests drain, so awaiting cursors inside it would commit it prematurely.
    const [existingSessions, existingContacts] = await Promise.all([
      cursorAll(tx('sessions')),
      cursorAll(tx('contacts')),
    ]);
    existingSessionIds = new Set(existingSessions.map(s => s.id));
    existingContactIds = new Set(existingContacts.map(c => c.id));
  }

  const storeTx = db.transaction(['sessions', 'contacts'], 'readwrite');
  const sessStore = storeTx.objectStore('sessions');
  const contStore = storeTx.objectStore('contacts');

  if (mode === 'merge') {
    data.sessions.forEach(s => { if (!existingSessionIds.has(s.id)) sessStore.put(s); });
    data.contacts.forEach(c => { if (!existingContactIds.has(c.id)) contStore.put(c); });
  } else {
    data.sessions.forEach(s => sessStore.put(s));
    data.contacts.forEach(c => contStore.put(c));
  }

  return new Promise((res, rej) => {
    storeTx.oncomplete = res;
    storeTx.onerror = () => rej(storeTx.error);
  });
}

export async function clearAll() {
  const storeTx = db.transaction(['sessions', 'contacts', 'meta'], 'readwrite');
  storeTx.objectStore('sessions').clear();
  storeTx.objectStore('contacts').clear();
  storeTx.objectStore('meta').clear();
  return new Promise((res, rej) => {
    storeTx.oncomplete = () => { _ensureMeta(); res(); };
    storeTx.onerror = () => rej(storeTx.error);
  });
}

// Image compression helper
export function compressImage(blob, maxDim = 800, quality = 0.7) {
  return new Promise((resolve) => {
    const img = new Image();
    const url = URL.createObjectURL(blob);
    img.onload = () => {
      const canvas = document.createElement('canvas');
      let w = img.naturalWidth, h = img.naturalHeight;
      if (w > maxDim || h > maxDim) {
        if (w > h) { h = Math.round(h * maxDim / w); w = maxDim; }
        else { w = Math.round(w * maxDim / h); h = maxDim; }
      }
      canvas.width = w; canvas.height = h;
      canvas.getContext('2d').drawImage(img, 0, 0, w, h);
      URL.revokeObjectURL(url);
      resolve(canvas.toDataURL('image/jpeg', quality));
    };
    img.src = url;
  });
}
