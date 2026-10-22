// Economy mode for the Gemini narrator: chapters are synthesized through the
// Gemini Batch API at half price, a little ahead of the listener, and land in
// the same audio cache the player reads from. Jobs survive reloads.

import * as db from './db.js';
import { geminiBatchSubmit, geminiBatchGet, geminiParseAudio, geminiRequestBody, geminiCost } from './engines.js';
import { recordUsage } from './usage.js';

const STORE = 'rz_batches';
const PER_JOB = 6; // chunks per job: keeps each inline response a manageable size on phones

function loadJobs() {
    try { return JSON.parse(localStorage.getItem(STORE) || '[]'); } catch { return []; }
}

function saveJobs(jobs) {
    localStorage.setItem(STORE, JSON.stringify(jobs));
}

export function pendingKeys() {
    const set = new Set();
    for (const j of loadJobs()) for (const it of j.items) set.add(it.key);
    return set;
}

export function pendingChapters(bookId) {
    return [...new Set(loadJobs().filter((j) => j.bookId === bookId).map((j) => j.c))];
}

// Estimated cost (USD) of preparing the given chunks in a batch
export function batchEstimate(model, chars) {
    return geminiCost(model, chars / 3, chars / 14 * 25, true);
}

// Queue the not-yet-synthesized chunks of chapter c. Returns how many chunks were queued.
export async function submitChapter(player, c, st) {
    if (c < 0 || c >= player.chapters.length) return 0;
    await player.ensureChapter(c);
    const specs = await player.chapterSpecs(c);
    const pending = pendingKeys();
    const missing = [];
    for (const spec of specs) {
        if (pending.has(spec.key) || await db.audioHas(spec.key)) continue;
        missing.push(spec);
    }
    if (!missing.length) return 0;
    const lang = player.book.translateTo || (st.lang !== 'auto' ? st.lang : player.book.lang);
    const jobs = loadJobs();
    for (let i = 0; i < missing.length; i += PER_JOB) {
        const group = missing.slice(i, i + PER_JOB);
        const items = group.map((spec) => ({
            key: spec.key,
            request: geminiRequestBody({ text: spec.text, voice: st.geminiVoice, style: st.style, customStyle: st.customStyle, lang }),
        }));
        const name = await geminiBatchSubmit({
            apiKey: st.apiKey, model: st.geminiModel, items,
            name: `razkazvach-${player.book.id}-ch${c + 1}-${i / PER_JOB + 1}`,
        });
        jobs.push({
            name, bookId: player.book.id, c, model: st.geminiModel, at: Date.now(),
            items: group.map((spec) => ({ key: spec.key, chars: spec.chars })),
        });
        saveJobs(jobs);
    }
    return missing.length;
}

let polling = false;

// Check running jobs; store finished audio. onDone(job, storedCount, error)
export async function pollBatches(apiKey, onDone) {
    if (polling || !apiKey) return;
    polling = true;
    try {
        for (const job of loadJobs()) {
            let r;
            try { r = await geminiBatchGet(apiKey, job.name); } catch { continue; }
            if (!r.done) continue;
            let stored = 0;
            if (r.ok) {
                const chars = Object.fromEntries(job.items.map((it) => [it.key, it.chars]));
                for (const resp of r.responses) {
                    if (!resp.key || !resp.response) continue;
                    try {
                        const a = geminiParseAudio(resp.response);
                        await db.audioPut({ key: resp.key, blob: a.blob, dur: a.dur, chars: chars[resp.key] || 0, bookId: job.bookId });
                        recordUsage({ engine: 'gemini', inTokens: a.inTokens, outTokens: a.outTokens, usd: geminiCost(job.model, a.inTokens, a.outTokens, true), mode: 'batch' });
                        stored++;
                    } catch {}
                }
            }
            saveJobs(loadJobs().filter((j) => j.name !== job.name));
            onDone?.(job, stored, r.ok ? '' : (r.error || r.state));
        }
    } finally {
        polling = false;
    }
}

export function hasJobs() {
    return loadJobs().length > 0;
}
