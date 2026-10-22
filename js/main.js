// Разказвач — UI layer.

import * as db from './db.js';
import { parseBook, ACCEPT } from './parsers.js';
import { Player } from './player.js';
import { LANG_NAMES, LOCALES, charLen } from './text.js';
import {
    GEMINI_VOICES, GEMINI_DEFAULT_MODEL, NARRATION_STYLES, PRICES,
    cloudVoices, cloudSynthesize, cloudDiagnose, CLOUD_LINKS, geminiSynthesize, geminiModels, deviceVoices, onDeviceVoicesChanged, cloudTier,
    cheapestGeminiModel, isVerifiedGeminiModel, geminiCost,
} from './engines.js';
import { translateChapter, translationCost, deviceTranslationAvailable, TRANSLATE_DEFAULT_MODEL } from './translate.js';
import { isNative, Native, nativeFileUrl, loadNativeVoices, nativeEngines } from './native.js';
import { submitChapter, pollBatches, hasJobs, pendingChapters, batchEstimate } from './batch.js';
import { usableFreeKey } from './player.js';
import { exportPlan, exportChapters, packageFiles } from './export.js';
import { SHELVES, loadShelf, wikisourceWorks, fetchCatalogBook, sourceKey } from './library.js';
import { usageSummary, resetUsage, hourlyCost, freeHoursPerMonth, recordUsage } from './usage.js';

const $ = (s, root = document) => root.querySelector(s);
const $$ = (s, root = document) => [...root.querySelectorAll(s)];

// ==================== Settings ====================

// Shown in the settings footer; bump with every release
export const APP_VERSION = '2.3';

const SETTINGS_KEY = 'rz_settings';
const DEFAULTS = {
    engine: null, apiKey: '', cloudVoice: '', geminiVoice: 'Charon', geminiModel: '', geminiEconomy: true, geminiFreeKey: '',
    style: 'intriguing', customStyle: '', deviceVoice: '', lang: 'auto', rate: 1, lookahead: 2,
    cacheMB: 500, theme: 'system', readerSize: 19, view: 'cover', cloudReady: false, autoTranslate: 'bg',
    freeOnly: true, geminiCapUsd: 2,
};

let settings = loadSettings();

function preconfiguredKey() {
    const k = window.PRECONFIGURED_API_KEY;
    return typeof k === 'string' && k !== '__GEMINI_API_KEY__' && k.trim() ? k.trim() : '';
}

function loadSettings() {
    let s = {};
    try { s = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}'); } catch {}
    // Migrate the key from the previous version of the app
    if (!s.apiKey) s.apiKey = localStorage.getItem('gemini_tts_api_key') || '';
    // Earlier versions stored the default model explicitly: switch them to "cheapest"
    if (s.geminiModel === GEMINI_DEFAULT_MODEL && !s.geminiModelChosen) s.geminiModel = '';
    s = { ...DEFAULTS, ...s };
    // The Gemini narrator is the main voice; the phone voice is the free fallback
    if (!s.engine) s.engine = (s.apiKey || preconfiguredKey()) ? 'gemini' : 'device';
    return s;
}

function saveSettings() {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
}

// Gemini models available to the key (cached so the cheapest is known at startup)
function knownGeminiModels() {
    try { return JSON.parse(localStorage.getItem('rz_gemini_models') || '[]'); } catch { return []; }
}

function rememberGeminiModels(list) {
    localStorage.setItem('rz_gemini_models', JSON.stringify(list || []));
}

function activeGeminiModel() {
    return settings.geminiModel || cheapestGeminiModel(knownGeminiModels());
}

function geminiCardPrice() {
    const m = activeGeminiModel();
    return settings.geminiEconomy
        ? `от ~${hourlyCost('gemini', m, true).toFixed(2)} $/ч`
        : `~${hourlyCost('gemini', m, false).toFixed(2)} $/ч`;
}

function effectiveSettings() {
    return { ...settings, apiKey: settings.apiKey || preconfiguredKey(), geminiModel: activeGeminiModel() };
}

function applyTheme() {
    if (settings.theme === 'system') document.documentElement.removeAttribute('data-theme');
    else document.documentElement.setAttribute('data-theme', settings.theme);
    document.documentElement.style.setProperty('--reader-size', settings.readerSize + 'px');
}

// ==================== State ====================

const player = new Player(effectiveSettings);
player.rate = settings.rate;
player.charsPerSecond = Number(localStorage.getItem('rz_cps')) || 14;

const coverUrls = new Map();
let currentBook = null;
let sleepTimer = null; // { until, id } | 'chapter'
let cloudVoiceCache = {};
let geminiModelList = null;

// ==================== Helpers ====================

function toast(msg, opts = {}) {
    const el = document.createElement('div');
    el.className = 'toast' + (opts.error ? ' err' : '');
    const span = document.createElement('span');
    span.textContent = msg;
    el.appendChild(span);
    if (opts.action) {
        const b = document.createElement('button');
        b.textContent = opts.action.label;
        b.onclick = () => { opts.action.run(); el.remove(); };
        el.appendChild(b);
    }
    $('#toasts').appendChild(el);
    setTimeout(() => el.remove(), opts.duration || (opts.action ? 7000 : 3500));
}

function esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function fmtDuration(sec) {
    if (!isFinite(sec) || sec <= 0) return '';
    const m = Math.round(sec / 60);
    if (m < 1) return '< 1 мин';
    if (m < 60) return `${m} мин`;
    const h = Math.floor(m / 60);
    return `${h} ч ${m % 60 ? (m % 60) + ' мин' : ''}`.trim();
}

function fmtUsd(v) {
    if (v === 0) return '0 $';
    if (v < 0.01) return '< 0.01 $';
    return v.toFixed(2) + ' $';
}

function approxUsd(v) {
    return v < 0.01 ? 'под 0.01 $' : '~' + fmtUsd(v);
}

function fmtNum(n) {
    return Math.round(n).toLocaleString('bg-BG');
}

function strHash(s) {
    let h = 0;
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
    return Math.abs(h);
}

const COVER_PALETTES = [
    ['#7A3B2E', '#C2703D'], ['#2F4A43', '#5F8A73'], ['#2E3A59', '#6A7FA8'], ['#5A3D5C', '#A07399'],
    ['#4B4032', '#9C8460'], ['#1F3B4D', '#4C8C9E'], ['#6B2F3A', '#B5616B'], ['#33402A', '#7D9361'],
];

function coverHtml(book) {
    if (book.cover) {
        if (!coverUrls.has(book.id)) coverUrls.set(book.id, URL.createObjectURL(book.cover));
        return `<img src="${coverUrls.get(book.id)}" alt="" loading="lazy">`;
    }
    const [a, b] = COVER_PALETTES[strHash(book.title) % COVER_PALETTES.length];
    return `<div class="cover-gen" style="background:linear-gradient(155deg, ${b}, ${a})">
        <span>${esc(book.author || ' ')}</span><hr><b>${esc(book.title)}</b></div>`;
}

function bookProgress(book) {
    const total = book.totalChars || 1;
    const pos = book.position || { c: 0, s: 0 };
    let before = 0;
    for (let c = 0; c < pos.c; c++) before += book.chapterChars[c] || 0;
    const chFrac = book.sentenceCounts?.[pos.c] ? pos.s / book.sentenceCounts[pos.c] : 0;
    before += (book.chapterChars[pos.c] || 0) * chFrac;
    return Math.min(1, before / total);
}

