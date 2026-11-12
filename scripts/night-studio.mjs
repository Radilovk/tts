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
//   auto  — every day the free quota first; whatever is still missing goes to Batch
//           (½ price) only while the owner's spending this month stays under the job's
//           budget (e.g. 1 $). Past the budget it simply waits for the next free day.
//
// Few requests to the worker: a run that has nothing to do (free quota used today, no
// batch in flight, budget spent) stops after one listing; passages known to be ready
// are remembered in the job (readyKeys), so they are not checked again.
//
// No secrets: the runner proves itself to the worker with the OIDC token GitHub issues to
// this workflow (permissions: id-token: write), and every job carries the key that pays
// for it (the one the app sent it with). Optional env fallbacks: GEMINI_API_KEY,
//      GEMINI_FREE_KEY, GOOGLE_TTS_KEY,
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
const ENV_KEY = process.env.GEMINI_API_KEY || '';
let KEY = ENV_KEY; // set per job: the key the job was filed with
const TTS_KEY = process.env.GOOGLE_TTS_KEY || KEY;
// 700k leaves room in Google's free 1M a month for listening live with Google HD
const CLOUD_CAP = process.env.CLOUD_FREE_CHARS === undefined ? 700_000 : Number(process.env.CLOUD_FREE_CHARS);
const GEMINI = process.env.GEMINI_BASE || 'https://generativelanguage.googleapis.com/v1beta';
const TTS = process.env.TTS_BASE || 'https://texttospeech.googleapis.com/v1';
const PER_BATCH = 8; // passages per batch: each answer is ~10 MB of audio, keeps memory sane

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

// ---------- worker ----------

let OIDC = '';
async function oidcToken() {
    const url = process.env.ACTIONS_ID_TOKEN_REQUEST_URL, tok = process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
    if (!url || !tok) return '';
    const r = await fetch(`${url}&audience=razkazvach-studio`, { headers: { Authorization: `bearer ${tok}` } });
    return r.ok ? (await r.json()).value || '' : '';
}

async function api(path, opts = {}) {
    // GitHub's tokens live a few minutes: take a fresh one now and then
    if (!OIDC || Date.now() - (api.at || 0) > 4 * 60_000) { OIDC = await oidcToken() || OIDC; api.at = Date.now(); }
    const r = await fetch(API + path, {
        ...opts,
        headers: { ...(OIDC ? { Authorization: `Bearer ${OIDC}` } : { 'X-Rz-Key': KEY }), ...(opts.body && typeof opts.body === 'string' ? { 'Content-Type': 'application/json' } : {}), ...opts.headers },
    });
    if (!r.ok) throw new Error(`${opts.method || 'GET'} ${path}: HTTP ${r.status} ${(await r.text()).slice(0, 200)}`);
    return r.json();
}

const ownerQ = (job) => (job.owner ? `?o=${job.owner}` : '');
const saveState = (job, patch) => api(`/jobs/${job.id}${ownerQ(job)}`, { method: 'PUT', body: JSON.stringify(patch) }).then((s) => Object.assign(job, s));

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

// generateContent answer → { pcm, rate, dur, finish, inTokens, outTokens }
function geminiPcm(data) {
    const part = data?.candidates?.[0]?.content?.parts?.find((p) => p.inlineData?.data);
    if (!part) {
        const reason = data?.candidates?.[0]?.finishReason || 'no audio';
        throw Object.assign(new Error(`Gemini: ${reason}`), { permanent: /SAFETY|PROHIBITED|BLOCK/.test(reason) });
    }
    const rate = Number((part.inlineData.mimeType || '').match(/rate=(\d+)/)?.[1] || 24000);
    const raw = Buffer.from(part.inlineData.data, 'base64');
    const pcm = levelLoudness(trimSilence(new Int16Array(raw.buffer, raw.byteOffset, raw.length >> 1), rate));
    const u = data.usageMetadata || {};
    return { pcm, rate, dur: pcm.length / rate, finish: data.candidates[0].finishReason || '',
        inTokens: u.promptTokenCount || 0, outTokens: u.candidatesTokenCount || Math.round(raw.length / 2 / rate * 25) };
}

