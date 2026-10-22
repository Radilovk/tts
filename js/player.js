// Playback engine. Splits the book into fixed chunks, synthesizes only a
// couple of chunks ahead of the listener, caches every chunk in IndexedDB
// and plays them through a single <audio> element (background playback,
// lock-screen controls, pitch-preserving speed).

import * as db from './db.js';
import { buildChapterModel, chunkBoundaries, nextBoundary, chunkText, charLen, LOCALES } from './text.js';
import { cloudSynthesize, geminiSynthesize, cloudTier, deviceVoices, PRICES } from './engines.js';
import { recordUsage, monthlyCloudChars, monthlyGeminiUsd } from './usage.js';
import { Native } from './native.js';

const CHUNK_CHARS = { cloud: 1400, gemini: 1500 };
const FAST_START_CHARS = 320;

async function hash(str) {
    if (crypto.subtle) {
        const buf = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(str));
        return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
    }
    let h = 2166136261;
    for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
    return (h >>> 0).toString(16) + str.length;
}

export class Player extends EventTarget {
    constructor(getSettings) {
        super();
        this.getSettings = getSettings;
        this.audio = new Audio();
        this.audio.preload = 'auto';
        this.book = null;       // metadata record
        this.chapters = null;   // [{ title, paras }]
        this.models = new Map();
        this.pos = { c: 0, s: 0 };
        this.playing = false;
        this.loading = false;
        this.current = null;    // chunk spec being played
        this.queue = new Map(); // key -> Promise<record>
        this.history = [];
        this.session = 0;
        this.rate = 1;
        this.sleepAtChapterEnd = false;
        this.charsPerSecond = 14;
        this.translated = new Map();  // c -> translated chapter
        this.translating = new Map(); // c -> Promise
        this.translator = null;       // async (c, chapter, onProgress) => translated chapter
        this.synthSeconds = {};       // engine -> average synthesis time
        this._seekTimer = null;
        this._nq = [];                // native utterance ids queued in Android TTS
        this._bindAudio();
        if (Native) this._bindNative();
    }

    // ---------- public API ----------

    async load(book, chapters) {
        this.stop();
        this.book = book;
        this.chapters = chapters;
        this.models.clear();
        this.queue.clear();
        this.translated.clear();
        this.translating.clear();
        this.history = [];
        this.pos = { ...(book.position || { c: 0, s: 0 }) };
        if (this.pos.c >= chapters.length) this.pos = { c: 0, s: 0 };
        this._emit('position');
    }

    chapter(c) {
        return this.translated.get(c) || this.chapters[c];
    }

    model(c) {
        if (!this.models.has(c)) {
            const m = buildChapterModel(this.chapter(c), this.translated.has(c) ? this._lang() : this.book.lang);
            m.pending = this.needsTranslation(c);
            this.models.set(c, m);
        }
        return this.models.get(c);
    }

    needsTranslation(c) {
        return !!this.book?.translateTo && !this.translated.has(c) && c < this.chapters.length;
    }

    // Make sure chapter c is translated (when the book is set to be translated).
    ensureChapter(c) {
        if (!this.needsTranslation(c) || !this.translator) return Promise.resolve();
        if (this.translating.has(c)) return this.translating.get(c);
        const p = (async () => {
            const tr = await this.translator(c, this.chapters[c], (f) => {
                if (c === this.pos.c) this.dispatchEvent(new CustomEvent('translating', { detail: f }));
            });
            const old = this.models.get(c);
            this.translated.set(c, tr);
            this.models.delete(c);
            if (!tr.auto && tr.title) this.book.chapterTitles[c] = tr.title;
            if (this.pos.c === c && old) {
                // Keep the place: same paragraph in the translated text
                const para = old.sentences[this.pos.s]?.p ?? 0;
                const m = this.model(c);
                this.pos = { c, s: m.paras[Math.min(para, m.paras.length - 1)]?.first ?? 0 };
            }
            this._emit('translated');
            this._emit('position');
            this._emit('save');
        })();
        this.translating.set(c, p);
        p.catch(() => this.translating.delete(c));
        return p;
    }