function engineLabel(s = settings) {
    if (s.engine === 'device') {
        const v = deviceVoices(currentLang()).find((x) => x.voiceURI === s.deviceVoice) || deviceVoices(currentLang())[0];
        return v ? v.name.replace(/^(Google|Microsoft)\s*/, '').split(/[(-]/)[0].trim() || 'Устройство' : 'Устройство';
    }
    if (s.engine === 'cloud') {
        const name = s.cloudVoice ? s.cloudVoice.split('-').slice(-1)[0] : 'Google';
        return `${name} · ${PRICES.cloud[cloudTier(s.cloudVoice)]?.label === 'Chirp 3 HD' ? 'HD' : PRICES.cloud[cloudTier(s.cloudVoice)]?.label || ''}`;
    }
    return `${s.geminiVoice} · AI`;
}

function currentLang() {
    if (currentBook?.translateTo) return currentBook.translateTo;
    return settings.lang !== 'auto' ? settings.lang : (currentBook?.lang || 'bg');
}

// ==================== Library ====================

async function allBooks() {
    const books = await db.getAll('books');
    return books.sort((a, b) => (b.lastOpened || b.addedAt) - (a.lastOpened || a.addedAt));
}

async function renderLibrary() {
    renderDiscover();
    const books = await allBooks();
    const has = books.length > 0;
    $('#emptyState').classList.toggle('hidden', has);
    $('#librarySection').classList.toggle('hidden', !has);
    $('#btnAdd').classList.toggle('hidden', !has);

    const last = books.find((b) => b.lastOpened);
    const cont = $('#continueCard');
    if (last) {
        const p = bookProgress(last);
        cont.innerHTML = `
            <div class="cover">${coverHtml(last)}</div>
            <div class="continue-body">
                <span class="eyebrow">Продължете</span>
                <h3>${esc(last.title)}</h3>
                <span class="muted continue-meta truncate">${esc(last.chapterTitles[last.position?.c || 0] || '')}</span>
                <div class="continue-row">
                    <div class="progress-track"><i style="width:${(p * 100).toFixed(1)}%"></i></div>
                    <span class="muted continue-meta">${Math.round(p * 100)}%</span>
                    <button class="continue-play" aria-label="Продължи"><svg class="ic"><use href="#i-play"/></svg></button>
                </div>
            </div>`;
        cont.onclick = (e) => openBook(last.id, !!e.target.closest('.continue-play'));
        cont.classList.remove('hidden');
    } else {
        cont.classList.add('hidden');
    }

    $('#libCount').textContent = has ? `${books.length} ${books.length === 1 ? 'книга' : 'книги'}` : '';
    $('#bookGrid').innerHTML = books.map((b) => {
        const p = bookProgress(b);
        return `<button class="book" data-id="${esc(b.id)}">
            <div class="cover">${coverHtml(b)}</div>
            <span class="book-title">${esc(b.title)}</span>
            ${b.author ? `<span class="book-sub truncate">${esc(b.author)}</span>` : ''}
            ${p > 0.005 ? `<div class="progress-track"><i style="width:${(p * 100).toFixed(1)}%"></i></div>` : ''}
        </button>`;
    }).join('');
}

async function importFile(file) {
    if (!file) return;
    if (file.size > 150 * 1024 * 1024) return toast('Файлът е твърде голям (макс. 150 MB).', { error: true });
    const overlay = $('#importOverlay');
    const arc = $('#importArc');
    $('#importText').textContent = `Подготвям „${file.name.replace(/\.[^.]+$/, '')}“…`;
    arc.style.strokeDashoffset = 125.7;
    overlay.classList.remove('hidden');
    try {
        const parsed = await parseBook(file, (p) => { arc.style.strokeDashoffset = 125.7 * (1 - p); });
        await saveImported(parsed, { fileName: file.name });
    } catch (e) {
        overlay.classList.add('hidden');
        console.error(e);
        toast(e.message || 'Неуспешно четене на файла.', { error: true, duration: 6000 });
    }
}

// Store a parsed book (from a file or from the catalog) and open it.
async function saveImported(parsed, { fileName = '', source = null, translateTo } = {}) {
    const overlay = $('#importOverlay');
    {
        const id = 'b' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
        const chapterChars = parsed.chapters.map((c) => c.paras.reduce((n, p) => n + p.length + 1, c.title.length + 1));
        const meta = {
            id, title: parsed.title, author: parsed.author, lang: parsed.lang, cover: parsed.cover || null,
            chapterTitles: parsed.chapters.map((c) => c.title), chapterChars,
            totalChars: chapterChars.reduce((a, b) => a + b, 0), sentenceCounts: [],
            addedAt: Date.now(), lastOpened: 0, position: { c: 0, s: 0 }, fileName,
            translateTo: translateTo !== undefined ? translateTo
                : settings.autoTranslate && parsed.lang !== settings.autoTranslate ? settings.autoTranslate : null,
            // Public-domain catalog books share narration and translations with everyone
            source: source ? { type: source.source, id: source.id } : null,
            sourceKey: source?.key || '',
            shared: !!source,
        };
        await db.put('contents', { id, chapters: parsed.chapters });
        await db.put('books', meta);
        db.requestPersistence();
        overlay.classList.add('hidden');
        await renderLibrary();
        const hours = meta.totalChars / (player.charsPerSecond * 3600);
        const n = parsed.chapters.length;
        toast(`Добавена: ${n} ${n === 1 ? 'глава' : 'глави'} · ${fmtDuration(hours * 3600) || '< 1 мин'} слушане`);
        await openBook(id, false);
        if (meta.translateTo) {
            setTimeout(() => toast(`Книгата е на ${LANG_NAMES[parsed.lang] || parsed.lang} — ще я чета на ${LANG_NAMES[meta.translateTo]}. Превежда се глава по глава при слушане (${approxUsd(translationCost(meta.totalChars))} за цялата книга).`, {
                duration: 10000, action: { label: 'Чети оригинала', run: () => setBookTranslation(null) },
            }), 600);
        }
    }
}

// ==================== Discover (public-domain catalog) ====================

const shelfData = {};

async function renderDiscover() {
    const box = $('#shelves');
    if (!box || box.dataset.ready) return;
    box.dataset.ready = '1';
    box.innerHTML = SHELVES.map((sh) => `
        <section class="shelf" data-shelf="${sh.id}">
            <div class="shelf-head"><h3>${esc(sh.title)}</h3><span class="muted">${esc(sh.note || '')}</span></div>
            <div class="shelf-row"><div class="shelf-loading muted">Зареждам…</div></div>
        </section>`).join('');
    for (const sh of SHELVES) {
        const row = box.querySelector(`[data-shelf="${sh.id}"] .shelf-row`);
        try {
            const { items, next } = await loadShelf(sh, 1);
            shelfData[sh.id] = { items, next };
            if (!items.length) { row.closest('.shelf').remove(); continue; }
            row.innerHTML = items.map((it, i) => shelfCard(it, sh.id, i)).join('');
            if (next) row.insertAdjacentHTML('beforeend', `<button class="shelf-more" data-more="${sh.id}">Още</button>`);
        } catch (e) {
            row.innerHTML = `<div class="shelf-loading muted">${esc(e.message)}</div>`;
        }
    }
}

function shelfCard(it, shelfId, i) {
    // Generated cover underneath; the real one covers it once it loads
    const cover = coverHtml({ title: it.title, author: it.source === 'wikisource-author' ? '' : it.author })
        + (it.cover ? `<img class="cover-img" src="${esc(it.cover)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.remove()">` : '');
    return `<button class="shelf-card" data-shelf-id="${shelfId}" data-i="${i}">
        <div class="cover">${cover}</div>
        <span class="book-title">${esc(it.title)}</span>
        ${it.author ? `<span class="book-sub truncate">${esc(it.author)}</span>` : ''}
    </button>`;
}

async function openCatalogItem(it) {
    if (it.source === 'wikisource-author') {
        openSheet(it.title, (body) => {
            body.innerHTML = '<p class="hint">Зареждам произведенията от Wikisource…</p>';
            wikisourceWorks(it.lang, it.title).then((works) => {
                body.innerHTML = works.length
                    ? `<p class="hint" style="margin:0 0 6px">Обществено достояние · bg.wikisource.org</p><div class="list">${works.map((w, i) => `<button class="list-item" data-w="${i}"><span class="grow">${esc(w.title)}</span></button>`).join('')}</div>`
                    : '<p class="hint">Не открих произведения.</p>';
                body.onclick = (e) => {
                    const b = e.target.closest('[data-w]');
                    if (b) { closeSheet(); importCatalog(works[Number(b.dataset.w)], {}); }
                };
            }).catch((e) => { body.innerHTML = `<p class="hint">${esc(e.message)}</p>`; });
        });
        return;
    }
    openSheet(it.title, (body) => {
        const foreign = it.translateTo && it.lang !== it.translateTo;
        body.innerHTML = `
            <div class="catalog-book">
                <div class="cover">${coverHtml({ title: it.title, author: it.author })}${it.cover ? `<img class="cover-img" src="${esc(it.cover)}" alt="" referrerpolicy="no-referrer" onerror="this.remove()">` : ''}</div>
                <div>
                    <p class="catalog-author">${esc(it.author || '')}</p>
                    <p class="hint" style="margin-top:6px">Обществено достояние · ${it.source === 'gutenberg' ? 'Project Gutenberg' : 'Wikisource'} · ${esc(LANG_NAMES[it.lang] || it.lang)}</p>
                    <p class="hint">Веднъж прочетена от разказвача, книгата се пази и следващите слушатели не плащат за нея.</p>
                </div>
            </div>
            <div class="catalog-actions">
                ${foreign ? `<button class="btn btn-primary" data-act="tr">Слушай на ${esc(LANG_NAMES[it.translateTo].toLowerCase())}</button>
                    <button class="btn btn-ghost" data-act="orig">Оригинал (${esc(LANG_NAMES[it.lang] || it.lang)})</button>`
                : '<button class="btn btn-primary" data-act="orig">Добави и слушай</button>'}
            </div>`;
        body.onclick = (e) => {
            const act = e.target.closest('[data-act]')?.dataset.act;
            if (!act) return;
            closeSheet();
            importCatalog(it, { translateTo: act === 'tr' ? it.translateTo : null });
        };
    });
}

async function importCatalog(item, { translateTo = null }) {
    const key = await sourceKey(item);
    const existing = (await allBooks()).find((b) => b.sourceKey === key);
    if (existing) return openBook(existing.id, false);
    const overlay = $('#importOverlay');
    const arc = $('#importArc');
    $('#importText').textContent = `Изтеглям „${item.title}“…`;
    arc.style.strokeDashoffset = 125.7;
    overlay.classList.remove('hidden');
    try {
        const parsed = await fetchCatalogBook(item, (p) => { arc.style.strokeDashoffset = 125.7 * (1 - p); });
        await saveImported(parsed, { fileName: item.title, source: { ...item, key }, translateTo: translateTo && parsed.lang !== translateTo ? translateTo : null });
    } catch (e) {
        overlay.classList.add('hidden');
        console.error(e);
        toast(e.message || 'Книгата не можа да се изтегли.', { error: true, duration: 6000 });
    }
}

async function deleteBook(id) {
    if (player.book?.id === id) {
        player.stop();
        player.book = null;
        currentBook = null;
        hidePlayer();
        updateMini();
    }
    await db.del('books', id);
    await db.del('contents', id);
    await db.audioDeleteBook(id);
    await db.transDeleteBook(id).catch(() => {});
    if (coverUrls.has(id)) { URL.revokeObjectURL(coverUrls.get(id)); coverUrls.delete(id); }
    renderLibrary();
    toast('Книгата е премахната.');
}

// ==================== Player view ====================

async function openBook(id, autoplay) {
    if (player.book?.id === id) {
        showPlayer();
        if (autoplay) startPlayback();
        return;
    }
    const meta = await db.get('books', id);
    const content = await db.get('contents', id);
    if (!meta || !content) return toast('Книгата не е намерена.', { error: true });
    meta.lastOpened = Date.now();
    if (meta.cover && !coverUrls.has(id)) coverUrls.set(id, URL.createObjectURL(meta.cover));
    meta.coverUrl = coverUrls.get(id) || '';
    currentBook = meta;
    player.translator = (c, chapter, onProgress) => translateChapter({
        bookId: player.book.id, c, chapter, from: player.book.lang, to: player.book.translateTo,
        apiKey: effectiveSettings().apiKey, model: settings.translateModel || TRANSLATE_DEFAULT_MODEL, onProgress,
        sharedKey: player.book.shared ? player.book.sourceKey : '',
    });
    await player.load(meta, content.chapters);
    // Store sentence counts once so library progress is accurate
    if (!meta.sentenceCounts?.length) {
        meta.sentenceCounts = content.chapters.map((_, c) => player.model(c).sentences.length);
    }
    persistBook();
    renderPlayerStatic();
    showPlayer();
    renderLibrary();
    if (autoplay) startPlayback();
    checkPendingExport().catch(() => {});
}

function setBookTranslation(to) {
    if (!currentBook || (currentBook.translateTo || null) === (to || null)) return;
    player.setTranslation(to);
    currentBook.translateTo = to || null;
    persistBook();
    renderedChapter = -1;
    updatePlayerUI();
    toast(to ? `Ще чета на ${LANG_NAMES[to]}.` : 'Ще чета оригинала.');
}

function persistBook() {
    if (!currentBook) return;
    const { coverUrl, ...rec } = currentBook;
    db.put('books', rec).catch(() => {});
}

let saveTimer = null;
function scheduleSave() {
    if (!currentBook) return;
    currentBook.position = { ...player.pos };
    currentBook.lastOpened = Date.now();
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
        persistBook();
        localStorage.setItem('rz_cps', String(player.charsPerSecond.toFixed(2)));
    }, 1200);
}

function showPlayer() {
    $('#viewPlayer').classList.remove('hidden');
    document.body.style.overflow = 'hidden';
    updateMini();
    applyStageView();
    history.replaceState(null, '', '#play');
}

function hidePlayer() {
    $('#viewPlayer').classList.add('hidden');
    document.body.style.overflow = '';
    updateMini();
    history.replaceState(null, '', location.pathname + location.search);
}

function renderPlayerStatic() {
    const b = currentBook;
    $('#pTopTitle').textContent = b.title;
    $('#pTitle').textContent = b.title;
    $('#pAuthor').textContent = b.author || '';
    $('#pCover').innerHTML = coverHtml(b);
    $('#textStage').setAttribute('lang', b.lang || 'bg');
    renderedChapter = -1;
    updatePlayerUI();
}

let renderedChapter = -1;

function applyStageView() {
    const text = settings.view === 'text';
    $('#coverStage').classList.toggle('hidden', text);
    $('#textStage').classList.toggle('hidden', !text);
    $('#chipText').classList.toggle('on', text);
    $('#chipText').innerHTML = `<svg class="ic ic-sm"><use href="#${text ? 'i-cover' : 'i-text'}"/></svg>`;
    if (text) renderText(true);
}

function renderText(force) {
    if (!currentBook || settings.view !== 'text') return;
    const c = player.pos.c;
    const stage = $('#textStage');
    if (renderedChapter !== c || force) {
        const m = player.model(c);
        let html = '';
        m.paras.forEach((p) => {
            const spans = [];
            for (let i = p.first; i < p.last; i++) spans.push(`<span data-s="${i}">${esc(m.sentences[i].t)}</span>`);
            html += p.h ? `<h4>${spans.join(' ')}</h4>` : `<p>${spans.join(' ')}</p>`;
        });
        stage.innerHTML = html;
        renderedChapter = c;
        lastHighlighted = null;
    }
    highlight(true);
}

let lastHighlighted = null;
let userScrolledAt = 0;

function highlight(jump) {
    if (settings.view !== 'text' || renderedChapter !== player.pos.c) return;
    const el = $(`#textStage span[data-s="${player.pos.s}"]`);
    if (el === lastHighlighted) return;
    lastHighlighted?.classList.remove('now');
    if (!el) return;
    el.classList.add('now');
    lastHighlighted = el;
    if (Date.now() - userScrolledAt > 5000 || jump) {
        const stage = $('#textStage');
        const top = el.offsetTop - stage.clientHeight * 0.32;
        stage.scrollTo({ top, behavior: jump ? 'auto' : 'smooth' });
    }
}

function updatePlayerUI() {
    if (!currentBook) return;
    const { c, s } = player.pos;
    const m = player.model(c);
    const n = m.sentences.length;
    $('#pChapter').textContent = currentBook.chapterTitles[c] || `Глава ${c + 1}`;
    const slider = $('#chapterSlider');
    slider.max = Math.max(1, n - 1);
    if (!sliderDragging) slider.value = s;
    slider.style.setProperty('--p', `${(s / Math.max(1, n - 1)) * 100}%`);
    const p = bookProgress({ ...currentBook, position: player.pos });
    $('#pPos').textContent = `Глава ${c + 1} от ${currentBook.chapterTitles.length} · ${Math.round(p * 100)}%`;
    const chRem = player.chapterRemainingSeconds();
    const bookRem = player.remainingSeconds();
    $('#pRemain').textContent = chRem > 30 ? `${fmtDuration(chRem)} до края на главата` : (bookRem > 60 ? `${fmtDuration(bookRem)} общо` : '');
    $('#btnPrevCh').disabled = c === 0 && s === 0;
    $('#btnNextCh').disabled = c >= currentBook.chapterTitles.length - 1;
    $('#speedLabel').textContent = player.rate.toFixed(player.rate * 10 % 1 ? 2 : 1) + '×';
    $('#voiceLabel').textContent = engineLabel();
    updatePlayState();
    updateMini();
    if (settings.view === 'text') {
        if (renderedChapter !== c) renderText(false);
        else highlight(false);
    }
}

