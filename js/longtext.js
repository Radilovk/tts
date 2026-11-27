// "Текст → аудио файл": a text (yours, retold, or written from a topic), a voice, and
// one audio file to save or share by a link. The engine is js/narrate.js.

import * as db from './db.js';
import { prepareLongText, planBlocks, narrateBlocks, billedChars, CHIRP_MAIN, AZURE_VOICES, GOOGLE_MAX_BYTES, AZURE_MAX_BYTES, RATE } from './narrate.js';
import { pcmToWav, parseWavPcm, PRICES } from './engines.js';
import { encodeOpus } from './opus.js';
import { detectLang } from './text.js';
import { parseBook } from './parsers.js';
import { libraryApi } from './shared.js';
import { writeNarration, pickWriterModel, editForVoice } from './writer.js';
import { SCENARIO } from './scenario.js';
import { recordUsage, cloudReserve, cloudRelease, reportCloudUsage, cloudUsedChars, cloudLimitChars, azureFreeLeft } from './usage.js';

const DRAFT = 'rz_longtext';
// source: 'text' — read the text as it is; 'rewrite' — retell it by the scenario
// (js/scenario.js); 'topic' — write it from a topic.
const DEFAULT_DRAFT = { text: '', topic: '', source: 'text', title: '', engine: 'google', google: 'bg-BG-Chirp3-HD-Charon', azure: 'bg-BG-KalinaNeural', reviewed: '' };
// Fixed, not asked: the newest Flash model writes; every text goes through the editor for
// the voice (when a Google key is there); the file is Ogg/Opus (WAV where the browser
// cannot encode Opus). reviewed: the text as the editor returned it, so the same text is
// never edited — and paid for — twice.
const SOURCE_HINTS = {
    text: 'Поставете текста тук (25 000+ знака са наред) или отворете файл',
    rewrite: 'Поставете научния материал — ИИ ще го преразкаже като документален аудиоразказ по сценария',
    topic: 'Тема или разсъждение, напр. „Защо мозъкът предсказва, вместо да вижда“',
};
let ui = null;           // helpers from main.js
let draft = loadDraft();
let lastFile = null;     // { name, blob, url }

function loadDraft() {
    try {
        return { ...DEFAULT_DRAFT, ...JSON.parse(localStorage.getItem(DRAFT) || '{}') };
    } catch { return { ...DEFAULT_DRAFT }; }
}

function saveDraft() {
    try { localStorage.setItem(DRAFT, JSON.stringify(draft)); } catch {}
}

export function initTextToFile(helpers) {
    ui = helpers;
}

function plan() {
    const paras = prepareLongText(draft.text);
    if (!paras.length) return null;
    const lang = detectLang(paras.slice(0, 20).join(' ')) || 'bg';
    const azure = draft.engine === 'azure';
    const blocks = planBlocks(paras, { maxBytes: azure ? AZURE_MAX_BYTES : GOOGLE_MAX_BYTES, lang, keepParagraphs: azure });
    const chars = billedChars(blocks, draft.engine);
    return { paras, blocks, chars, lang, minutes: chars / 14 / 60 };
}

function priceLine(p) {
    if (draft.engine === 'azure') {
        const left = azureFreeLeft();
        return p.chars <= left
            ? `0 $ — остават ${ui.fmtNum(left)} безплатни знака за месеца`
            : `Не стига безплатният лимит за месеца (остават ${ui.fmtNum(left)} знака)`;
    }
    const left = Math.max(0, cloudLimitChars('Chirp3-HD') - cloudUsedChars('Chirp3-HD'));
    return p.chars <= left
        ? `0 $ — остават ${ui.fmtNum(left)} безплатни знака за месеца`
        : `Не стига безплатният лимит за месеца (остават ${ui.fmtNum(left)} знака; над него ~${(PRICES.cloud['Chirp3-HD'].per1M).toFixed(0)} $ за 1M)`;
}

function keyOk(st) {
    return draft.engine === 'azure' ? !!(st.azureKey && st.azureRegion) : !!st.apiKey;
}

