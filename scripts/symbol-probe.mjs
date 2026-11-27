#!/usr/bin/env node
// Which symbols does Google Chirp 3 HD read wrongly? (js/probe.js)
//   GOOGLE_TTS_KEY=… [GEMINI_API_KEY=…] node scripts/symbol-probe.mjs [--voice Kore] [--out отчет.md]
// Voices ~57 one-symbol sentences as written and after the app's cleanup; Gemini writes
// down what was actually said. ~5 000 characters of the free Google HD month.

import { writeFileSync } from 'node:fs';

globalThis.window ??= globalThis;
if (!globalThis.localStorage) {
    const m = new Map();
    globalThis.localStorage = { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) };
}
const { runSymbolProbe, probeMarkdown } = await import('../js/probe.js');

const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : d; };
const apiKey = process.env.GOOGLE_TTS_KEY || process.env.GEMINI_API_KEY || '';
if (!apiKey) { console.error('Липсва GOOGLE_TTS_KEY (или GEMINI_API_KEY).'); process.exit(2); }
const v = arg('voice', 'Charon');
const voice = v.startsWith('bg-') ? v : `bg-BG-Chirp3-HD-${v}`;
const rows = await runSymbolProbe({ apiKey, geminiKey: process.env.GEMINI_API_KEY || apiKey, voice, onProgress: (l) => console.log(l) });
const md = probeMarkdown(rows, voice);
const out = arg('out', 'symbol-probe.md');
writeFileSync(out, md);
for (const r of rows) {
    console.log(`${r.rawNote ? '✗' : '✓'} ${r.name}: „${r.raw}“ → „${r.rawHeard}“${r.rawNote ? `  (${r.rawNote})` : ''}`);
    if (r.rawNote || r.cleanNote) console.log(`    след почистване: „${r.cleanHeard}“${r.cleanNote ? `  (${r.cleanNote})` : ' ✓'}`);
}
console.log(`\nОтчет: ${out}`);