function updatePlayState() {
    const playing = player.playing;
    const loading = player.loading && playing;
    for (const btn of [$('#btnPlay'), $('#miniPlay')]) {
        btn.querySelector('use').setAttribute('href', playing ? '#i-pause' : '#i-play');
        btn.classList.toggle('is-paused', !playing);
        btn.classList.toggle('is-loading', loading);
        btn.setAttribute('aria-label', playing ? 'Пауза' : 'Пусни');
    }
    $('#pStatus').textContent = loading
        ? (settings.engine === 'gemini' ? 'Разказвачът подготвя гласа…' : 'Подготвям гласа…')
        : '';
    if ('mediaSession' in navigator) navigator.mediaSession.playbackState = playing ? 'playing' : 'paused';
}

function updateMini() {
    const mini = $('#miniPlayer');
    const show = !!currentBook && $('#viewPlayer').classList.contains('hidden');
    mini.classList.toggle('hidden', !show);
    document.body.classList.toggle('has-mini', show);
    if (!show) return;
    if (mini.dataset.id !== currentBook.id) {
        $('#miniCover').innerHTML = coverHtml(currentBook);
        mini.dataset.id = currentBook.id;
    }
    $('#miniTitle').textContent = currentBook.title;
    $('#miniChapter').textContent = currentBook.chapterTitles[player.pos.c] || '';
    $('#miniProgress').style.width = (bookProgress({ ...currentBook, position: player.pos }) * 100).toFixed(1) + '%';
}

async function startPlayback() {
    if (!currentBook) return;
    if (!player.current) unlockAudio(player.audio);
    const st = effectiveSettings();
    if (st.engine === 'cloud' && (!st.apiKey || !settings.cloudReady)) {
        openCloudSetup({ thenPlay: true });
        return;
    }
    if (st.engine !== 'device' && !st.apiKey) {
        toast('За естествените гласове е нужен Google API ключ. Засега чета с гласа на устройството.', {
            action: { label: 'Настройки', run: openSettings },
        });
        settings.engine = 'device';
        saveSettings();
        updatePlayerUI();
    }
    if (settings.engine === 'cloud' && !settings.cloudVoice) {
        const ok = await pickDefaultCloudVoice();
        if (!ok) return;
    }
    player.play();
}

async function pickDefaultCloudVoice() {
    try {
        const voices = await loadCloudVoices(currentLang());
        if (!voices.length) {
            toast(`Google няма гласове за ${LANG_NAMES[currentLang()] || currentLang()}. Изберете друг двигател.`, { error: true });
            return false;
        }
        const preferred = voices.find((v) => v.tier === 'Chirp3-HD' && /Charon|Kore|Aoede|Orus/.test(v.name)) || voices[0];
        settings.cloudVoice = preferred.name;
        saveSettings();
        updatePlayerUI();
        return true;
    } catch (e) {
        toast(e.message, { error: true, duration: 7000, action: { label: 'Настройки', run: openSettings } });
        return false;
    }
}

async function loadCloudVoices(lang) {
    if (cloudVoiceCache[lang]) return cloudVoiceCache[lang];
    const voices = await cloudVoices(effectiveSettings().apiKey, lang);
    cloudVoiceCache[lang] = voices;
    return voices;
}

function goChapter(delta) {
    if (!currentBook) return;
    let { c, s } = player.pos;
    if (delta < 0 && s > 2) return player.seekTo(c, 0);
    c = Math.max(0, Math.min(currentBook.chapterTitles.length - 1, c + delta));
    player.seekTo(c, 0);
}

// ==================== Sheets ====================

let sheetOnClose = null;

function openSheet(title, render, onClose) {
    $('#sheetTitle').textContent = title;
    const body = $('#sheetBody');
    body.innerHTML = '';
    body.scrollTop = 0;
    render(body);
    sheetOnClose = onClose || null;
    $('#sheet').classList.remove('hidden');
    $('#sheetBackdrop').classList.remove('hidden');
}

function closeSheet() {
    $('#sheet').classList.add('hidden');
    $('#sheetBackdrop').classList.add('hidden');
    const cb = sheetOnClose;
    sheetOnClose = null;
    cb?.();
}

function rerenderSheet(render) {
    const body = $('#sheetBody');
    const top = body.scrollTop;
    body.innerHTML = '';
    render(body);
    body.scrollTop = top;
}

// ---------- Chapters ----------

function openChapters() {
    if (!currentBook) return;
    openSheet('Навигация', (body) => {
        const cur = player.pos.c;
        const total = currentBook.chapterChars.reduce((x, y) => x + y, 0) || 1;
        const starts = [];
        currentBook.chapterChars.reduce((acc, n, i) => { starts[i] = acc; return acc + n; }, 0);
        const p = bookProgress({ ...currentBook, position: player.pos });
        const listened = (i) => i < cur;
        body.innerHTML = `
            <div class="nav-book">
                <div class="nav-book-head"><span class="group-title" style="margin:0">Цялата книга</span><span id="bookPct" class="muted">${Math.round(p * 100)}%</span></div>
                <input id="bookRange" class="slider" type="range" min="0" max="1000" step="1" value="${Math.round(p * 1000)}" aria-label="Позиция в книгата">
                <p id="bookPreview" class="nav-preview">${esc(currentBook.chapterTitles[cur] || '')}</p>
            </div>
            <div class="nav-search">
                <input id="bookSearch" class="input" type="search" placeholder="Търси дума или израз в книгата" autocomplete="off">
            </div>
            <div id="searchResults" class="list"></div>
            <div class="group-title" style="margin-top:18px" id="chaptersTitle">Глави</div>
            <div class="list" id="chapterList">${currentBook.chapterTitles.map((t, i) => `
                <button class="list-item ${i === cur ? 'on' : ''} ${listened(i) ? 'done' : ''}" data-c="${i}">
                    <span class="num">${i + 1}</span>
                    <span class="grow"><span class="truncate" style="display:block">${esc(t)}</span>
                    <small>${fmtDuration((currentBook.chapterChars[i] || 0) / player.charsPerSecond / player.rate) || '< 1 мин'}</small></span>
                    ${i === cur ? '<svg class="ic ic-sm"><use href="#i-voice"/></svg>' : listened(i) ? '<svg class="ic ic-sm" style="opacity:.5"><use href="#i-check"/></svg>' : ''}
                </button>`).join('')}</div>`;

        // Whole-book scrubber: preview while dragging, jump on release
        const range = $('#bookRange', body);
        const locate = (v) => {
            const at = v / 1000 * total;
            let c = 0;
            while (c + 1 < starts.length && starts[c + 1] <= at) c++;
            const frac = Math.min(1, Math.max(0, (at - starts[c]) / (currentBook.chapterChars[c] || 1)));
            return { c, frac };
        };
        const paint = () => range.style.setProperty('--p', `${range.value / 10}%`);
        paint();
        range.oninput = () => {
            paint();
            const { c, frac } = locate(Number(range.value));
            $('#bookPct', body).textContent = Math.round(range.value / 10) + '%';
            $('#bookPreview', body).textContent = `${c + 1}. ${currentBook.chapterTitles[c] || ''} · ${Math.round(frac * 100)}% от главата`;
        };
        range.onchange = () => {
            const { c, frac } = locate(Number(range.value));
            const n = player.model(c).sentences.length;
            player.seekTo(c, Math.min(n - 1, Math.round(frac * n)));
            closeSheet();
        };

        // Full-text search across the book (local, no network)
        let timer = null;
        const search = $('#bookSearch', body);
        search.oninput = () => {
            clearTimeout(timer);
            timer = setTimeout(() => renderSearch(body, search.value.trim()), 220);
        };

        body.onclick = (e) => {
            const r = e.target.closest('[data-hit]');
            if (r) {
                const [c, pi, q] = [Number(r.dataset.c), Number(r.dataset.p), r.dataset.q];
                const m = player.model(c);
                const ch = player.chapter(c);
                const offset = ch.title && !ch.auto ? 1 : 0;
                const para = m.paras[pi + offset] || m.paras[0];
                let target = para.first;
                for (let i = para.first; i < para.last; i++) {
                    if (m.sentences[i].t.toLowerCase().includes(q)) { target = i; break; }
                }
                player.seekTo(c, target);
                closeSheet();
                return;
            }
            const item = e.target.closest('[data-c]');
            if (!item) return;
            player.seekTo(Number(item.dataset.c), 0);
            closeSheet();
        };
        setTimeout(() => body.querySelector('#chapterList .on')?.scrollIntoView({ block: 'center' }), 50);
    });
}

function renderSearch(body, q) {
    const box = $('#searchResults', body);
    if (!box) return;
    if (q.length < 3) { box.innerHTML = ''; return; }
    const needle = q.toLowerCase();
    const hits = [];
    for (let c = 0; c < player.chapters.length && hits.length < 40; c++) {
        const ch = player.chapter(c);
        ch.paras.forEach((para, pi) => {
            if (hits.length >= 40) return;
            const i = para.toLowerCase().indexOf(needle);
            if (i < 0) return;
            const from = Math.max(0, i - 50);
            const snip = (from ? '…' : '') + esc(para.slice(from, i)) + '<mark>' + esc(para.slice(i, i + q.length)) + '</mark>' + esc(para.slice(i + q.length, i + q.length + 70)) + '…';
            hits.push(`<button class="list-item" data-hit data-c="${c}" data-p="${pi}" data-q="${esc(needle)}">
                <span class="num">${c + 1}</span><span class="grow"><span class="snippet">${snip}</span><small>${esc(currentBook.chapterTitles[c] || '')}</small></span></button>`);
        });
    }
    box.innerHTML = hits.length ? hits.join('') : '<p class="hint">Няма съвпадения.</p>';
}

// ---------- Speed ----------

function openSpeed() {
    const render = (body) => {
        body.innerHTML = `
            <div class="speed-big">${player.rate.toFixed(2).replace(/0$/, '')}×</div>
            <input id="speedRange" class="slider" type="range" min="0.6" max="2.5" step="0.05" value="${player.rate}">
            <div class="pills" style="justify-content:center;margin-top:16px">
                ${[0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2].map((r) => `<button class="pill ${Math.abs(player.rate - r) < 0.01 ? 'on' : ''}" data-r="${r}">${r}×</button>`).join('')}
            </div>
            <p class="hint" style="text-align:center">Скоростта не струва нищо — аудиото не се генерира наново.</p>`;
        const range = $('#speedRange', body);
        const paint = () => range.style.setProperty('--p', `${((range.value - 0.6) / 1.9) * 100}%`);
        paint();
        range.oninput = () => { $('.speed-big', body).textContent = Number(range.value).toFixed(2).replace(/0$/, '') + '×'; paint(); };
        range.onchange = () => setRate(Number(range.value), body, render);
        body.onclick = (e) => {
            const p = e.target.closest('[data-r]');
            if (p) setRate(Number(p.dataset.r), body, render);
        };
    };
    openSheet('Скорост', render);
}

function setRate(r, body, render) {
    player.setRate(r);
    settings.rate = r;
    saveSettings();
    updatePlayerUI();
    rerenderSheet(render);
}

// ---------- Sleep timer ----------

function openSleep() {
    openSheet('Таймер за сън', (body) => {
        const opts = [[0, 'Изключен'], [10, '10 минути'], [20, '20 минути'], [30, '30 минути'], [45, '45 минути'], [60, '1 час'], ['chapter', 'До края на главата']];
        const active = sleepTimer === 'chapter' ? 'chapter' : sleepTimer ? 'time' : 0;
        body.innerHTML = `<div class="list">${opts.map(([v, l]) => {
            const on = (v === 0 && !active) || (v === 'chapter' && active === 'chapter');
            return `<button class="list-item ${on ? 'on' : ''}" data-v="${v}"><span class="grow">${l}</span>${on ? '<svg class="ic ic-sm"><use href="#i-check"/></svg>' : ''}</button>`;
        }).join('')}</div>
        ${active === 'time' ? `<p class="hint">Остават ${Math.max(1, Math.ceil((sleepTimer.until - Date.now()) / 60000))} мин.</p>` : ''}`;
        body.onclick = (e) => {
            const it = e.target.closest('[data-v]');
            if (!it) return;
            setSleep(it.dataset.v === 'chapter' ? 'chapter' : Number(it.dataset.v));
            closeSheet();
        };
    });
}