// Pieces of one passage → one Ogg/Opus file (0.35 s between the pieces)
async function encodePieces(pieces) {
    const rate = pieces[0].rate;
    const gap = Math.round(rate * 0.35);
    const len = pieces.reduce((n, p) => n + p.pcm.length, 0) + gap * (pieces.length - 1);
    const pcm = new Int16Array(len);
    let o = 0;
    pieces.forEach((p, i) => { pcm.set(p.pcm, o); o += p.pcm.length + (i < pieces.length - 1 ? gap : 0); });
    const bytes = await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 's16le', '-ar', String(rate), '-ac', '1', '-i', 'pipe:0',
        '-c:a', 'libopus', '-b:a', '32k', '-application', 'voip', '-metadata', 'comment=AI narration', '-f', 'ogg', 'pipe:1'],
    Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength));
    return { bytes, dur: pcm.length / rate };
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
        if (!r.ok) throw Object.assign(new Error(data?.error?.message || `HTTP ${r.status}`), { status: r.status, raw: text.slice(0, 4000) });
        return data;
    } finally {
        clearTimeout(t);
    }
}

function todayPacific() {
    return new Date(Date.now() - 8 * 3600 * 1000).toISOString().slice(0, 10);
}

// ---------- engines ----------

// The models that narrate with the same voices; each has its own free daily quota
const FREE_MODELS = ['gemini-2.5-flash-tts', 'gemini-2.5-flash-preview-tts'];

const isDaily = (e) => /PerDay/i.test(e.raw || '');
const retryIn = (e) => Number(((e.raw || '').match(/retry in ([\d.]+)\s*s/i) || (e.raw || '').match(/"retryDelay":\s*"([\d.]+)s"/) || [])[1]) || 0;

