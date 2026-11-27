#!/usr/bin/env node
// Text → narrated documentary video with pictures and footage that fit each sentence.
//
//   node scripts/video/make-video.mjs текст.txt                 → out/<заглавие>/video.mp4 (+ captions.srt, description.txt)
//   node scripts/video/make-video.mjs --topic "Защо мозъкът предсказва"   (Gemini пише по сценария)
//   --max-chars 4000   прототип: само началото (~3–5 мин)        --voice Enceladus --style clear
//   --no-ai-images     без AI картини за сцени без подходящ кадър   --burn-subtitles   субтитри в картината
//   --upload           качва MP4 и дава линк (worker /files)
//
// Keys (environment / GitHub secrets): GEMINI_API_KEY (voice, scenes, choosing the shots);
// PIXABAY_API_KEY and PEXELS_API_KEY are optional — without them Wikimedia Commons, NASA and
// Openverse (no key) are searched. ffmpeg must be installed.
//
// How a scene gets its picture (the difference from keyword compilations):
//   1. the narration is made first; every sentence's start is found in the audio (js/align.js);
//   2. Gemini (scenes) reads the whole text and cuts it into scenes of ~5–10 s; for each it
//      says what should be SEEN — abstract ideas turned into concrete visual metaphors — and
//      gives English search terms (stock libraries are tagged in English);
//   3. candidates are searched in every source; Gemini (look) LOOKS at the thumbnails next to
//      the sentence and picks the one that fits, or none; nothing is used twice;
//   4. when no candidate fits, an AI picture is made for that scene only (or the best is kept);
//   5. photos move slowly (Ken Burns, a different move each time), footage is cut to length,
//      shots cross-fade; the cut falls exactly where the narrator starts the sentence.

import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, resolve, dirname, basename, extname } from 'node:path';

globalThis.window ??= globalThis;
if (!globalThis.localStorage) {
    const m = new Map();
    globalThis.localStorage = { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) };
}
const { prepareLongText, planBlocks, narrateBlocks, geminiMaxBytes, RATE } = await import('../../js/narrate.js');
const { pcmToWav, GEMINI_DEFAULT_MODEL, GEMINI_DEFAULT_VOICE } = await import('../../js/engines.js');
const { splitSentences } = await import('../../js/text.js');
const { findPauses, alignSentences } = await import('../../js/align.js');
const { generate, parseJson, setWriterLog, writeNarration, editForVoice } = await import('../../js/writer.js');
const { SCENARIO } = await import('../../js/scenario.js');
const { searchAll } = await import('./sources.mjs');

