#!/usr/bin/env node
// Long text → one audio file, from the command line (the same engine as the app's
// "Текст → аудио файл": js/narrate.js).
//
//   node scripts/narrate.mjs статия.txt                       → статия.mp3 (Gemini разказвач, Enceladus)
//   node scripts/narrate.mjs статия.txt --voice Iapetus --style warm   (стил: intriguing, warm, dramatic, clear)
//   node scripts/narrate.mjs статия.txt --voice Kore --out статия.m4a
//   node scripts/narrate.mjs статия.txt --engine azure --voice Kalina
//   node scripts/narrate.mjs статия.txt --video корица.jpg     → статия.mp4 (за YouTube)
//   node scripts/narrate.mjs статия.txt --upload               → + линк за споделяне (worker /files)
//   node scripts/narrate.mjs статия.txt --dry-run              → само план: блокове, знаци, цена
//   node scripts/narrate.mjs --topic "Защо мозъкът предсказва" → Gemini пише по сценария, после аудио
//   node scripts/narrate.mjs материал.txt --rewrite            → преразказ по сценария, после аудио
//     + --text-only (само текстът), --writer pro, --scenario мой-сценарий.txt
//   Всеки текст минава преглед и редакция за глас (Gemini; съкращения, скоби, символи,
//   дълги изречения), ако има GEMINI_API_KEY; --no-review го спира. Редактираният текст
//   се записва до аудиото (… (за глас).txt).
//
// Keys (environment): GOOGLE_TTS_KEY (or GEMINI_API_KEY) for Google; AZURE_SPEECH_KEY and
// AZURE_SPEECH_REGION (default westeurope) for Microsoft.
// Google never leaves the free 1M characters a month unless --allow-paid: the month's
// count is the worker's /usage total for the key (shared with the app on every device),
// and the run stops at 90 % before the first billed character.
// Finished blocks are kept in .narrate-cache/ — a stopped run continues for free.
// Formats by --out extension: .mp3 .m4a .ogg .wav .mp4 (ffmpeg needed except for .wav).

import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync, rmSync, mkdtempSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname, basename, extname, resolve } from 'node:path';

// The browser modules run in Node with two small stand-ins
globalThis.window ??= globalThis;
if (!globalThis.localStorage) {
    const m = new Map();
    globalThis.localStorage = { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) };
}

const { prepareLongText, planBlocks, narrateBlocks, billedChars, CHIRP_VOICES, AZURE_VOICES, GOOGLE_MAX_BYTES, AZURE_MAX_BYTES, geminiMaxBytes, RATE } = await import('../js/narrate.js');
const { pcmToWav, PRICES, GEMINI_DEFAULT_MODEL, geminiCost } = await import('../js/engines.js');
const { detectLang } = await import('../js/text.js');

function args(argv) {
    const o = { _: [] };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (!a.startsWith('--')) { o._.push(a); continue; }
        const [k, v] = a.slice(2).split('=');
        if (v !== undefined) o[k] = v;
        else if (argv[i + 1] && !argv[i + 1].startsWith('--') && !['dry-run', 'upload', 'allow-paid', 'help', 'rewrite', 'text-only', 'no-search', 'no-review'].includes(k)) o[k] = argv[++i];
        else o[k] = true;
    }
    return o;
}

const opt = args(process.argv.slice(2));
if (opt.help || (!opt._[0] && !opt.topic)) {
    console.log(readFileSync(new URL(import.meta.url), 'utf8').split("\n").slice(1, 26).map((l) => l.replace(/^\/\/ ?/, '')).join('\n'));
    process.exit(opt.help ? 0 : 1);
}