// Split a passage in two near the middle (paragraph, else sentence end, else comma/space)
function splitHalf(text) {
    const mid = text.length / 2;
    for (const re of [/\n+/g, /[.!?…]["»”']?\s+/g, /[,;:—–]\s+/g, /\s+/g]) {
        let best = -1;
        for (const m of text.matchAll(re)) {
            const at = m.index + m[0].length;
            if (at > 0 && at < text.length && (best < 0 || Math.abs(at - mid) < Math.abs(best - mid))) best = at;
        }
        if (best > text.length * 0.15 && best < text.length * 0.85) return [text.slice(0, best), text.slice(best)];
    }
    return null;
}

// The same request with another piece of the passage (the prompt is "direction\n\ntext")
function reqFor(item, text) {
    const req = structuredClone(item.req);
    const part = req.contents[0].parts[0];
    part.text = part.text.endsWith(item.text) ? part.text.slice(0, part.text.length - item.text.length) + text : text;
    return req;
}

// A long passage that comes back cut short is read again in two halves (as in the app)
const truncated = (a, chars) => a.finish === 'MAX_TOKENS' || (chars > 500 && a.dur < chars / 24);

// One passage with the free key → { pcm, rate } pieces; throws { quotaDay } when the
// day's free quota of every model is used up
async function freePassage(state, item, text = item.text, depth = 0) {
    for (;;) {
        const model = state.models.find((m) => !state.usedModels.has(m));
        if (!model) throw Object.assign(new Error('free quota over'), { quotaDay: true });
        let data;
        try {
            data = await google(`${GEMINI}/models/${model}:generateContent?key=${state.key}`, reqFor(item, text), 330_000);
        } catch (e) {
            if (e.status === 429 && !isDaily(e) && state.minuteWaits < 6) {
                state.minuteWaits++;
                const wait = Math.min(65, Math.max(10, retryIn(e) || 30));
                log(`  per-minute limit — waiting ${wait}s`);
                await sleep(wait * 1000);
                continue;
            }
            if (e.status === 429 || e.status === 403 || e.status === 404) {
                // Ambiguous 429 after several waits, or a model the key cannot use
                log(`  ${model}: ${e.status === 429 ? 'free quota over for today' : 'not available'}`);
                state.usedModels.add(model);
                state.minuteWaits = 0;
                continue;
            }
            if (e.status === 400 && /token/i.test(e.message) && depth < 2) {
                const halves = splitHalf(text);
                if (halves) return [...await freePassage(state, item, halves[0], depth + 1), ...await freePassage(state, item, halves[1], depth + 1)];
            }
            throw e;
        }
        state.requests++;
        const a = geminiPcm(data);
        if (truncated(a, text.length) && depth < 2) {
            const halves = splitHalf(text);
            if (halves) {
                log(`  ${item.key.slice(0, 8)}: cut short — reading in two halves`);
                await sleep(21_000);
                const first = await freePassage(state, item, halves[0], depth + 1);
                await sleep(21_000);
                return [...first, ...await freePassage(state, item, halves[1], depth + 1)];
            }
        }
        return [a];
    }
}

// Free daily quota: one passage at a time, slowly, until Google says "enough for today"
async function runFree(job, book, missing) {
    // The free key entered in the app travels with the job; the repo secret is a fallback
    const FREE_KEY = book.freeKey || process.env.GEMINI_FREE_KEY || '';
    if (!FREE_KEY) {
        await saveState(job, { error: 'Няма безплатен ключ — въведете го в Настройки → Gemini → „Безплатен ключ“ и изпратете наново.', freeDay: todayPacific() });
        return 0;
    }
    if (job.freeDay === todayPacific()) { log('  free quota already used today'); return 0; }
    const state = { key: FREE_KEY, models: [...new Set([book.model, ...FREE_MODELS])], usedModels: new Set(), minuteWaits: 0, requests: 0 };
    const ready = new Set(job.readyKeys || []);
    let made = 0;
    for (const item of missing) {
        if (timeLeft() < 8 * 60_000) break;
        try {
            const pieces = await freePassage(state, item);
            const a = await encodePieces(pieces);
            await upload(item, a.bytes, 'audio/ogg', a.dur);
            made++;
            ready.add(item.key);
            await saveState(job, { done: job.done + 1, status: 'working', error: '', readyKeys: [...ready] });
        } catch (e) {
            if (e.quotaDay) {
                log(`  free quota over for today after ${made} passages (${state.requests} requests)`);
                await saveState(job, { freeDay: todayPacific() });
                break;
            }
            if (e.permanent) { await saveState(job, { failedKeys: [...(job.failedKeys || []), item.key] }); continue; }
            log(`  ${item.key.slice(0, 8)}: ${e.message}`);
            await sleep(30_000);
        }
        await sleep(Number(process.env.FREE_GAP_MS ?? 21_000)); // free tier allows only a few requests a minute
    }
    log(`  free: ${made} passages`);
    return made;
}

// Spending this month (USD) of one owner, over all their jobs
function ownerSpent(jobs, owner) {
    return jobs.filter((j) => j.owner === owner).reduce((n, j) => n + (j.spent?.[month()] || 0), 0);
}

// Rough cost of a passage at Batch price: ~14 characters a second, 25 audio tokens a
// second, ~1 text token per 3 characters, plus 20% to stay on the safe side
function passageEstimate(model, chars) {
    return geminiCost(model, chars / 3 + 120, chars / 14 * 25, true) * 1.2;
}

async function collectBatches(job, book) {
    const byKey = new Map(book.items.map((it) => [it.key, it]));
    const keep = [];
    let cost = job.costUsd || 0;
    const spent = { ...(job.spent || {}) };
    const failedKeys = new Set(job.failedKeys || []);
    const freeOnly = new Set(job.freeOnlyKeys || []);
    const ready = new Set(job.readyKeys || []);
    for (const b of job.batches || []) {
        let data;
        try { data = await google(`${GEMINI}/${b.name}?key=${KEY}`, null, 600_000); } catch (e) { log(`  batch ${b.name}: ${e.message}`); keep.push(b); continue; }
        const state = data.metadata?.state || data.state || '';
        const done = !!data.done || /SUCCEEDED|FAILED|CANCELLED|EXPIRED/.test(state);
        if (!done) { keep.push(b); continue; }
        const box = data.response?.inlinedResponses || data.metadata?.output?.inlinedResponses || data.output?.inlinedResponses || {};
        const list = Array.isArray(box) ? box : (box.inlinedResponses || []);
        log(`  batch ${b.name.split('/').pop()}: ${state}, ${list.length} answers`);
        let real = 0;
        for (const r of list) {
            const item = byKey.get(r.metadata?.key);
            if (!item || !r.response) continue;
            try {
                const a = geminiPcm(r.response);
                real += geminiCost(book.model, a.inTokens, a.outTokens, true);
                // Cut short: never sent to Batch again — the free runs read it in halves
                if (truncated(a, item.text.length)) { freeOnly.add(item.key); log(`  ${item.key.slice(0, 8)}: cut short, left for the free runs`); continue; }
                const enc = await encodePieces([a]);
                await upload(item, enc.bytes, 'audio/ogg', enc.dur);
                ready.add(item.key);
            } catch (e) {
                log(`  ${item.key.slice(0, 8)}: ${e.message}`);
                if (e.permanent) failedKeys.add(item.key);
            }
        }
        cost += real;
        // The estimate reserved when the batch was sent is replaced by what it really cost
        const m = b.month || month();
        spent[m] = Math.max(0, (spent[m] || 0) - (b.est || 0) + real);
    }
    await saveState(job, {
        batches: keep, costUsd: Math.round(cost * 10000) / 10000, failedKeys: [...failedKeys],
        spent, freeOnlyKeys: [...freeOnly], readyKeys: [...ready],
    });
}

// budget: USD still allowed this month (Infinity in plain batch mode)
async function submitBatches(job, book, missing, budget = Infinity) {
    if (!KEY) return saveState(job, { error: 'Няма GEMINI_API_KEY в secret-ите на репото.' });
    const inFlight = new Set((job.batches || []).flatMap((b) => b.keys));
    const freeOnly = new Set(job.freeOnlyKeys || []);
    let todo = missing.filter((it) => !inFlight.has(it.key) && !freeOnly.has(it.key));
    // Auto mode: only as many passages as the month's budget still covers
    if (budget !== Infinity) {
        const fit = [];
        let left = budget;
        for (const it of todo) {
            const est = passageEstimate(book.model, it.text.length);
            if (est > left) break;
            left -= est;
            fit.push(it);
        }
        todo = fit;
    }
    const batches = [...(job.batches || [])];
    const spent = { ...(job.spent || {}) };
    for (let i = 0; i < todo.length; i += PER_BATCH) {
        const group = todo.slice(i, i + PER_BATCH);
        const data = await google(`${GEMINI}/models/${book.model}:batchGenerateContent?key=${KEY}`, {
            batch: {
                display_name: `razkazvach-night-${job.id}-${batches.length + 1}`,
                input_config: { requests: { requests: group.map((it) => ({ request: it.req, metadata: { key: it.key } })) } },
            },
        }, 120_000);
        if (!data?.name) throw new Error('Gemini did not accept the batch');
        const est = group.reduce((n, it) => n + passageEstimate(book.model, it.text.length), 0);
        // Reserved now, so the next run cannot pass the budget before this batch is back
        spent[month()] = (spent[month()] || 0) + est;
        batches.push({ name: data.name, keys: group.map((it) => it.key), at: Date.now(), est, month: month() });
    }
    if (todo.length) log(`  submitted ${todo.length} passages in ${Math.ceil(todo.length / PER_BATCH)} batches`);
    await saveState(job, { batches, spent, status: 'working' });
    return todo.length;
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

// Nothing this run could do for the job: skip it before any further request
function idle(job, jobs) {
    if (job.engine !== 'gemini' || job.batches?.length) return false;
    const freeUsed = job.freeDay === todayPacific();
    if (job.mode === 'free') return freeUsed;
    if (job.mode === 'auto') return freeUsed && ownerSpent(jobs, job.owner) + 0.02 >= (job.budgetUsd || 0);
    return false;
}

async function main() {
    if (!API) { log('LIBRARY_API missing — nothing to do'); return; }
    OIDC = await oidcToken();
    api.at = Date.now();
    if (!OIDC && !KEY) { log('no OIDC token and no GEMINI_API_KEY — nothing to do'); return; }
    const { jobs } = await api('/jobs');
    const open = jobs.filter((j) => !['done', 'cancelled'].includes(j.status));
    log(`${open.length} open job(s)`);
    const usedThisMonth = { n: jobs.reduce((s, j) => s + (j.usage?.[month()] || 0), 0) };
    for (const job of open) {
        if (timeLeft() < 120_000) break;
        if (idle(job, jobs)) { log(`job ${job.id}: nothing to do until the next free day`); continue; }
        log(`job ${job.id}: ${job.title} [${job.engine}/${job.mode}]`);
        try {
            const book = await api(`/jobs/${job.id}/book${ownerQ(job)}`);
            KEY = book.apiKey || ENV_KEY;
            if (!KEY) { await saveState(job, { error: 'Задачата няма ключ — изпратете я наново от приложението.' }); continue; }
            if (job.engine === 'gemini' && job.batches?.length) await collectBatches(job, book);
            const failed = new Set(job.failedKeys || []);
            const ready = new Set(job.readyKeys || []);
            const missing = [];
            const items = book.items.filter((it) => !failed.has(it.key));
            // Only passages not known to be ready are checked on the server
            // (and not those Google is narrating in a batch right now)
            const waiting = new Set((job.batches || []).flatMap((b) => b.keys));
            const unknown = items.filter((it) => !ready.has(it.key) && !waiting.has(it.key));
            for (let i = 0; i < unknown.length; i += 16) {
                const part = unknown.slice(i, i + 16);
                const flags = await Promise.all(part.map((it) => onServer(it.key)));
                part.forEach((it, k) => { if (flags[k]) ready.add(it.key); else missing.push(it); });
            }
            items.forEach((it) => { if (waiting.has(it.key)) missing.push(it); });
            const done = book.items.length - missing.length - failed.size;
            await saveState(job, { done, readyKeys: [...ready] });
            log(`  ${done}/${book.items.length} ready`);
            if (!missing.length) { await saveState(job, { status: 'done', batches: [], error: '' }); continue; }
            // Passages already sent to Batch are waiting for Google, not missing
            const inFlight = new Set((job.batches || []).flatMap((b) => b.keys));
            const todo = missing.filter((it) => !inFlight.has(it.key));
            if (job.engine === 'cloud') await runCloud(job, book, todo, usedThisMonth);
            else if (job.mode === 'free') await runFree(job, book, todo);
            else if (job.mode === 'auto') {
                // 1) the free daily quota  2) Batch at ½ price within the month's budget
                await runFree(job, book, todo);
                if (job.freeDay === todayPacific()) {
                    const left = (job.budgetUsd || 0) - ownerSpent(jobs, job.owner);
                    const still = todo.filter((it) => !new Set(job.readyKeys || []).has(it.key));
                    if (!still.length) log('  the rest is with Google (batch)');
                    else if (left > 0.01) {
                        const sent = await submitBatches(job, book, still, left);
                        if (!sent) log(`  budget left ${left.toFixed(2)} $ — not enough for the next passage`);
                    } else log(`  monthly budget used (${ownerSpent(jobs, job.owner).toFixed(2)} of ${job.budgetUsd} $) — free days only`);
                    if (!job.batches?.length) await saveState(job, { note: 'Чака следващия безплатен ден.' });
                }
            } else await submitBatches(job, book, todo);
        } catch (e) {
            log(`  error: ${e.message}`);
            await saveState(job, { error: String(e.message).slice(0, 300) }).catch(() => {});
        }
    }
}

main().catch((e) => { console.error(e); process.exit(1); });