function setSleep(v) {
    if (sleepTimer && sleepTimer !== 'chapter') clearInterval(sleepTimer.id);
    sleepTimer = null;
    player.sleepAtChapterEnd = false;
    if (v === 'chapter') {
        sleepTimer = 'chapter';
        player.sleepAtChapterEnd = true;
        toast('Ще спра в края на главата.');
    } else if (v > 0) {
        const until = Date.now() + v * 60000;
        sleepTimer = {
            until,
            id: setInterval(() => {
                const left = sleepTimer.until - Date.now();
                if (left <= 8000 && left > 0) player.audio.volume = Math.max(0.05, left / 8000);
                if (left <= 0) {
                    clearInterval(sleepTimer.id);
                    sleepTimer = null;
                    player.pause();
                    player.audio.volume = 1;
                    updateSleepChip();
                    return;
                }
                updateSleepChip();
            }, 1000),
        };
        if (!player.playing) startPlayback();
        toast(`Ще спра след ${v} минути.`);
    }
    player.audio.volume = 1;
    updateSleepChip();
}

function updateSleepChip() {
    const chip = $('#chipSleep');
    let label = '';
    if (sleepTimer === 'chapter') label = 'Глава';
    else if (sleepTimer) label = Math.max(1, Math.ceil((sleepTimer.until - Date.now()) / 60000)) + ' мин';
    $('#sleepLabel').textContent = label;
    chip.classList.toggle('on', !!sleepTimer);
}

// ---------- Book menu ----------

function openBookMenu() {
    if (!currentBook) return;
    openSheet(currentBook.title, (body) => {
        const hours = currentBook.totalChars / player.charsPerSecond / 3600;
        const costRow = (label, v) => `<div class="row"><span class="row-label">${label}</span><span class="muted">${v}</span></div>`;
        const freeHrs = freeHoursPerMonth('Chirp3-HD');
        body.innerHTML = `
            <div class="group">
                ${costRow('Обем', `${fmtNum(currentBook.totalChars)} знака · ~${hours.toFixed(1)} ч`)}
                ${costRow('Език', LANG_NAMES[currentBook.lang] || currentBook.lang)}
                ${costRow('Цена с гласа на устройството', '0 $')}
                ${costRow('Цена с Google HD', hours <= freeHrs ? 'безплатно (в месечния лимит)' : '~' + fmtUsd(Math.max(0, hours - freeHrs) * hourlyCost('cloud')))}
                ${costRow('Цена с Gemini разказвач', '~' + fmtUsd(hours * hourlyCost('gemini', activeGeminiModel(), settings.geminiEconomy)) + (settings.geminiEconomy ? ' (−50%)' : ''))}
            </div>
            ${currentBook.lang !== 'bg' ? `<div class="group">
                <div class="group-title">Превод</div>
                <div class="seg" id="bookTranslate">
                    <button data-t="" class="${!currentBook.translateTo ? 'on' : ''}">Оригинал (${esc(LANG_NAMES[currentBook.lang] || currentBook.lang)})</button>
                    <button data-t="bg" class="${currentBook.translateTo === 'bg' ? 'on' : ''}">На български</button>
                </div>
                <p class="hint" id="transHint">Превежда се само главата, която слушате, и преводът се пази — всяка глава се плаща веднъж. Цялата книга: ${approxUsd(translationCost(currentBook.totalChars))} (Gemini Flash-Lite).</p>
            </div>` : ''}
            <div class="group list">
                ${settings.engine === 'gemini' ? `<button class="list-item" data-a="batch"><span class="grow">Подготви следващите 3 глави на ½ цена<small>Gemini Batch: ~${approxUsd(batchEstimate(activeGeminiModel(), nextChaptersChars(3)))} · готово обикновено до няколко часа${pendingChapters(currentBook.id).length ? ` · в момента се подготвят ${pendingChapters(currentBook.id).length}` : ''}</small></span></button>` : ''}
                <button class="list-item" data-a="export"><span class="grow">Изтегли като аудиокнига<small>Аудиофайл (.ogg) за всеки плейър · вече чутото е безплатно</small></span></button>
                <button class="list-item" data-a="prepare"><span class="grow">Подготви текущата глава за офлайн<small>Генерира цялата глава предварително (същата цена като слушане)</small></span></button>
                <button class="list-item" data-a="restart"><span class="grow">Започни отначало</span></button>
                <button class="list-item danger" data-a="delete"><span class="grow">Премахни книгата</span></button>
            </div>`;
        if (currentBook.lang !== 'bg') {
            deviceTranslationAvailable(currentBook.lang, 'bg').then((ok) => {
                const h = $('#transHint', body);
                if (ok && h) h.textContent = 'Браузърът има вграден преводач — преводът е безплатен и става на устройството.';
            });
        }
        body.onclick = async (e) => {
            const t = e.target.closest('#bookTranslate [data-t]');
            if (t) {
                setBookTranslation(t.dataset.t || null);
                $$('#bookTranslate button', body).forEach((b) => b.classList.toggle('on', b === t));
                return;
            }
            const a = e.target.closest('[data-a]')?.dataset.a;
            if (!a) return;
            if (a === 'delete') {
                if (confirm(`Да премахна ли „${currentBook.title}“ и запазеното аудио?`)) { closeSheet(); deleteBook(currentBook.id); }
            } else if (a === 'export') {
                closeSheet();
                openExport();
            } else if (a === 'batch') {
                closeSheet();
                prepareAhead(3, true);
            } else if (a === 'restart') {
                closeSheet();
                player.seekTo(0, 0);
            } else if (a === 'prepare') {
                closeSheet();
                if (settings.engine === 'device') return toast('Гласът на устройството работи офлайн и без подготовка.');
                if (!effectiveSettings().apiKey) return toast('Нужен е API ключ.', { error: true });
                if (settings.engine === 'cloud' && !settings.cloudVoice && !(await pickDefaultCloudVoice())) return;
                const c = player.pos.c;
                toast('Подготвям главата…');
                try {
                    await player.prepareChapter(c, (p) => { $('#pStatus').textContent = `Офлайн подготовка: ${Math.round(p * 100)}%`; });
                    $('#pStatus').textContent = '';
                    toast('Главата е готова за слушане без интернет.');
                } catch (err) {
                    $('#pStatus').textContent = '';
                    toast(err.message, { error: true });
                }
            }
        };
    });
}

// ---------- Settings ----------

function openSettings() {
    openSheet('Настройки', renderSettings, () => {
        if (currentBook) updatePlayerUI();
    });
}

function renderSettings(body) {
    const st = effectiveSettings();
    const lang = currentLang();
    const hasPreKey = !!preconfiguredKey();
    const freeHrs = Math.round(freeHoursPerMonth('Chirp3-HD'));
    const engines = [
        ['gemini', 'Gemini разказвач', 'Най-жива интонация: разказвачът „играе“ текста според избран стил и езика на книгата.', geminiCardPrice(), settings.geminiEconomy ? 'до −50% с пестелив режим' : 'плаща се само чутото'],
        ['device', 'Гласът на телефона', 'Безплатно и офлайн. Качеството зависи от устройството.', '0 $', 'завинаги'],
        ['cloud', 'Google HD гласове', `Chirp 3 HD. ~${freeHrs} ч месечно безплатно, но на български звучат по-слабо от разказвача.`, 'безплатно', `после ~${hourlyCost('cloud').toFixed(2)} $/ч`],
    ];
    body.innerHTML = `
        <section class="group">
            <div class="group-title">Глас за четене</div>
            <div class="engine-list">
                ${engines.map(([id, name, desc, price, sub]) => `
                <button class="engine ${settings.engine === id ? 'on' : ''}" data-engine="${id}">
                    <span class="engine-name">${name}${id === 'gemini' ? '<span class="badge">Препоръчан</span>' : ''}</span>
                    <span class="engine-price">${price}<small>${sub}</small></span>
                    <span class="engine-desc">${desc}</span>
                </button>`).join('')}
            </div>
        </section>

        <section class="group" id="voiceGroup"></section>

        <section class="group">
            <div class="group-title">Език на четене</div>
            <select class="select" id="setLang">
                <option value="auto">Автоматично (${esc(LANG_NAMES[currentBook?.lang] || 'по книгата')})</option>
                ${Object.entries(LANG_NAMES).map(([k, v]) => `<option value="${k}" ${settings.lang === k ? 'selected' : ''}>${v}</option>`).join('')}
            </select>
        </section>

        <section class="group">
            <div class="group-title">Google API ключ</div>
            ${hasPreKey && !settings.apiKey ? '<p class="hint" style="margin:0 0 8px">Използва се вграден ключ. Можете да въведете собствен.</p>' : ''}
            <div class="field">
                <input class="input" id="setKey" type="password" autocomplete="off" spellcheck="false" placeholder="AIza…" value="${esc(settings.apiKey)}">
                <button class="btn btn-ghost btn-sm" id="btnTestKey">Провери</button>
            </div>
            <p class="hint" id="keyStatus"></p>
            <p class="hint">Един ключ за всички AI гласове — създава се безплатно в <a href="https://aistudio.google.com/apikey" target="_blank" rel="noopener">Google AI Studio</a>. За Google HD използвайте <a href="#" data-setup-link>съветника за свързване</a> — той сам открива какво липсва. Ключът остава само на това устройство.</p>
        </section>

        <section class="group">
            <div class="group-title">Икономия</div>
            <div class="row">
                <span class="row-label">Google HD само безплатно<small>Спира при 95% от безплатния месечен лимит</small></span>
                <select class="select" id="setFreeOnly">
                    <option value="1" ${settings.freeOnly ? 'selected' : ''}>Да</option>
                    <option value="0" ${!settings.freeOnly ? 'selected' : ''}>Не</option>
                </select>
            </div>
            <div class="row">
                <span class="row-label">Месечен лимит за Gemini<small>Над него четенето минава на гласа на телефона</small></span>
                <select class="select" id="setGeminiCap">
                    ${[[0.5, '0.5 $'], [1, '1 $'], [2, '2 $'], [5, '5 $'], [10, '10 $'], [0, 'Без лимит']].map(([v, l]) => `<option value="${v}" ${settings.geminiCapUsd === v ? 'selected' : ''}>${l}</option>`).join('')}
                </select>
            </div>

            <div class="row">
                <span class="row-label">Пазене на аудио<small id="cacheInfo">…</small></span>
                <select class="select" id="setCache">
                    ${[200, 500, 1000, 2000, 4000].map((n) => `<option value="${n}" ${settings.cacheMB === n ? 'selected' : ''}>${n >= 1000 ? n / 1000 + ' GB' : n + ' MB'}</option>`).join('')}
                </select>
            </div>
            <div class="row">
                <span class="row-label">Изчисти запазеното аудио<small>Следващото слушане ще се генерира наново</small></span>
                <button class="btn btn-ghost btn-sm" id="btnClearCache">Изчисти</button>
            </div>
        </section>

        <section class="group">
            <div class="group-title">Разход този месец</div>
            <div class="usage" id="usageBox"></div>
        </section>

        <section class="group">
            <div class="group-title">Изглед</div>
            <div class="seg" id="setTheme">
                ${[['system', 'Система'], ['light', 'Светла'], ['dark', 'Тъмна']].map(([v, l]) => `<button data-v="${v}" class="${settings.theme === v ? 'on' : ''}">${l}</button>`).join('')}
            </div>
            <div class="row" style="margin-top:8px">
                <span class="row-label">Размер на текста</span>
                <div class="seg" id="setSize" style="width:180px">
                    ${[[16, 'A'], [19, 'A'], [22, 'A']].map(([v, l], i) => `<button data-v="${v}" class="${settings.readerSize === v ? 'on' : ''}" style="font-size:${12 + i * 3}px">${l}</button>`).join('')}
                </div>
            </div>
        </section>
        <p class="hint" style="text-align:center;margin-top:26px">Разказвач ${APP_VERSION}${isNative ? ' · Android' : ''} · всичко се пази на вашето устройство</p>`;

    renderVoiceGroup($('#voiceGroup', body), lang);
    renderUsage($('#usageBox', body));
    db.audioStats().then(({ size, count }) => {
        const el = $('#cacheInfo', body);
        if (el) el.textContent = `${(size / 1048576).toFixed(0)} MB в ${count} откъса — те се преслушват без разход`;
    });

    body.onclick = async (e) => {
        const eng = e.target.closest('[data-engine]');
        if (eng) {
            if (eng.dataset.engine === 'cloud' && !settings.cloudReady) {
                openCloudSetup({ backToSettings: true });
                return;
            }
            if (eng.dataset.engine !== settings.engine) {
                settings.engine = eng.dataset.engine;
                saveSettings();
                player.voiceChanged();
                rerenderSheet(renderSettings);
            }
            return;
        }
        const theme = e.target.closest('#setTheme [data-v]');
        if (theme) { settings.theme = theme.dataset.v; saveSettings(); applyTheme(); rerenderSheet(renderSettings); return; }
        const size = e.target.closest('#setSize [data-v]');
        if (size) { settings.readerSize = Number(size.dataset.v); saveSettings(); applyTheme(); rerenderSheet(renderSettings); return; }
        if (e.target.id === 'btnTestKey') return testKey(body);
        if (e.target.closest('[data-setup-link]')) { e.preventDefault(); return openCloudSetup({ backToSettings: true }); }
        if (e.target.id === 'btnClearCache') {
            await db.audioClear();
            player.queue.clear();
            toast('Запазеното аудио е изчистено.');
            rerenderSheet(renderSettings);
        }
        if (e.target.id === 'btnResetUsage') { resetUsage(); renderUsage($('#usageBox', body)); }
    };
    $('#setKey', body).onchange = (e) => {
        settings.apiKey = e.target.value.trim();
        settings.cloudReady = false;
        saveSettings();
        cloudVoiceCache = {};
        geminiModelList = null;
        player.queue.clear();
        rerenderSheet(renderSettings);
    };
    $('#setLang', body).onchange = (e) => {
        settings.lang = e.target.value;
        saveSettings();
        player.voiceChanged();
        rerenderSheet(renderSettings);
    };
    $('#setFreeOnly', body).onchange = (e) => { settings.freeOnly = e.target.value === '1'; saveSettings(); };
    $('#setGeminiCap', body).onchange = (e) => { settings.geminiCapUsd = Number(e.target.value); saveSettings(); };
    $('#setCache', body).onchange = (e) => {
        settings.cacheMB = Number(e.target.value);
        saveSettings();
        db.audioEvict(settings.cacheMB * 1048576);
    };
}

