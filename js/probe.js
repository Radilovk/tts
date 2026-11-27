// Symbol test: which characters does Google Chirp 3 HD read wrongly in Bulgarian?
// Every case is a short sentence with one symbol. The sentences are voiced twice — as
// written and after the app's cleanup (speakable) — and Gemini writes down word for
// word what the voice actually said. The report puts the two side by side, so it is
// heard, not guessed, which symbols need a rule. Cost: ~5 000 characters of the free
// Google HD month and a few Gemini requests.

import { cloudNarratePcm, pcmToWav, fetchJson, withRetry } from './engines.js';
import { speakable } from './narrate.js';
import { pickWriterModel } from './writer.js';

export const PROBE_CASES = [
    ['наклонена черта между думи', 'Учените/изследователите спорят.'],
    ['и/или', 'Ще дойде той и/или тя.'],
    ['дроб', 'Половината, тоест 1/2 от клетките, умира.'],
    ['скоби', 'Мозъкът (най-сложният орган) тежи малко.'],
    ['квадратни скоби', 'Това е доказано [12] отдавна.'],
    ['фигурни скоби', 'Множеството {1, 2} е малко.'],
    ['кавички „“', 'Той го нарече „предсказваща машина“ без колебание.'],
    ['кавички ""', 'Той го нарече "предсказваща машина" без колебание.'],
    ['кавички «»', 'Той го нарече «предсказваща машина» без колебание.'],
    ['апостроф', "Това е 'особен' случай."],
    ['тире в изречение', 'Мозъкът — този невероятен орган — предсказва.'],
    ['средно тире', 'Мозъкът – този орган – предсказва.'],
    ['тире в началото (реплика)', '— Не вярвам, каза той.'],
    ['диапазон години', 'Между 1990–2000 г. всичко се промени.'],
    ['диапазон с дефис', 'Отнема 2-3 седмици.'],
    ['минус', 'Температурата пада до -40 градуса.'],
    ['хиляди с интервал', 'В града живеят 300 000 души.'],
    ['десетична запетая', 'Числото пи е 3,14.'],
    ['десетична точка', 'Числото пи е 3.14.'],
    ['процент', 'Около 95% от сигналите идват отвътре.'],
    ['промил', 'Нивото е 0,5‰ в кръвта.'],
    ['градус Целзий', 'Водата кипи при 100°C.'],
    ['градус', 'Ъгълът е 45°.'],
    ['равно', 'Ако x = 5, отговорът е ясен.'],
    ['плюс', 'Две плюс две: 2 + 2.'],
    ['умножение', 'Площта е 3 × 4 метра.'],
    ['приблизително', 'Скоростта е ≈ 7 метра.'],
    ['тилда', 'Разстоянието е ~15 километра.'],
    ['плюс-минус', 'Грешката е ±2 процента.'],
    ['по-малко/по-голямо', 'Ако 3 < 5 и 7 > 4, всичко е наред.'],
    ['стрелка', 'Стимул → реакция.'],
    ['звездичка', 'Това е *много* важно.'],
    ['диез', 'Темата е #наука.'],
    ['долна черта', 'Файлът се казва нов_файл.'],
    ['вертикална черта', 'Избор: да | не.'],
    ['маймунка', 'Пишете на учен@институт.'],
    ['амперсанд', 'Джонсън & Джонсън.'],
    ['номер', 'Опит № 5 успя.'],
    ['параграф', 'Виж § 3 от закона.'],
    ['долар', 'Струва $5.'],
    ['евро', 'Струва 10 €.'],
    ['точка и запетая', 'Мозъкът мисли; тялото действа.'],
    ['многоточие ...', 'И тогава... тишина.'],
    ['многоточие …', 'И тогава… тишина.'],
    ['!!! ?!', 'Невероятно!!! Наистина?!'],
    ['римски век', 'През XX век физиката се промени.'],
    ['арабски век', 'През 20 век физиката се промени.'],
    ['съкращение г.', 'През 1867 г. Хелмхолц писа за това.'],
    ['т.е. напр.', 'Сигналът, т.е. импулсът, напр. звук, идва.'],
    ['гръцка буква', 'Дължината на вълната λ е малка.'],
    ['степен', 'Формулата E = mc² е известна.'],
    ['булет', '• Първо идва сигналът.'],
    ['емоджи', 'Мозъкът 🧠 работи постоянно.'],
    ['отметка', 'Готово ✓ и проверено.'],
    ['ГЛАВНИ БУКВИ', 'Това е ДНК и РНК.'],
    ['латинско съкращение', 'Това е DNA, не RNA.'],
    ['URL', 'Виж www.example.com за повече.'],
];

