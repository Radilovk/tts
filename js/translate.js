// Book translation. Paragraphs are translated one chapter at a time, just
// before they are read, and stored in IndexedDB, so each chapter is paid
// for once. Uses the browser's built-in on-device translator when it exists
// (free), otherwise Gemini Flash-Lite — about 0.1–0.2 $ for a whole novel.

import * as db from './db.js';
import { recordUsage } from './usage.js';
import { LANG_NAMES } from './text.js';

export const TRANSLATE_DEFAULT_MODEL = 'gemini-2.5-flash-lite';
const BATCH_CHARS = 6000;
const BATCH_PARAS = 60;
const CONCURRENCY = 4;
const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta';

const EN_NAMES = { bg: 'Bulgarian', en: 'English', ru: 'Russian', de: 'German', fr: 'French', es: 'Spanish', it: 'Italian', uk: 'Ukrainian', sr: 'Serbian' };

// ---------- on-device (Chrome Translator API) ----------

let deviceTranslator = null;

const withTimeout = (p, ms) => Promise.race([p, new Promise((_, j) => setTimeout(() => j(new Error('timeout')), ms))]);

// Only use the on-device translator when its language pack is already installed;
// a pack that still needs downloading would stall playback.
async function getDeviceTranslator(from, to) {
    if (!('Translator' in self)) return null;
    const key = `${from}>${to}`;
    if (deviceTranslator?.key === key) return deviceTranslator.t;
    let t = null;
    try {
        const av = await withTimeout(self.Translator.availability({ sourceLanguage: from, targetLanguage: to }), 1500);
        if (av === 'available') t = await withTimeout(self.Translator.create({ sourceLanguage: from, targetLanguage: to }), 4000);
    } catch {}
    // Remember a negative answer too, so later chapters don't wait for the check again
    deviceTranslator = { key, t };
    return t;
}

export async function deviceTranslationAvailable(from, to) {
    if (!('Translator' in self)) return false;
    try { return (await withTimeout(self.Translator.availability({ sourceLanguage: from, targetLanguage: to }), 1500)) === 'available'; }
    catch { return false; }
}

// ---------- Gemini ----------

async function geminiBatch(paras, { apiKey, model, from, to, signal }) {
    const prompt = `You are a professional literary translator. Translate each paragraph of the JSON array below from ${EN_NAMES[from] || from} into ${EN_NAMES[to] || to}.
Write natural, fluent, literary ${EN_NAMES[to] || to} that sounds good when read aloud. Keep the tone, humour and tension of the original.
Use the dialogue punctuation conventions of ${EN_NAMES[to] || to}. Transliterate names the way published translations do.
Return ONLY a JSON array with exactly ${paras.length} strings — one translation per input paragraph, in the same order. Never merge, split, skip or comment.

${JSON.stringify(paras)}`;
    const generationConfig = {
        temperature: 0.3,
        responseMimeType: 'application/json',
        responseSchema: { type: 'ARRAY', items: { type: 'STRING' } },
    };
    if (/2\.5-flash/.test(model)) generationConfig.thinkingConfig = { thinkingBudget: 0 };

    let lastErr;
    for (let attempt = 0; attempt < 3; attempt++) {
        try {
            const res = await fetch(`${GEMINI_BASE}/models/${model}:generateContent?key=${encodeURIComponent(apiKey)}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig }),
                signal,
            });
            const data = await res.json().catch(() => null);
            if (!res.ok) {
                const msg = data?.error?.message || `HTTP ${res.status}`;
                const err = new Error(/API key not valid/i.test(msg) ? 'Невалиден API ключ.' : 'Грешка при превод: ' + msg);
                if (res.status !== 429 && res.status < 500) throw Object.assign(err, { fatal: true });
                throw err;
            }
            const usage = data.usageMetadata || {};
            recordUsage({ engine: 'translate', inTokens: usage.promptTokenCount || 0, outTokens: (usage.candidatesTokenCount || 0) + (usage.thoughtsTokenCount || 0) });
            const text = data.candidates?.[0]?.content?.parts?.map((p) => p.text || '').join('') || '';
            const out = JSON.parse(text);
            if (!Array.isArray(out) || out.length !== paras.length) throw Object.assign(new Error('mismatch'), { mismatch: true });
            return out.map((t, i) => (typeof t === 'string' && t.trim() ? t.trim() : paras[i]));
        } catch (e) {
            if (e.name === 'AbortError' || e.fatal) throw e;
            if (e.mismatch && paras.length > 1) {
                // The model merged or dropped a paragraph: split the batch and retry the halves
                const mid = Math.ceil(paras.length / 2);
                const a = await geminiBatch(paras.slice(0, mid), { apiKey, model, from, to, signal });
                const b = await geminiBatch(paras.slice(mid), { apiKey, model, from, to, signal });
                return [...a, ...b];
            }
            lastErr = e;
            await new Promise((r) => setTimeout(r, 1500 * 2 ** attempt));
        }
    }
    throw lastErr;
}

function batches(items) {
    const out = [];
    let cur = [], len = 0;
    items.forEach((t, i) => {
        if (cur.length && (len + t.length > BATCH_CHARS || cur.length >= BATCH_PARAS)) { out.push(cur); cur = []; len = 0; }
        cur.push(i);
        len += t.length;
    });
    if (cur.length) out.push(cur);
    return out;
}

// ---------- public ----------

// Translate one chapter ({ title, paras }) and cache it. Returns the translated chapter.
export async function translateChapter({ bookId, c, chapter, from, to, apiKey, model, onProgress, signal }) {
    const key = `${bookId}|${to}|${c}`;
    const cached = await db.get('trans', key);
    if (cached) return cached.chapter;

    const items = [chapter.auto ? '' : chapter.title, ...chapter.paras];
    const result = items.slice();
    const todo = items.map((t, i) => i).filter((i) => items[i].trim());
    let done = 0;

    const device = await getDeviceTranslator(from, to);
    if (device) {
        for (const i of todo) {
            if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
            try { result[i] = await withTimeout(device.translate(items[i]), 20000); } catch {}
            onProgress?.(++done / todo.length);
        }
    } else {
        if (!apiKey) throw new Error('За превод е нужен Google API ключ (или браузър с вграден преводач).');
        const groups = batches(todo.map((i) => items[i])).map((g) => g.map((k) => todo[k]));
        let next = 0;
        const worker = async () => {
            while (next < groups.length) {
                const g = groups[next++];
                const out = await geminiBatch(g.map((i) => items[i]), { apiKey, model: model || TRANSLATE_DEFAULT_MODEL, from, to, signal });
                g.forEach((i, k) => { result[i] = out[k]; });
                done += g.length;
                onProgress?.(done / todo.length);
            }
        };
        await Promise.all(Array.from({ length: Math.min(CONCURRENCY, groups.length) }, worker));
    }

    const translated = { title: chapter.auto ? chapter.title : result[0], paras: result.slice(1), auto: chapter.auto };
    await db.put('trans', { key, chapter: translated, at: Date.now() });
    return translated;
}

// Rough cost of translating a whole book with Gemini Flash-Lite (USD).
export function translationCost(chars) {
    const inTok = chars / 4 + 400 * Math.ceil(chars / BATCH_CHARS);
    const outTok = chars / 2.2; // Cyrillic output uses more tokens per character
    return inTok / 1e6 * 0.1 + outTok / 1e6 * 0.4;
}

export function langPairLabel(from, to) {
    return `${LANG_NAMES[from] || from} → ${LANG_NAMES[to] || to}`;
}