function renderUsage(box) {
    const u = usageSummary();
    if (!u.rows.length) {
        box.innerHTML = '<p class="hint" style="margin:0">Още няма платено генериране този месец. Гласът на телефона и преслушването от кеша са безплатни.</p>';
        return;
    }
    box.innerHTML = u.rows.map((r) => `
        <div class="usage-item">
            <div class="top"><span>${r.label}</span><span>${fmtUsd(r.cost)}</span></div>
            <div class="sub">${r.translated ? `${fmtNum(r.used)} ${r.unit}` : r.minutes != null ? (r.minutes < 1 ? '< 1 мин аудио' : `~${Math.round(r.minutes)} мин аудио`) + (r.note ? ` (${r.note})` : '') : `${fmtNum(r.used)} от ${fmtNum(r.free)} безплатни ${r.unit}`}</div>
            ${r.free ? `<div class="progress-track"><i style="width:${Math.min(100, r.used / r.free * 100).toFixed(1)}%"></i></div>` : ''}
        </div>`).join('') + `
        <div class="usage-total"><span>Общо (ориентировъчно)</span><span>${fmtUsd(u.total)}</span></div>
        <button class="btn btn-ghost btn-sm" id="btnResetUsage" style="justify-self:start">Нулирай брояча</button>`;
}

function renderVoiceGroup(box, lang) {
    const engine = settings.engine;
    if (engine === 'device') {
        const voices = deviceVoices(lang);
        box.innerHTML = `
            <div class="group-title">Глас</div>
            ${voices.length ? `<div class="field">
                <select class="select" id="setDeviceVoice">
                    ${voices.map((v) => `<option value="${esc(v.voiceURI)}" ${v.voiceURI === settings.deviceVoice ? 'selected' : ''}>${esc(v.name)}${v.localService || v.native ? '' : ' · онлайн'}</option>`).join('')}
                </select>
                <button class="btn btn-ghost btn-sm" data-preview>Чуй</button>
            </div>` : `<p class="hint">Няма инсталиран глас за ${esc(LANG_NAMES[lang] || lang)}. На Android: Настройки → Достъпност → Синтезиран говор → Google → Инсталиране на гласови данни.</p>`}
            ${isNative ? `
                <div class="row">
                    <span class="row-label">Гласов двигател<small>Всички двигатели, инсталирани на телефона</small></span>
                    <select class="select" id="setTtsEngine">
                        ${nativeEngines().engines.map((e) => `<option value="${esc(e.name)}" ${e.name === nativeEngines().current ? 'selected' : ''}>${esc(e.label)}</option>`).join('')}
                    </select>
                </div>
                <button class="btn btn-ghost btn-sm" id="btnTtsSettings">Изтегли още гласове</button>
                <p class="hint">Чете и при изгасен екран. „HD“ гласовете звучат най-естествено; „онлайн“ гласовете искат интернет.</p>`
            : '<p class="hint">Съвет: в настройките на Android изберете „Речеви услуги от Google“ и изтеглете гласа в най-високо качество.</p>'}`;
        const sel = $('#setDeviceVoice', box);
        if (sel) sel.onchange = () => { settings.deviceVoice = sel.value; saveSettings(); player.voiceChanged(); };
        const eng = $('#setTtsEngine', box);
        if (eng) eng.onchange = async () => {
            settings.ttsEngine = eng.value;
            settings.deviceVoice = '';
            saveSettings();
            player.voiceChanged();
            await loadNativeVoices(eng.value);
            renderVoiceGroup(box, lang);
        };
        const ttsSet = $('#btnTtsSettings', box);
        if (ttsSet) ttsSet.onclick = () => Native.openTtsSettings();
    } else if (engine === 'cloud') {
        box.innerHTML = `<div class="group-title">Глас</div><p class="hint" id="cloudVoiceMsg">Зареждам гласовете…</p>`;
        if (!effectiveSettings().apiKey || !settings.cloudReady) {
            box.innerHTML = `<div class="group-title">Глас</div>
                <button class="setup-cta" data-setup>
                    <span><b>Свържете Google HD</b><small>3 кратки стъпки · ~20 ч слушане месечно безплатно</small></span>
                    <span class="setup-cta-go">Започни</span>
                </button>`;
            $('[data-setup]', box).onclick = () => openCloudSetup({ backToSettings: true });
        } else {
            loadCloudVoices(lang).then((voices) => {
                if (!voices.length) {
                    $('#cloudVoiceMsg', box).textContent = `Google няма гласове за ${LANG_NAMES[lang] || lang}.`;
                    return;
                }
                if (!voices.some((v) => v.name === settings.cloudVoice)) {
                    settings.cloudVoice = (voices.find((v) => v.tier === 'Chirp3-HD') || voices[0]).name;
                    saveSettings();
                }
                const tiers = [...new Set(voices.map((v) => v.tier))];
                box.innerHTML = `
                    <div class="group-title">Глас</div>
                    <div class="field">
                        <select class="select" id="setCloudVoice">
                            ${tiers.map((t) => {
                                const p = PRICES.cloud[t];
                                return `<optgroup label="${p.label} · ${p.free ? '~' + Math.round(freeHoursPerMonth(t)) + ' ч/мес. безплатно' : ''} · ${hourlyCost('cloud', t).toFixed(2)} $/ч след това">
                                    ${voices.filter((v) => v.tier === t).map((v) => `<option value="${v.name}" ${v.name === settings.cloudVoice ? 'selected' : ''}>${voiceTitle(v)}</option>`).join('')}
                                </optgroup>`;
                            }).join('')}
                        </select>
                        <button class="btn btn-ghost btn-sm" data-preview>Чуй</button>
                    </div>
                    <p class="hint">Chirp 3 HD звучи най-естествено. WaveNet и Standard са по-прости, но с ~${Math.round(freeHoursPerMonth('Wavenet'))} ч безплатно месечно.
                    <a href="#" data-setup>Проверка на връзката</a></p>`;
                $('[data-setup]', box).onclick = (ev) => { ev.preventDefault(); openCloudSetup({ backToSettings: true }); };
                const sel = $('#setCloudVoice', box);
                sel.onchange = () => { settings.cloudVoice = sel.value; saveSettings(); player.voiceChanged(); };
            }).catch((e) => {
                const m = $('#cloudVoiceMsg', box);
                if (!m) return;
                m.textContent = e.message;
                const b = document.createElement('button');
                b.className = 'btn btn-accent btn-sm';
                b.style.marginTop = '10px';
                b.textContent = 'Свържи Google HD';
                b.onclick = () => openCloudSetup({ backToSettings: true });
                m.after(b);
            });
        }
    } else {
        const styles = Object.entries(NARRATION_STYLES);
        box.innerHTML = `
            <div class="group-title">Глас на разказвача</div>
            <div class="field">
                <select class="select" id="setGeminiVoice">
                    ${GEMINI_VOICES.map(([n, d]) => `<option value="${n}" ${n === settings.geminiVoice ? 'selected' : ''}>${n} — ${d}</option>`).join('')}
                </select>
                <button class="btn btn-ghost btn-sm" data-preview>Чуй</button>
            </div>
            <div class="group-title" style="margin-top:18px">Стил на разказване</div>
            <div class="pills" id="setStyle">
                ${styles.map(([k, s]) => `<button class="pill ${settings.style === k ? 'on' : ''}" data-style="${k}">${s.label}</button>`).join('')}
                <button class="pill ${settings.style === 'custom' ? 'on' : ''}" data-style="custom">Свой</button>
            </div>
            ${settings.style === 'custom' ? `<textarea class="input" id="setCustomStyle" style="margin-top:10px" placeholder="Напр.: Чети като стар моряк, който разказва край огъня — бавно, с дрезгав глас и загадъчни паузи">${esc(settings.customStyle)}</textarea>` : ''}
            <div class="group-title" style="margin-top:18px">Пестене</div>
            <div class="row">
                <span class="row-label">Пестелив режим (−50%)<small>Следващата глава се подготвя предварително през Batch на Google на половин цена. Плаща се най-много една глава напред.</small></span>
                <select class="select" id="setEconomy">
                    <option value="1" ${settings.geminiEconomy ? 'selected' : ''}>Вкл.</option>
                    <option value="0" ${!settings.geminiEconomy ? 'selected' : ''}>Изкл.</option>
                </select>
            </div>
            <div class="group-title" style="margin-top:14px">Безплатен ключ (по избор)</div>
            <input class="input" id="setFreeKey" type="password" autocomplete="off" spellcheck="false" placeholder="AIza… от проект без плащане" value="${esc(settings.geminiFreeKey)}">
            <p class="hint">Ключ от <b>нов проект без свързано плащане</b> използва безплатния дневен лимит на Google. Разказвачът първо чете с него, а когато лимитът свърши за деня, минава на основния ключ. Създава се в <a href="https://aistudio.google.com/apikey" target="_blank" rel="noopener">AI Studio</a> → Create API key → „Create in new project“.${settings.geminiFreeKey && !usableFreeKey(settings) ? ' <b>Днешният безплатен лимит е изчерпан.</b>' : ''}</p>
            <div class="group-title" style="margin-top:18px">Модел</div>
            <select class="select" id="setGeminiModel"></select>
            <p class="hint">„Автоматично“ избира най-евтиния проверен модел (Gemini 2.5 Flash TTS). Другите модели може да прочетат на глас инструкцията за стила — ако това стане, върнете „Автоматично“.</p>`;
        $('#setEconomy', box).onchange = (e) => { settings.geminiEconomy = e.target.value === '1'; saveSettings(); rerenderSheet(renderSettings); };
        $('#setFreeKey', box).onchange = (e) => { settings.geminiFreeKey = e.target.value.trim(); localStorage.removeItem('rz_free_key_exhausted'); saveSettings(); };
        $('#setGeminiVoice', box).onchange = (e) => { settings.geminiVoice = e.target.value; saveSettings(); player.voiceChanged(); };
        $('#setStyle', box).onclick = (e) => {
            const p = e.target.closest('[data-style]');
            if (!p) return;
            settings.style = p.dataset.style;
            saveSettings();
            player.voiceChanged();
            renderVoiceGroup(box, lang);
        };
        const custom = $('#setCustomStyle', box);
        if (custom) custom.onchange = () => { settings.customStyle = custom.value.trim(); saveSettings(); player.voiceChanged(); };
        const modelSel = $('#setGeminiModel', box);
        modelSel.onchange = () => {
            settings.geminiModel = modelSel.value;
            settings.geminiModelChosen = !!modelSel.value;
            saveSettings();
            player.voiceChanged();
            rerenderSheet(renderSettings);
        };
        const perHour = (m) => `${hourlyCost('gemini', m, settings.geminiEconomy).toFixed(2)} $/ч`;
        const fillModels = (list) => {
            const all = [...new Set([...(settings.geminiModel ? [settings.geminiModel] : []), ...list.filter((m) => !/native|live|dialog/.test(m)), GEMINI_DEFAULT_MODEL])];
            const cheapest = cheapestGeminiModel(list.length ? list : [GEMINI_DEFAULT_MODEL]);
            modelSel.innerHTML = `<option value="" ${!settings.geminiModel ? 'selected' : ''}>Автоматично: ${esc(cheapest)} · ${perHour(cheapest)}</option>` +
                all.map((m) => `<option value="${esc(m)}" ${m === settings.geminiModel ? 'selected' : ''}>${esc(m)} · ${perHour(m)}${isVerifiedGeminiModel(m) ? '' : ' · непроверен'}</option>`).join('');
        };
        fillModels(geminiModelList || knownGeminiModels());
        if (!geminiModelList && effectiveSettings().apiKey) {
            geminiModels(effectiveSettings().apiKey).then((l) => {
                geminiModelList = l;
                rememberGeminiModels(l);
                fillModels(l);
                const price = document.querySelector('[data-engine="gemini"] .engine-price');
                if (price) price.firstChild.textContent = geminiCardPrice();
            }).catch(() => {});
        }
    }
    const prev = $('[data-preview]', box);
    if (prev) prev.onclick = () => previewVoice(prev);
}

