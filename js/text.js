// Text model: cleanup, sentence splitting and deterministic chunking.
// Chunk boundaries are fixed per chapter, so cached audio is reused
// whenever the same part of the book is played again.

const ABBREVIATIONS = /(?:^|\s)(?:т\.е|т\.нар|напр|г-н|г-жа|г-ца|д-р|проф|ул|бул|гр|с|стр|вж|др|св|ок|мин|сек|млн|млрд|хил|Mr|Mrs|Ms|Dr|Prof|St|Jr|Sr|vs|etc|e\.g|i\.e|No)\.$/i;

const segmenterCache = {};

function getSegmenter(lang) {
    if (typeof Intl === 'undefined' || !Intl.Segmenter) return null;
    const key = lang || 'bg';
    if (!segmenterCache[key]) {
        try { segmenterCache[key] = new Intl.Segmenter(key, { granularity: 'sentence' }); }
        catch { segmenterCache[key] = null; }
    }
    return segmenterCache[key];
}

export function normalizeSpace(s) {
    return s
        .replace(/[­​-‍﻿]/g, '')
        .replace(/[   \t]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

// Remove things a narrator should not read and that cost money: footnote
// markers, URLs, decorative separators.
export function cleanForSpeech(s) {
    return s
        .replace(/https?:\/\/\S+/g, '')
        .replace(/\[\d{1,3}\]|\{\d{1,3}\}/g, '')
        .replace(/([а-яa-z»"”.,!?])\d{1,3}(?=[\s.,;:!?]|$)/gi, '$1') // trailing footnote digits
        .replace(/^[\s*•·~#=_\-–—]{3,}$/g, '')
        .replace(/[*_#]{2,}/g, '')
        .replace(/\s{2,}/g, ' ')
        .trim();
}

function rawSentences(text, lang) {
    const seg = getSegmenter(lang);
    if (seg) return Array.from(seg.segment(text), (x) => x.segment);
    return text.match(/[^.!?…]+(?:[.!?…]+["»”')\]]*\s*|$)/g) || [text];
}

// Split a paragraph into sentences. Merges false splits after abbreviations
// and initials, and breaks overly long sentences at soft punctuation.
export function splitSentences(text, lang, maxLen = 450) {
    const parts = rawSentences(text, lang);
    const merged = [];
    for (const p of parts) {
        const t = p.trim();
        if (!t) continue;
        const prev = merged[merged.length - 1];
        if (prev && (ABBREVIATIONS.test(prev) || /(?:^|\s)[A-ZА-Я]\.$/.test(prev) || t.length < 3)) {
            merged[merged.length - 1] = prev + ' ' + t;
        } else {
            merged.push(t);
        }
    }
    const out = [];
    for (const s of merged) {
        if (s.length <= maxLen) { out.push(s); continue; }
        let rest = s;
        while (rest.length > maxLen) {
            const window = rest.slice(0, maxLen);
            let cut = Math.max(window.lastIndexOf('; '), window.lastIndexOf(', '), window.lastIndexOf(' — '), window.lastIndexOf(': '));
            if (cut < maxLen * 0.4) cut = window.lastIndexOf(' ');
            if (cut <= 0) cut = maxLen;
            out.push(rest.slice(0, cut + 1).trim());
            rest = rest.slice(cut + 1).trim();
        }
        if (rest) out.push(rest);
    }
    return out;
}

// Build the speakable model of a chapter: flat sentence list with paragraph indexes.
export function buildChapterModel(chapter, lang) {
    const sentences = [];
    const paras = [];
    const blocks = chapter.title && !chapter.auto
        ? [{ t: chapter.title, h: true }, ...chapter.paras.map((t) => ({ t }))]
        : chapter.paras.map((t) => ({ t }));
    blocks.forEach((b) => {
        const pIndex = paras.length;
        const first = sentences.length;
        for (const s of splitSentences(b.t, lang)) {
            const speak = cleanForSpeech(s);
            sentences.push({ t: s, speak, p: pIndex });
        }
        paras.push({ first, last: sentences.length, h: !!b.h });
    });
    return { sentences, paras };
}

// Fixed chunk start indexes for a chapter at a given max chunk size.
export function chunkBoundaries(model, maxChars, paraFrac = 0.75) {
    const starts = [0];
    let len = 0;
    model.sentences.forEach((s, i) => {
        const l = s.speak.length + 1;
        // Prefer to break at paragraph starts once the chunk is reasonably full
        const paraStart = i > 0 && model.sentences[i - 1].p !== s.p;
        if (i > 0 && (len + l > maxChars || (paraStart && len > maxChars * paraFrac))) {
            starts.push(i);
            len = 0;
        }
        len += l;
    });
    return starts;
}

export function nextBoundary(starts, s, total) {
    for (const b of starts) if (b > s) return b;
    return total;
}

// Join sentences s0..s1 into speakable text, paragraphs separated by blank lines
// so the narrator makes a natural pause.
export function chunkText(model, s0, s1) {
    let out = '';
    let prevP = -1;
    for (let i = s0; i < s1; i++) {
        const s = model.sentences[i];
        if (!s.speak) continue;
        if (out) out += s.p !== prevP ? '\n\n' : ' ';
        out += s.speak;
        prevP = s.p;
    }
    return out;
}

export function charLen(model, s0, s1) {
    let n = 0;
    for (let i = s0; i < s1; i++) n += model.sentences[i].speak.length + 1;
    return n;
}

// Rough language detection for Cyrillic/Latin books.
export function detectLang(sample) {
    const text = sample.slice(0, 8000);
    const cyr = (text.match(/[Ѐ-ӿ]/g) || []).length;
    const lat = (text.match(/[A-Za-z]/g) || []).length;
    if (cyr > lat) {
        const ru = (text.match(/[ыэЫЭёЁ]/g) || []).length;
        const uk = (text.match(/[іїєІЇЄ]/g) || []).length;
        if (uk > cyr * 0.005) return 'uk';
        if (ru > cyr * 0.005) return 'ru';
        if ((text.match(/[ђћљњџ]/gi) || []).length > 3) return 'sr';
        return 'bg';
    }
    const lower = text.toLowerCase();
    const score = (words) => words.reduce((n, w) => n + (lower.split(` ${w} `).length - 1), 0);
    const scores = {
        en: score(['the', 'and', 'of', 'to', 'is']),
        de: score(['der', 'die', 'und', 'nicht', 'das']),
        fr: score(['le', 'les', 'et', 'des', 'est']),
        es: score(['el', 'los', 'que', 'y', 'las']),
        it: score(['il', 'che', 'di', 'e', 'non']),
    };
    return Object.entries(scores).sort((a, b) => b[1] - a[1])[0][0];
}

export const LOCALES = {
    bg: 'bg-BG', en: 'en-US', ru: 'ru-RU', uk: 'uk-UA', sr: 'sr-RS', de: 'de-DE',
    fr: 'fr-FR', es: 'es-ES', it: 'it-IT',
};

export const LANG_NAMES = {
    bg: 'Български', en: 'English', ru: 'Русский', uk: 'Українська', sr: 'Српски',
    de: 'Deutsch', fr: 'Français', es: 'Español', it: 'Italiano',
};
