// Long text → one audio file ("Текст → аудио файл").
//
// A long popular-science text (25 000+ characters) is narrated block by block through
// the voice API and joined into ONE file with no audible seams — no listening, no
// real-time recording. Works in the app (browser / Android WebView) and in Node
// (scripts/narrate.mjs), which also makes MP3 / M4A / an MP4 for YouTube.
//
// Why it sounds like one reading:
//   • Paragraphs are not sent as paragraphs. Chirp 3 HD renders every piece between line
//     breaks as a separate performance, so timbre and energy jump at each paragraph
//     (the "every 20–50 words" defect). Each paragraph is closed like a sentence and the
//     whole block goes as ONE line of text.
//   • Few seams: a block is filled up to ~4600 UTF-8 bytes (the API takes 5000), which
//     is ~2300 Cyrillic characters. A 25 000-character text is ~11 requests, not ~100.
//   • Blocks are balanced: the text is split into equal blocks, so the last one is
//     never a short scrap (a short request is read with a different energy).
//   • Blocks end only where a sentence ends; between blocks there is the same pause
//     as between two sentences.
//   • Every block is checked (no cut-off word, no skipped text, duration fits the
//     voice's pace) and requested again when it fails; then brought to the same
//     loudness as the others.
// Microsoft voices (Azure) are not generative — the same text always sounds the same —
// so their seams are inaudible anyway; paragraphs keep a short breath there.

import { prepareParagraph, cloudNarratePcm, azureNarratePcm, speechExtent, levelLoudness, pcmToWav, cloudBilledChars, azureBilledChars } from './engines.js';
import { splitSentences, cleanForSpeech } from './text.js';

export const RATE = 24000;
export const GOOGLE_MAX_BYTES = 4600;   // API limit 5000 bytes per request
export const AZURE_MAX_BYTES = 9000;    // Azure: up to 10 min of audio per request; ~4500 Cyrillic chars
const SENTENCE_GAP = 0.5;               // seconds between two blocks (= a sentence pause)
const EDGE = 0.03;                      // kept around the speech of each block

// Chirp 3 HD voices (all speak Bulgarian). Charon and Kore first: calm, documentary.
export const CHIRP_VOICES = [
    ['Charon', 'm', 'информативен, документален'], ['Kore', 'f', 'твърд, уверен'], ['Orus', 'm', 'твърд'],
    ['Fenrir', 'm', 'енергичен'], ['Iapetus', 'm', 'ясен'], ['Algenib', 'm', 'дрезгав'], ['Rasalgethi', 'm', 'информативен'],
    ['Schedar', 'm', 'равен'], ['Sadaltager', 'm', 'знаещ'], ['Alnilam', 'm', 'твърд'], ['Gacrux', 'f', 'зрял'],
    ['Aoede', 'f', 'лек'], ['Leda', 'f', 'младежки'], ['Erinome', 'f', 'ясен'], ['Despina', 'f', 'гладък'],
    ['Sulafat', 'f', 'топъл'], ['Vindemiatrix', 'f', 'мек'], ['Achernar', 'f', 'мек'], ['Autonoe', 'f', 'ярък'],
    ['Callirrhoe', 'f', 'непринуден'], ['Laomedeia', 'f', 'бодър'], ['Pulcherrima', 'f', 'открит'], ['Zephyr', 'f', 'ярък'],
    ['Puck', 'm', 'бодър'], ['Enceladus', 'm', 'с придихание'], ['Umbriel', 'm', 'непринуден'], ['Algieba', 'm', 'гладък'],
    ['Achird', 'm', 'приятелски'], ['Zubenelgenubi', 'm', 'непринуден'], ['Sadachbia', 'm', 'жив'],
].map(([n, g, d]) => ({ name: `bg-BG-Chirp3-HD-${n}`, label: n, gender: g, note: d }));