    // Turn translation on/off for the open book, keeping the listener's paragraph.
    setTranslation(to) {
        const wasPlaying = this.playing;
        this.stop();
        const para = this.model(this.pos.c).sentences[this.pos.s]?.p ?? 0;
        this.book.translateTo = to || null;
        this.translated.clear();
        this.translating.clear();
        this.models.clear();
        this.queue.clear();
        this.history = [];
        this.book.chapterTitles = this.chapters.map((ch) => ch.title);
        const m = this.model(this.pos.c);
        this.pos = { c: this.pos.c, s: m.paras[Math.min(para, m.paras.length - 1)]?.first ?? 0 };
        this._emit('translated');
        this._emit('position');
        this._emit('save');
        if (wasPlaying) this.play();
    }

    // Translate the next chapter in the background once the listener is well into this one.
    _prefetchTranslation(c, s) {
        const m = this.models.get(c);
        if (m && s > m.sentences.length * 0.85 && this.needsTranslation(c + 1)) this.ensureChapter(c + 1).catch(() => {});
    }

    get engine() { return this.getSettings().engine; }

    async play() {
        if (!this.book) return;
        if (this.playing) return;
        this.playing = true;
        this._emit('state');
        if (this.needsTranslation(this.pos.c)) {
            const session = ++this.session;
            this.loading = true;
            this._emit('state');
            try { await this.ensureChapter(this.pos.c); } catch (e) { if (session === this.session) this._fail(e); return; }
            if (session !== this.session || !this.playing) return;
            this.loading = false;
            this._emit('state');
        }
        if (this.engine === 'device') return this._deviceSpeak(++this.session);
        if (this.current && this.audio.src && this.audio.currentTime > 0 && !this.audio.ended) {
            try { await this.audio.play(); } catch (e) { this._fail(e); }
            return;
        }
        this._startAt(this.pos.c, this.pos.s);
    }

    pause() {
        if (!this.playing) return;
        this.playing = false;
        this.session++;
        if (this.engine === 'device') this._stopDeviceVoice();
        else this.audio.pause();
        this.loading = false;
        this._emit('state');
        this._emit('save');
    }

    toggle() { this.playing ? this.pause() : this.play(); }

    stop() {
        this.session++;
        this.playing = false;
        this.loading = false;
        this._stopDeviceVoice();
        this.audio.pause();
        this._releaseUrl();
        this.current = null;
        this._emit('state');
    }

    // Jump to a sentence (from the text view, the chapter list or the slider).
    // While playing, the new position starts after a short pause so that rapid
    // taps or scrubbing only synthesize the place where the listener settles.
    seekTo(c, s) {
        const wasPlaying = this.playing || !!this._seekTimer;
        clearTimeout(this._seekTimer);
        this._seekTimer = null;
        this.stop();
        this.pos = { c, s: Math.max(0, s) };
        this._emit('position');
        this._emit('save');
        if (!wasPlaying) return;
        this.playing = true;
        this.loading = true;
        this._emit('state');
        const session = this.session;
        this._seekTimer = setTimeout(() => {
            this._seekTimer = null;
            if (session !== this.session) return;
            this.playing = false;
            this.loading = false;
            this.play();
        }, 450);
    }

    // Relative skip in seconds; works on sentence units for the device voice.
    async skip(seconds) {
        if (!this.book) return;
        if (this.engine === 'device' || !this.current) {
            const sentences = Math.round(seconds / 4);
            return this._skipSentences(sentences);
        }
        const t = this.audio.currentTime + seconds;
        const dur = this.current.dur || this.audio.duration || 0;
        if (t >= 0 && t < dur) { this.audio.currentTime = t; return; }
        if (t < 0) {
            const prev = this.history[this.history.length - 1];
            if (prev) {
                this.history.pop();
                return this._playSpec(prev, ++this.session, { offsetFromEnd: -t });
            }
            this.audio.currentTime = 0;
            return this._skipSentences(-3);
        }
        // Past the end of the chunk: continue into the next one
        const next = await this._specAfter(this.current);
        if (next) {
            this.history.push(this.current);
            return this._playSpec(next, ++this.session, { offset: t - dur });
        }
    }

