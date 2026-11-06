// Penyimpanan lokal di browser (IndexedDB): scan, foto, dan pengaturan proyek.
// Data tidak dikirim ke server mana pun. Gunakan Ekspor/Impor untuk memindahkan data.

const DB_NAME = 'progress-tracker';
const DB_VERSION = 1;

let dbPromise = null;

function open() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('scans')) db.createObjectStore('scans', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta');
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}

async function tx(store, mode, fn) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const s = t.objectStore(store);
    const req = fn(s);
    t.oncomplete = () => resolve(req?.result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

export const store = {
  async available() {
    try {
      await open();
      return true;
    } catch {
      return false;
    }
  },
  listScans: () => tx('scans', 'readonly', (s) => s.getAll()),
  putScan: (scan) => tx('scans', 'readwrite', (s) => s.put(scan)),
  deleteScan: (id) => tx('scans', 'readwrite', (s) => s.delete(id)),
  clearScans: () => tx('scans', 'readwrite', (s) => s.clear()),
  getMeta: (key) => tx('meta', 'readonly', (s) => s.get(key)),
  setMeta: (key, value) => tx('meta', 'readwrite', (s) => s.put(value, key)),
  deleteMeta: (key) => tx('meta', 'readwrite', (s) => s.delete(key)),
};

// --- Ekspor / impor proyek sebagai satu file JSON ---

function toBase64(bytes) {
  let s = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) s += String.fromCharCode(...bytes.subarray(i, i + chunk));
  return btoa(s);
}

function fromBase64(str) {
  const bin = atob(str);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function serializeProject({ settings, scans, planName }) {
  return JSON.stringify({
    format: 'progress-tracker/v1',
    exportedAt: new Date().toISOString(),
    planName,
    settings,
    scans: scans.map((s) => ({
      ...s,
      points: toBase64(new Uint8Array(s.points.buffer, s.points.byteOffset, s.points.byteLength)),
      colors: s.colors ? toBase64(s.colors) : null,
    })),
  });
}

export function parseProject(text) {
  const data = JSON.parse(text);
  if (data.format !== 'progress-tracker/v1') throw new Error('Bukan file proyek progress tracker.');
  data.scans = data.scans.map((s) => {
    const bytes = fromBase64(s.points);
    return {
      ...s,
      points: new Float32Array(bytes.buffer, 0, bytes.byteLength / 4),
      colors: s.colors ? fromBase64(s.colors) : null,
    };
  });
  return data;
}
