// Night studio runner: narrates whole books on the server while the app is closed.
//
// Runs from .github/workflows/night-studio.yml every hour. It reads the queue from the
// library worker (/jobs), narrates what is missing and stores every passage as Ogg/Opus
// (Gemini) or MP3 (Google HD) under the same key the app uses for its audio cache, so the
// player simply finds it.
//
// Modes:
//   batch — Gemini Batch API, half the price; Google usually finishes within hours
//   free  — the free daily Gemini quota (GEMINI_FREE_KEY, a key from a project without
//           billing); a few dozen passages a day, so a book takes days, but costs 0 $
//   cloud — Google HD (Chirp 3 HD) inside the free 1M characters a month
//
// Env: GEMINI_API_KEY (the repo secret the app is built with; it is also the owner id of
//      the queue — no other secret is needed), GEMINI_FREE_KEY, GOOGLE_TTS_KEY,
//      LIBRARY_API (default: from js/config.js), MAX_MINUTES (default 300),
//      CLOUD_FREE_CHARS (default 700000 a month; 0 = no cap)

import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const started = Date.now();
const MAX_MS = (Number(process.env.MAX_MINUTES) || 300) * 60_000;
const timeLeft = () => MAX_MS - (Date.now() - started);
const API = (process.env.LIBRARY_API || readFileSync(new URL('../js/config.js', import.meta.url), 'utf8')
    .match(/LIBRARY_API\s*=\s*'([^']+)'/)?.[1] || '').replace(/\/$/, '');
const KEY = process.env.GEMINI_API_KEY || '';
const TTS_KEY = process.env.GOOGLE_TTS_KEY || KEY;
// 700k leaves room in Google's free 1M a month for listening live with Google HD
const CLOUD_CAP = process.env.CLOUD_FREE_CHARS === undefined ? 700_000 : Number(process.env.CLOUD_FREE_CHARS);
const GEMINI = process.env.GEMINI_BASE || 'https://generativelanguage.googleapis.com/v1beta';
const TTS = process.env.TTS_BASE || 'https://texttospeech.googleapis.com/v1';
const PER_BATCH = 8; // passages per batch: each answer is ~10 MB of audio, keeps memory sane

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

// ---------- worker ----------

async function api(path, opts = {}) {
    const r = await fetch(API + path, {
        ...opts,
        headers: { 'X-Rz-Key': KEY, ...(opts.body && typeof opts.body === 'string' ? { 'Content-Type': 'application/json' } : {}), ...opts.headers },
    });
    if (!r.ok) throw new Error(`${opts.method || 'GET'} ${path}: HTTP ${r.status} ${(await r.text()).slice(0, 200)}`);
    return r.json();
}

const saveState = (job, patch) => api(`/jobs/${job.id}`, { method: 'PUT', body: JSON.stringify(patch) }).then((s) => Object.assign(job, s));

async function onServer(key) {
    for (let i = 0; i < 3; i++) {
        try { return (await fetch(`${API}/audio/${key}`, { method: 'HEAD' })).ok; } catch { await sleep(1000); }
    }
    return false;
}

async function upload(item, bytes, type, dur) {
    for (let i = 0; ; i++) {
        try {
            const r = await fetch(`${API}/audio/${item.key}?dur=${dur.toFixed(2)}`, {
                method: 'PUT',
                headers: {
                    'Content-Type': type,
                    'X-Rz-Voice': encodeURIComponent(item.vk),
                    'X-Rz-Lang': item.lang,
                    'X-Rz-Text': Buffer.from(item.text, 'utf8').toString('base64'),
                },
                body: bytes,
            });
            if (r.ok) return;
            throw new Error(`HTTP ${r.status} ${(await r.text()).slice(0, 200)}`);
        } catch (e) {
            if (i >= 3) throw e;
            await sleep(2000 * 2 ** i);
        }
    }
}

// ---------- audio ----------