    _skipSentences(n) {
        let { c, s } = this.pos;
        s += n;
        while (s < 0 && c > 0) { c--; s += this.model(c).sentences.length; }
        while (c < this.chapters.length - 1 && s >= this.model(c).sentences.length) { s -= this.model(c).sentences.length; c++; }
        this.seekTo(c, Math.max(0, Math.min(s, this.model(c).sentences.length - 1)));
    }

    setRate(rate) {
        this.rate = rate;
        this.audio.playbackRate = rate;
        if (this.engine === 'device' && this.playing) {
            // Restart the current sentence at the new rate
            this.session++;
            this._stopDeviceVoice();
            this._deviceSpeak(this.session);
        }
    }

    // Settings that change the voice invalidate the prefetched chunks.
    voiceChanged() {
        const wasPlaying = this.playing;
        this.stop();
        this.queue.clear();
        this.history = [];
        if (wasPlaying) this.play();
    }

    // Synthesize a whole chapter ahead of time (for offline listening).
    async prepareChapter(c, onProgress) {
        await this.ensureChapter(c);
        const m = this.model(c);
        const starts = chunkBoundaries(m, CHUNK_CHARS[this.engine]);
        for (let i = 0; i < starts.length; i++) {
            const s1 = i + 1 < starts.length ? starts[i + 1] : m.sentences.length;
            const spec = await this._spec(c, starts[i], s1);
            if (spec) await this._ensure(spec);
            onProgress?.((i + 1) / starts.length);
        }
    }

    remainingSeconds() {
        if (!this.book) return 0;
        const totals = this.book.chapterChars || [];
        let chars = 0;
        const m = this.model(this.pos.c);
        chars += charLen(m, this.pos.s, m.sentences.length);
        for (let c = this.pos.c + 1; c < totals.length; c++) chars += totals[c];
        return chars / this.charsPerSecond / this.rate;
    }

    chapterRemainingSeconds() {
        const m = this.model(this.pos.c);
        return charLen(m, this.pos.s, m.sentences.length) / this.charsPerSecond / this.rate;
    }

    // ---------- chunk planning ----------

    _settingsKey() {
        const st = this.getSettings();
        if (st.engine === 'cloud') return `cloud|${st.cloudVoice}`;
        if (st.engine === 'gemini') return `gemini|${st.geminiModel}|${st.geminiVoice}|${st.style}|${st.style === 'custom' ? st.customStyle : ''}`;
        return 'device';
    }

    _lang() {
        const st = this.getSettings();
        if (this.book.translateTo) return this.book.translateTo;
        return st.lang && st.lang !== 'auto' ? st.lang : (this.book.lang || 'bg');
    }

    async _spec(c, s0, s1) {
        const m = this.model(c);
        const text = chunkText(m, s0, s1);
        if (!text) return null;
        const vk = this._settingsKey();
        const key = await hash(`${vk}|${this._lang()}|${text}`);
        return { c, s0, s1, text, key, vk, chars: charLen(m, s0, s1) };
    }

    // Spec for a chunk starting at sentence s (partial up to the next fixed boundary).
    async _specFrom(c, s, fastStart) {
        while (c < this.chapters.length) {
            await this.ensureChapter(c);
            const m = this.model(c);
            if (s < m.sentences.length) {
                const starts = chunkBoundaries(m, CHUNK_CHARS[this.engine]);
                let s1 = nextBoundary(starts, s, m.sentences.length);
                let spec = await this._spec(c, s, s1);
                if (!spec) { s = s1; continue; }
                if (fastStart && spec.chars > FAST_START_CHARS * 1.5 && !(await db.audioHas(spec.key))) {
                    // Start quickly with a short piece; the rest follows while it plays
                    spec = await this._spec(c, s, this._fastSplit(m, s, s1));
                }
                return spec;
            }
            c++;
            s = 0;
        }
        return null;
    }

    _specAfter(spec) {
        if (!spec) return null;
        return this._specFrom(spec.c, spec.s1, false);
    }

