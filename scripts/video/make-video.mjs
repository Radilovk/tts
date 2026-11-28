#!/usr/bin/env node
// Text → narrated documentary video with pictures and footage that fit each sentence.
//
//   node scripts/video/make-video.mjs текст.txt                 → out/<заглавие>/video.mp4 (+ captions.srt, description.txt)
//   node scripts/video/make-video.mjs --topic "Защо мозъкът предсказва"   (Gemini пише по сценария)
//   --max-chars 4000   прототип: само началото (~3–5 мин)        --voice Enceladus --style clear
//   --burn-subtitles   субтитри в картината
//   --upload           качва MP4 и дава линк (worker /files)
//
// Keys (environment / GitHub secrets): GEMINI_API_KEY (voice, scenes, choosing the shots);
// PIXABAY_API_KEY and PEXELS_API_KEY are optional — without them Wikimedia Commons and NASA
// (footage and photos) and Openverse (photos) are searched, no key. ffmpeg/ffprobe must be installed.
// No generated (AI) pictures, ever: every shot is real footage or a real photograph.
//
// How a scene gets its picture (the difference from keyword compilations):
//   1. the narration is made first; every sentence's start is found in the audio (js/align.js);
//   2. Gemini (scenes) reads the whole text and cuts it into scenes of ~5–10 s; for each it
//      says what should be SEEN — in MOTION, abstract ideas turned into concrete filmable
//      actions — and gives English search terms (stock libraries are tagged in English);
//   3. footage is searched first in every source; Gemini (look) LOOKS at the frames next to the
//      sentence and picks the one that fits, or none; nothing is used twice. A photo is searched
//      only when no clip fits (or the subject has no motion: a historical portrait, a painting);
//   4. when nothing fits at all, the previous shot stays a little longer;
//   5. footage: the best part — from the middle, never the first frames, never looped (a clip a
//      bit short is slowed down instead); photos move slowly (Ken Burns); shots cross-fade and the
//      cut falls exactly where the narrator starts the sentence.

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
if (!opt['no-review']) {
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
// Each block is narrated independently (several at once); the sentence times inside a block
// come from its own audio, then the blocks are stitched in order.
const parts = new Array(blocks.length);
let voiceDone = 0;
await pool(blocks, 3, async (block, b) => {
    const res = await narrateBlocks([block], {
        engine: 'gemini', voice: gemini.voice, voiceKey: Object.values(gemini).join('|'), gemini, apiKey: KEY,
        freeKey: process.env.GEMINI_FREE_KEY || '', cache, concurrency: 1, onIssue: (m) => log(`\n  ⚠ ${m}`),
    });
    const ss = block.split('\n').flatMap((p) => splitSentences(p, 'bg', 450)).filter((s) => /\p{L}/u.test(s));
    const step = Math.round(RATE / 8000);
    const f = new Float32Array(Math.floor(res.pcm.length / step));
    for (let i = 0; i < f.length; i++) f[i] = res.pcm[i * step] / 32768;
    const marks = alignSentences(ss.map((s) => s.length), findPauses(f));
    parts[b] = { pcm: res.pcm, marks: ss.map((s, i) => ({ text: s, local: marks[i] ?? 0 })) };
    process.stdout.write(`\rГлас: ${++voiceDone} от ${blocks.length} части   `);
});
const sentences = [];
const audio = [];
let offset = 0;
for (const part of parts) {
    for (const m of part.marks) sentences.push({ text: m.text, start: offset + m.local });
    audio.push(part.pcm);
    offset += part.pcm.length / RATE;
}
const total = offset;
const pcm = new Int16Array(audio.reduce((a, p) => a + p.length, 0));
{ let o = 0; for (const p of audio) { pcm.set(p, o); o += p.length; } }
writeFileSync(join(WORK, 'voice.wav'), Buffer.from(await pcmToWav(pcm, RATE).arrayBuffer()));
sentences[0].start = 0;
process.stdout.write('\n');
log(`Глас: ${(total / 60).toFixed(1)} мин, ${sentences.length} изречения`);

// ---------- 3. scenes: what each one shows ----------
const sentEnd = (i) => (i + 1 < sentences.length ? sentences[i + 1].start : total);
const SCENE_SYSTEM = `You are a documentary film editor and footage researcher. You cut a narrated Bulgarian documentary (social sciences, history, biology, medicine, philosophy, psychology, mathematics, physics) into shots and decide what each shot shows, so that the picture always matches the MEANING of what the narrator is saying at that moment. The film is made of real VIDEO CLIPS from stock and archive libraries; still photos are the exception.
Rules:
- Every sentence belongs to exactly one scene; scenes are consecutive and cover all sentences given.
- A scene lasts about 5–10 seconds (use the durations); one long sentence may be one scene; never more than ~12 s.
- "visual": what is SEEN MOVING, concrete and filmable (subject, action, setting). Turn abstract ideas into concrete actions a footage library has ("the brain predicts" → "neurons firing"; "memory fades" → "footprints washed away by a wave"; "society changes" → "crowd crossing a city street"). Real named things (a scientist, an event, a place, an instrument, an organ) are shown as themselves.
- "queries": 3 English search terms for FOOTAGE: subject + action, 1–3 words, as a video library tags them ("neurons firing", "cells dividing", "heart beating", "pendulum swinging", "soldiers marching", "chalk writing equations", "crowd walking"). NO camera or style words ("slow-motion", "shot", "tracking", "close-up", "macro", "cinematic", "aerial", "footage", "4k"), NO sentences, NO single abstract nouns ("brain", "science"). Order: most specific; an alternative; a broad but still moving fallback in the same field ("microscope cells", "laboratory scientist", "city crowd").
- What the fields look like in footage libraries:
  history — archival film and newsreels (Wikimedia Commons has many: "ww1 soldiers trench", "1930s newsreel crowd", "steam locomotive"), ruins and castles, old towns, museum artifacts, maps; name the era and place.
  biology — microscopy ("cells dividing", "bacteria moving", "blood cells flowing"), animals behaving, plants growing, DNA, ecosystems.
  medicine — "surgery operating room", "doctor examining patient", "heart ultrasound", "mri scan", "pills production", "hospital corridor", "vaccine injection".
  psychology — people's behaviour and emotion: "friends talking", "child playing", "person alone window", "crowd walking", "brain scan".
  social sciences — "city street crowd", "market trading", "factory workers", "protest march", "farmers field", "parliament session".
  philosophy — "ancient greek statue", "temple columns", "library books", "candle flame", "starry sky night", "person walking alone road", "chess game".
  mathematics — "chalk writing equations", "geometric pattern", "spiral shell", "fractal", "honeycomb bees", "abacus counting", "clock gears".
  physics — "pendulum swinging", "laser beam", "lightning storm", "iron filings magnet", "water waves", "galaxy rotating", "particle accelerator", "rocket launch" (NASA has space, Earth and physics footage).
- "kind": "video" by default. "photo" ONLY for a subject that has no motion and exists only as a still: a historical portrait of a named person, a painting, a manuscript, an old map or engraving.
- Keep a visual thread: a recurring subject looks consistent; avoid faces in close-up unless the text is about a person.
Return only JSON: {"scenes":[{"from":0,"to":2,"visual":"…","queries":["neurons firing","brain cells signals","microscope cells"],"kind":"video"}]}`;

// Strip camera / style words a model sometimes still slips into a query, and keep the noun
const CAMERA = /\b(ultra|extreme|slow[- ]?motion|slow|motion|time[- ]?lapse|timelapse|high[- ]?speed|tracking|handheld|steadicam|dolly|pan(ning)?|zoom|aerial|drone|overhead|top[- ]?down|close[- ]?up|macro|wide|medium|establishing|cinematic|editorial|archival|footage|b[- ]?roll|4k|8k|hd|shot|clip|view|animation|visualization|visualisation|render|3d|still|photograph|photo|portrait|side|front|rear|dark|bright|minimalist|sudden|intense)\b/gi;
function cleanQuery(q) {
    let s = String(q || '').toLowerCase().replace(/\bshot of\b/gi, ' ').replace(CAMERA, ' ').replace(/\bof\b|\bthe\b|\ba\b|\ban\b|\bwith\b|\binto\b/gi, ' ').replace(/[^\p{L}\p{N} ]+/gu, ' ').replace(/\s+/g, ' ').trim();
    return s.split(' ').slice(0, 4).join(' ');
}

async function planScenes(first, last) {
    const lines = [];
    for (let i = first; i <= last; i++) lines.push(`${i}. [${(sentEnd(i) - sentences[i].start).toFixed(1)} s] ${sentences[i].text}`);
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
        out.push({ ...s, from, to, queries, kind: s.kind === 'photo' ? 'photo' : 'video' });
        next = to + 1;
        if (next > last) break;
    }
    if (next <= last) {
        const prev = out[out.length - 1];
        if (prev) prev.to = last; else out.push({ from: first, to: last, visual: title, queries: [title], kind: 'video' });
    }
    return out;
}