function run(cmd, args, input) {
    return new Promise((resolve, reject) => {
        const p = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'] });
        const out = [], err = [];
        p.stdout.on('data', (d) => out.push(d));
        p.stderr.on('data', (d) => err.push(d));
        p.on('error', reject);
        p.on('close', (code) => code === 0 ? resolve(Buffer.concat(out)) : reject(new Error(`${cmd}: ${Buffer.concat(err).toString().slice(0, 300)}`)));
        p.stdin.on('error', () => {});
        p.stdin.end(input);
    });
}

// Same treatment as in the app (js/engines.js): trim long silences, even loudness
function trimSilence(view, rate) {
    const keep = Math.round(rate * 0.25);
    let start = 0, end = view.length - 1;
    while (start < view.length && Math.abs(view[start]) < 400) start++;
    while (end > start && Math.abs(view[end]) < 400) end--;
    return view.slice(Math.max(0, start - keep), Math.min(view.length, end + keep));
}

function levelLoudness(view) {
    let sum = 0, n = 0;
    for (let i = 0; i < view.length; i += 4) { const x = view[i]; if (x > 500 || x < -500) { sum += x * x; n++; } }
    if (n < 1000) return view;
    const gain = Math.max(0.6, Math.min(2.2, 3300 / Math.sqrt(sum / n)));
    if (Math.abs(gain - 1) < 0.05) return view;
    const out = new Int16Array(view.length);
    const knee = 24000;
    for (let i = 0; i < view.length; i++) {
        let y = view[i] * gain;
        const a = Math.abs(y);
        if (a > knee) y = Math.sign(y) * (knee + (32767 - knee) * Math.tanh((a - knee) / (32767 - knee)));
        out[i] = y;
    }
    return out;
}

// generateContent answer → { bytes (Ogg/Opus 32 kb/s), dur, inTokens, outTokens }
async function geminiAudio(data) {
    const part = data?.candidates?.[0]?.content?.parts?.find((p) => p.inlineData?.data);
    if (!part) {
        const reason = data?.candidates?.[0]?.finishReason || 'no audio';
        throw Object.assign(new Error(`Gemini: ${reason}`), { permanent: /SAFETY|PROHIBITED|BLOCK/.test(reason) });
    }
    const rate = Number((part.inlineData.mimeType || '').match(/rate=(\d+)/)?.[1] || 24000);
    const raw = Buffer.from(part.inlineData.data, 'base64');
    const pcm = levelLoudness(trimSilence(new Int16Array(raw.buffer, raw.byteOffset, raw.length >> 1), rate));
    const bytes = await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 's16le', '-ar', String(rate), '-ac', '1', '-i', 'pipe:0',
        '-c:a', 'libopus', '-b:a', '32k', '-application', 'voip', '-metadata', 'comment=AI narration', '-f', 'ogg', 'pipe:1'],
    Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength));
    const u = data.usageMetadata || {};
    return { bytes, dur: pcm.length / rate, inTokens: u.promptTokenCount || 0, outTokens: u.candidatesTokenCount || Math.round(raw.length / 2 / rate * 25) };
}

async function mp3Duration(bytes) {
    const dir = mkdtempSync(join(tmpdir(), 'rz-'));
    try {
        const f = join(dir, 'a.mp3');
        writeFileSync(f, bytes);
        const out = await run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', f], '');
        return Number(out.toString().trim()) || 0;
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
}

// USD per 1M tokens (in / audio out); keep in step with geminiPrice() in js/engines.js
function geminiCost(model, inT, outT, batch) {
    const m = model || '';
    let p = { in: 0.5, out: 10 };
    if (/3\.8-flash/.test(m)) p = Date.now() < Date.UTC(2027, 0, 1) ? { in: 0.5, out: 9 } : { in: 0.5, out: 18 };
    else if (/3\.1-flash|pro/.test(m)) p = { in: 1, out: 20 };
    return (inT * p.in + outT * p.out) / 1e6 * (batch ? 0.5 : 1);
}

// ---------- Google APIs ----------

async function google(url, body, timeout = 240_000) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeout);
    try {
        const r = await fetch(url, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: ctrl.signal } : { signal: ctrl.signal });
        const text = await r.text();
        let data = null;
        try { data = JSON.parse(text); } catch {}
        if (!r.ok) throw Object.assign(new Error(data?.error?.message || `HTTP ${r.status}`), { status: r.status });
        return data;
    } finally {
        clearTimeout(t);
    }
}