    // Get (from cache or by synthesis) the audio record for a chunk.
    _ensure(spec) {
        if (this.queue.has(spec.key)) return this.queue.get(spec.key);
        const p = (async () => {
            const cached = await db.audioGet(spec.key);
            if (cached) return cached;
            const rec = await this._synthesize(spec);
            await db.audioPut(rec);
            db.audioEvict(this.getSettings().cacheMB * 1024 * 1024).catch(() => {});
            return rec;
        })();
        this.queue.set(spec.key, p);
        p.catch(() => this.queue.delete(spec.key));
        // Keep the in-memory queue small
        if (this.queue.size > 12) this.queue.delete(this.queue.keys().next().value);
        return p;
    }

    // Hard monthly cap enforced in the app: Google itself only offers per-minute
    // quotas, so this is what keeps a month of listening inside the budget.
    _checkSpendingCap(st, spec) {
        const capError = (msg) => Object.assign(new Error(msg), { reason: 'APP_CAP' });
        if (st.engine === 'cloud' && st.freeOnly) {
            const tier = cloudTier(st.cloudVoice);
            const free = (PRICES.cloud[tier] || PRICES.cloud.Other).free;
            if (monthlyCloudChars(tier) + spec.text.length > free * 0.95) {
                throw capError('Безплатният месечен лимит на Google HD е почти изчерпан — спирам, за да не се таксува.');
            }
        }
        if (st.engine === 'gemini' && st.geminiCapUsd > 0 && monthlyGeminiUsd() >= st.geminiCapUsd) {
            throw capError(`Достигнат месечен лимит за Gemini (${st.geminiCapUsd} $).`);
        }
    }

    async _synthesize(spec) {
        const st = this.getSettings();
        if (!st.apiKey) throw new Error('Добавете Google API ключ в настройките или изберете гласа на устройството.');
        const lang = this._lang();
        this._checkSpendingCap(st, spec);
        const t0 = performance.now();
        let result;
        if (st.engine === 'cloud') {
            const locale = st.cloudVoice.split('-').slice(0, 2).join('-') || LOCALES[lang];
            result = await cloudSynthesize({ apiKey: st.apiKey, text: spec.text, voice: st.cloudVoice, locale });
            recordUsage({ engine: 'cloud', tier: cloudTier(st.cloudVoice), chars: spec.text.length });
        } else {
            result = await geminiSynthesize({
                apiKey: st.apiKey, model: st.geminiModel, text: spec.text, voice: st.geminiVoice,
                style: st.style, customStyle: st.customStyle, lang,
            });
            recordUsage({ engine: 'gemini', inTokens: result.inTokens, outTokens: result.outTokens });
        }
        const took = (performance.now() - t0) / 1000;
        const prev = this.synthSeconds[st.engine];
        this.synthSeconds[st.engine] = prev ? prev * 0.6 + took * 0.4 : took;
        const dur = await blobDuration(result.blob);
        return { key: spec.key, blob: result.blob, dur, chars: spec.chars, bookId: this.book.id };
    }

    // ---------- remote playback ----------

    // Short opening piece of a chunk, so playback starts within seconds. The split
    // point depends only on the text, so the pieces get the same cache keys every time.
    _fastSplit(m, s0, s1) {
        let n = 0, k = s0;
        while (k < s1 - 1 && n < FAST_START_CHARS) { n += m.sentences[k].speak.length + 1; k++; }
        return k;
    }

    // Start playing at sentence s. Anything synthesized before (a whole chunk or its
    // fast-start pieces) is replayed from the cache at no cost.
    async _startAt(c, s) {
        const session = ++this.session;
        try { await this.ensureChapter(c); } catch (e) { if (session === this.session) this._fail(e); return; }
        if (session !== this.session) return;
        const m = this.model(c);
        if (s < m.sentences.length) {
            const starts = chunkBoundaries(m, CHUNK_CHARS[this.engine]);
            let a = 0;
            for (const b of starts) if (b <= s) a = b;
            const end = nextBoundary(starts, a, m.sentences.length);
            const k = this._fastSplit(m, a, end);
            const ranges = [[a, end], [a, k], [k, end]].filter(([x, y]) => x < y && x <= s && s < y);
            for (const [x, y] of ranges) {
                const piece = await this._spec(c, x, y);
                if (session !== this.session) return;
                if (piece && (this.queue.has(piece.key) || await db.audioHas(piece.key))) {
                    if (session !== this.session) return;
                    return this._playSpec(piece, session, { offsetFrac: charLen(m, x, s) / piece.chars });
                }
            }
        }
        const spec = await this._specFrom(c, s, true);
        if (session !== this.session) return;
        if (!spec) return this._finished();
        this._playSpec(spec, session);
    }