// ---------- options ----------
const argv = process.argv.slice(2);
const opt = { _: [] };
for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { opt._.push(a); continue; }
    const k = a.slice(2);
    if (['no-ai-images', 'burn-subtitles', 'upload', 'no-review', 'keep'].includes(k)) opt[k] = true;
    else opt[k] = argv[++i];
}
const KEY = process.env.GEMINI_API_KEY || '';
const keys = { pixabay: process.env.PIXABAY_API_KEY || '', pexels: process.env.PEXELS_API_KEY || '' };
if (!KEY) { console.error('Липсва GEMINI_API_KEY.'); process.exit(2); }
if (!opt._[0] && !opt.topic) { console.error('Дайте файл с текст или --topic "…".'); process.exit(1); }
const ff = (args) => {
    const r = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], { stdio: ['ignore', 'inherit', 'inherit'] });
    if (r.status !== 0) throw new Error(`ffmpeg: ${args.slice(-1)[0]}`);
};
// Async ffmpeg (several run at once across CPU cores)
import { spawn as _spawn } from 'node:child_process';
const ffA = (args) => new Promise((res, rej) => {
    const p = _spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], { stdio: ['ignore', 'inherit', 'inherit'] });
    p.on('error', rej);
    p.on('close', (code) => code === 0 ? res() : rej(new Error(`ffmpeg: ${args.slice(-1)[0]}`)));
});
const cpu = Math.max(2, Math.min(6, (await import('node:os')).cpus().length));
// Run jobs (functions returning promises) with limited concurrency
async function pool(items, n, fn) {
    let i = 0;
    await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (i < items.length) { const k = i++; await fn(items[k], k); } }));
}
const log = (m) => console.log(m);
setWriterLog((m) => console.log(`  · ${m}`));
const slug = (t) => String(t).replace(/[\\/:*?"<>|\n\r]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60) || 'видео';
const T = 0.5;            // cross-fade, seconds
const FPS = 25;

// ---------- 1. the text ----------
let text = opt._[0] ? readFileSync(resolve(opt._[0]), 'utf8') : '';
let title = opt.title || (opt._[0] ? basename(opt._[0], extname(opt._[0])) : '');
if (opt.topic) {
    log(`Пиша по сценария: ${opt.topic}`);
    // A prototype (--max-chars) needs only that much text written
    const w = await writeNarration({ apiKey: KEY, mode: 'topic', input: opt.topic, scenario: SCENARIO, minChars: Number(opt['max-chars']) || 25000, onProgress: (f, l) => l && process.stdout.write(`\r  ${l.slice(0, 90).padEnd(90)}`) });
    process.stdout.write('\n');
    text = w.text;
    title ||= w.title;
}
// A generated text is already written by the voice rules (writer's prompt) — a second
// editing pass costs time for nothing; a pasted text is edited (unless --no-review).
if (!opt['no-review'] && !opt.topic) {
    log('Редакция за глас…');
    try { text = (await editForVoice({ apiKey: KEY, text })).text; } catch (e) { log(`  редакцията не успя (${e.message}) — продължавам с текста както е`); }
}
let paras = prepareLongText(text);
const maxChars = Number(opt['max-chars']) || 0;
if (maxChars) {
    const keep = [];
    let n = 0;
    for (const p of paras) { if (n && n + p.length > maxChars) break; keep.push(p); n += p.length; }
    paras = keep;
}
title ||= paras[0].slice(0, 60);
const OUT = resolve(opt.out || join('out', slug(title)));
const WORK = join(OUT, 'work');
mkdirSync(WORK, { recursive: true });
log(`„${title}“: ${paras.length} абзаца, ${paras.reduce((a, p) => a + p.length, 0)} знака → ${OUT}`);

// ---------- 2. the narration, and when every sentence starts ----------
const gemini = { model: opt.model || GEMINI_DEFAULT_MODEL, voice: opt.voice || GEMINI_DEFAULT_VOICE, style: opt.style || 'clear', customStyle: '', lang: 'bg' };
const blocks = planBlocks(paras, { maxBytes: geminiMaxBytes(6000), keepParagraphs: true });
const cacheDir = join(OUT, '.cache');
mkdirSync(cacheDir, { recursive: true });
const cache = {
    get: async (k) => {
        const f = join(cacheDir, `${k}.pcm`);
        if (!existsSync(f)) return null;
        const b = readFileSync(f);
        return new Int16Array(b.buffer.slice(b.byteOffset, b.byteOffset + (b.byteLength & ~1)));
    },
    put: async (k, pcm) => writeFileSync(join(cacheDir, `${k}.pcm`), Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength)),
};
// The sentences are known from the text alone (the same split the narration uses), so the
// scenes can be planned and their shots searched WHILE the voice is being made; the real
// times arrive with the voice and only the cut points wait for it.
const blockSents = blocks.map((block) => block.split('\n').flatMap((p) => splitSentences(p, 'bg', 450)).filter((x) => /\p{L}/u.test(x)));
const sentences = blockSents.flat().map((t) => ({ text: t, est: t.length / 14.5 }));
const t0 = Date.now();
const since = () => `${((Date.now() - t0) / 1000).toFixed(0)} с`;
let total = 0;
const voiceReady = (async () => {
    const parts = new Array(blocks.length);
    let done = 0;
    await pool(blocks, blocks.length, async (block, b) => {
        const res = await narrateBlocks([block], {
            engine: 'gemini', voice: gemini.voice, voiceKey: Object.values(gemini).join('|'), gemini, apiKey: KEY,
            freeKey: process.env.GEMINI_FREE_KEY || '', cache, concurrency: 1, onIssue: (m) => log(`  ⚠ ${m}`),
        });
        const ss = blockSents[b];
        const step = Math.round(RATE / 8000);
        const f = new Float32Array(Math.floor(res.pcm.length / step));
        for (let i = 0; i < f.length; i++) f[i] = res.pcm[i * step] / 32768;
        parts[b] = { pcm: res.pcm, marks: alignSentences(ss.map((x) => x.length), findPauses(f)) };
        log(`Глас: ${++done} от ${blocks.length} части (${since()})`);
    });
    let offset = 0, k = 0;
    for (const [b, part] of parts.entries()) {
        for (let i = 0; i < blockSents[b].length; i++) sentences[k++].start = offset + (part.marks[i] ?? 0);
        offset += part.pcm.length / RATE;
    }
    total = offset;
    sentences[0].start = 0;
    const pcm = new Int16Array(parts.reduce((a, p) => a + p.pcm.length, 0));
    { let o = 0; for (const p of parts) { pcm.set(p.pcm, o); o += p.pcm.length; } }
    writeFileSync(join(WORK, 'voice.wav'), Buffer.from(await pcmToWav(pcm, RATE).arrayBuffer()));
    log(`Глас: готов, ${(total / 60).toFixed(1)} мин (${since()})`);
})();
voiceReady.catch(() => {});

// ---------- 3. scenes: what each one shows ----------
const sentEnd = (i) => (i + 1 < sentences.length ? sentences[i + 1].start : total);
const estDur = (i) => sentences[i].est;
const SCENE_SYSTEM = `You are a documentary film editor and picture researcher. You cut a narrated Bulgarian popular-science documentary into shots and decide what each shot shows, so that the picture always matches what the narrator is saying at that moment.
Rules:
- Every sentence belongs to exactly one scene; scenes are consecutive and cover all sentences given.
- A scene lasts about 5–10 seconds (use the durations); one long sentence may be one scene; never more than ~12 s.
- "visual": what is SEEN, concrete and filmable (subject, setting, light). Turn abstract ideas into concrete visual metaphors a stock library has (e.g. "the brain predicts" → "glowing neurons firing"; "uncertainty" → "fog over a forest road at dawn"). Real named things (a scientist, a place, an instrument, a spacecraft) are shown as themselves.
- "queries": 2–3 English stock-search terms, each the PLAIN SUBJECT only — concrete nouns a photographer would tag, 1–3 words. NO camera or style words (no "slow-motion", "shot", "tracking", "close-up", "macro", "cinematic", "aerial", "editorial", "footage", "4k"), NO sentences. Good: "neurons firing", "tennis player serve", "foggy forest road", "brain scan". Bad: "slow-motion side tracking shot of a tennis player". Order: most specific first, then one broad fallback (e.g. "brain", "science lab").
- "kind": "video" when motion matters (processes, nature, people doing something), else "photo".
- Keep a visual thread: a recurring subject looks consistent; avoid people's faces in close-up unless the text is about a person.
Return only JSON: {"scenes":[{"from":0,"to":2,"visual":"…","queries":["neurons firing","brain"],"kind":"video"}]}`;

// Strip camera / style words a model sometimes still slips into a query, and keep the noun
const CAMERA = /\b(ultra|extreme|slow[- ]?motion|slow|motion|time[- ]?lapse|timelapse|high[- ]?speed|tracking|handheld|steadicam|dolly|pan(ning)?|zoom|aerial|drone|overhead|top[- ]?down|close[- ]?up|macro|wide|medium|establishing|cinematic|editorial|archival|footage|b[- ]?roll|4k|8k|hd|shot|clip|view|animation|visualization|visualisation|render|3d|still|photograph|photo|portrait|side|front|rear|dark|bright|minimalist|sudden|intense)\b/gi;
function cleanQuery(q) {
    let s = String(q || '').toLowerCase().replace(/\bshot of\b/gi, ' ').replace(CAMERA, ' ').replace(/\bof\b|\bthe\b|\ba\b|\ban\b|\bwith\b|\binto\b/gi, ' ').replace(/[^\p{L}\p{N} ]+/gu, ' ').replace(/\s+/g, ' ').trim();
    return s.split(' ').slice(0, 4).join(' ');
}

async function planScenes(first, last) {
    const lines = [];
    for (let i = first; i <= last; i++) lines.push(`${i}. [${estDur(i).toFixed(1)} s] ${sentences[i].text}`);
    const prompt = `Title: ${title}\nThe story so far (for context): ${paras.slice(0, 3).join(' ').slice(0, 1500)}\n\nSentences ${first}–${last} (index, duration, text):\n${lines.join('\n')}\n\nCut sentences ${first}–${last} into scenes.`;
    const r = await generate({ apiKey: KEY, task: 'scenes', system: SCENE_SYSTEM, prompt, json: true, maxTokens: 32768, what: `сцени ${first}–${last}` });
    const sc = (parseJson(r.text).scenes || []).filter((s) => Number.isInteger(s.from) && Number.isInteger(s.to) && s.to >= s.from)
        .sort((a, b) => a.from - b.from);
    // Make them cover first..last without gaps or overlaps
    const out = [];
    let next = first;
    for (const s of sc) {
        if (s.to < next) continue;
        const from = next, to = Math.min(last, s.to);
        const queries = [...new Set((s.queries || []).map(cleanQuery).filter((q) => q.length > 1))].slice(0, 3);
        out.push({ ...s, from, to, queries, kind: s.kind === 'video' ? 'video' : 'photo' });
        next = to + 1;
        if (next > last) break;
    }
    if (next <= last) {
        const prev = out[out.length - 1];
        if (prev) prev.to = last; else out.push({ from: first, to: last, visual: title, queries: [title], kind: 'photo' });
    }
    return out;
}

// Chunks of 40 sentences are planned at once (was: one after another)
const chunks = [];
for (let i = 0; i < sentences.length; i += 40) chunks.push([i, Math.min(sentences.length - 1, i + 39)]);
const scenes = (await Promise.all(chunks.map(([a, b]) => planScenes(a, b)))).flat();
for (const s of scenes) s.text = sentences.slice(s.from, s.to + 1).map((x) => x.text).join(' ');
log(`${scenes.length} сцени (${since()})`);

// ---------- 4. candidates, and the one that fits ----------
const used = new Set();
const thumbCache = new Map();
async function thumb64(url) {
    if (thumbCache.has(url)) return thumbCache.get(url);
    try {
        const r = await fetch(url, { headers: { 'User-Agent': 'Razkazvach-video/1.0' } });
        if (!r.ok) return null;
        const b = Buffer.from(await r.arrayBuffer());
        if (b.length > 1.5e6) return null;
        const v = { mime: r.headers.get('content-type')?.split(';')[0] || 'image/jpeg', data: b.toString('base64') };
        thumbCache.set(url, v);
        return v;
    } catch { return null; }
}

const LOOK_SYSTEM = `You choose the shot for one moment of a documentary. You see what the narrator says, what the editor wants to show, and numbered candidate pictures (for footage: a frame from it). Pick the candidate whose picture best matches the meaning of the sentence and the intended visual — as a viewer would feel it fits. Reject pictures with visible text, logos, watermarks, collages, illustrations that look cheap, or anything unrelated. Return only JSON: {"best": <candidate number or 0 if none fits>, "score": <0-10 how well it fits>, "why": "<short>"}`;

async function choose(scene, cands) {
    const parts = [{ text: `Narration (Bulgarian): "${scene.text}"\nIntended visual: ${scene.visual}\nPreferred: ${scene.kind}.` }];
    const shown = [];
    for (const c of cands) {
        const t = await thumb64(c.thumb);
        if (!t) continue;
        shown.push(c);
        parts.push({ text: `Candidate ${shown.length} (${c.kind}${c.duration ? `, ${c.duration} s` : ''}):` }, { inline_data: { mime_type: t.mime, data: t.data } });
        if (shown.length >= 10) break;
    }
    if (!shown.length) return null;
    const r = await generate({ apiKey: KEY, task: 'look', system: LOOK_SYSTEM, parts, json: true, maxTokens: 4096, what: `кадър ${scene.idx + 1}` });
    const j = parseJson(r.text);
    const c = shown[(Number(j.best) || 0) - 1];
    return c ? { ...c, score: Number(j.score) || 0, why: j.why || '' } : { score: 0 };
}

// An AI picture for a scene no library has (Gemini image model, only as the last resort)
let imageModel = null;
async function aiPicture(scene, file) {
    if (imageModel === null) {
        try {
            const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?pageSize=500&key=${KEY}`);
            const names = ((await r.json()).models || []).map((m) => m.name.replace('models/', '')).filter((n) => /image/.test(n) && !/lite|imagen|edit/.test(n));
            imageModel = names.find((n) => /flash-image$/.test(n)) || names.find((n) => /flash-image/.test(n)) || names[0] || '';
        } catch { imageModel = ''; }
    }
    if (!imageModel) return false;
    const body = {
        contents: [{ parts: [{ text: `A photorealistic documentary still, 16:9 landscape, natural light, cinematic, no text, no logos, no watermark: ${scene.visual}` }] }],
        generationConfig: { responseModalities: ['IMAGE'], imageConfig: { aspectRatio: '16:9' } },
    };
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${imageModel}:generateContent?key=${KEY}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    if (!r.ok) { log(`  AI картина: HTTP ${r.status}`); return false; }
    const d = await r.json();
    const part = d?.candidates?.[0]?.content?.parts?.find((p) => p.inlineData?.data);
    if (!part) return false;
    writeFileSync(file, Buffer.from(part.inlineData.data, 'base64'));
    return true;
}

// ---------- 5. shots, cross-fades, sound ----------
const MOVES = [
    ["1+0.10*on/FR", "iw/2-(iw/zoom/2)", "ih/2-(ih/zoom/2)"],          // slow push in
    ["1.10-0.10*on/FR", "iw/2-(iw/zoom/2)", "ih/2-(ih/zoom/2)"],       // slow pull out
    ["1.10", "(iw-iw/zoom)*on/FR", "ih/2-(ih/zoom/2)"],                // pan left → right
    ["1.10", "(iw-iw/zoom)*(1-on/FR)", "ih/2-(ih/zoom/2)"],            // pan right → left
];
const GRADE = 'eq=contrast=1.03:saturation=0.96';
const GROUP = 12;
const clips = new Array(scenes.length);
let clipDone = 0, cpuFree = cpu;
const cpuWait = [];
const cpuTake = () => (cpuFree > 0 ? (cpuFree--, Promise.resolve()) : new Promise((r) => cpuWait.push(r)));
const cpuGive = () => (cpuWait.length ? cpuWait.shift()() : cpuFree++);
async function renderClip(i) {
    await voiceReady;
    const s = scenes[i];
    s.start = sentences[s.from].start;
    s.end = sentEnd(s.to);
    // Shots cross-fade inside groups of GROUP; groups are joined end to end without another
    // encode (a plain cut every GROUP shots), so only the last shot of the video and the
    // shots ending a group get no overlap
    const endsGroup = (i + 1) % GROUP === 0 || i === scenes.length - 1;
    const d = (s.end - s.start) + (i === scenes.length - 1 ? 0.3 : endsGroup ? 0 : T);
    const frames = Math.max(2, Math.round(d * FPS));
    const out = join(WORK, `clip-${String(i).padStart(4, '0')}.mp4`);
    // intermediate files: fastest encode, near-lossless (the group pass makes the final one)
    const enc = ['-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '16', '-pix_fmt', 'yuv420p', '-r', String(FPS)];
    await cpuTake();
    try {
        if (s.asset.kind === 'video') {
            await ffA(['-stream_loop', '-1', '-i', s.asset.file, '-t', d.toFixed(3), '-an',
                '-vf', `scale=1920:1080:force_original_aspect_ratio=increase,crop=1920:1080,fps=${FPS},setsar=1,${GRADE}`, ...enc, out]);
        } else {
            const [z, x, y] = MOVES[i % MOVES.length].map((e) => e.replace(/FR/g, String(frames)));
            // 2560 px is enough headroom for a slow 10% move to stay smooth
            await ffA(['-i', s.asset.file, '-frames:v', String(frames),
                '-vf', `scale=2560:1440:force_original_aspect_ratio=increase,crop=2560:1440,zoompan=z='${z}':x='${x}':y='${y}':d=${frames}:s=1920x1080:fps=${FPS},setsar=1,${GRADE}`,
                ...enc, out]);
        }
    } finally { cpuGive(); }
    clips[i] = { file: out, d: s.end - s.start, last: i === scenes.length - 1 };
    clipDone++;
}

const aiLimit = opt['no-ai-images'] ? 0 : Math.ceil(scenes.length * 0.2);
let aiUsed = 0, sceneDone = 0;
// Scenes are independent (search → look → download), so several run at once; the shared
// `used` set is marked at pick time so two scenes rarely grab the same asset.
async function fillScene(idx, scene) {
    scene.idx = idx;
    let dur = 0;
    for (let i = scene.from; i <= scene.to; i++) dur += estDur(i);
    // Every query and source at once (was: query by query, a look after each), then ONE
    // look at the best candidates of all of them
    // Two queries; footage only where motion matters (each search hits Pixabay, ~100/min)
    const [q1, q2 = q1] = scene.queries.length ? scene.queries : [scene.visual];
    const jobs = scene.kind === 'video' ? [[q1, 'video'], [q1, 'photo'], [q2, 'video']] : [[q1, 'photo'], [q2, 'photo']];
    const lists = await Promise.all(jobs.map(([q, k]) => searchAll(q, k, keys)));
    const seen = new Set();
    const ok = (c) => c.thumb && !used.has(c.id) && !seen.has(c.id) && (c.kind !== 'video' || !c.duration || c.duration >= Math.min(dur, 6));
    // Interleave: the specific query's top results first, footage first when motion matters
    const cands = [];
    for (let r = 0; r < 4; r++) {
        for (const l of lists) {
            const sorted = scene.kind === 'video' ? [...l].sort((a, b) => (b.kind === 'video') - (a.kind === 'video')) : l;
            const c = sorted.filter(ok)[0];
            if (c) { seen.add(c.id); cands.push(c); }
        }
    }
    let pick = null;
    if (cands.length) pick = await choose(scene, cands.slice(0, 10)).catch((e) => { log(`  подбор: ${e.message}`); return null; });
    const file = join(WORK, `asset-${String(idx).padStart(4, '0')}`);
    if (pick?.id) used.add(pick.id);   // claim it now, before the slow download
    if ((!pick || pick.score < 5) && aiUsed < aiLimit) {
        aiUsed++;
        if (await aiPicture(scene, `${file}.png`).catch(() => false)) {
            scene.asset = { kind: 'photo', file: `${file}.png`, source: 'AI (Gemini)', author: '', page: '', license: 'генерирано изображение' };
        } else { aiUsed--; }
    }
    if (!scene.asset && pick?.id) {
        const ext = pick.kind === 'video' ? '.mp4' : '.jpg';
        const r = await fetch(pick.url, { headers: { 'User-Agent': 'Razkazvach-video/1.0' } }).catch(() => null);
        if (r?.ok) { writeFileSync(file + ext, Buffer.from(await r.arrayBuffer())); scene.asset = { ...pick, file: file + ext }; }
    }
    log(`Сцена ${++sceneDone}/${scenes.length} (${since()}): ${scene.asset ? `${scene.asset.source} ${scene.asset.kind}${pick?.score != null && scene.asset.source !== 'AI (Gemini)' ? ` · ${pick.score}/10` : ''}` : '— без кадър'} — ${scene.visual.slice(0, 60)}`);
    // The shot is encoded as soon as the voice says when it starts and ends
    if (scene.asset) await renderClip(idx);
}
{
    let next = 0;
    await Promise.all(Array.from({ length: 10 }, async () => { while (next < scenes.length) { const i = next++; await fillScene(i, scenes[i]); } }));
}
// A scene with nothing at all keeps the previous shot on screen a little longer
for (let i = 0; i < scenes.length; i++) {
    if (scenes[i].asset) continue;
    const j = i > 0 ? i - 1 : scenes.findIndex((s) => s.asset);
    if (j < 0) throw new Error('Не намерих нито един кадър — проверете ключовете и мрежата.');
    scenes[i].asset = { ...scenes[j].asset, repeat: true };
    await renderClip(i);
}
await voiceReady;
writeFileSync(join(OUT, 'scenes.json'), JSON.stringify(scenes.map(({ asset, ...s }) => ({ ...s, asset: asset && { source: asset.source, kind: asset.kind, page: asset.page, author: asset.author, license: asset.license, score: asset.score, why: asset.why } })), null, 2));

// Cross-fade the shots of each group (the groups encode at once, one per core), then join
// the groups without re-encoding.
log('Сглобявам…');
const groups = [];
for (let i = 0; i < clips.length; i += GROUP) groups.push(clips.slice(i, i + GROUP));
const groupFiles = new Array(groups.length);
await pool([...groups.entries()], cpu, async ([gi, g]) => {
    const out = join(WORK, `group-${String(gi).padStart(3, '0')}.mp4`);
    const final = ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '22', '-pix_fmt', 'yuv420p', '-r', String(FPS)];
    if (g.length === 1) { await ffA(['-i', g[0].file, ...final, out]); groupFiles[gi] = out; return; }
    let filter = g.map((_, k) => `[${k}:v]settb=AVTB,fps=${FPS},format=yuv420p[i${k}];`).join('');
    let prev = '[i0]', off = 0;
    for (let k = 1; k < g.length; k++) {
        off += g[k - 1].d;
        const outLabel = k === g.length - 1 ? '[v]' : `[x${k}]`;
        filter += `${prev}[i${k}]xfade=transition=fade:duration=${T}:offset=${off.toFixed(3)}${outLabel};`;
        prev = `[x${k}]`;
    }
    await ffA([...g.flatMap((c) => ['-i', c.file]), '-filter_complex', filter.replace(/;$/, ''), '-map', '[v]', ...final, out]);
    groupFiles[gi] = out;
});
const listFile = join(WORK, 'groups.txt');
writeFileSync(listFile, groupFiles.map((f) => `file '${f.replace(/'/g, "'\\''")}'`).join('\n') + '\n');
const picture = { file: join(WORK, 'picture.mp4') };
ff(['-f', 'concat', '-safe', '0', '-i', listFile, '-c', 'copy', picture.file]);

// Captions (SRT) from the sentence times
const ts = (t) => {
    const ms = Math.round(t * 1000), h = Math.floor(ms / 3600000), m = Math.floor(ms / 60000) % 60, s = Math.floor(ms / 1000) % 60;
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')},${String(ms % 1000).padStart(3, '0')}`;
};
const srt = sentences.map((s, i) => `${i + 1}\n${ts(s.start)} --> ${ts(Math.max(s.start + 0.5, sentEnd(i) - 0.05))}\n${s.text}\n`).join('\n');
writeFileSync(join(OUT, 'captions.srt'), srt);

const video = join(OUT, 'video.mp4');
const sub = opt['burn-subtitles'] ? ['-vf', `subtitles=${join(OUT, 'captions.srt').replace(/[:\\']/g, '\\$&')}:force_style='FontSize=20,Outline=1,MarginV=40'`] : [];
ff(['-i', picture.file, '-i', join(WORK, 'voice.wav'), '-map', '0:v', '-map', '1:a', ...(sub.length ? sub : ['-c:v', 'copy']),
    ...(sub.length ? ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p'] : []),
    '-c:a', 'aac', '-b:a', '128k', '-ac', '1', '-ar', '48000', '-shortest', '-movflags', '+faststart',
    '-metadata', `title=${title}`, '-metadata', 'comment=Озвучено и илюстрирано с изкуствен интелект — Разказвач', video]);

// Description with the credits (Pexels asks for a link; Wikimedia/Openverse licences name the author)
const credits = new Map();
for (const s of scenes) {
    const a = s.asset;
    if (!a || a.repeat) continue;
    const k = a.page || `${a.source}-${s.idx}`;
    if (!credits.has(k)) credits.set(k, `${a.source}${a.author ? ` — ${a.author}` : ''}${a.license ? ` (${a.license})` : ''}${a.page ? `: ${a.page}` : ''}`);
}
const intro = paras.find((p) => p.length > 120) || paras[0];
const desc = `${title}\n\n${intro.slice(0, 400)}${intro.length > 400 ? '…' : ''}\n\nОзвучено с изкуствен интелект (Gemini), илюстрирано със свободни кадри${aiUsed ? ' и няколко AI изображения' : ''}.\n\nКадри:\n${[...credits.values()].map((c) => `• ${c}`).join('\n')}\n`;
writeFileSync(join(OUT, 'description.txt'), desc);
if (!opt.keep) rmSync(WORK, { recursive: true, force: true });
log(`Готово: ${video} (${(statSync(video).size / 1048576).toFixed(1)} MB, ${(total / 60).toFixed(1)} мин, ${scenes.length} сцени, ${aiUsed} AI картини)`);

if (opt.upload) {
    const API = (process.env.LIBRARY_API || readFileSync(new URL('../../js/config.js', import.meta.url), 'utf8').match(/LIBRARY_API\s*=\s*'([^']+)'/)?.[1] || '').replace(/\/$/, '');
    const body = readFileSync(video);
    const r = await fetch(`${API}/files?name=${encodeURIComponent(`${slug(title)}.mp4`)}`, {
        method: 'PUT', headers: { 'X-Rz-Key': KEY, 'Content-Type': 'video/mp4', 'Content-Length': String(body.length) }, body,
    });
    const d = await r.json().catch(() => ({}));
    if (r.ok) { log(`Линк: ${d.url}`); writeFileSync(join(OUT, 'link.txt'), d.url + '\n'); } else log(`Качването не успя: ${d.error || r.status}`);
}
