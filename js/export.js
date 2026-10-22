// Export a book (or chapters) as audio files: every chunk comes from the local
// cache, the shared cache or — only if still missing — the voice service, then it
// is decoded and re-encoded into one Ogg/Opus file per chapter.

import * as db from './db.js';
import { OpusWriter } from './opus.js';
import { sharedHasAudio } from './shared.js';

const RATE = 24000;
const CHAPTER_GAP = 0.8; // seconds of silence at the start of each chapter file

function pad(n, len) { return String(n).padStart(len, '0'); }

export function safeFileName(s) {
    return (s || 'книга').replace(/[\\/:*?"<>|\n\r]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80) || 'книга';
}

// How much of the selection is already narrated (free) and how much is missing.
export async function exportPlan(player, chapters) {
    let total = 0, missingChars = 0, chunks = 0, missing = 0;
    const shared = !!player.book.shared;
    for (const c of chapters) {
        for (const spec of await player.chapterSpecs(c)) {
            chunks++;
            total += spec.chars;
            if (await db.audioHas(spec.key)) continue;
            if (shared && await sharedHasAudio(spec.key)) continue;
            missing++;
            missingChars += spec.chars;
        }
    }
    return { chunks, missing, total, missingChars };
}

async function decodeTo24k(blob) {
    const ctx = new OfflineAudioContext(1, 1, RATE);
    const buf = await ctx.decodeAudioData(await blob.arrayBuffer());
    const f = buf.getChannelData(0);
    const out = new Int16Array(f.length);
    for (let i = 0; i < f.length; i++) out[i] = Math.max(-32768, Math.min(32767, Math.round(f[i] * 32767)));
    return out;
}

// Build one Ogg/Opus file per chapter. onProgress(fraction, label)
export async function exportChapters(player, chapters, { onProgress, isCancelled } = {}) {
    if (!(await OpusWriter.supported(RATE))) {
        throw new Error('Този браузър не може да записва аудио файлове. Опитайте в Chrome или в Android приложението.');
    }
    const book = player.book;
    const allSpecs = [];
    for (const c of chapters) allSpecs.push(...(await player.chapterSpecs(c)).map((s) => ({ ...s, c })));
    const width = String(player.chapters.length).length;
    const files = [];
    let done = 0;
    for (const c of chapters) {
        const title = book.chapterTitles[c] || `Глава ${c + 1}`;
        const writer = new OpusWriter(RATE, {
            TITLE: title,
            ARTIST: book.author || '',
            ALBUM: book.title,
            TRACKNUMBER: String(c + 1),
            COMMENT: 'Озвучено с изкуствен интелект — Разказвач',
        });
        writer.add(new Int16Array(Math.round(RATE * CHAPTER_GAP)));
        for (const spec of allSpecs.filter((s) => s.c === c)) {
            if (isCancelled?.()) throw new DOMException('Cancelled', 'AbortError');
            onProgress?.(done / allSpecs.length, title);
            const rec = await player._ensure(spec);
            writer.add(await decodeTo24k(rec.blob));
            done++;
        }
        const blob = await writer.finish();
        if (!blob) throw new Error('Аудиото не можа да се кодира.');
        files.push({ name: `${pad(c + 1, Math.max(2, width))} - ${safeFileName(title)}.ogg`, blob });
    }
    onProgress?.(1, '');
    return files;
}

// Single chapter → the .ogg itself; several → a ZIP (stored, audio is already compressed)
export async function packageFiles(book, files) {
    if (files.length === 1) return { name: `${safeFileName(book.title)} - ${files[0].name}`, blob: files[0].blob };
    const JSZip = window.JSZip || await new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = 'https://cdn.jsdelivr.net/npm/jszip@3.10.1/dist/jszip.min.js';
        s.onload = () => resolve(window.JSZip);
        s.onerror = () => reject(new Error('Няма връзка за създаване на архива.'));
        document.head.appendChild(s);
    });
    const zip = new JSZip();
    const folder = zip.folder(safeFileName(book.title));
    for (const f of files) folder.file(f.name, f.blob);
    const blob = await zip.generateAsync({ type: 'blob', compression: 'STORE' });
    return { name: `${safeFileName(book.title)} (аудиокнига).zip`, blob };
}