    async _playSpec(spec, session, opts = {}) {
        this.current = spec;
        this.loading = true;
        this._emit('state');
        let rec;
        try {
            rec = await this._ensure(spec);
        } catch (e) {
            if (session === this.session) this._fail(e);
            return;
        }
        if (session !== this.session || !this.playing) { this.loading = false; this._emit('state'); return; }
        spec.dur = rec.dur;
        if (rec.dur > 0) this._learnRate(rec.chars, rec.dur);
        this._releaseUrl();
        this._url = URL.createObjectURL(rec.blob);
        this.audio.src = this._url;
        this.audio.playbackRate = this.rate;
        if (opts.offsetFrac) opts.offset = opts.offsetFrac * rec.dur;
        const startAt = opts.offset ? Math.min(opts.offset, rec.dur - 0.5)
            : opts.offsetFromEnd ? Math.max(0, rec.dur - opts.offsetFromEnd) : 0;
        try {
            if (startAt > 0) {
                await new Promise((r) => { this.audio.addEventListener('loadedmetadata', r, { once: true }); });
                this.audio.currentTime = startAt;
            }
            await this.audio.play();
        } catch (e) {
            if (session === this.session) this._fail(e);
            return;
        }
        this.loading = false;
        this._emit('state');
        this._updateMediaSession();
        this._prefetchedFor = null;
    }

    // Just-in-time: synthesize the next chunk only when the current one is about
    // to end (with a margin based on how long synthesis really takes), so pausing
    // or stopping never leaves paid-for audio nobody asked for.
    async _prefetch(spec, session) {
        const next = await this._specAfter(spec);
        if (!next || session !== this.session) return;
        this._ensure(next).catch(() => {});
    }

    _prefetchMargin() {
        const avg = this.synthSeconds[this.engine] || (this.engine === 'gemini' ? 20 : 4);
        return avg * 2 + 8;
    }

    _bindAudio() {
        const a = this.audio;
        a.addEventListener('timeupdate', () => {
            if (!this.current || !this.playing) return;
            const dur = this.current.dur || a.duration;
            if (!dur) return;
            // Estimate the sentence being spoken from elapsed time vs character length
            const frac = Math.min(1, a.currentTime / dur);
            const m = this.model(this.current.c);
            const target = frac * this.current.chars;
            let acc = 0, s = this.current.s0;
            for (let i = this.current.s0; i < this.current.s1; i++) {
                acc += m.sentences[i].speak.length + 1;
                s = i;
                if (acc >= target) break;
            }
            if (s !== this.pos.s || this.current.c !== this.pos.c) {
                this.pos = { c: this.current.c, s };
                this._emit('position');
                this._prefetchTranslation(this.current.c, s);
            }
            const left = (dur - a.currentTime) / (a.playbackRate || 1);
            if (left < this._prefetchMargin() && this._prefetchedFor !== this.current.key) {
                this._prefetchedFor = this.current.key;
                this._prefetch(this.current, this.session);
            }
            this._emit('time');
        });
        a.addEventListener('ended', async () => {
            if (!this.playing || !this.current) return;
            const done = this.current;
            this.history.push(done);
            if (this.history.length > 30) this.history.shift();
            const session = ++this.session;
            let next;
            try { next = await this._specAfter(done); } catch (e) { if (session === this.session) this._fail(e); return; }
            if (session !== this.session) return;
            if (!next) return this._finished();
            if (next.c !== done.c) {
                this._emit('chapter');
                if (this.sleepAtChapterEnd) {
                    this.sleepAtChapterEnd = false;
                    this.pos = { c: next.c, s: 0 };
                    this.pause();
                    this._emit('position');
                    this._emit('sleep');
                    return;
                }
            }
            this.pos = { c: next.c, s: next.s0 };
            this._emit('position');
            this._emit('save');
            this._playSpec(next, session);
        });
        a.addEventListener('pause', () => {
            // Paused externally (headphones unplugged, lock screen)
            if (this.playing && !a.ended && this.engine !== 'device' && !this.loading) {
                this.playing = false;
                this._emit('state');
                this._emit('save');
            }
        });
        a.addEventListener('play', () => {
            if (!this.playing) { this.playing = true; this._emit('state'); }
        });
    }