const scenes = [];
for (let i = 0; i < sentences.length; i += 80) {
    log(`Сцени за изречения ${i + 1}–${Math.min(sentences.length, i + 80)}…`);
    scenes.push(...await planScenes(i, Math.min(sentences.length - 1, i + 79)));
}
for (const s of scenes) {
    s.start = sentences[s.from].start;
    s.end = sentEnd(s.to);
    s.text = sentences.slice(s.from, s.to + 1).map((x) => x.text).join(' ');
}
log(`${scenes.length} сцени (средно ${(total / scenes.length).toFixed(1)} с)`);

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

const LOOK_SYSTEM = `You choose the shot for one moment of a documentary. You see what the narrator says, what the editor wants to show, and numbered candidates (for a video clip: one frame from it). Pick the candidate that best matches the MEANING of the sentence and the intended visual — as a viewer would feel it fits; archival black-and-white film is welcome for history. Reject candidates with visible text, subtitles, logos, watermarks, collages, cartoons or cheap-looking illustrations, title cards, or anything unrelated. Score honestly: 7+ clearly fits, 5–6 fits the idea, below 5 is a stretch. Return only JSON: {"best": <candidate number or 0 if none fits>, "score": <0-10 how well it fits>, "why": "<short>"}`;

async function choose(scene, cands) {
    const parts = [{ text: `Narration (Bulgarian): "${scene.text}"\nIntended visual: ${scene.visual}\nPreferred: ${scene.kind}.` }];
    const shown = [];
    for (const c of cands) {
        const t = await thumb64(c.thumb);
        if (!t) continue;
        shown.push(c);
        parts.push({ text: `Candidate ${shown.length} (${c.kind}${c.duration ? `, ${c.duration} s` : ''}):` }, { inline_data: { mime_type: t.mime, data: t.data } });
        if (shown.length >= 8) break;
    }
    if (!shown.length) return null;
    const r = await generate({ apiKey: KEY, task: 'look', system: LOOK_SYSTEM, parts, json: true, maxTokens: 4096, what: `кадър ${scene.idx + 1}` });
    const j = parseJson(r.text);
    const c = shown[(Number(j.best) || 0) - 1];
    return c ? { ...c, score: Number(j.score) || 0, why: j.why || '' } : { score: 0 };
}