const slug = (t) => String(t).replace(/[\\/:*?"<>|\n\r]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60) || 'разказ';
let input = opt._[0] ? resolve(opt._[0]) : resolve(slug(opt.topic) + '.txt');
const engine = ['azure', 'google'].includes(opt.engine) ? opt.engine : 'gemini';   // google = Chirp 3 HD
const pickVoice = () => {
    const v = String(opt.voice || (engine === 'azure' ? 'bg-BG-KalinaNeural' : engine === 'gemini' ? 'Enceladus' : 'Charon'));
    if (engine === 'gemini') return v.replace(/^bg-BG-Chirp3-HD-/, '');
    const list = engine === 'azure' ? AZURE_VOICES : CHIRP_VOICES;
    const hit = list.find((x) => x.name.toLowerCase() === v.toLowerCase() || x.label.toLowerCase() === v.toLowerCase()
        || x.name.toLowerCase().includes(v.toLowerCase()));
    return hit ? hit.name : v;
};
const voice = pickVoice();
const video = opt.video ? resolve(String(opt.video)) : '';
const outFor = (inp) => resolve(opt.out || join(dirname(inp), basename(inp, extname(inp)) + (video || opt.video ? '.mp4' : '.mp3')));
let title = String(opt.title || basename(input, extname(input)));
const API = (process.env.LIBRARY_API || readFileSync(new URL('../js/config.js', import.meta.url), 'utf8')
    .match(/LIBRARY_API\s*=\s*'([^']+)'/)?.[1] || '').replace(/\/$/, '');

const googleKey = process.env.GOOGLE_TTS_KEY || process.env.GEMINI_API_KEY || '';
const azureKey = process.env.AZURE_SPEECH_KEY || '';
const region = process.env.AZURE_SPEECH_REGION || 'westeurope';
const accountKey = engine === 'azure' ? azureKey : engine === 'gemini' ? (process.env.GEMINI_API_KEY || googleKey) : googleKey;
const gemini = { model: opt.model || GEMINI_DEFAULT_MODEL, voice, style: opt.style || 'clear', customStyle: opt['custom-style'] || '', lang: 'bg' };
if (opt['custom-style']) gemini.style = 'custom';

// ---- the writer: Gemini writes the narration by the scenario ----
let raw = opt.topic && !opt._[0] ? '' : readFileSync(input, 'utf8');
if (opt.topic || opt.rewrite) {
    const { writeNarration, pickWriterModel } = await import('../js/writer.js');
    const { SCENARIO } = await import('../js/scenario.js');
    const key = process.env.GEMINI_API_KEY || process.env.GOOGLE_TTS_KEY || '';
    if (!key) { console.error('Липсва GEMINI_API_KEY за писането.'); process.exit(2); }
    const model = opt.model || await pickWriterModel(key, opt.writer === 'pro' ? 'pro' : 'flash');
    console.log(`Пиша с ${model} по сценария…`);
    const w = await writeNarration({
        apiKey: key, model, mode: opt.topic ? 'topic' : 'rewrite', input: opt.topic ? String(opt.topic) : raw,
        scenario: opt.scenario ? readFileSync(resolve(String(opt.scenario)), 'utf8') : SCENARIO, search: !opt['no-search'],
        onProgress: (f, l) => l && console.log(`  ${l}`),
    });
    raw = w.text;
    if (!opt.title && w.title) title = w.title;
    const txt = join(dirname(input), slug(opt.title || w.title || basename(input, extname(input))) + (opt.rewrite ? ' (разказ)' : '') + '.txt');
    writeFileSync(txt, (w.title ? w.title + '\n\n' : '') + w.text + '\n');
    console.log(`Текст: ${txt} — ${w.text.length} знака (${w.inTokens} + ${w.outTokens} токена)`);
    input = txt;
}

// ---- review and edit for the voice ----
const gemKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_TTS_KEY || '';
if (!opt['no-review'] && !opt['dry-run'] && gemKey) {
    const { editForVoice, pickWriterModel } = await import('../js/writer.js');
    const model = opt.model || await pickWriterModel(gemKey, opt.writer === 'pro' ? 'pro' : 'flash');
    console.log(`Преглед и редакция за глас (${model})…`);
    try {
        const r = await editForVoice({ apiKey: gemKey, model, text: raw, onProgress: (f, l) => l && console.log(`  ${l}`) });
        raw = r.text;
        const txt = join(dirname(input), basename(input, extname(input)).replace(/ \(за глас\)$/, '') + ' (за глас).txt');
        writeFileSync(txt, raw + '\n');
        console.log(`Редактиран текст: ${txt}${r.kept ? ` (${r.kept} откъса без промяна)` : ''}`);
    } catch (e) {
        console.log(`  ⚠ Редакцията не успя (${e.message}) — чета текста както е.`);
    }
} else if (!opt['no-review'] && !gemKey) {
    console.log('Без редакция за глас (няма GEMINI_API_KEY) — само локалната нормализация.');
}
if (opt['text-only']) process.exit(0);

const out = outFor(input);
const paras = prepareLongText(raw);
const lang = detectLang(paras.slice(0, 20).join(' ')) || 'bg';
const maxBytes = Number(opt['max-bytes']) || (engine === 'azure' ? AZURE_MAX_BYTES : engine === 'gemini' ? geminiMaxBytes(6000) : GOOGLE_MAX_BYTES);
const blocks = planBlocks(paras, { maxBytes, lang, keepParagraphs: engine !== 'google' });
const chars = billedChars(blocks, engine === 'azure' ? 'azure' : 'google');
const minutes = chars / 14 / 60;
const sizes = blocks.map((b) => Buffer.byteLength(b));

console.log(`Текст: ${raw.length} знака, ${paras.length} абзаца → ${blocks.length} блока (${Math.min(...sizes)}–${Math.max(...sizes)} байта, лимит ${maxBytes})`);
console.log(`Глас: ${voice} (${engine === 'azure' ? 'Microsoft' : engine === 'gemini' ? `Gemini ${gemini.model}, стил ${gemini.style}` : 'Google Chirp 3 HD'}) · ~${minutes.toFixed(0)} мин аудио · ${chars} знака за таксуване`);

// ---- the free limit (Google): the worker's month total for this key ----
const tier = 'Chirp3-HD';
const FREE = PRICES.cloud[tier].free;
const SAFE = Math.floor(FREE * 0.9);
async function usage(body) {
    if (!API || !accountKey) return null;
    try {
        const r = await fetch(`${API}/usage`, {
            method: body ? 'POST' : 'GET',
            headers: { 'X-Rz-Key': accountKey, ...(body ? { 'Content-Type': 'application/json' } : {}) },
            body: body ? JSON.stringify(body) : undefined,
        });
        return r.ok ? (await r.json()).cloud?.[tier] || 0 : null;
    } catch { return null; }
}

let used = 0;
if (engine === 'google') {
    const u = await usage();
    used = u ?? 0;
    const paid = Math.max(0, used + chars - FREE);
    console.log(`Google този месец: ${u == null ? 'неизвестно (няма връзка със сървъра)' : `${used} от ${FREE} безплатни знака`}`);
    console.log(`Цена: ${paid ? `~${(paid / 1e6 * PRICES.cloud[tier].per1M).toFixed(2)} $ (над безплатните)` : '0 $ (в безплатния лимит)'}`);
} else if (engine === 'gemini') {
    console.log(`Цена: ~${geminiCost(gemini.model, chars / 3, chars / 14 * 25).toFixed(2)} $ (половин цена през Batch е в приложението: „Най-евтино“)`);
} else {
    console.log(`Цена: 0 $ в безплатния ресурс F0 (500 000 знака/месец; над тях Azure само отказва)`);
}
if (opt['dry-run']) {
    blocks.forEach((b, i) => console.log(`\n— блок ${i + 1} (${Buffer.byteLength(b)} байта) —\n${b.slice(0, 160)}…`));
    process.exit(0);
}
if (!accountKey) {
    console.error(engine === 'azure' ? 'Липсва AZURE_SPEECH_KEY.' : engine === 'gemini' ? 'Липсва GEMINI_API_KEY.' : 'Липсва GOOGLE_TTS_KEY (или GEMINI_API_KEY).');
    process.exit(2);
}

// ---- blocks are kept on disk: a stopped run continues without paying again ----
const cacheDir = resolve(opt.cache || join(dirname(out), '.narrate-cache'));
mkdirSync(cacheDir, { recursive: true });
const cache = {
    get: async (k) => {
        const f = join(cacheDir, k + '.pcm');
        if (!existsSync(f)) return null;
        const b = readFileSync(f);
        return new Int16Array(b.buffer.slice(b.byteOffset, b.byteOffset + (b.byteLength & ~1)));
    },
    put: async (k, pcm) => writeFileSync(join(cacheDir, k + '.pcm'), Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength)),
};

let reserved = 0;
const beforeRequest = (billed) => {
    if (!opt['allow-paid'] && used + reserved + billed > SAFE) {
        throw Object.assign(new Error(`Спрях преди таксуване: безплатните знаци на Google за месеца стигат до 90 % (${used} използвани). Пуснете отново с --allow-paid или от 1-во число.`), { cloudCap: true });
    }
    reserved += billed;
    return () => { reserved -= billed; };
};
const afterRequest = (billed) => {
    used += billed;
    usage({ tier, chars: billed });
};

const t0 = Date.now();
let res;
try {
    res = await narrateBlocks(blocks, {
        engine, voice, apiKey: engine === 'gemini' ? accountKey : googleKey, gemini, voiceKey: engine === 'gemini' ? Object.values(gemini).join('|') : '',
        azureKey, region, cache, beforeRequest, afterRequest,
        concurrency: Number(opt.parallel) || (engine === 'gemini' ? 1 : 2),
        onProgress: (d, n) => process.stdout.write(`\rОзвучавам: ${d}/${n} блока`),
        onIssue: (m) => console.log(`\n  ⚠ ${m}`),
    });
} catch (e) {
    console.error(`\n${e.message}`);
    console.error('Готовите блокове са запазени — следващото пускане продължава от тук.');
    process.exit(3);
}
console.log(`\nГотово за ${((Date.now() - t0) / 1000).toFixed(0)} сек.: ${(res.dur / 60).toFixed(1)} мин аудио${res.issues.length ? `, ${res.issues.length} забележки` : ''}`);

// ---- encode ----
const wavBytes = Buffer.from(await pcmToWav(res.pcm, RATE).arrayBuffer());
const ext = extname(out).toLowerCase();
const meta = ['-metadata', `title=${title}`, '-metadata', 'comment=Озвучено с изкуствен интелект — Разказвач'];
if (opt.artist) meta.push('-metadata', `artist=${opt.artist}`);
if (ext === '.wav') writeFileSync(out, wavBytes);
else {
    const tmp = mkdtempSync(join(tmpdir(), 'narrate-'));
    const wav = join(tmp, 'a.wav');
    writeFileSync(wav, wavBytes);
    let ff;
    if (ext === '.mp4') {
        // YouTube takes video only: a still picture (or a plain dark frame) + the narration
        const pic = video && existsSync(video) ? ['-loop', '1', '-framerate', '1', '-i', video] : ['-f', 'lavfi', '-i', 'color=c=0x15181d:s=1920x1080:r=1'];
        ff = ['-y', ...pic, '-i', wav, '-map', '0:v', '-map', '1:a', '-c:v', 'libx264', '-tune', 'stillimage', '-preset', 'veryfast',
            '-vf', 'scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2,format=yuv420p', '-r', '1',
            // YouTube re-encodes the sound; its recommended upload is AAC-LC at 48 kHz, 128 kb/s mono
            '-c:a', 'aac', '-b:a', '128k', '-ac', '1', '-ar', '48000', '-shortest', '-movflags', '+faststart', ...meta, out];
    } else {
        // Speech, not music: mono and audiobook bit rates. The voice is 24 kHz mono, so nothing
        // above these adds sound. MP3 64 kb/s mono — the LibriVox / podcast standard, plays
        // everywhere (cars too); M4A (AAC-LC) 64 kb/s — Apple / Audible "high quality";
        // Ogg/Opus 32 kb/s voip — the smallest, same as the app's own file.
        const codec = {
            '.mp3': ['-c:a', 'libmp3lame', '-b:a', '64k', '-ac', '1'],
            '.m4a': ['-c:a', 'aac', '-b:a', '64k', '-ac', '1', '-movflags', '+faststart'],
            '.ogg': ['-c:a', 'libopus', '-b:a', '32k', '-application', 'voip', '-ac', '1'],
        }[ext];
        if (!codec) { console.error(`Неподдържан формат ${ext} (mp3, m4a, ogg, wav, mp4).`); process.exit(4); }
        ff = ['-y', '-i', wav, ...codec, ...meta, out];
    }
    const r = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', ...ff], { stdio: 'inherit' });
    rmSync(tmp, { recursive: true, force: true });
    if (r.status !== 0) { console.error('ffmpeg не успя (инсталиран ли е?).'); process.exit(4); }
}
console.log(`Файл: ${out} (${(statSync(out).size / 1024 / 1024).toFixed(1)} MB)`);

// ---- share by a link ----
if (opt.upload) {
    const type = { '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.ogg': 'audio/ogg', '.wav': 'audio/wav', '.mp4': 'video/mp4' }[ext];
    const body = readFileSync(out);
    const r = await fetch(`${API}/files?name=${encodeURIComponent(basename(out))}`, {
        method: 'PUT', headers: { 'X-Rz-Key': accountKey, 'Content-Type': type, 'Content-Length': String(body.length) }, body,
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) { console.error(`Качването не успя: ${d.error || r.status}`); process.exit(5); }
    console.log(`Линк: ${d.url}`);
}