export function openTextToFile() {
    const render = (body) => {
        const st = ui.settings();
        const voices = draft.engine === 'azure' ? AZURE_VOICES : CHIRP_MAIN;
        const cur = draft.engine === 'azure' ? draft.azure : draft.google;
        body.innerHTML = `
            <div class="seg" id="ltSource">
                <button data-s="text" class="${draft.source === 'text' ? 'on' : ''}">Мой текст</button>
                <button data-s="rewrite" class="${draft.source === 'rewrite' ? 'on' : ''}">Преразкажи</button>
                <button data-s="topic" class="${draft.source === 'topic' ? 'on' : ''}">По тема</button>
            </div>
            <div class="group">
                <textarea id="ltText" class="input lt-text ${draft.source === 'topic' ? 'lt-topic' : ''}" placeholder="${SOURCE_HINTS[draft.source]}" spellcheck="false">${ui.esc(draft.source === 'topic' ? draft.topic : draft.text)}</textarea>
                <div class="lt-row">
                    ${draft.source !== 'topic' ? '<button class="btn btn-ghost btn-sm" id="ltOpen">Отвори файл</button>' : ''}
                    <input class="input" id="ltTitle" placeholder="Заглавие" value="${ui.esc(draft.title)}">
                </div>
                <input type="file" id="ltFile" hidden accept=".txt,.md,.markdown,.docx,.epub,.fb2,.html,.htm,.pdf">
            </div>
            <div class="group">
                <div class="group-title">Глас</div>
                <div class="seg" id="ltEngine">
                    <button data-e="google" class="${draft.engine === 'google' ? 'on' : ''}">Google HD</button>
                    <button data-e="azure" class="${draft.engine === 'azure' ? 'on' : ''}">Microsoft</button>
                </div>
                <div class="lt-voices" id="ltVoices">
                    ${voices.map((v) => `<button class="lt-voice ${v.name === cur ? 'on' : ''}" data-v="${v.name}"><b>${ui.esc(v.label)}</b><small>${v.gender === 'f' ? 'жен.' : 'мъж.'} · ${ui.esc(v.note)}</small></button>`).join('')}
                </div>
                ${keyOk(st) ? '' : `<p class="hint">${draft.engine === 'azure' ? 'Нужен е ключ за Microsoft гласовете.' : 'Нужен е Google API ключ.'} <a href="#" id="ltSetup">Настройки →</a></p>`}
            </div>
            <div id="ltInfo" class="usage"></div>
            <div class="catalog-actions">${draft.source === 'text'
                ? `<button class="btn btn-primary" id="ltGo">Създай аудио файла</button>
                   <button class="btn btn-ghost" id="ltListen">Слушай в приложението</button>`
                : `<button class="btn btn-primary" id="ltWriteGo">Напиши и създай аудио файла</button>
                   <button class="btn btn-ghost" id="ltWrite">Само напиши текста</button>`}</div>
            ${lastFile ? `<div class="group"><div class="group-title">Готов файл</div>${resultHtml()}</div>` : ''}`;
        const info = () => {
            if (draft.source !== 'text') {
                const box = $('#ltInfo', body);
                const ok = !!(draft.source === 'topic' ? draft.topic.trim() : draft.text.trim()) && !!ui.settings().apiKey;
                $('#ltWriteGo', body).disabled = !ok || !keyOk(ui.settings());
                $('#ltWrite', body).disabled = !ok;
                box.innerHTML = `<div class="usage-item"><div class="top"><span>~30 мин аудио</span><span>≥ 25 000 знака</span></div>
                    <div class="sub">Пише се като документален разказ — няколко минути.</div>
                    ${ui.settings().apiKey ? '' : '<div class="sub">Нужен е Google API ключ — Настройки.</div>'}</div>`;
                return;
            }
            const p = plan();
            const box = $('#ltInfo', body);
            const go = $('#ltGo', body);
            if (!p) { box.innerHTML = ''; go.disabled = true; return; }
            go.disabled = !keyOk(ui.settings());
            box.innerHTML = `<div class="usage-item"><div class="top"><span>~${Math.max(1, Math.round(p.minutes))} мин аудио</span><span>${ui.fmtNum(p.chars)} знака</span></div>
                <div class="sub">${ui.esc(priceLine(p))}</div></div>`;
        };
        info();
        const ta = $('#ltText', body);
        let t = 0;
        ta.oninput = () => { draft[draft.source === 'topic' ? 'topic' : 'text'] = ta.value; clearTimeout(t); t = setTimeout(() => { saveDraft(); info(); }, 300); };
        $('#ltTitle', body).oninput = (e) => { draft.title = e.target.value; saveDraft(); };
        const open = $('#ltOpen', body);
        if (open) open.onclick = () => $('#ltFile', body).click();
        $('#ltFile', body).onchange = async (e) => {
            const f = e.target.files[0];
            if (!f) return;
            try {
                if (draft.source === 'topic') draft.source = 'rewrite';
                if (/\.(txt|md|markdown)$/i.test(f.name)) draft.text = await f.text();
                else {
                    const book = await parseBook(f);
                    draft.text = book.chapters.map((c) => [c.title, ...(c.paras || [])].filter(Boolean).join('\n\n')).join('\n\n');
                    if (!draft.title) draft.title = book.title || '';
                }
                if (!draft.title) draft.title = f.name.replace(/\.[^.]+$/, '');
                saveDraft();
                ui.rerenderSheet(render);
            } catch (err) { ui.toast(err.message || 'Файлът не се отвори.', { error: true }); }
        };
        body.onclick = (e) => {
            const src = e.target.closest('#ltSource [data-s]');
            if (src && src.dataset.s !== draft.source) { draft.source = src.dataset.s; saveDraft(); return ui.rerenderSheet(render); }
            if (e.target.closest('#ltWriteGo')) return write(true);
            if (e.target.closest('#ltWrite')) return write(false);
            if (e.target.closest('#ltListen')) return listen();
            const eng = e.target.closest('#ltEngine [data-e]');
            if (eng && eng.dataset.e !== draft.engine) { draft.engine = eng.dataset.e; saveDraft(); return ui.rerenderSheet(render); }
            const v = e.target.closest('#ltVoices [data-v]');
            if (v) { draft[draft.engine === 'azure' ? 'azure' : 'google'] = v.dataset.v; saveDraft(); return ui.rerenderSheet(render); }
            if (e.target.closest('#ltSetup')) { e.preventDefault(); ui.closeSheet(); ui.openSettings(); return; }
            if (e.target.closest('#ltGo')) return run();
            resultClick(e);
        };
    };
    ui.openSheet('Текст → аудио файл', render);
}