// Download a chosen asset to disk (streamed; footage can be tens of MB)
const MAX_BYTES = 400e6;
async function download(c, file, need) {
    const url = c.url || (c.resolve ? await c.resolve().catch(() => '') : '');
    if (!url) return false;
    // A long film (archival reels run up to an hour): only the piece from its middle is fetched
    // (ffmpeg seeks over HTTP), with a margin for the trim and the slow-down later
    if (c.kind === 'video' && c.duration > 120) {
        const len = need + 4;
        await ffA(['-user_agent', 'Razkazvach-video/1.0 (https://github.com/Radilovk/tts)', '-ss', (c.duration * 0.45).toFixed(1), '-i', url,
            '-t', len.toFixed(1), '-an', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-f', 'mp4', file]);
        return statSync(file).size > 10000;
    }
    const r = await fetch(url, { headers: { 'User-Agent': 'Razkazvach-video/1.0 (https://github.com/Radilovk/tts)' } }).catch(() => null);
    if (!r?.ok || Number(r.headers.get('content-length') || 0) > MAX_BYTES) { r?.body?.cancel?.(); return false; }
    const { createWriteStream } = await import('node:fs');
    const { Readable } = await import('node:stream');
    const { pipeline } = await import('node:stream/promises');
    await pipeline(Readable.fromWeb(r.body), createWriteStream(file));
    return statSync(file).size > 10000;
}

// Footage is accepted at this score; a photo is looked for only below it
const VIDEO_OK = 5;
let sceneDone = 0, photoScenes = 0;
// Look through the queries for one kind; stop early on a clear fit
async function best(scene, kind, seen) {
    const dur = scene.end - scene.start;
    let pick = null;
    for (const q of scene.queries.length ? scene.queries : [scene.visual]) {
        const found = await searchAll(q, kind, keys, log);
        // a clip may be slowed down at most 1.6× and its first second is skipped
        const cands = found.filter((c) => !used.has(c.id) && !seen.has(c.id) && (kind !== 'video' || !c.duration || c.duration >= dur / 1.6 + 1));
        cands.forEach((c) => seen.add(c.id));
        if (!cands.length) continue;
        const r = await choose(scene, cands.slice(0, 8)).catch((e) => { log(`  подбор: ${e.message}`); return null; });
        if (r?.id && (!pick || r.score > pick.score)) pick = r;
        if (pick && pick.score >= 7) break;
    }
    return pick;
}
// Scenes are independent (search → look → download), so several run at once; the shared
// `used` set is marked at pick time so two scenes rarely grab the same asset.
async function fillScene(idx, scene) {
    scene.idx = idx;
    const dur = scene.end - scene.start;
    const seen = new Set();
    const order = scene.kind === 'photo' ? ['photo', 'video'] : ['video', 'photo'];
    const picks = [];
    for (const kind of order) {
        const p = await best(scene, kind, seen);
        if (p) picks.push(p);
        if (p && p.score >= VIDEO_OK) break;
    }
    // the first kind that fits; otherwise the better of the two, if it is not a stretch
    const ranked = picks.filter((p) => p.score >= VIDEO_OK).concat(picks.filter((p) => p.score < VIDEO_OK && p.score >= 3).sort((a, b) => b.score - a.score));
    const file = join(WORK, `asset-${String(idx).padStart(4, '0')}`);
    for (const pick of ranked) {
        if (used.has(pick.id)) continue;
        used.add(pick.id);   // claim it now, before the slow download
        const f = file + (pick.kind === 'video' ? '.vid' : '.img');
        if (await download(pick, f, dur).catch(() => false)) { scene.asset = { ...pick, file: f }; break; }
    }
    if (scene.asset?.kind === 'photo') photoScenes++;
    const a = scene.asset;
    log(`Сцена ${++sceneDone}/${scenes.length} (${dur.toFixed(1)} с): ${a ? `${a.source} ${a.kind === 'video' ? 'клип' : 'снимка'} · ${a.score}/10` : '— без кадър (остава предишният)'} — ${scene.visual.slice(0, 70)}`);
}
{
    let next = 0;
    await Promise.all(Array.from({ length: 4 }, async () => { while (next < scenes.length) { const i = next++; await fillScene(i, scenes[i]); } }));
}
// A scene with nothing at all keeps the previous shot on screen a little longer
// (the scene is merged into its neighbour, so the same clip is never shown twice)
if (!scenes.some((s) => s.asset)) throw new Error('Не намерих нито един кадър — проверете ключовете и мрежата.');
for (let i = 0; i < scenes.length; i++) {
    if (scenes[i].asset) continue;
    const j = i > 0 ? i - 1 : i + 1;
    const [lo, hi] = j < i ? [scenes[j], scenes[i]] : [scenes[i], scenes[j]];
    scenes[j] = { ...scenes[j], from: lo.from, to: hi.to, start: lo.start, end: hi.end, text: `${lo.text} ${hi.text}` };
    scenes.splice(i, 1);
    i = Math.max(-1, Math.min(i, j) - 1);
}
writeFileSync(join(OUT, 'scenes.json'), JSON.stringify(scenes.map(({ asset, ...s }) => ({ ...s, asset: asset && { source: asset.source, kind: asset.kind, page: asset.page, author: asset.author, license: asset.license, score: asset.score, why: asset.why } })), null, 2));

// ---------- 5. shots, cross-fades, sound ----------
const MOVES = [
    ["1+0.10*on/FR", "iw/2-(iw/zoom/2)", "ih/2-(ih/zoom/2)"],          // slow push in
    ["1.10-0.10*on/FR", "iw/2-(iw/zoom/2)", "ih/2-(ih/zoom/2)"],       // slow pull out
    ["1.10", "(iw-iw/zoom)*on/FR", "ih/2-(ih/zoom/2)"],                // pan left → right
    ["1.10", "(iw-iw/zoom)*(1-on/FR)", "ih/2-(ih/zoom/2)"],            // pan right → left
];
const GRADE = 'eq=contrast=1.03:saturation=0.96';
// Black bars baked into the picture (4:3 archival film in a 16:9 file, letterboxed scans):
// found on a couple of seconds of the part that is used, then cropped away before filling the frame
function detectCrop(file, start) {
    const r = spawnSync('ffmpeg', ['-hide_banner', '-ss', start.toFixed(2), '-i', file, '-t', '2', '-vf', 'cropdetect=limit=24:round=2:reset=0', '-an', '-f', 'null', '-'], { encoding: 'utf8' });
    const m = [...String(r.stderr).matchAll(/crop=(\d+):(\d+):(\d+):(\d+)/g)].pop();
    const v = spawnSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', file], { encoding: 'utf8' }).stdout.trim().split(',').map(Number);
    if (!m || !v[0]) return '';
    const [w, h] = [Number(m[1]), Number(m[2])];
    // only real bars: something removed, but most of the picture kept
    if (w * h > v[0] * v[1] * 0.96 || w < v[0] * 0.5 || h < v[1] * 0.5) return '';
    return `crop=${m[1]}:${m[2]}:${m[3]}:${m[4]},`;
}
function probeDuration(file) {
    const r = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file], { encoding: 'utf8' });
    return Number.parseFloat(r.stdout) || 0;
}
const clips = new Array(scenes.length);
let clipDone = 0;
await pool([...scenes.entries()], cpu, async ([i, s]) => {
    const d = (s.end - s.start) + (i < scenes.length - 1 ? T : 0.3);   // overlap for the cross-fade; the last one a bit longer than the voice
    const frames = Math.max(2, Math.round(d * FPS));
    const out = join(WORK, `clip-${String(i).padStart(4, '0')}.mp4`);
    const enc = ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p', '-r', String(FPS)];
    if (s.asset.kind === 'video') {
        // The best part: the middle of the clip, past the first second (openings are often a
        // fade-in, a title or a shaky start). Never looped: a clip that is too short is slowed down.
        const D = probeDuration(s.asset.file) || s.asset.duration || d;
        const skip = Math.min(1.5, D * 0.1);
        const avail = Math.max(0.5, D - 2 * skip);
        const slow = avail >= d ? 1 : Math.min(1.6, d / avail);
        const start = avail * slow >= d ? skip + (avail - d / slow) / 2 : skip;
        const bars = detectCrop(s.asset.file, start);
        await ffA(['-ss', start.toFixed(3), '-i', s.asset.file, '-t', d.toFixed(3), '-an',
            '-vf', `${bars}${slow > 1 ? `setpts=${slow.toFixed(3)}*PTS,` : ''}scale=1920:1080:force_original_aspect_ratio=increase,crop=1920:1080,fps=${FPS},setsar=1,${GRADE},tpad=stop_mode=clone:stop_duration=${d.toFixed(3)}`,
            '-frames:v', String(frames), ...enc, out]);
    } else {
        const [z, x, y] = MOVES[i % MOVES.length].map((e) => e.replace(/FR/g, String(frames)));
        await ffA(['-i', s.asset.file, '-frames:v', String(frames),
            '-vf', `scale=3840:2160:force_original_aspect_ratio=increase,crop=3840:2160,zoompan=z='${z}':x='${x}':y='${y}':d=${frames}:s=1920x1080:fps=${FPS},setsar=1,${GRADE}`,
            ...enc, out]);
    }
    clips[i] = { file: out, d: s.end - s.start, last: i === scenes.length - 1 };
    process.stdout.write(`\rКадри: ${++clipDone} от ${scenes.length}   `);
});
process.stdout.write('\n');