function voiceTitle(v) {
    const short = v.name.split('-').slice(-1)[0];
    const g = v.gender === 'FEMALE' ? 'жен.' : v.gender === 'MALE' ? 'мъж.' : '';
    return `${short}${g ? ' · ' + g : ''}`;
}

const SAMPLES = {
    bg: 'Нощта беше тиха. Твърде тиха. И точно тогава някой почука на вратата… три пъти, бавно, сякаш знаеше, че го чакам.',
    en: 'The night was quiet. Too quiet. And just then, someone knocked on the door… three times, slowly, as if they knew I was waiting.',
    ru: 'Ночь была тихой. Слишком тихой. И именно тогда кто-то постучал в дверь… три раза, медленно, будто знал, что я жду.',
};

let previewAudio = null;

// Some browsers (Opera, Huawei) only allow sound that starts inside the tap itself.
// Starting a silent clip during the tap unlocks the element for the real audio
// that arrives a few seconds later from the voice service.
const SILENT_WAV = 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=';
function unlockAudio(el) {
    if (el.dataset.unlocked) return;
    el.dataset.unlocked = '1';
    const had = el.src;
    if (had) return;
    el.src = SILENT_WAV;
    // Pause only the silent clip — the real audio may already have replaced it
    el.play().then(() => { if (el.src === SILENT_WAV) el.pause(); }).catch(() => {});
}

function playOrReport(el) {
    return el.play().catch((e) => {
        toast(e.name === 'NotAllowedError'
            ? 'Браузърът спря звука. Натиснете „Чуй“ още веднъж.'
            : 'Аудиото не може да се възпроизведе: ' + e.message, { error: true });
    });
}
async function previewVoice(btn) {
    const lang = currentLang();
    const text = SAMPLES[lang] || SAMPLES.en;
    const st = effectiveSettings();
    if (player.playing) player.pause();
    previewAudio?.pause();
    // Created and unlocked inside the tap, filled when the audio arrives
    const audioEl = new Audio();
    if (st.engine !== 'device') unlockAudio(audioEl);
    if (st.engine === 'device' && isNative) {
        const v = deviceVoices(lang).find((x) => x.voiceURI === st.deviceVoice) || deviceVoices(lang)[0];
        Native.speak({ id: 'preview', text, voice: v?.voiceURI || '', lang: LOCALES[lang] || lang, rate: player.rate, pitch: 1, flush: true }).catch((e) => toast(e.message, { error: true }));
        return;
    }
    if (st.engine === 'device') {
        speechSynthesis.cancel();
        const u = new SpeechSynthesisUtterance(text);
        const v = deviceVoices(lang).find((x) => x.voiceURI === st.deviceVoice) || deviceVoices(lang)[0];
        if (v) { u.voice = v; u.lang = v.lang; } else u.lang = LOCALES[lang];
        u.rate = player.rate;
        speechSynthesis.speak(u);
        return;
    }
    if (!st.apiKey) return toast('Нужен е API ключ.', { error: true });
    const key = st.engine === 'cloud' ? `preview|${st.cloudVoice}|${lang}` : `preview|${st.geminiModel}|${st.geminiVoice}|${st.style}|${st.customStyle}|${lang}`;
    const old = btn.textContent;
    btn.textContent = '…';
    btn.disabled = true;
    try {
        let rec = await db.audioGet(key);
        if (!rec) {
            let blob;
            if (st.engine === 'cloud') {
                ({ blob } = await cloudSynthesize({ apiKey: st.apiKey, text, voice: st.cloudVoice, locale: st.cloudVoice.split('-').slice(0, 2).join('-') }));
                recordUsage({ engine: 'cloud', tier: cloudTier(st.cloudVoice), chars: text.length });
            } else {
                const r = await geminiSynthesize({ apiKey: st.apiKey, model: st.geminiModel, text, voice: st.geminiVoice, style: st.style, customStyle: st.customStyle, lang });
                blob = r.blob;
                recordUsage({ engine: 'gemini', inTokens: r.inTokens, outTokens: r.outTokens });
            }
            rec = { key, blob, dur: 0, chars: text.length, bookId: '_preview' };
            await db.audioPut(rec);
        }
        previewAudio = audioEl;
        previewAudio.src = URL.createObjectURL(rec.blob);
        previewAudio.playbackRate = player.rate;
        await playOrReport(previewAudio);
    } catch (e) {
        toast(e.message, { error: true, duration: 7000 });
    } finally {
        btn.textContent = old;
        btn.disabled = false;
    }
}

// ---------- Google HD setup wizard ----------

let setupOpen = false;
let setupRecheck = null;

function openCloudSetup(opts = {}) {
    let diag = null;
    let checking = false;

    const stepState = (id) => {
        if (!diag) return 'wait';
        return diag[id];
    };

    const render = (body) => {
        const k = effectiveSettings().apiKey;
        const ok = diag && !diag.failed;
        const step = (id, n, title, sub, extra) => {
            const st = stepState(id);
            const active = diag?.failed === id || (!diag && id === 'key' && !k);
            return `<li class="step ${st} ${active ? 'active' : ''}">
                <span class="step-dot">${st === 'ok' ? '<svg class="ic ic-sm"><use href="#i-check"/></svg>' : n}</span>
                <div class="step-body">
                    <b>${title}</b><small>${sub}</small>
                    ${active ? extra : ''}
                    ${active && diag?.message ? `<p class="step-msg">${esc(diag.message)}</p>` : ''}
                </div>
            </li>`;
        };
        const fix = (label) => diag?.fixUrl
            ? `<a class="btn btn-accent btn-sm step-btn" href="${esc(diag.fixUrl)}" target="_blank" rel="noopener">${label} ↗</a>` : '';
        body.innerHTML = `
            <p class="setup-lead">Еднократна настройка за най-естествените гласове. Първият <b>1 милион знака всеки месец</b> (~20 ч слушане) е безплатен.</p>
            <ol class="steps">
                ${step('key', 1, 'API ключ', 'Същият ключ от Google AI Studio — един за всички AI гласове.', `
                    <div class="field step-field">
                        <input class="input" id="setupKey" type="password" autocomplete="off" spellcheck="false" placeholder="Поставете ключа (AIza…)" value="${esc(settings.apiKey)}">
                        <button class="btn btn-ghost btn-sm" id="setupPaste">Постави</button>
                    </div>
                    <a class="btn btn-accent btn-sm step-btn" href="${CLOUD_LINKS.aiStudioKey}" target="_blank" rel="noopener">Създай ключ ↗</a>`)}
                ${step('api', 2, 'Включете Google HD гласовете', 'На страницата натиснете синия бутон „Enable / Активиране“.', fix('Отвори и включи'))}
                ${step('billing', 3, 'Свържете профил за плащане', 'Google го изисква, но не таксува до 1M знака месечно.', `${fix('Свържи плащане')}
                    <p class="hint">За спокойствие задайте <a href="${CLOUD_LINKS.budgets}" target="_blank" rel="noopener">бюджет-аларма</a> от 1 $ — ще получите имейл, ако някога наближите платения праг.</p>`)}
            </ol>
            ${ok ? `<div class="setup-done">
                    <svg class="ic"><use href="#i-check"/></svg>
                    <div><b>Свързано!</b><small>Глас: ${esc((settings.cloudVoice || diag.voice).split('-').slice(-1)[0])} · Chirp 3 HD</small></div>
                    <button class="btn btn-ghost btn-sm" id="setupHear">Чуй</button>
                </div>
                <button class="btn btn-primary setup-main" id="setupDone">${opts.thenPlay ? 'Започни да слушаш' : 'Готово'}</button>`
            : `<button class="btn btn-primary setup-main" id="setupCheck" ${checking ? 'disabled' : ''}>${checking ? 'Проверявам…' : diag ? 'Провери отново' : 'Провери'}</button>
               ${diag && diag.failed !== 'key' ? '<p class="hint" style="text-align:center">Току-що включена услуга може да заработи след около минута.</p>' : ''}`}`;

        const keyInput = $('#setupKey', body);
        if (keyInput) {
            keyInput.onchange = () => { saveKey(keyInput.value); check(); };
            $('#setupPaste', body).onclick = async () => {
                try {
                    const t = (await navigator.clipboard.readText()).trim();
                    if (t) { keyInput.value = t; saveKey(t); check(); }
                } catch { keyInput.focus(); toast('Поставете ключа ръчно (задръжте в полето → Постави).'); }
            };
        }
        const checkBtn = $('#setupCheck', body);
        if (checkBtn) checkBtn.onclick = () => {
            if (keyInput && keyInput.value.trim() !== settings.apiKey) saveKey(keyInput.value);
            check();
        };
        const hear = $('#setupHear', body);
        if (hear) hear.onclick = () => (diag?.sample ? playSample() : previewVoice(hear));
        const done = $('#setupDone', body);
        if (done) done.onclick = () => {
            closeSheet();
            if (opts.thenPlay) startPlayback();
            else if (opts.backToSettings) openSettings();
        };
    };

    const saveKey = (v) => {
        const key = v.trim();
        if (key === settings.apiKey) return;
        settings.apiKey = key;
        settings.cloudReady = false;
        saveSettings();
        cloudVoiceCache = {};
        geminiModelList = null;
        player.queue.clear();
    };

    let sampleUrl = null;
    const playSample = () => {
        if (!diag?.sample) return;
        previewAudio?.pause();
        if (!sampleUrl) sampleUrl = URL.createObjectURL(diag.sample);
        previewAudio = new Audio(sampleUrl);
        playOrReport(previewAudio);
    };

    const check = async () => {
        if (checking || !setupOpen) return;
        checking = true;
        rerenderSheet(render);
        try {
            diag = await cloudDiagnose(effectiveSettings().apiKey, currentLang());
        } catch (e) {
            diag = { key: 'wait', api: 'wait', billing: 'wait', failed: 'key', message: e.message };
        }
        checking = false;
        if (!setupOpen) return;
        if (!diag.failed) {
            if (diag.sampleChars) recordUsage({ engine: 'cloud', tier: cloudTier(diag.voice), chars: diag.sampleChars });
            if (diag.voices?.length) cloudVoiceCache[currentLang()] = diag.voices;
            const known = diag.voices?.some((v) => v.name === settings.cloudVoice);
            if (!known) settings.cloudVoice = diag.voice;
            const changed = settings.engine !== 'cloud';
            settings.engine = 'cloud';
            settings.cloudReady = true;
            saveSettings();
            if (changed) player.voiceChanged();
            if (currentBook) updatePlayerUI();
            playSample();
        }
        rerenderSheet(render);
    };

    // Re-check automatically when the user comes back from the Google console
    setupRecheck = () => {
        if (document.visibilityState === 'visible' && setupOpen && diag?.failed && diag.failed !== 'key') setTimeout(check, 700);
    };
    document.addEventListener('visibilitychange', setupRecheck);

    setupOpen = true;
    openSheet('Свържи Google HD', render, () => {
        setupOpen = false;
        document.removeEventListener('visibilitychange', setupRecheck);
        if (sampleUrl) URL.revokeObjectURL(sampleUrl);
    });
    // Already connected: show it without another (billable) test call
    if (settings.cloudReady && effectiveSettings().apiKey) {
        diag = { key: 'ok', api: 'ok', billing: 'ok', failed: null, voice: settings.cloudVoice, sample: null };
        rerenderSheet(render);
    } else if (effectiveSettings().apiKey) check();
}