const $ = (s, root = document) => root.querySelector(s);

function resultHtml() {
    return `<audio controls preload="metadata" src="${lastFile.url}" class="lt-audio"></audio>
        <p class="hint">${ui.esc(lastFile.name)} · ${(lastFile.blob.size / 1024 / 1024).toFixed(1)} MB · ${Math.round(lastFile.dur / 60)} мин</p>
        <div class="catalog-actions">
            <button class="btn btn-primary" data-lt="save">Запази файла</button>
            <button class="btn btn-ghost" data-lt="link">${lastFile.link ? 'Копирай линка' : 'Качи и вземи линк'}</button>
        </div>
        ${lastFile.link ? `<p class="hint lt-link"><a href="${ui.esc(lastFile.link)}" target="_blank" rel="noopener">${ui.esc(lastFile.link)}</a></p>` : ''}`;
}

async function resultClick(e) {
    const act = e.target.closest('[data-lt]')?.dataset.lt;
    if (!act || !lastFile) return;
    if (act === 'save') return ui.saveBlob(lastFile.name, lastFile.blob);
    if (act === 'link') {
        if (lastFile.link) return share(lastFile.link);
        const btn = e.target.closest('[data-lt]');
        btn.disabled = true;
        btn.textContent = 'Качвам…';
        try {
            lastFile.link = await upload(lastFile);
            share(lastFile.link);
        } catch (err) {
            ui.toast(err.message || 'Качването не успя.', { error: true, duration: 7000 });
        }
        openTextToFile();
    }
}