// Cross-fade a list of clips (each one T longer than its part, except the very last) into
// one; groups of 12, then the groups the same way — any number of shots.
let joinN = 0;
function crossfade(list) {
    if (list.length === 1) return list[0];
    const groups = [];
    for (let i = 0; i < list.length; i += 12) groups.push(list.slice(i, i + 12));
    const merged = groups.map((g) => {
        if (g.length === 1) return g[0];
        const inputs = g.flatMap((c) => ['-i', c.file]);
        // xfade needs the same time base and frame rate on both sides
        let filter = g.map((_, k) => `[${k}:v]settb=AVTB,fps=${FPS},format=yuv420p[i${k}];`).join('');
        let prev = '[i0]', off = 0;
        for (let k = 1; k < g.length; k++) {
            off += g[k - 1].d;
            const outLabel = k === g.length - 1 ? '[v]' : `[x${k}]`;
            filter += `${prev}[i${k}]xfade=transition=fade:duration=${T}:offset=${off.toFixed(3)}${outLabel};`;
            prev = `[x${k}]`;
        }
        const out = join(WORK, `join-${joinN++}.mp4`);
        ff([...inputs, '-filter_complex', filter.replace(/;$/, ''), '-map', '[v]', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p', out]);
        return { file: out, d: g.reduce((a, c) => a + c.d, 0), last: g[g.length - 1].last };
    });
    return crossfade(merged);
}
log('Сглобявам…');
const picture = crossfade(clips);

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
const desc = `${title}\n\n${intro.slice(0, 400)}${intro.length > 400 ? '…' : ''}\n\nОзвучено с изкуствен интелект (Gemini), илюстрирано със свободни видеокадри и архивни материали.\n\nКадри:\n${[...credits.values()].map((c) => `• ${c}`).join('\n')}\n`;
writeFileSync(join(OUT, 'description.txt'), desc);
if (!opt.keep) rmSync(WORK, { recursive: true, force: true });
log(`Готово: ${video} (${(statSync(video).size / 1048576).toFixed(1)} MB, ${(total / 60).toFixed(1)} мин, ${scenes.length} сцени, ${scenes.filter((x) => x.asset.kind === 'video').length} клипа, ${photoScenes} снимки)`);

if (opt.upload) {
    const API = (process.env.LIBRARY_API || readFileSync(new URL('../../js/config.js', import.meta.url), 'utf8').match(/LIBRARY_API\s*=\s*'([^']+)'/)?.[1] || '').replace(/\/$/, '');
    const body = readFileSync(video);
    const r = await fetch(`${API}/files?name=${encodeURIComponent(`${slug(title)}.mp4`)}`, {
        method: 'PUT', headers: { 'X-Rz-Key': KEY, 'Content-Type': 'video/mp4', 'Content-Length': String(body.length) }, body,
    });
    const d = await r.json().catch(() => ({}));
    if (r.ok) { log(`Линк: ${d.url}`); writeFileSync(join(OUT, 'link.txt'), d.url + '\n'); } else log(`Качването не успя: ${d.error || r.status}`);
}
