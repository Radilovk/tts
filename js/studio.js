// Night studio: a whole book is sent to the server (library worker + the hourly
// runner in .github/workflows/night-studio.yml) and narrated there while the app
// is closed. Finished passages are stored under the same keys the player uses, so
// listening later just downloads them — no waiting, no new synthesis.

import * as db from './db.js';
import { geminiRequestBody } from './engines.js';
import { libraryApi, sharedHasAudio } from './shared.js';

// apiKey: the owner's Gemini key — the server keeps only its hash, as the owner id
async function call(apiKey, path, opts = {}) {
    const base = libraryApi();
    if (!base) throw new Error('Няма адрес на сървъра (LIBRARY_API).');
    const r = await fetch(base + path, {
        ...opts,
        headers: { 'X-Rz-Key': apiKey, ...(opts.body ? { 'Content-Type': 'application/json' } : {}) },
    });
    let data = null;
    try { data = await r.json(); } catch {}
    if (!r.ok) throw new Error(data?.error || `Сървърът отговори с грешка ${r.status}.`);
    return data;
}

// The voice a studio book is narrated (and later played) with
export function studioVoice(st) {
    return { geminiModel: st.geminiModel, geminiVoice: st.geminiVoice, style: st.style, customStyle: st.customStyle };
}

// Every passage of the book with the exact request the app itself would send.
// Always the Gemini narrator: the studio records only the expressive voice.
export async function buildJob(player, st, mode, onProgress) {
    st = { ...st, engine: 'gemini' };
    const items = [];
    const n = player.chapters.length;
    const lang = player._lang();
    for (let c = 0; c < n; c++) {
        await player.ensureChapter(c); // translated books are translated first
        for (const spec of await player.chapterSpecs(c, st)) {
            const req = geminiRequestBody({ text: spec.text, voice: st.geminiVoice, style: st.style, customStyle: st.customStyle, lang });
            items.push({ key: spec.key, vk: spec.vk, lang: spec.lang, text: spec.text, chars: spec.chars, c, req });
        }
        onProgress?.((c + 1) / n);
    }
    return {
        bookId: player.book.id, title: player.book.title, author: player.book.author || '',
        engine: 'gemini', mode, model: st.geminiModel, voice: st.geminiVoice,
        freeKey: st.geminiFreeKey || '', items,
    };
}

export async function submitJob(apiKey, job) {
    return call(apiKey, '/jobs', { method: 'POST', body: JSON.stringify(job) });
}

export async function jobStatus(apiKey, id) {
    return call(apiKey, `/jobs/${id}`);
}

export async function cancelJob(apiKey, id) {
    return call(apiKey, `/jobs/${id}`, { method: 'DELETE' });
}

// Keep the server's audio on the phone (for listening without internet).
export async function downloadBook(player, onProgress) {
    const specs = [];
    for (let c = 0; c < player.chapters.length; c++) specs.push(...await player.chapterSpecs(c));  // the book's studio voice
    let got = 0, missing = 0;
    for (let i = 0; i < specs.length; i++) {
        const spec = specs[i];
        if (await db.audioHas(spec.key)) got++;
        else if (await sharedHasAudio(spec.key)) {
            try { await player._ensure(spec, { remoteOnly: true }); got++; } catch { missing++; }
        } else missing++;
        onProgress?.((i + 1) / specs.length);
    }
    return { got, missing, total: specs.length };
}