async function share(link) {
    try {
        if (navigator.share) return await navigator.share({ title: lastFile.name, url: link });
    } catch (e) { if (e.name === 'AbortError') return; }
    try { await navigator.clipboard.writeText(link); ui.toast('Линкът е копиран.'); } catch { ui.toast(link, { duration: 10000 }); }
}

async function upload(file) {
    const base = libraryApi();
    if (!base) throw new Error('Няма адрес на сървъра (LIBRARY_API).');
    const st = ui.settings();
    const key = file.engine === 'azure' ? st.azureKey : st.apiKey;
    const r = await fetch(`${base}/files?name=${encodeURIComponent(file.name)}`, {
        method: 'PUT', headers: { 'X-Rz-Key': key, 'Content-Type': file.blob.type }, body: file.blob,
    });
    let d = null;
    try { d = await r.json(); } catch {}
    if (!r.ok) throw new Error(d?.error || `Сървърът отговори с грешка ${r.status}.`);
    return d.url;
}

// Finished blocks are kept in the audio cache (WAV), so a stopped run goes on for free
const cache = {
    get: async (k) => {
        const rec = await db.audioGet('lt-' + k);
        return rec ? parseWavPcm(new Uint8Array(await rec.blob.arrayBuffer())).pcm : null;
    },
    put: (k, pcm) => db.audioPut({ key: 'lt-' + k, blob: pcmToWav(pcm, RATE), dur: pcm.length / RATE, chars: 0, bookId: 'longtext' }),
};

// The editor pass inside the progress overlay; false when it failed (toast shown)
async function review(st, arc, label) {
    if (!st.apiKey || !draft.text.trim() || draft.text === draft.reviewed) return true;
    try {
        const r = await editForVoice({
            apiKey: st.apiKey, model: await pickWriterModel(st.apiKey, 'flash'), text: draft.text,
            onProgress: (f, l) => { arc.style.strokeDashoffset = 125.7 * (1 - f); if (l) label.textContent = l; },
        });
        draft.text = r.text;
        draft.reviewed = r.text;
        saveDraft();
        if (r.kept) ui.diag?.(`Редакция за глас: ${r.kept} откъса останаха непроменени (отговорът се различаваше твърде много по дължина)`);
        return true;
    } catch (e) {
        if (e.name === 'AbortError') throw e;
        ui.toast(`Редакцията не успя (${e.message}) — текстът остава както е.`, { error: true, duration: 7000 });
        return false;
    }
}

function overlayOn(text) {
    const overlay = $('#importOverlay');
    const arc = $('#importArc');
    const label = $('#importText');
    arc.style.strokeDashoffset = 125.7;
    label.textContent = text;
    overlay.classList.remove('hidden');
    return { overlay, arc, label };
}