    _releaseUrl() {
        if (this._url) { URL.revokeObjectURL(this._url); this._url = null; }
    }

    _learnRate(chars, dur) {
        const cps = chars / dur;
        if (cps > 5 && cps < 40) this.charsPerSecond = this.charsPerSecond * 0.7 + cps * 0.3;
    }

    // ---------- device voice ----------

    _stopDeviceVoice() {
        if (Native) {
            this._nq = [];
            Native.stopSpeaking().catch(() => {});
        } else if ('speechSynthesis' in window) speechSynthesis.cancel();
    }

    // ---------- Android TTS (APK) ----------
    // Sentences are queued in the native engine a few at a time, so reading goes
    // on with the screen off even when the WebView is slow to respond.

    _nativeStart(session) {
        this._nq = [];
        this._nCursor = { ...this.pos };
        this._nFlush = true;
        this._nStopAtChapter = false;
        this._nativeFill(session);
    }

    async _nativeFill(session) {
        if (this._nFilling) return;
        this._nFilling = true;
        try {
            while (session === this.session && this.playing && this._nq.length < 3 && !this._nStopAtChapter) {
                const { c, s } = this._nCursor;
                if (c >= this.chapters.length) break;
                const m = this.model(c);
                if (s >= m.sentences.length) {
                    if (c + 1 >= this.chapters.length) { this._nCursor = { c: this.chapters.length, s: 0 }; break; }
                    if (this.sleepAtChapterEnd) { this._nStopAtChapter = true; break; }
                    await this.ensureChapter(c + 1);
                    if (session !== this.session) return;
                    this._nCursor = { c: c + 1, s: 0 };
                    continue;
                }
                this._nCursor = { c, s: s + 1 };
                const sent = m.sentences[s];
                if (!sent.speak) continue;
                const next = m.sentences[s + 1];
                const pause = !next ? 900 : next.p !== sent.p ? (m.paras[sent.p].h ? 800 : 450) : 0;
                const id = `${session}|${c}|${s}`;
                const st = this.getSettings();
                const lang = this._lang();
                this._nq.push(id);
                await Native.speak({
                    id, text: sent.speak, voice: st.deviceVoice || '', lang: LOCALES[lang] || lang,
                    rate: this.rate, pitch: 1, flush: this._nFlush, pauseAfter: Math.round(pause / this.rate),
                });
                this._nFlush = false;
            }
        } catch (e) {
            if (session === this.session) this._fail(e);
        } finally {
            this._nFilling = false;
        }
        // Nothing left to read
        if (session === this.session && this.playing && !this._nq.length && this._nCursor.c >= this.chapters.length) this._finished();
    }

    _bindNative() {
        const parse = (id) => {
            const [sess, c, s] = String(id).split('|').map(Number);
            return { sess, c, s };
        };
        Native.addListener('ttsStart', ({ id }) => {
            if (String(id).endsWith(':pause')) return;
            const u = parse(id);
            if (u.sess !== this.session || !this.playing) return;
            if (u.c !== this.pos.c) this._emit('chapter');
            this.pos = { c: u.c, s: u.s };
            this._emit('position');
            this._emit('save');
            this._prefetchTranslation(u.c, u.s);
        });
        Native.addListener('ttsDone', ({ id }) => {
            if (String(id).endsWith(':pause')) return;
            const u = parse(id);
            this._nq = this._nq.filter((x) => x !== id);
            if (u.sess !== this.session || !this.playing) return;
            if (this._nStopAtChapter && !this._nq.length) {
                this.sleepAtChapterEnd = false;
                this._nStopAtChapter = false;
                this.pos = { c: Math.min(u.c + 1, this.chapters.length - 1), s: 0 };
                this.pause();
                this._emit('position');
                this._emit('sleep');
                return;
            }
            this._nativeFill(this.session);
        });
        Native.addListener('ttsError', ({ id }) => {
            const u = parse(id);
            if (u.sess === this.session && this.playing) this._fail(new Error('Гласът на устройството не можа да прочете текста. Изберете друг глас.'));
        });
    }