function b64(bytes) {
    let s = '';
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(s);
}

async function transcribe({ apiKey, model, pcm, rate, count, signal }) {
    const wav = new Uint8Array(await pcmToWav(pcm, rate).arrayBuffer());
    const body = {
        contents: [{
            role: 'user', parts: [
                { inline_data: { mime_type: 'audio/wav', data: b64(wav) } },
                { text: `Това е запис на синтезиран глас на български. Той чете ${count} номерирани изречения („Номер 1. …“, „Номер 2. …“).
Запиши ДОСЛОВНО какво е изговорено във всяко изречение — точно думите, които се чуват, с кирилица. Ако гласът изговаря име на символ („наклонена черта“, „звездичка“), чете цифри една по една, спелува букви, пропуска нещо или звучи странно — запиши го точно както е изговорено, а в "note" опиши накратко странното (празно, ако звучи естествено).
Върни САМО JSON: {"1": {"heard": "…", "note": "…"}, "2": …}` },
            ],
        }],
        generationConfig: { temperature: 0, responseMimeType: 'application/json', maxOutputTokens: 8192 },
    };
    const data = await withRetry(() => fetchJson(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(apiKey)}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    }, 180000, signal), signal, 3);
    const t = (data?.candidates?.[0]?.content?.parts || []).filter((p) => !p.thought).map((p) => p.text || '').join('');
    try { return JSON.parse(t.slice(t.indexOf('{'), t.lastIndexOf('}') + 1)); } catch { return {}; }
}

const GROUP = 12;

// Voice a list of sentences in groups; → [{ heard, note }] in the same order
async function hear(sentences, o) {
    const out = [];
    for (let g = 0; g < sentences.length; g += GROUP) {
        const part = sentences.slice(g, g + GROUP);
        o.onProgress?.(`${o.label}: ${g + part.length} от ${sentences.length}`);
        const text = part.map((s, i) => `Номер ${i + 1}. ${s}`).join(' ');
        const r = await cloudNarratePcm({ apiKey: o.apiKey, text, voice: o.voice, locale: 'bg-BG', signal: o.signal, beforeRequest: o.beforeRequest, afterRequest: o.afterRequest });
        const t = await transcribe({ apiKey: o.geminiKey || o.apiKey, model: o.model, pcm: r.pcm, rate: r.rate, count: part.length, signal: o.signal });
        part.forEach((_, i) => out.push(t[i + 1] || t[String(i + 1)] || { heard: '?', note: 'не е разпознато' }));
    }
    return out;
}

// → [{ name, raw, clean, rawHeard, rawNote, cleanHeard, cleanNote }]
export async function runSymbolProbe({ apiKey, geminiKey, voice = 'bg-BG-Chirp3-HD-Charon', cases = PROBE_CASES, signal, onProgress, beforeRequest, afterRequest }) {
    const model = await pickWriterModel(geminiKey || apiKey);
    const raw = cases.map((c) => c[1]);
    const clean = raw.map((t) => speakable(t));
    const o = { apiKey, geminiKey, voice, model, signal, onProgress, beforeRequest, afterRequest };
    const a = await hear(raw, { ...o, label: 'Както е написано' });
    const b = await hear(clean, { ...o, label: 'След почистването' });
    return cases.map((c, i) => ({
        name: c[0], raw: raw[i], clean: clean[i],
        rawHeard: a[i]?.heard || '', rawNote: a[i]?.note || '',
        cleanHeard: b[i]?.heard || '', cleanNote: b[i]?.note || '',
    }));
}

export function probeMarkdown(rows, voice) {
    const esc = (s) => String(s).replace(/\|/g, '\\|');
    return `# Тест на символите — ${voice}\n\n| Символ | Написано | Чуто | Странно | След почистване | Чуто | Странно |\n|---|---|---|---|---|---|---|\n`
        + rows.map((r) => `| ${esc(r.name)} | ${esc(r.raw)} | ${esc(r.rawHeard)} | ${esc(r.rawNote)} | ${esc(r.clean)} | ${esc(r.cleanHeard)} | ${esc(r.cleanNote)} |`).join('\n') + '\n';
}