async function run() {
    const st = ui.settings();
    if (st.apiKey && draft.text.trim() && draft.text !== draft.reviewed) {
        ui.closeSheet();
        const { overlay, arc, label } = overlayOn('Редактирам за слушане…');
        await review(st, arc, label);
        overlay.classList.add('hidden');
    }
    const p = plan();
    if (!p) return;
    const engine = draft.engine;
    const voice = engine === 'azure' ? draft.azure : draft.google;
    if (engine === 'azure' && p.chars > azureFreeLeft()) {
        return ui.toast('Безплатните знаци на Microsoft за месеца не стигат за този текст.', { error: true, duration: 7000 });
    }
    ui.closeSheet();
    const overlay = $('#importOverlay');
    const arc = $('#importArc');
    const label = $('#importText');
    arc.style.strokeDashoffset = 125.7;
    label.textContent = 'Подготвям текста…';
    overlay.classList.remove('hidden');
    const tier = 'Chirp3-HD';
    try {
        const res = await narrateBlocks(p.blocks, {
            engine, voice, apiKey: st.apiKey, azureKey: st.azureKey, region: st.azureRegion, locale: 'bg-BG', cache,
            beforeRequest: (billed) => {
                if (!cloudReserve(tier, billed)) throw new Error('Безплатните знаци на Google HD за този месец свършиха — спрях преди таксуване. Готовото е запазено; продължава от 1-во число.');
                return () => cloudRelease(tier, billed);
            },
            afterRequest: (billed) => { recordUsage({ engine: 'cloud', tier, chars: billed }); reportCloudUsage(st.apiKey, tier, billed); },
            afterBlock: (eng, chars) => { if (eng === 'azure') recordUsage({ engine: 'azure', chars }); },
            onProgress: (d, n) => {
                arc.style.strokeDashoffset = 125.7 * (1 - d / n);
                label.textContent = `Озвучавам: ${d} от ${n} части`;
            },
            onIssue: (m) => ui.diag?.(m),
        });
        label.textContent = 'Записвам файла…';
        const title = (draft.title || p.paras[0].slice(0, 60)).trim();
        const name = ui.safeFileName(title);
        let blob = null;
        blob = await encodeOpus(res.pcm, RATE, { TITLE: title, COMMENT: 'Озвучено с изкуствен интелект — Разказвач' });
        const file = blob ? { name: `${name}.ogg`, blob } : { name: `${name}.wav`, blob: pcmToWav(res.pcm, RATE) };
        if (lastFile?.url) URL.revokeObjectURL(lastFile.url);
        lastFile = { ...file, url: URL.createObjectURL(file.blob), dur: res.dur, engine };
        overlay.classList.add('hidden');
        openTextToFile();
    } catch (e) {
        overlay.classList.add('hidden');
        console.error(e);
        if (e.name !== 'AbortError') ui.toast(e.message || 'Аудио файлът не можа да се създаде.', { error: true, duration: 8000 });
    }
}

// The text as a book in the library: the app's own player reads it aloud
async function listen() {
    const p = plan();
    if (!p) return;
    ui.closeSheet();
    const title = (draft.title || p.paras[0].slice(0, 60)).trim();
    await ui.importFile(new File([draft.text], `${ui.safeFileName(title)}.txt`, { type: 'text/plain' }));
}

// Gemini writes the text by the scenario; then (andVoice) it is voiced into a file
async function write(andVoice) {
    const st = ui.settings();
    if (!st.apiKey) return ui.toast('Нужен е Google (Gemini) API ключ.', { error: true });
    const mode = draft.source;
    const input = mode === 'topic' ? draft.topic : draft.text;
    ui.closeSheet();
    const overlay = $('#importOverlay');
    const arc = $('#importArc');
    const label = $('#importText');
    arc.style.strokeDashoffset = 125.7;
    label.textContent = 'Избирам модел…';
    overlay.classList.remove('hidden');
    try {
        const model = await pickWriterModel(st.apiKey, 'flash');
        const r = await writeNarration({
            apiKey: st.apiKey, model, mode, input, scenario: SCENARIO,
            onProgress: (f, l) => { arc.style.strokeDashoffset = 125.7 * (1 - f); if (l) label.textContent = l; },
        });
        draft.text = r.text;
        draft.reviewed = '';
        if (r.title) draft.title = r.title;
        draft.source = 'text';
        saveDraft();
        await review(st, arc, label);
        overlay.classList.add('hidden');
        ui.toast(`Текстът е готов: ${ui.fmtNum(r.text.length)} знака (${r.model}, ${ui.fmtNum(r.inTokens + r.outTokens)} токена).`, { duration: 6000 });
        if (andVoice) return run();
        openTextToFile();
    } catch (e) {
        overlay.classList.add('hidden');
        console.error(e);
        if (e.name !== 'AbortError') ui.toast(e.message || 'Текстът не можа да се напише.', { error: true, duration: 8000 });
        openTextToFile();
    }
}