async function testKey(body) {
    const key = ($('#setKey', body).value || '').trim() || preconfiguredKey();
    settings.apiKey = ($('#setKey', body).value || '').trim();
    saveSettings();
    const status = $('#keyStatus', body);
    if (!key) { status.textContent = 'Въведете ключ.'; return; }
    status.textContent = 'Проверявам…';
    const res = await Promise.allSettled([geminiModels(key), cloudVoices(key, 'bg')]);
    const g = res[0].status === 'fulfilled';
    const c = res[1].status === 'fulfilled';
    status.innerHTML = `${g ? '✓' : '✕'} Gemini разказвач ${g ? 'работи' : '— ' + esc(res[0].reason?.message || '')}<br>
        ${c ? '✓' : '✕'} Google HD гласове ${c ? 'работят' : '— ' + esc(res[1].reason?.message || '')}`;
    if (g) { geminiModelList = res[0].value; rememberGeminiModels(geminiModelList); }
    if (c) cloudVoiceCache = { bg: res[1].value };
    if (!c && res[1].reason?.reason) status.innerHTML += ' <a href="#" id="keyFix">Поправи</a>';
    const fixLink = $('#keyFix', body);
    if (fixLink) fixLink.onclick = (ev) => { ev.preventDefault(); openCloudSetup({ backToSettings: true }); };
}

// ==================== Events ====================

let sliderDragging = false;

function bindEvents() {
    const fileInput = $('#fileInput');
    fileInput.accept = ACCEPT;
    document.addEventListener('click', (e) => {
        if (e.target.closest('[data-action="add"]')) fileInput.click();
    });
    fileInput.onchange = () => { importFile(fileInput.files[0]); fileInput.value = ''; };

    $('#shelves').addEventListener('click', async (e) => {
        const more = e.target.closest('[data-more]');
        if (more) {
            const sh = SHELVES.find((x) => x.id === more.dataset.more);
            const d = shelfData[sh.id];
            more.textContent = '…';
            try {
                const { items, next } = await loadShelf(sh, d.next);
                const start = d.items.length;
                d.items.push(...items);
                d.next = next;
                more.insertAdjacentHTML('beforebegin', items.map((it, i) => shelfCard(it, sh.id, start + i)).join(''));
                if (next) more.textContent = 'Още'; else more.remove();
            } catch { more.textContent = 'Още'; }
            return;
        }
        const card = e.target.closest('.shelf-card');
        if (card) openCatalogItem(shelfData[card.dataset.shelfId].items[Number(card.dataset.i)]);
    });
    $('#bookGrid').addEventListener('click', (e) => {
        const b = e.target.closest('.book');
        if (b) openBook(b.dataset.id, false);
    });

    // Long-press a book to remove it
    let pressTimer = null;
    $('#bookGrid').addEventListener('pointerdown', (e) => {
        const b = e.target.closest('.book');
        if (!b) return;
        pressTimer = setTimeout(async () => {
            pressTimer = 'fired';
            const meta = await db.get('books', b.dataset.id);
            if (meta && confirm(`Да премахна ли „${meta.title}“?`)) deleteBook(meta.id);
        }, 650);
    });
    ['pointerup', 'pointerleave', 'pointercancel'].forEach((ev) => $('#bookGrid').addEventListener(ev, () => {
        if (pressTimer !== 'fired') clearTimeout(pressTimer);
        pressTimer = null;
    }));
    $('#bookGrid').addEventListener('contextmenu', (e) => { if (e.target.closest('.book')) e.preventDefault(); });

    // Drag & drop
    let dragDepth = 0;
    window.addEventListener('dragenter', (e) => { if (e.dataTransfer?.types.includes('Files')) { dragDepth++; $('#dropHint').classList.remove('hidden'); } });
    window.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; $('#dropHint').classList.add('hidden'); } });
    window.addEventListener('dragover', (e) => e.preventDefault());
    window.addEventListener('drop', (e) => {
        e.preventDefault();
        dragDepth = 0;
        $('#dropHint').classList.add('hidden');
        const f = e.dataTransfer?.files?.[0];
        if (f) importFile(f);
    });

    $('#btnSettings').onclick = openSettings;
    $('#btnBack').onclick = hidePlayer;
    $('#btnBookMenu').onclick = openBookMenu;
    $('#btnChapter').onclick = openChapters;
    $('#btnPlay').onclick = () => {
        if (player.playing) {
            player.allowFullPrice = false;
            player.pause();
        } else startPlayback();
    };
    $('#btnBack15').onclick = () => player.skip(-15);
    $('#btnFwd30').onclick = () => player.skip(30);
    $('#btnPrevCh').onclick = () => goChapter(-1);
    $('#btnNextCh').onclick = () => goChapter(1);
    $('#chipSpeed').onclick = openSpeed;
    $('#chipVoice').onclick = openSettings;
    $('#chipSleep').onclick = openSleep;
    $('#chipText').onclick = () => {
        settings.view = settings.view === 'text' ? 'cover' : 'text';
        saveSettings();
        applyStageView();
    };

    const slider = $('#chapterSlider');
    const bubble = $('#seekBubble');
    slider.addEventListener('input', () => {
        sliderDragging = true;
        const m = player.model(player.pos.c);
        const v = Number(slider.value);
        const pct = (v / Math.max(1, slider.max)) * 100;
        slider.style.setProperty('--p', `${pct}%`);
        const left = charLen(m, v, m.sentences.length) / player.charsPerSecond / player.rate;
        $('#pRemain').textContent = `${fmtDuration(left) || '< 1 мин'} до края на главата`;
        // Preview the sentence you will land on
        const text = m.sentences[v]?.t || '';
        bubble.textContent = text.length > 110 ? text.slice(0, 110) + '…' : text;
        bubble.classList.remove('hidden');
        // Keep the bubble on screen near the thumb
        const W = slider.clientWidth, bw = bubble.offsetWidth;
        bubble.style.left = `${Math.min(W - bw / 2, Math.max(bw / 2, pct / 100 * W))}px`;
    });
    const endScrub = () => {
        bubble.classList.add('hidden');
        if (!sliderDragging) return;
        sliderDragging = false;
        player.seekTo(player.pos.c, Number(slider.value));
    };
    slider.addEventListener('change', endScrub);
    slider.addEventListener('pointerup', () => setTimeout(() => bubble.classList.add('hidden'), 50));

    // Tap a sentence in the text view to read from there
    const stage = $('#textStage');
    stage.addEventListener('click', (e) => {
        const s = e.target.closest('span[data-s]');
        if (!s) return;
        player.seekTo(player.pos.c, Number(s.dataset.s));
        if (!player.playing) startPlayback();
    });
    ['touchmove', 'wheel'].forEach((ev) => stage.addEventListener(ev, () => { userScrolledAt = Date.now(); }, { passive: true }));

    $('#miniPlayer').addEventListener('click', (e) => {
        if (e.target.closest('#miniPlay')) {
            e.stopPropagation();
            return player.playing ? player.pause() : startPlayback();
        }
        showPlayer();
    });

    $('#sheetClose').onclick = closeSheet;
    $('#sheetBackdrop').onclick = closeSheet;

    // Swipe the sheet down to close it
    let startY = null;
    const sheet = $('#sheet');
    sheet.addEventListener('touchstart', (e) => {
        if ($('#sheetBody').scrollTop > 0 && !e.target.closest('.sheet-head, .sheet-grip')) return;
        startY = e.touches[0].clientY;
    }, { passive: true });
    sheet.addEventListener('touchmove', (e) => {
        if (startY == null) return;
        const dy = e.touches[0].clientY - startY;
        if (dy > 0) sheet.style.transform = `translateY(${dy}px)`;
    }, { passive: true });
    sheet.addEventListener('touchend', (e) => {
        if (startY == null) return;
        const dy = e.changedTouches[0].clientY - startY;
        sheet.style.transform = '';
        startY = null;
        if (dy > 110) closeSheet();
    });

    document.addEventListener('keydown', (e) => {
        if (e.target.matches('input, textarea, select')) return;
        if (e.key === 'Escape') {
            if (!$('#sheet').classList.contains('hidden')) closeSheet();
            else if (!$('#viewPlayer').classList.contains('hidden')) hidePlayer();
        }
        if (!currentBook) return;
        if (e.code === 'Space') { e.preventDefault(); player.playing ? player.pause() : startPlayback(); }
        if (e.key === 'ArrowLeft') player.skip(-15);
        if (e.key === 'ArrowRight') player.skip(30);
    });

    window.addEventListener('popstate', () => { if (location.hash !== '#play') hidePlayer(); });
    document.addEventListener('visibilitychange', () => { if (document.hidden) persistNow(); });
    window.addEventListener('pagehide', persistNow);

    // Player events
    player.addEventListener('state', updatePlayState);
    player.addEventListener('position', updatePlayerUI);
    player.addEventListener('save', scheduleSave);
    player.addEventListener('position', maybePrepareNext);
    player.addEventListener('translating', (e) => { $('#pStatus').textContent = `Превеждам главата… ${Math.round(e.detail * 100)}%`; });
    player.addEventListener('translated', () => {
        renderedChapter = -1;
        updatePlayerUI();
        $('#textStage').setAttribute('lang', currentLang());
    });
    player.addEventListener('sleep', () => { sleepTimer = null; updateSleepChip(); toast('Лека нощ. Спрях в края на главата.'); });
    player.addEventListener('finished', () => toast('Краят на книгата. Надявам се, че ви е харесала.'));
    player.addEventListener('error', (e) => {
        const err = e.detail;
        console.error(err);
        if (err.reason === 'BATCH_PENDING') {
            waitingForBatch = true;
            startBatchPolling();
            toast(err.message, {
                duration: 12000,
                action: { label: 'Чети сега (пълна цена)', run: () => { player.allowFullPrice = true; player.play(); } },
            });
            return;
        }
        if (err.reason === 'APP_CAP') {
            settings.engine = 'device';
            saveSettings();
            updatePlayerUI();
            toast(err.message + ' Продължавам с гласа на телефона.', { duration: 9000, action: { label: 'Настройки', run: openSettings } });
            player.play();
            return;
        }
        const offerDevice = settings.engine !== 'device';
        const setupIssue = settings.engine === 'cloud' && /^(API_KEY|SERVICE_DISABLED|BILLING_DISABLED)/.test(err.reason || '');
        if (setupIssue) {
            settings.cloudReady = false;
            saveSettings();
        }
        toast(err.message || 'Грешка при четене.', {
            error: true, duration: 8000,
            action: setupIssue ? { label: 'Поправи', run: () => openCloudSetup({ thenPlay: true }) } : offerDevice ? { label: 'Чети с телефона', run: () => { settings.engine = 'device'; saveSettings(); updatePlayerUI(); player.play(); } } : null,
        });
    });

    onDeviceVoicesChanged(() => { if (currentBook) updatePlayerUI(); });

    if ('mediaSession' in navigator) {
        const ms = navigator.mediaSession;
        const set = (a, fn) => { try { ms.setActionHandler(a, fn); } catch {} };
        set('play', () => startPlayback());
        set('pause', () => player.pause());
        set('seekbackward', () => player.skip(-15));
        set('seekforward', () => player.skip(30));
        set('previoustrack', () => goChapter(-1));
        set('nexttrack', () => goChapter(1));
    }
}

