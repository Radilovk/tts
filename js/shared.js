// Shared store (Cloudflare worker + R2) for public-domain books: narration chunks
// and chapter translations are made once and reused by every listener.

const BASE = (window.LIBRARY_API || '').replace(/\/$/, '');
let health = null;

export function libraryApi() { return BASE; }

export async function sharedAvailable() {
    if (!BASE) return false;
    if (health) return health;
    health = fetch(`${BASE}/health`, { cache: 'no-store' })
        .then((r) => r.ok ? r.json() : null)
        .then((d) => !!d?.audio)
        .catch(() => false);
    return health;
}

function b64utf8(str) {
    const bytes = new TextEncoder().encode(str);
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(bin);
}

// Returns { blob, dur, chars } or null
export async function sharedGetAudio(key) {
    if (!(await sharedAvailable())) return null;
    try {
        const r = await fetch(`${BASE}/audio/${key}`);
        if (!r.ok) return null;
        const blob = await r.blob();
        return { blob, dur: Number(r.headers.get('X-Rz-Dur')) || 0, chars: Number(r.headers.get('X-Rz-Chars')) || 0 };
    } catch {
        return null;
    }
}

export async function sharedHasAudio(key) {
    if (!(await sharedAvailable())) return false;
    try { return (await fetch(`${BASE}/audio/${key}`, { method: 'HEAD' })).ok; } catch { return false; }
}

// Fire-and-forget upload; the worker checks that key = SHA-1("voice|lang|text").
export async function sharedPutAudio(key, voice, lang, text, blob, dur) {
    if (!(await sharedAvailable())) return;
    try {
        await fetch(`${BASE}/audio/${key}?dur=${encodeURIComponent(dur || '')}`, {
            method: 'PUT',
            headers: {
                'Content-Type': blob.type || 'audio/wav',
                'X-Rz-Voice': encodeURIComponent(voice),
                'X-Rz-Lang': lang,
                'X-Rz-Text': b64utf8(text),
            },
            body: blob,
        });
    } catch {}
}

export async function sharedGetTrans(key) {
    if (!(await sharedAvailable())) return null;
    try {
        const r = await fetch(`${BASE}/trans/${encodeURIComponent(key)}`);
        return r.ok ? await r.json() : null;
    } catch {
        return null;
    }
}

export async function sharedPutTrans(key, chapter) {
    if (!(await sharedAvailable())) return;
    try {
        await fetch(`${BASE}/trans/${encodeURIComponent(key)}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(chapter),
        });
    } catch {}
}
