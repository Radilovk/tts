// Разказвач — UI layer.

import * as db from './db.js';
import { parseBook, ACCEPT } from './parsers.js';
import { Player } from './player.js';
import { LANG_NAMES, LOCALES, charLen } from './text.js';
import {
    GEMINI_VOICES, GEMINI_DEFAULT_MODEL, NARRATION_STYLES, PRICES,
    cloudVoices, cloudSynthesize, geminiSynthesize, geminiModels, deviceVoices, onDeviceVoicesChanged, cloudTier,
} from './engines.js';
import { usageSummary, resetUsage, hourlyCost, freeHoursPerMonth, recordUsage } from './usage.js';

const $ = (s, root = document) => root.querySelector(s);
const $$ = (s, root = document) => [...root.querySelectorAll(s)];

// ==================== Settings ====================

const SETTINGS_KEY = 'rz_settings';
const DEFAULTS = {
    engine: null, apiKey: '', cloudVoice: '', geminiVoice: 'Charon', geminiModel: GEMINI_DEFAULT_MODEL,
    style: 'intriguing', customStyle: '', deviceVoice: '', lang: 'auto', rate: 1, lookahead: 2,
    cacheMB: 500, theme: 'system', readerSize: 19, view: 'cover',
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
    s = { ...DEFAULTS, ...s };
    if (!s.engine) s.engine = (s.apiKey || preconfiguredKey()) ? 'cloud' : 'device';
    return s;
}

function saveSettings() {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
}

function effectiveSettings() {
    return { ...settings, apiKey: settings.apiKey || preconfiguredKey() };
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
    return settings.lang !== 'auto' ? settings.lang : (currentBook?.lang || 'bg');
}

// ==================== Library ====================

async function allBooks() {
    const books = await db.getAll('books');
    return books.sort((a, b) => (b.lastOpened || b.addedAt) - (a.lastOpened || a.addedAt));
}