function persistNow() {
    if (!currentBook) return;
    currentBook.position = { ...player.pos };
    persistBook();
}

// ==================== Boot ====================

// ==================== Export as audio files ====================

const EXPORT_KEY = 'rz_pending_export';

async function saveBlob(name, blob) {
    if (isNative) {
        const { id } = await Native.fileBegin();
        const step = 1536 * 1024; // keeps every bridge message small
        for (let off = 0; off < blob.size; off += step) {
            const b64 = await new Promise((resolve, reject) => {
                const r = new FileReader();
                r.onload = () => resolve(String(r.result).split(',')[1] || '');
                r.onerror = () => reject(r.error);
                r.readAsDataURL(blob.slice(off, off + step));
            });
            await Native.fileAppend({ id, data: b64 });
        }
        const { path } = await Native.fileEnd({ id, name, mime: name.endsWith('.zip') ? 'application/zip' : 'audio/ogg' });
        toast(`Записано: ${path}`, { duration: 8000 });
        return;
    }
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
}

function exportCost(missingChars, batch) {
    const hours = missingChars / player.charsPerSecond / 3600;
    const model = activeGeminiModel();
    return settings.engine === 'cloud' ? hours * hourlyCost('cloud') : hours * hourlyCost('gemini', model, batch);
}

function openExport() {
    if (!currentBook) return;
    if (settings.engine === 'device') {
        return toast('Гласът на телефона не може да се запише във файл. Изберете Gemini разказвача.', { action: { label: 'Настройки', run: openSettings } });
    }
    let scope = 'chapter';
    const render = (body) => {
        const chapters = scope === 'chapter' ? [player.pos.c] : currentBook.chapterTitles.map((_, i) => i);
        body.innerHTML = `
            <div class="seg" id="expScope">
                <button data-s="chapter" class="${scope === 'chapter' ? 'on' : ''}">Текущата глава</button>
                <button data-s="book" class="${scope === 'book' ? 'on' : ''}">Цялата книга</button>
            </div>
            <div id="expInfo" class="usage" style="margin-top:16px"><p class="hint" style="margin:0">Изчислявам…</p></div>
            <div id="expActions" class="catalog-actions"></div>
            <p class="hint">Формат: Ogg/Opus — пуска се в телефона, VLC и повечето плейъри. ${scope === 'book' ? 'Цялата книга се изтегля като ZIP с файл за всяка глава.' : ''} Във файла е отбелязано, че е озвучен с изкуствен интелект.</p>`;
        body.onclick = (e) => {
            const b = e.target.closest('#expScope [data-s]');
            if (b && b.dataset.s !== scope) { scope = b.dataset.s; rerenderSheet(render); }
            const act = e.target.closest('[data-exp]')?.dataset.exp;
            if (act === 'now') { closeSheet(); runExport(chapters); }
            if (act === 'batch') { closeSheet(); prepareExportHalfPrice(chapters); }
        };
        exportPlan(player, chapters).then((plan) => {
            const info = $('#expInfo', body);
            if (!info) return;
            const hours = plan.total / player.charsPerSecond / 3600;
            const readyPct = plan.chunks ? Math.round((plan.chunks - plan.missing) / plan.chunks * 100) : 0;
            const now = exportCost(plan.missingChars, false);
            const half = exportCost(plan.missingChars, true);
            info.innerHTML = `
                <div class="usage-item"><div class="top"><span>Продължителност</span><span>~${fmtDuration(hours * 3600) || '< 1 мин'}</span></div>
                <div class="sub">Вече озвучено: ${readyPct}% — взема се от кеша безплатно</div>
                <div class="progress-track"><i style="width:${readyPct}%"></i></div></div>`;
            const actions = $('#expActions', body);
            if (!plan.missing) {
                actions.innerHTML = '<button class="btn btn-primary" data-exp="now">Изтегли (безплатно)</button>';
            } else {
                actions.innerHTML = `<button class="btn btn-primary" data-exp="now">Изтегли сега · ${approxUsd(now)}</button>
                    ${settings.engine === 'gemini' ? `<button class="btn btn-ghost" data-exp="batch">На ½ цена · ${approxUsd(half)} — когато е готово</button>` : ''}`;
            }
        }).catch((e) => { const i = $('#expInfo', body); if (i) i.innerHTML = `<p class="hint">${esc(e.message)}</p>`; });
    };
    openSheet('Изтегли като аудиокнига', render);
}

async function runExport(chapters) {
    const overlay = $('#importOverlay');
    const arc = $('#importArc');
    const label = $('#importText');
    arc.style.strokeDashoffset = 125.7;
    label.textContent = 'Подготвям аудиофайла…';
    overlay.classList.remove('hidden');
    const wasPlaying = player.playing;
    if (wasPlaying) player.pause();
    player.allowFullPrice = true;
    try {
        const files = await exportChapters(player, chapters, {
            onProgress: (p, title) => {
                arc.style.strokeDashoffset = 125.7 * (1 - p);
                if (title) label.textContent = `Записвам: ${title}`;
            },
        });
        label.textContent = 'Запазвам файла…';
        const pkg = await packageFiles(currentBook, files);
        overlay.classList.add('hidden');
        await saveBlob(pkg.name, pkg.blob);
    } catch (e) {
        overlay.classList.add('hidden');
        console.error(e);
        if (e.name !== 'AbortError') toast(e.message || 'Аудиофайлът не можа да се създаде.', { error: true, duration: 7000 });
    } finally {
        player.allowFullPrice = false;
    }
}

// Half price: queue the missing parts in Gemini Batch; the file is offered when they are ready
async function prepareExportHalfPrice(chapters) {
    const st = effectiveSettings();
    let queued = 0;
    try {
        for (const c of chapters) queued += await submitChapter(player, c, st);
    } catch (e) {
        return toast('Партидата не беше приета: ' + e.message, { error: true });
    }
    localStorage.setItem(EXPORT_KEY, JSON.stringify({ bookId: currentBook.id, chapters }));
    startBatchPolling();
    toast(queued
        ? `Подготвям ${queued} откъса на половин цена. Когато са готови, ще ви предложа файла.`
        : 'Всичко вече е подготвено или се подготвя.', { duration: 8000 });
}

// Called after batch results arrive: offer the file once everything is narrated
async function checkPendingExport() {
    let pend;
    try { pend = JSON.parse(localStorage.getItem(EXPORT_KEY) || 'null'); } catch { pend = null; }
    if (!pend || !currentBook || currentBook.id !== pend.bookId) return;
    const plan = await exportPlan(player, pend.chapters);
    if (plan.missing) return;
    localStorage.removeItem(EXPORT_KEY);
    toast('Аудиокнигата е готова (на половин цена).', { duration: 20000, action: { label: 'Изтегли', run: () => runExport(pend.chapters) } });
}

// ==================== Gemini economy (Batch, half price) ====================

function nextChaptersChars(n) {
    if (!currentBook) return 0;
    let sum = 0;
    for (let c = player.pos.c + 1; c <= player.pos.c + n && c < currentBook.chapterChars.length; c++) sum += currentBook.chapterChars[c];
    return sum;
}

const submitted = new Set();
let waitingForBatch = false;

async function prepareAhead(n, manual) {
    const st = effectiveSettings();
    if (!currentBook || st.engine !== 'gemini' || !st.apiKey) {
        if (manual) toast('Пестеливият режим работи с Gemini разказвача и основния API ключ.', { error: true });
        return;
    }
    let queued = 0;
    try {
        for (let c = player.pos.c + 1; c <= player.pos.c + n && c < player.chapters.length; c++) {
            const id = `${currentBook.id}|${c}|${st.geminiModel}|${st.geminiVoice}|${st.style}`;
            if (submitted.has(id) && !manual) continue;
            submitted.add(id);
            queued += await submitChapter(player, c, st);
        }
    } catch (e) {
        if (manual) toast('Партидата не беше приета: ' + e.message, { error: true });
        return;
    }
    if (manual) toast(queued ? `Подготвям ${queued} откъса на половин цена. Ще ви кажа, когато са готови.` : 'Следващите глави вече са готови или се подготвят.');
    if (queued) startBatchPolling();
}

// While listening with the Gemini narrator, prepare the next chapter in time
function maybePrepareNext() {
    if (!settings.geminiEconomy || settings.engine !== 'gemini' || !player.playing || !currentBook) return;
    const m = player.model(player.pos.c);
    if (player.pos.s >= m.sentences.length * 0.4) prepareAhead(1, false);
}

let batchTimer = null;
function startBatchPolling() {
    if (batchTimer || !hasJobs()) return;
    const tick = () => pollBatches(effectiveSettings().apiKey, (job, stored, error) => {
        if (error) return toast(`Подготовката на глава ${job.c + 1} не успя (${error}). Ще се чете нормално.`, { error: true });
        if (!stored) return;
        const title = currentBook?.id === job.bookId ? currentBook.chapterTitles[job.c] : '';
        if (waitingForBatch && !player.playing) {
            waitingForBatch = false;
            toast(`Готово на половин цена: ${title || 'глава ' + (job.c + 1)}.`, { duration: 12000, action: { label: 'Слушай', run: () => startPlayback() } });
        } else {
            toast(`Подготвена на половин цена: ${title || 'глава ' + (job.c + 1)}.`);
        }
    }).finally(() => {
        checkPendingExport().catch(() => {});
        if (!hasJobs()) { clearInterval(batchTimer); batchTimer = null; }
    });
    batchTimer = setInterval(() => { if (!document.hidden) tick(); }, 60000);
    setTimeout(tick, 15000);
}

// ==================== Android app ====================

const importedShares = new Set();

async function importShared(file) {
    if (!file?.path || importedShares.has(file.path)) return;
    importedShares.add(file.path);
    try {
        const blob = await (await fetch(nativeFileUrl(file.path))).blob();
        await importFile(new File([blob], file.name || 'книга'));
    } catch (e) {
        toast('Файлът не можа да се отвори: ' + e.message, { error: true });
    }
}

let lastPlayback = '';
function syncPlaybackNotification() {
    if (!Native || !currentBook) return;
    const state = JSON.stringify([currentBook.title, currentBook.chapterTitles[player.pos.c] || '', player.playing]);
    if (state === lastPlayback) return;
    lastPlayback = state;
    Native.updatePlayback({
        title: currentBook.title,
        subtitle: currentBook.chapterTitles[player.pos.c] || '',
        playing: player.playing,
    }).catch(() => {});
}

function initNative() {
    loadNativeVoices(settings.ttsEngine || undefined);
    Native.addListener('mediaAction', ({ action }) => {
        if (action === 'play') startPlayback();
        else if (action === 'pause') player.pause();
        else if (action === 'forward' || action === 'next') player.skip(30);
        else if (action === 'back' || action === 'prev') player.skip(-15);
    });
    Native.addListener('sharedFile', ({ file, error }) => {
        if (error) return toast('Споделеният файл не можа да се прочете.', { error: true });
        importShared(file);
    });
    Native.getPendingFile().then(({ file }) => importShared(file)).catch(() => {});
    player.addEventListener('state', syncPlaybackNotification);
    player.addEventListener('position', syncPlaybackNotification);
}

async function init() {
    applyTheme();
    bindEvents();
    updateSleepChip();
    await renderLibrary();
    startBatchPolling();
    document.addEventListener('visibilitychange', () => { if (!document.hidden) startBatchPolling(); });
    if (isNative) initNative();
    else if ('serviceWorker' in navigator && location.protocol !== 'file:') {
        navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' }).catch(() => {});
        // A new version took over: reload now if nothing is playing, otherwise offer it
        const hadController = !!navigator.serviceWorker.controller;
        navigator.serviceWorker.addEventListener('controllerchange', () => {
            if (!hadController) return;
            if (!player.playing) location.reload();
            else toast('Има нова версия на приложението.', { duration: 15000, action: { label: 'Обнови', run: () => location.reload() } });
        });
    }
    // Reopen the last book after a reload while listening
    if (location.hash === '#play') {
        const last = (await allBooks()).find((b) => b.lastOpened);
        if (last) openBook(last.id, false);
        else history.replaceState(null, '', location.pathname);
    }
    // Shared file (Android share target / file handler)
    if ('launchQueue' in window) {
        window.launchQueue.setConsumer(async (params) => {
            const handle = params.files?.[0];
            if (handle) importFile(await handle.getFile());
        });
    }
}

init();
