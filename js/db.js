// IndexedDB storage: library metadata, book contents and the audio cache.
// The audio cache is what keeps the app cheap — a chunk of text is never
// paid for twice, no matter how many times it is replayed.

const DB_NAME = 'razkazvach';
const DB_VERSION = 1;

let dbPromise = null;

function open() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, DB_VERSION);
        req.onupgradeneeded = () => {
            const db = req.result;
            if (!db.objectStoreNames.contains('books')) db.createObjectStore('books', { keyPath: 'id' });
            if (!db.objectStoreNames.contains('contents')) db.createObjectStore('contents', { keyPath: 'id' });
            if (!db.objectStoreNames.contains('audio')) {
                const audio = db.createObjectStore('audio', { keyPath: 'key' });
                audio.createIndex('at', 'at');
                audio.createIndex('bookId', 'bookId');
            }
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
    return dbPromise;
}

function wrap(req) {
    return new Promise((resolve, reject) => {
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
}

async function store(name, mode = 'readonly') {
    const db = await open();
    return db.transaction(name, mode).objectStore(name);
}

export async function get(name, key) {
    return wrap((await store(name)).get(key));
}

export async function put(name, value) {
    return wrap((await store(name, 'readwrite')).put(value));
}

export async function del(name, key) {
    return wrap((await store(name, 'readwrite')).delete(key));
}

export async function getAll(name) {
    return wrap((await store(name)).getAll());
}

// ---------- Audio cache ----------

export async function audioGet(key) {
    const rec = await get('audio', key);
    if (rec) {
        // Touch for LRU, without waiting
        rec.at = Date.now();
        put('audio', rec).catch(() => {});
    }
    return rec;
}

export async function audioHas(key) {
    const s = await store('audio');
    const count = await wrap(s.count(key));
    return count > 0;
}

export async function audioPut(rec) {
    rec.at = Date.now();
    rec.size = rec.blob.size;
    await put('audio', rec);
}

export async function audioStats() {
    const s = await store('audio');
    return new Promise((resolve, reject) => {
        let size = 0, count = 0;
        const req = s.openCursor();
        req.onsuccess = () => {
            const cur = req.result;
            if (!cur) return resolve({ size, count });
            size += cur.value.size || 0;
            count++;
            cur.continue();
        };
        req.onerror = () => reject(req.error);
    });
}

// Delete least-recently-used audio until the cache fits in maxBytes.
export async function audioEvict(maxBytes) {
    const { size } = await audioStats();
    if (size <= maxBytes) return 0;
    let excess = size - maxBytes;
    const db = await open();
    return new Promise((resolve, reject) => {
        const tx = db.transaction('audio', 'readwrite');
        const req = tx.objectStore('audio').index('at').openCursor();
        let removed = 0;
        req.onsuccess = () => {
            const cur = req.result;
            if (!cur || excess <= 0) return;
            excess -= cur.value.size || 0;
            removed++;
            cur.delete();
            cur.continue();
        };
        tx.oncomplete = () => resolve(removed);
        tx.onerror = () => reject(tx.error);
    });
}

export async function audioDeleteBook(bookId) {
    const db = await open();
    return new Promise((resolve, reject) => {
        const tx = db.transaction('audio', 'readwrite');
        const req = tx.objectStore('audio').index('bookId').openCursor(IDBKeyRange.only(bookId));
        req.onsuccess = () => {
            const cur = req.result;
            if (!cur) return;
            cur.delete();
            cur.continue();
        };
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
    });
}

export async function audioClear() {
    return wrap((await store('audio', 'readwrite')).clear());
}

export async function requestPersistence() {
    try {
        if (navigator.storage && navigator.storage.persist) await navigator.storage.persist();
    } catch {}
}