async function renderLibrary() {
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
        const id = 'b' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
        const chapterChars = parsed.chapters.map((c) => c.paras.reduce((n, p) => n + p.length + 1, c.title.length + 1));
        const meta = {
            id, title: parsed.title, author: parsed.author, lang: parsed.lang, cover: parsed.cover || null,
            chapterTitles: parsed.chapters.map((c) => c.title), chapterChars,
            totalChars: chapterChars.reduce((a, b) => a + b, 0), sentenceCounts: [],
            addedAt: Date.now(), lastOpened: 0, position: { c: 0, s: 0 }, fileName: file.name,
        };
        await db.put('contents', { id, chapters: parsed.chapters });
        await db.put('books', meta);
        db.requestPersistence();
        overlay.classList.add('hidden');
        await renderLibrary();
        const hours = meta.totalChars / (player.charsPerSecond * 3600);
        const n = parsed.chapters.length;
        toast(`Добавена: ${n} ${n === 1 ? 'глава' : 'глави'} · ${fmtDuration(hours * 3600) || '< 1 мин'} слушане`);
        openBook(id, false);
    } catch (e) {
        overlay.classList.add('hidden');
        console.error(e);
        toast(e.message || 'Неуспешно четене на файла.', { error: true, duration: 6000 });
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
    const st = effectiveSettings();
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
    openSheet('Съдържание', (body) => {
        const cur = player.pos.c;
        body.innerHTML = `<div class="list">${currentBook.chapterTitles.map((t, i) => `
            <button class="list-item ${i === cur ? 'on' : ''}" data-c="${i}">
                <span class="num">${i + 1}</span>
                <span class="grow"><span class="truncate" style="display:block">${esc(t)}</span>
                <small>${fmtDuration((currentBook.chapterChars[i] || 0) / player.charsPerSecond / player.rate)}</small></span>
                ${i === cur ? '<svg class="ic ic-sm"><use href="#i-voice"/></svg>' : ''}
            </button>`).join('')}</div>`;
        body.onclick = (e) => {
            const item = e.target.closest('[data-c]');
            if (!item) return;
            const wasPlaying = player.playing;
            player.seekTo(Number(item.dataset.c), 0);
            closeSheet();
            if (!wasPlaying) startPlayback();
        };
        setTimeout(() => body.querySelector('.on')?.scrollIntoView({ block: 'center' }), 50);
    });
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
                ${costRow('Цена с Gemini разказвач', '~' + fmtUsd(hours * hourlyCost('gemini')))}
            </div>
            <div class="group list">
                <button class="list-item" data-a="prepare"><span class="grow">Подготви текущата глава за офлайн<small>Генерира цялата глава предварително (същата цена като слушане)</small></span></button>
                <button class="list-item" data-a="restart"><span class="grow">Започни отначало</span></button>
                <button class="list-item danger" data-a="delete"><span class="grow">Премахни книгата</span></button>
            </div>`;
        body.onclick = async (e) => {
            const a = e.target.closest('[data-a]')?.dataset.a;
            if (!a) return;
            if (a === 'delete') {
                if (confirm(`Да премахна ли „${currentBook.title}“ и запазеното аудио?`)) { closeSheet(); deleteBook(currentBook.id); }
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
        ['device', 'Гласът на телефона', 'Безплатно и офлайн. Качеството зависи от устройството.', '0 $', 'завинаги'],
        ['cloud', 'Google HD гласове', `Chirp 3 HD — много естествени гласове. ~${freeHrs} ч слушане месечно безплатно.`, 'безплатно', `после ~${hourlyCost('cloud').toFixed(2)} $/ч`],
        ['gemini', 'Gemini разказвач', 'Най-жива интонация: разказвачът „играе“ текста според избран стил.', `~${hourlyCost('gemini').toFixed(2)} $/ч`, 'плаща се само чутото'],
    ];
    body.innerHTML = `
        <section class="group">
            <div class="group-title">Глас за четене</div>
            <div class="engine-list">
                ${engines.map(([id, name, desc, price, sub]) => `
                <button class="engine ${settings.engine === id ? 'on' : ''}" data-engine="${id}">
                    <span class="engine-name">${name}${id === 'cloud' ? '<span class="badge">Изгодно</span>' : ''}</span>
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
            <p class="hint">Един ключ работи и за двата AI гласа. Създайте го в <a href="https://aistudio.google.com/apikey" target="_blank" rel="noopener">Google AI Studio</a>. За Google HD гласовете включете
            <a href="https://console.cloud.google.com/apis/library/texttospeech.googleapis.com" target="_blank" rel="noopener">Cloud Text-to-Speech API</a> в същия проект (изисква профил за плащане, но първият милион знака всеки месец е безплатен). Ключът остава само на това устройство.</p>
        </section>

        <section class="group">
            <div class="group-title">Икономия</div>
            <div class="row">
                <span class="row-label">Подготовка напред<small>Колко откъса се генерират преди да стигнете до тях</small></span>
                <select class="select" id="setAhead">
                    ${[1, 2, 3].map((n) => `<option value="${n}" ${settings.lookahead === n ? 'selected' : ''}>${n}</option>`).join('')}
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
        <p class="hint" style="text-align:center;margin-top:26px">Разказвач · всичко се пази на вашето устройство</p>`;

    renderVoiceGroup($('#voiceGroup', body), lang);
    renderUsage($('#usageBox', body));
    db.audioStats().then(({ size, count }) => {
        const el = $('#cacheInfo', body);
        if (el) el.textContent = `${(size / 1048576).toFixed(0)} MB в ${count} откъса — те се преслушват без разход`;
    });

    body.onclick = async (e) => {
        const eng = e.target.closest('[data-engine]');
        if (eng) {
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
    $('#setAhead', body).onchange = (e) => { settings.lookahead = Number(e.target.value); saveSettings(); };
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
            <div class="sub">${r.minutes != null ? (r.minutes < 1 ? '< 1 мин аудио' : `~${Math.round(r.minutes)} мин аудио`) : `${fmtNum(r.used)} от ${fmtNum(r.free)} безплатни ${r.unit}`}</div>
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
                    ${voices.map((v) => `<option value="${esc(v.voiceURI)}" ${v.voiceURI === settings.deviceVoice ? 'selected' : ''}>${esc(v.name)}${v.localService ? '' : ' · онлайн'}</option>`).join('')}
                </select>
                <button class="btn btn-ghost btn-sm" data-preview>Чуй</button>
            </div>` : `<p class="hint">Няма инсталиран глас за ${esc(LANG_NAMES[lang] || lang)}. На Android: Настройки → Достъпност → Синтезиран говор → Google → Инсталиране на гласови данни.</p>`}
            <p class="hint">Съвет: в настройките на Android изберете „Речеви услуги от Google“ и изтеглете гласа в най-високо качество.</p>`;
        const sel = $('#setDeviceVoice', box);
        if (sel) sel.onchange = () => { settings.deviceVoice = sel.value; saveSettings(); player.voiceChanged(); };
    } else if (engine === 'cloud') {
        box.innerHTML = `<div class="group-title">Глас</div><p class="hint" id="cloudVoiceMsg">Зареждам гласовете…</p>`;
        if (!effectiveSettings().apiKey) {
            $('#cloudVoiceMsg', box).textContent = 'Въведете API ключ отдолу, за да заредите гласовете.';
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
                    <p class="hint">Chirp 3 HD звучи най-естествено. WaveNet и Standard са по-прости, но с ~${Math.round(freeHoursPerMonth('Wavenet'))} ч безплатно месечно.</p>`;
                const sel = $('#setCloudVoice', box);
                sel.onchange = () => { settings.cloudVoice = sel.value; saveSettings(); player.voiceChanged(); };
            }).catch((e) => {
                const m = $('#cloudVoiceMsg', box);
                if (m) m.textContent = e.message;
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
            <div class="group-title" style="margin-top:18px">Модел</div>
            <select class="select" id="setGeminiModel"><option value="${esc(settings.geminiModel)}">${esc(settings.geminiModel)}</option></select>
            <p class="hint">Flash моделите са 2× по-евтини от Pro и звучат почти толкова добре. В безплатния план на AI Studio има дневен лимит на заявките.</p>`;
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
        modelSel.onchange = () => { settings.geminiModel = modelSel.value; saveSettings(); player.voiceChanged(); };
        const fillModels = (list) => {
            const all = [...new Set([settings.geminiModel, GEMINI_DEFAULT_MODEL, ...list])];
            modelSel.innerHTML = all.map((m) => `<option value="${esc(m)}" ${m === settings.geminiModel ? 'selected' : ''}>${esc(m)}</option>`).join('');
        };
        if (geminiModelList) fillModels(geminiModelList);
        else if (effectiveSettings().apiKey) {
            geminiModels(effectiveSettings().apiKey).then((l) => { geminiModelList = l; fillModels(l); }).catch(() => {});
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
async function previewVoice(btn) {
    const lang = currentLang();
    const text = SAMPLES[lang] || SAMPLES.en;
    const st = effectiveSettings();
    if (player.playing) player.pause();
    previewAudio?.pause();
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
        previewAudio = new Audio(URL.createObjectURL(rec.blob));
        previewAudio.playbackRate = player.rate;
        previewAudio.play();
    } catch (e) {
        toast(e.message, { error: true, duration: 7000 });
    } finally {
        btn.textContent = old;
        btn.disabled = false;
    }
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
    if (g) geminiModelList = res[0].value;
    if (c) cloudVoiceCache = { bg: res[1].value };
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
    $('#btnPlay').onclick = () => (player.playing ? player.pause() : startPlayback());
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
    slider.addEventListener('input', () => {
        sliderDragging = true;
        const m = player.model(player.pos.c);
        slider.style.setProperty('--p', `${(slider.value / Math.max(1, slider.max)) * 100}%`);
        const left = charLen(m, Number(slider.value), m.sentences.length) / player.charsPerSecond / player.rate;
        $('#pRemain').textContent = `${fmtDuration(left) || '< 1 мин'} до края на главата`;
    });
    slider.addEventListener('change', () => {
        sliderDragging = false;
        player.seekTo(player.pos.c, Number(slider.value));
    });

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
    player.addEventListener('sleep', () => { sleepTimer = null; updateSleepChip(); toast('Лека нощ. Спрях в края на главата.'); });
    player.addEventListener('finished', () => toast('Краят на книгата. Надявам се, че ви е харесала.'));
    player.addEventListener('error', (e) => {
        const err = e.detail;
        console.error(err);
        const offerDevice = settings.engine !== 'device';
        toast(err.message || 'Грешка при четене.', {
            error: true, duration: 8000,
            action: offerDevice ? { label: 'Чети с телефона', run: () => { settings.engine = 'device'; saveSettings(); updatePlayerUI(); player.play(); } } : null,
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

async function init() {
    applyTheme();
    bindEvents();
    updateSleepChip();
    await renderLibrary();
    if ('serviceWorker' in navigator && location.protocol !== 'file:') {
        navigator.serviceWorker.register('sw.js').catch(() => {});
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