// Microsoft neural voices (the same list as the XEMS coach): Bulgarian, then
// multilingual voices told to speak Bulgarian (livelier, slight accent).
export const AZURE_VOICES = [
    { name: 'bg-BG-KalinaNeural', label: 'Калина', gender: 'f', note: 'български' },
    { name: 'bg-BG-BorislavNeural', label: 'Борислав', gender: 'm', note: 'български' },
    { name: 'en-US-AvaMultilingualNeural', label: 'Ава', gender: 'f', note: 'многоезичен' },
    { name: 'en-US-AndrewMultilingualNeural', label: 'Андрю', gender: 'm', note: 'многоезичен' },
    { name: 'de-DE-SeraphinaMultilingualNeural', label: 'Серафина', gender: 'f', note: 'многоезичен' },
    { name: 'de-DE-FlorianMultilingualNeural', label: 'Флориан', gender: 'm', note: 'многоезичен' },
];

const enc = new TextEncoder();
export const utf8Len = (s) => enc.encode(s).length;
const SENTENCE_END = /[.!?…]["»”'’)\]]*$/;

// Written forms a voice stumbles over → the words a narrator says. Only safe, local
// replacements (free, every text, every engine); the AI editor (js/writer.js
// editForVoice) does the rest: long sentences, brackets, numbers, foreign names.
// Unicode-aware word edges (\b in JS ignores Cyrillic)
const L = '[\\p{L}\\p{N}]';
const word = (w, to, after = '') => [new RegExp(`(?<!${L})${w}(?!${L})${after}`, 'gu'), to];
const N = '(\\d|\\b[IVXLC]+)';                         // a number, or a Roman one (V в.)
// a dot after a unit is dropped only when the sentence goes on ("5 км. по-късно" is rare;
// "…40 Hz." ends a sentence and keeps its full stop)
const unit = (u, to) => [new RegExp(`(\\d)\\s?${u}(?!${L})(?:\\.(?=\\s+\\p{Ll}))?`, 'gu'), `$1 ${to}`];
const SPOKEN = [
    // cubic / square units first (the superscript would be dropped as a footnote mark)
    [/(\d)\s?(км|см|мм|м)\s?³/gu, (m, d, u) => `${d} кубични ${{ км: 'километра', см: 'сантиметра', мм: 'милиметра', м: 'метра' }[u]}`],
    [/(\d)\s?(км|см|мм|м)\s?²/gu, (m, d, u) => `${d} квадратни ${{ км: 'километра', см: 'сантиметра', мм: 'милиметра', м: 'метра' }[u]}`],
    word('т\\.\\s?е\\.', 'тоест'), word('напр\\.', 'например'), word('и\\s+др\\.', 'и други'), word('и\\s+т\\.\\s?н\\.', 'и така нататък'),
    word('вкл\\.', 'включително'), word('прибл\\.', 'приблизително'), word('вж\\.', 'виж'), word('ок\\.', 'около'),
    word('проф\\.\\s?', 'професор '), word('акад\\.\\s?', 'академик '), word('д-р\\s?', 'доктор '), word('гл\\.\\s?ас\\.\\s?', 'главен асистент '),
    word('пр\\.\\s?(?:н\\.\\s?е\\.|Хр\\.)', 'преди Христа'), word('сл\\.\\s?Хр\\.', 'след Христа'), word('н\\.\\s?е\\.', 'от новата ера'),
    [new RegExp(`${N}\\s?гг\\.`, 'gu'), '$1 години'],
    [new RegExp(`${N}\\s?г\\.(?=\\s|$|[,;:)])`, 'gu'), '$1 година'],
    [new RegExp(`${N}\\s?в\\.(?=\\s|$|[,;:)])`, 'gu'), '$1 век'],
    word('млн\\.', 'милиона'), word('млрд\\.', 'милиарда'), word('трлн\\.', 'трилиона'), word('хил\\.', 'хиляди'),
    [/(\d)\s?%/g, '$1 процента'], [/\s?°\s?C(?![\p{L}])/gu, ' градуса по Целзий'], [/(\d)\s?°/g, '$1 градуса'],
    unit('км/ч', 'километра в час'), unit('км/с', 'километра в секунда'), unit('м/с', 'метра в секунда'),
    unit('км', 'километра'), unit('кг', 'килограма'), unit('см', 'сантиметра'), unit('мм', 'милиметра'),
    unit('нм', 'нанометра'), unit('(?:мкм|µm|μm)', 'микрометра'), unit('мг', 'милиграма'), unit('мл', 'милилитра'),
    unit('(?:Hz|Хц)', 'херца'), unit('(?:kHz|кХц)', 'килохерца'), unit('(?:ms|мс)', 'милисекунди'),
    [/(\d)\s?м(?![\p{L}\p{N}/-])(?:\.(?=\s+\p{Ll}))?/gu, '$1 метра'],
    [/\s&\s/g, ' и '], [/№\s?/g, 'номер '], [/\s*→\s*/g, ' към '], [/\s+[~≈]\s*(?=\d)/g, ' около '],
];

export function speakable(t) {
    let s = String(t);
    for (const [re, to] of SPOKEN.slice(0, 2)) s = s.replace(re, to);
    s = cleanForSpeech(s, 'bg');
    for (const [re, to] of SPOKEN.slice(2)) s = s.replace(re, to);
    return s.replace(/\s{2,}/g, ' ').trim();
}

// Raw text (pasted, a .txt/.md file) → paragraphs ready to be spoken. A blank line
// separates paragraphs; single line breaks inside one (hard-wrapped text, PDF copy)
// are joined, with words hyphenated across a line break put back together.
export function prepareLongText(raw) {
    let t = String(raw || '').replace(/\r\n?/g, '\n').replace(/­/g, '').replace(/[​﻿]/g, '')
        .replace(/^\s*#{1,6}\s+/gm, '')                    // Markdown headings
        .replace(/(\p{L})-\n(\p{Ll})/gu, '$1$2');          // "изслед-\nване" → "изследване"
    const blocks = /\n[ \t]*\n/.test(t) ? t.split(/\n[ \t]*\n+/) : t.split(/\n/);
    return blocks
        .map((b) => prepareParagraph(speakable(b.replace(/\s*\n\s*/g, ' ').replace(/[ \t]+/g, ' '))))
        .filter((p) => p && /\p{L}|\d/u.test(p));
}

// Sentences of the text, each marked with whether a paragraph ends after it.
function sentencesOf(paras, lang) {
    const out = [];
    for (const p of paras) {
        const ss = splitSentences(p, lang, 1500);
        ss.forEach((s, i) => out.push({ s, paraEnd: i === ss.length - 1 }));
    }
    return out;
}

// Paragraphs → blocks of at most maxBytes (UTF-8, as the API counts them), cut only at
// a sentence end, all of about the same size. Google: one line per block. Azure: the
// paragraphs stay on their own lines (the request adds a short breath there).
export function planBlocks(paras, { maxBytes = GOOGLE_MAX_BYTES, lang = 'bg', keepParagraphs = false } = {}) {
    const sents = sentencesOf(paras, lang);
    const sep = (x) => (keepParagraphs && x.paraEnd ? '\n' : ' ');
    let left = sents.reduce((a, x) => a + utf8Len(x.s) + 1, 0);
    // The target is set again after every block: what is left, shared equally among
    // the blocks still needed, so the last block is as long as the others
    const aim = () => left / Math.max(1, Math.ceil(left / (maxBytes * 0.97)));
    let target = aim();
    const blocks = [];
    let cur = [], bytes = 0;
    const flush = () => {
        if (!cur.length) return;
        blocks.push(cur.map((x, i) => x.s + (i < cur.length - 1 ? sep(x) : '')).join(''));
        left -= bytes;
        cur = []; bytes = 0;
        target = aim();
    };
    for (let i = 0; i < sents.length; i++) {
        const x = sents[i];
        const b = utf8Len(x.s) + 1;
        const atEnd = cur.length && SENTENCE_END.test(cur[cur.length - 1].s);
        // Over the limit: cut at the last sentence end in the block (or here if none)
        if (cur.length && bytes + b > maxBytes) {
            let k = cur.length;
            while (k > 0 && !SENTENCE_END.test(cur[k - 1].s)) k--;
            if (k > 0 && k < cur.length) {
                const rest = cur.slice(k);
                const restBytes = rest.reduce((a, y) => a + utf8Len(y.s) + 1, 0);
                cur = cur.slice(0, k);
                bytes -= restBytes;
                flush();
                cur = rest; bytes = restBytes;
            } else flush();
        } else if (atEnd && bytes >= target && Math.abs(bytes - target) <= Math.abs(bytes + b - target)) {
            // Balanced: close the block where it is nearest to the target size
            flush();
        }
        cur.push(x);
        bytes += b;
    }
    flush();
    return blocks;
}

// Trim a block to its speech (keeps EDGE) and level it.
function tidy(pcm, rate) {
    const x = speechExtent(pcm, rate);
    const a = Math.max(0, Math.floor((x.start - EDGE) * rate));
    const b = Math.min(pcm.length, Math.ceil((x.end + EDGE) * rate));
    return levelLoudness(b > a ? pcm.slice(a, b) : pcm);
}

// Key of a block in the cache: engine|voice|text (a block is paid for once).
export async function blockKey(engine, voice, text) {
    const d = await crypto.subtle.digest('SHA-1', enc.encode(`longtext|${engine}|${voice}|${text}`));
    return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// Billed characters of the whole text for an engine (shown before the start).
export function billedChars(blocks, engine) {
    return blocks.reduce((a, b) => a + (engine === 'azure' ? azureBilledChars(b) : cloudBilledChars(b)), 0);
}

// Narrate the blocks and join them → { pcm, rate, dur, issues }.
//   engine 'google' — { apiKey, voice: 'bg-BG-Chirp3-HD-Charon' }
//   engine 'azure'  — { azureKey, region, voice: 'bg-BG-KalinaNeural' }
//   cache: { get(key) → Int16Array|null, put(key, pcm) } — finished blocks are kept,
//          so a stopped or failed run continues without paying twice
//   beforeRequest/afterRequest: the free-limit guards (Google), as in the player
//   onProgress(done, total, note)
export async function narrateBlocks(blocks, opts) {
    const { engine, voice, signal, cache, onProgress, onIssue, concurrency = 2 } = opts;
    const locale = voice.split('-').slice(0, 2).join('-') || 'bg-BG';
    const out = new Array(blocks.length);
    const issues = [];
    let done = 0, next = 0;
    const one = async (i) => {
        const text = blocks[i];
        const key = cache ? await blockKey(engine, voice, text) : '';
        let pcm = key ? await cache.get(key) : null;
        if (!pcm) {
            const note = (m) => { const msg = `Блок ${i + 1}: ${m}`; issues.push(msg); onIssue?.(msg); };
            const r = engine === 'azure'
                ? await azureNarratePcm({ key: opts.azureKey, region: opts.region, text, voice, locale: opts.locale || 'bg-BG', signal, onSplit: (e) => note(`прочетен на две части (${e.message})`) })
                : await cloudNarratePcm({ apiKey: opts.apiKey, text, voice, locale, signal, beforeRequest: opts.beforeRequest, afterRequest: opts.afterRequest, onIssue: note });
            if (r.problem) note(r.problem);
            opts.afterBlock?.(engine, r.chars || 0);
            pcm = tidy(r.pcm, r.rate);
            if (r.rate !== RATE) throw new Error(`Неочаквана честота ${r.rate} Hz.`);
            if (key) await cache.put(key, pcm);
        }
        out[i] = pcm;
        done++;
        onProgress?.(done, blocks.length);
    };
    const worker = async () => {
        while (next < blocks.length) {
            if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
            await one(next++);
        }
    };
    onProgress?.(0, blocks.length);
    await Promise.all(Array.from({ length: Math.min(concurrency, blocks.length) }, worker));
    const gap = Math.round(RATE * SENTENCE_GAP);
    const lead = Math.round(RATE * 0.3);
    const len = lead * 2 + out.reduce((a, p) => a + p.length, 0) + gap * (out.length - 1);
    const pcm = new Int16Array(len);
    let o = lead;
    out.forEach((p, i) => { pcm.set(p, o); o += p.length + (i < out.length - 1 ? gap : 0); });
    return { pcm, rate: RATE, dur: len / RATE, issues };
}

export { pcmToWav };