function todayPacific() {
    return new Date(Date.now() - 8 * 3600 * 1000).toISOString().slice(0, 10);
}

// ---------- engines ----------

// Free daily quota: one passage at a time, slowly, until Google says "enough for today"
async function runFree(job, book, missing) {
    // The free key entered in the app travels with the job; the repo secret is a fallback
    const FREE_KEY = book.freeKey || process.env.GEMINI_FREE_KEY || '';
    if (!FREE_KEY) return saveState(job, { error: 'Няма безплатен ключ — въведете го в Настройки → Gemini → „Безплатен ключ“ и изпратете наново.' });
    if (job.freeDay === todayPacific()) return log(`  free quota already used today`);
    let made = 0;
    for (const item of missing) {
        if (timeLeft() < 120_000) break;
        try {
            const data = await google(`${GEMINI}/models/${book.model}:generateContent?key=${FREE_KEY}`, item.req);
            const a = await geminiAudio(data);
            await upload(item, a.bytes, 'audio/ogg', a.dur);
            made++;
            await saveState(job, { done: job.done + 1, status: 'working', error: '' });
        } catch (e) {
            if (e.status === 429 || e.status === 403) {
                log(`  free quota over for today after ${made}`);
                await saveState(job, { freeDay: todayPacific() });
                break;
            }
            if (e.permanent) { await saveState(job, { failedKeys: [...(job.failedKeys || []), item.key] }); continue; }
            log(`  ${item.key.slice(0, 8)}: ${e.message}`);
            await sleep(30_000);
        }
        await sleep(21_000); // free tier allows only a few requests a minute
    }
    log(`  free: ${made} passages`);
}

async function collectBatches(job, book) {
    const byKey = new Map(book.items.map((it) => [it.key, it]));
    const keep = [];
    let cost = job.costUsd || 0;
    const failedKeys = new Set(job.failedKeys || []);
    for (const b of job.batches || []) {
        let data;
        try { data = await google(`${GEMINI}/${b.name}?key=${KEY}`, null, 600_000); } catch (e) { log(`  batch ${b.name}: ${e.message}`); keep.push(b); continue; }
        const state = data.metadata?.state || data.state || '';
        const done = !!data.done || /SUCCEEDED|FAILED|CANCELLED|EXPIRED/.test(state);
        if (!done) { keep.push(b); continue; }
        const box = data.response?.inlinedResponses || data.metadata?.output?.inlinedResponses || data.output?.inlinedResponses || {};
        const list = Array.isArray(box) ? box : (box.inlinedResponses || []);
        log(`  batch ${b.name.split('/').pop()}: ${state}, ${list.length} answers`);
        for (const r of list) {
            const item = byKey.get(r.metadata?.key);
            if (!item || !r.response) continue;
            try {
                const a = await geminiAudio(r.response);
                await upload(item, a.bytes, 'audio/ogg', a.dur);
                cost += geminiCost(book.model, a.inTokens, a.outTokens, true);
            } catch (e) {
                log(`  ${item.key.slice(0, 8)}: ${e.message}`);
                if (e.permanent) failedKeys.add(item.key);
            }
        }
    }
    await saveState(job, { batches: keep, costUsd: Math.round(cost * 10000) / 10000, failedKeys: [...failedKeys] });
}

async function submitBatches(job, book, missing) {
    if (!KEY) return saveState(job, { error: 'Няма GEMINI_API_KEY в secret-ите на репото.' });
    const inFlight = new Set((job.batches || []).flatMap((b) => b.keys));
    const todo = missing.filter((it) => !inFlight.has(it.key));
    const batches = [...(job.batches || [])];
    for (let i = 0; i < todo.length; i += PER_BATCH) {
        const group = todo.slice(i, i + PER_BATCH);
        const data = await google(`${GEMINI}/models/${book.model}:batchGenerateContent?key=${KEY}`, {
            batch: {
                display_name: `razkazvach-night-${job.id}-${batches.length + 1}`,
                input_config: { requests: { requests: group.map((it) => ({ request: it.req, metadata: { key: it.key } })) } },
            },
        }, 120_000);
        if (!data?.name) throw new Error('Gemini did not accept the batch');
        batches.push({ name: data.name, keys: group.map((it) => it.key), at: Date.now() });
    }
    if (todo.length) log(`  submitted ${todo.length} passages in ${Math.ceil(todo.length / PER_BATCH)} batches`);
    await saveState(job, { batches, status: 'working' });
}