    _deviceSpeak(session) {
        if (Native) return this._nativeStart(session);
        if (!('speechSynthesis' in window)) return this._fail(new Error('Устройството не поддържа синтез на реч.'));
        const st = this.getSettings();
        let { c, s } = this.pos;
        let m = this.model(c);
        while (s >= m.sentences.length || !m.sentences[s]?.speak) {
            if (s >= m.sentences.length) {
                if (c + 1 >= this.chapters.length) return this._finished();
                c++; s = 0;
                this._emit('chapter');
                if (this.sleepAtChapterEnd) {
                    this.sleepAtChapterEnd = false;
                    this.pos = { c, s };
                    this.pause();
                    this._emit('position');
                    this._emit('sleep');
                    return;
                }
                if (this.needsTranslation(c)) {
                    this.pos = { c, s };
                    this.loading = true;
                    this._emit('state');
                    this.ensureChapter(c).then(() => {
                        this.loading = false;
                        this._emit('state');
                        if (session === this.session && this.playing) this._deviceSpeak(session);
                    }, (e) => { if (session === this.session) this._fail(e); });
                    return;
                }
                m = this.model(c);
            } else s++;
        }
        this.pos = { c, s };
        this._emit('position');
        this._prefetchTranslation(c, s);
        const sentence = m.sentences[s];
        const u = new SpeechSynthesisUtterance(sentence.speak);
        const lang = this._lang();
        u.lang = LOCALES[lang] || lang;
        const voices = deviceVoices(lang);
        const voice = voices.find((v) => v.voiceURI === st.deviceVoice) || voices[0];
        if (voice) { u.voice = voice; u.lang = voice.lang; }
        u.rate = this.rate;
        u.pitch = 1;
        // Natural breathing pauses: longer after paragraphs and headings
        const nextS = m.sentences[s + 1];
        const pauseMs = !nextS ? 900 : nextS.p !== sentence.p ? (m.paras[sentence.p].h ? 800 : 450) : 120;
        u.onend = () => {
            if (session !== this.session || !this.playing) return;
            this.pos = { c, s: s + 1 };
            this._emit('save');
            setTimeout(() => {
                if (session === this.session && this.playing) this._deviceSpeak(session);
            }, pauseMs / this.rate);
        };
        u.onerror = (e) => {
            if (session !== this.session || e.error === 'interrupted' || e.error === 'canceled') return;
            this._fail(new Error('Грешка при четене: ' + e.error));
        };
        speechSynthesis.speak(u);
        this._updateMediaSession();
    }

    // ---------- misc ----------

    _finished() {
        this.playing = false;
        this.loading = false;
        this.current = null;
        this._emit('state');
        this._emit('save');
        this._emit('finished');
    }

    _fail(err) {
        if (err?.name === 'AbortError') return;
        this.playing = false;
        this.loading = false;
        this._emit('state');
        this.dispatchEvent(new CustomEvent('error', { detail: err }));
    }

    _emit(type) { this.dispatchEvent(new Event(type)); }

    _updateMediaSession() {
        if (!('mediaSession' in navigator) || !this.book) return;
        const artwork = this.book.coverUrl ? [{ src: this.book.coverUrl, sizes: '400x600', type: 'image/jpeg' }] : [];
        navigator.mediaSession.metadata = new MediaMetadata({
            title: this.chapters[this.pos.c]?.title || this.book.title,
            artist: this.book.author || '',
            album: this.book.title,
            artwork,
        });
    }
}

function blobDuration(blob) {
    return new Promise((resolve) => {
        const a = new Audio();
        const url = URL.createObjectURL(blob);
        const done = (d) => { URL.revokeObjectURL(url); resolve(d); };
        a.preload = 'metadata';
        a.onloadedmetadata = () => {
            if (a.duration === Infinity || isNaN(a.duration)) {
                // Some browsers need a seek to compute the duration of OGG
                a.currentTime = 1e7;
                a.ontimeupdate = () => { a.ontimeupdate = null; done(a.duration || 0); };
            } else done(a.duration);
        };
        a.onerror = () => done(0);
        a.src = url;
    });
}