function month() { return new Date().toISOString().slice(0, 7); }

async function runCloud(job, book, missing, usedThisMonth) {
    if (!TTS_KEY) return saveState(job, { error: 'Няма GOOGLE_TTS_KEY / GEMINI_API_KEY в secret-ите на репото.' });
    const usage = { ...(job.usage || {}) };
    let made = 0;
    for (const item of missing) {
        if (timeLeft() < 60_000) break;
        const chars = item.text.length;
        if (CLOUD_CAP && usedThisMonth.n + chars > CLOUD_CAP) {
            log('  Google HD: monthly free characters used up — continuing next month');
            await saveState(job, { error: 'Безплатните знаци на Google HD за месеца са изчерпани — продължава от 1-во число.' });
            break;
        }
        try {
            const data = await google(`${TTS}/text:synthesize?key=${TTS_KEY}`, item.req, 120_000);
            const bytes = Buffer.from(data.audioContent, 'base64');
            await upload(item, bytes, 'audio/mpeg', await mp3Duration(bytes));
            usedThisMonth.n += chars;
            usage[month()] = (usage[month()] || 0) + chars;
            made++;
            if (made % 5 === 0) await saveState(job, { usage, status: 'working', error: '' });
        } catch (e) {
            log(`  ${item.key.slice(0, 8)}: ${e.message}`);
            if (e.status === 400) { await saveState(job, { failedKeys: [...(job.failedKeys || []), item.key] }); continue; }
            if (e.status === 403) { await saveState(job, { error: e.message }); break; }
            await sleep(10_000);
        }
    }
    await saveState(job, { usage, status: 'working' });
    log(`  Google HD: ${made} passages`);
}

// ---------- main ----------

async function main() {
    if (!API || !KEY) { log('LIBRARY_API or GEMINI_API_KEY missing — nothing to do'); return; }
    const { jobs } = await api('/jobs');
    const open = jobs.filter((j) => !['done', 'cancelled'].includes(j.status));
    log(`${open.length} open job(s)`);
    const usedThisMonth = { n: jobs.reduce((s, j) => s + (j.usage?.[month()] || 0), 0) };
    for (const job of open) {
        if (timeLeft() < 120_000) break;
        log(`job ${job.id}: ${job.title} [${job.engine}/${job.mode}]`);
        try {
            const book = await api(`/jobs/${job.id}/book`);
            if (job.engine === 'gemini' && job.batches?.length) await collectBatches(job, book);
            const failed = new Set(job.failedKeys || []);
            const missing = [];
            const items = book.items.filter((it) => !failed.has(it.key));
            for (let i = 0; i < items.length; i += 16) {
                const part = items.slice(i, i + 16);
                const flags = await Promise.all(part.map((it) => onServer(it.key)));
                part.forEach((it, k) => { if (!flags[k]) missing.push(it); });
            }
            const done = book.items.length - missing.length - failed.size;
            await saveState(job, { done });
            log(`  ${done}/${book.items.length} ready`);
            if (!missing.length) { await saveState(job, { status: 'done', batches: [], error: '' }); continue; }
            if (job.engine === 'cloud') await runCloud(job, book, missing, usedThisMonth);
            else if (job.mode === 'free') await runFree(job, book, missing);
            else await submitBatches(job, book, missing);
        } catch (e) {
            log(`  error: ${e.message}`);
            await saveState(job, { error: String(e.message).slice(0, 300) }).catch(() => {});
        }
    }
}

main().catch((e) => { console.error(e); process.exit(1); });
