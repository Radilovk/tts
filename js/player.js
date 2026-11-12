// Playback engine. Splits the book into fixed chunks, synthesizes only a
// couple of chunks ahead of the listener, caches every chunk in IndexedDB
// and plays them through a single <audio> element (background playback,
// lock-screen controls, pitch-preserving speed).

import * as db from './db.js';
import { buildChapterModel, chunkBoundaries, nextBoundary, chunkText, charLen, LOCALES } from './text.js';
import { cloudNarrate, cloudBilledChars, geminiSynthesize, geminiCost, cloudTier, deviceVoices, azureSynthesize, azureBilledChars, isVerifiedGeminiModel, quotaKind } from './engines.js';
import { pendingKeys } from './batch.js';
import { sharedGetAudio, sharedPutAudio } from './shared.js';
import { recordUsage, monthlyGeminiUsd, cloudReserve, cloudRelease, reportCloudUsage, azureFreeLeft } from './usage.js';
import { Native, NativeAudio } from './native.js';
import { sentenceMarks } from './align.js';

const CHUNK_CHARS = { cloud: 1400, gemini: 1500, azure: 2000 };
const FAST_START_CHARS = 320;
// Chunking v2 (new books): longer passages that end at paragraphs, so the joins between
// separately narrated passages are fewer and fall on natural pauses.
const CHUNK_V2 = { gemini: { max: 2600, para: 0.6 }, cloud: { max: 1400, para: 0.5 }, azure: { max: 2400, para: 0.6 } };
const FAST_START_V2 = { min: 450, max: 1100 };
// Chunking v4 (new books): the narrator gets passages up to ~3600 characters (~4 min of
// audio, well inside a request's limits). The free Gemini quota counts requests a day,
// so longer passages mean more free listening per day and fewer joins.
// Chunking v3: Google HD gets longer passages (up to ~2000 characters, still within its
// 5000-byte limit), so the voice keeps one melody over more text and joins are rarer.
const CHUNK_V3 = { ...CHUNK_V2, cloud: { max: 2000, para: 0.6 } };
const CHUNK_V4 = { ...CHUNK_V3, gemini: { max: 3600, para: 0.6 } };
// Network hiccups during playback are retried instead of stopping the book
const PLAY_RETRIES = [3, 6, 12, 20, 30];

// What happened when playback stalled or recovered — kept on the device (last 60
// entries) and shown in Settings, so a stop can be traced to its cause.
const DIAG_KEY = 'rz_diag';
export function diag(msg) {
    try {
        const list = JSON.parse(localStorage.getItem(DIAG_KEY) || '[]');
        list.push(`${new Date().toLocaleString('bg-BG')} · ${msg}`);
        localStorage.setItem(DIAG_KEY, JSON.stringify(list.slice(-60)));
    } catch {}
}
export function diagLog() {
    try { return JSON.parse(localStorage.getItem(DIAG_KEY) || '[]'); } catch { return []; }
}
export function diagClear() {
    try { localStorage.removeItem(DIAG_KEY); } catch {}
}

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
        // A book narrated by the night studio always plays in the studio's voice, so the
        // audio made on the server is what is heard (no new synthesis, no other voice)
        this.getSettings = () => {
            const st = getSettings();
            const v = this.book?.factory?.voice;
            if (v) return { ...st, ...v, engine: 'gemini' };
            // Plan C: Google WaveNet/Standard is Google Cloud TTS with another voice
            if (st.engine === 'wavenet') return { ...st, engine: 'cloud', cloudVoice: st.wavenetVoice || '' };
            return st;
        };
        // Android app: the sound comes from Android's MediaPlayer (see NativeAudio)
        // (Android 10+: MediaPlayer plays Ogg/Opus only from Android 10)
        const android = Number((navigator.userAgent.match(/Android (\d+)/) || [])[1] || 0);
        this.audio = Native && android >= 10 ? new NativeAudio() : new Audio();
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
        clearTimeout(this._seekTimer);
        this._seekTimer = null;
        this.gen = (this.gen || 0) + 1; // work started for an earlier book is dropped
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
        const gen = this.gen;
        const book = this.book;
        const p = (async () => {
            const tr = await this.translator(c, this.chapters[c], (f) => {
                if (gen === this.gen && c === this.pos.c) this.dispatchEvent(new CustomEvent('translating', { detail: f }));
            });
            // Another book was opened (or translation switched off) meanwhile
            if (gen !== this.gen || book !== this.book || !this.book.translateTo) throw Object.assign(new Error('stale'), { name: 'AbortError' });
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
        p.catch(() => { if (this.translating.get(c) === p) this.translating.delete(c); });
        return p;
    }

    // Turn translation on/off for the open book, keeping the listener's paragraph.
    setTranslation(to) {
        const wasPlaying = this.playing;
        this.stop();
        const para = this.model(this.pos.c).sentences[this.pos.s]?.p ?? 0;
        this.book.translateTo = to || null;
        this.gen = (this.gen || 0) + 1;
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
        // Paused, into another passage: move the reading place by sentences (playing
        // passages are only loaded while playing)
        if (!this.playing) return this._skipSentences(Math.round(seconds / 4));
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

    // All fixed chunks of chapter c for the current voice settings, or for the given
    // settings (audio files and the night studio always use the Gemini narrator).
    async chapterSpecs(c, st = null) {
        await this.ensureChapter(c);
        const m = this.model(c);
        const starts = this._boundaries(m, st?.engine);
        const out = [];
        for (let i = 0; i < starts.length; i++) {
            const s1 = i + 1 < starts.length ? starts[i + 1] : m.sentences.length;
            const spec = await this._spec(c, starts[i], s1, st);
            if (spec) out.push(spec);
        }
        return out;
    }

    // Synthesize a whole chapter ahead of time (for offline listening).
    async prepareChapter(c, onProgress) {
        await this.ensureChapter(c);
        const m = this.model(c);
        const starts = this._boundaries(m);
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

    // Fixed chunk starts of a chapter. Books keep the chunking they were first narrated
    // with, so audio already paid for keeps matching.
    _boundaries(m, engine = this.engine) {
        const v = this.book?.chunkV >= 4 ? CHUNK_V4[engine] : this.book?.chunkV >= 3 ? CHUNK_V3[engine] : this.book?.chunkV >= 2 && CHUNK_V2[engine];
        if (v) return chunkBoundaries(m, v.max, v.para);
        return chunkBoundaries(m, CHUNK_CHARS[engine] || CHUNK_CHARS.gemini);
    }

    _settingsKey(st = this.getSettings()) {
        // v3: every passage checked for skipped text and levelled. The version is part
        // of the cache key, so passages made before (possibly cut short) are not replayed
        if (st.engine === 'cloud') return `cloud3|${st.cloudVoice}`;
        if (st.engine === 'azure') return `azure1|${st.azureVoice}`;
        if (st.engine === 'gemini') return `gemini|${st.geminiModel}|${st.geminiVoice}|${st.style}|${st.style === 'custom' ? st.customStyle : ''}`;
        return 'device';
    }

    _lang() {
        const st = this.getSettings();
        if (this.book.translateTo) return this.book.translateTo;
        return st.lang && st.lang !== 'auto' ? st.lang : (this.book.lang || 'bg');
    }

    async _spec(c, s0, s1, st = null) {
        const m = this.model(c);
        const text = chunkText(m, s0, s1);
        if (!text) return null;
        const vk = this._settingsKey(st || undefined);
        const lang = this._lang();
        const key = await hash(`${vk}|${lang}|${text}`);
        return { c, s0, s1, text, key, vk, lang, chars: charLen(m, s0, s1), ...(st ? { st } : {}) };
    }

    // Spec for a chunk starting at sentence s (partial up to the next fixed boundary).
    async _specFrom(c, s, fastStart) {
        while (c < this.chapters.length) {
            await this.ensureChapter(c);
            const m = this.model(c);
            if (s < m.sentences.length) {
                const starts = this._boundaries(m);
                let s1 = nextBoundary(starts, s, m.sentences.length);
                let spec = await this._spec(c, s, s1);
                if (!spec) { s = s1; continue; }
                // No fast-start split for a chunk that is being prepared at half price:
                // waiting for it is the whole point of economy mode
                if (fastStart && !this.book.factory && spec.chars > this._fastMin() * 1.5 && !pendingKeys().has(spec.key) && !(await db.audioHas(spec.key))) {
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
    // remoteOnly: take it from the cache or the server, never pay for a new synthesis
    // spec.fresh: the listener asked for it again — ignore every stored copy
    _ensure(spec, { remoteOnly = false } = {}) {
        if (this.queue.has(spec.key)) return this.queue.get(spec.key);
        const book = this.book;
        const p = (async () => {
            const cached = spec.fresh ? null : await db.audioGet(spec.key);
            if (cached) return cached;
            const shared = !!book.shared;
            // Public-domain book: someone may already have had this part narrated.
            // A book sent to the night studio: the server has narrated it
            if ((shared || book.factory) && !spec.fresh) {
                const remote = await sharedGetAudio(spec.key);
                if (remote) {
                    const rec = { key: spec.key, blob: remote.blob, dur: remote.dur || await blobDuration(remote.blob), chars: spec.chars, bookId: book.id };
                    await db.audioPut(rec);
                    return rec;
                }
            }
            if (remoteOnly) throw Object.assign(new Error('not ready'), { name: 'AbortError' });
            const rec = await this._synthesize(spec, book);
            await db.audioPut(rec);
            if (shared) sharedPutAudio(spec.key, spec.vk, spec.lang, spec.text, rec.blob, rec.dur);
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
        if (st.engine === 'gemini' && st.geminiCapUsd > 0 && monthlyGeminiUsd() >= st.geminiCapUsd) {
            throw capError(`Достигнат месечен лимит за Gemini (${st.geminiCapUsd} $).`);
        }
    }

    async _synthesize(spec, book = this.book) {
        const st = spec.st || this.getSettings();
        if (st.engine === 'azure') return this._synthesizeAzure(spec, book, st);
        const freeKey = st.engine === 'gemini' ? usableFreeKey(st) : '';
        // "Only free": the narrator reads with the free key alone and never pays; when
        // the day's free quota is used up, the app goes on with a free plan-B voice
        const freeOnly = st.engine === 'gemini' && st.geminiFreeOnly && !book?.factory;
        if (freeOnly && !freeKey) {
            throw Object.assign(new Error(st.geminiFreeKey
                ? 'Безплатният дневен лимит на Gemini разказвача свърши за днес.'
                : 'За безплатен Gemini разказвач е нужен безплатен ключ (Настройки → Gemini → Безплатен ключ).'), { reason: 'APP_CAP', geminiFreeCap: true });
        }
        if (!st.apiKey && !freeKey) throw new Error('Добавете Google API ключ в настройките или изберете гласа на устройството.');
        const lang = spec.lang || this._lang();
        // Economy mode: this part is already being prepared at half price
        if (st.engine === 'gemini' && st.geminiEconomy && !this.allowFullPrice && pendingKeys().has(spec.key)) {
            throw Object.assign(new Error('Тази част се подготвя на половин цена — обикновено до няколко минути.'), { reason: 'BATCH_PENDING' });
        }
        if (!freeKey) this._checkSpendingCap(st, spec);
        const t0 = performance.now();
        let result;
        if (st.engine === 'cloud') {
            // Google HD is used only inside the free monthly characters — always. The
            // characters are reserved before the request leaves, so passages prefetched
            // at the same time cannot pass the limit together.
            const tier = cloudTier(st.cloudVoice);
            const locale = st.cloudVoice.split('-').slice(0, 2).join('-') || LOCALES[lang];
            // Every request of the passage (a retry, two halves) is reserved first
            const beforeRequest = (billed) => {
                if (!cloudReserve(tier, billed)) {
                    const name = tier === 'Chirp3-HD' ? 'Google HD' : `Google ${tier === 'Wavenet' ? 'WaveNet' : tier}`;
                    diag(`${name}: безплатните знаци за месеца свършиха — спрях преди таксуване`);
                    throw Object.assign(new Error(`Безплатните знаци на ${name} за този месец свършиха — спрях го, преди да започне да се таксува.`), { reason: 'APP_CAP', cloudCap: true, tier });
                }
                return () => cloudRelease(tier, billed);
            };
            const afterRequest = (billed) => {
                recordUsage({ engine: 'cloud', tier, chars: billed });
                reportCloudUsage(st.apiKey, tier, billed);
            };
            result = await cloudNarrate({
                apiKey: st.apiKey, text: spec.text, voice: st.cloudVoice, locale,
                beforeRequest, afterRequest, onIssue: (m) => diag(`${m} (гл. ${spec.c + 1}, изр. ${spec.s0 + 1}–${spec.s1})`),
            });
        } else {
            const req = { model: st.geminiModel, text: spec.text, voice: st.geminiVoice, style: st.style, customStyle: st.customStyle, lang };
            let free = false;
            if (freeKey) {
                // Free daily quota first (key from a project without billing). Each TTS
                // model has its own free daily quota, so when the chosen one is used up
                // the other verified narrator models (same voices) read on for free.
                let lastErr = null;
                for (const model of freeModels(st)) {
                    for (let attempt = 0; attempt < 3 && !result; attempt++) {
                        try {
                            result = await geminiSynthesize({ ...req, model, apiKey: freeKey, retry429: false });
                            free = true;
                            if (model !== st.geminiModel) diag(`Gemini: безплатно с ${model} (лимитът на ${st.geminiModel} за днес свърши)`);
                        } catch (e) {
                            if (e.status !== 429 && e.status !== 403 && e.status !== 404) throw e;
                            lastErr = e;
                            const q = quotaKind(e);
                            // Only the per-minute limit: wait the seconds Google asks for
                            if (e.status === 429 && !q.daily && attempt < 2) {
                                const wait = Math.min(65, Math.max(5, q.wait || 20));
                                diag(`Gemini: минутен лимит — изчаквам ${wait} сек.`);
                                this.dispatchEvent(new CustomEvent('retrying', { detail: { seconds: wait } }));
                                await new Promise((r) => setTimeout(r, wait * 1000));
                                continue;
                            }
                            markModelExhausted(model);
                            break;
                        }
                    }
                    if (result) break;
                }
                if (!result) {
                    if (!lastErr) lastErr = new Error('no free model');
                    markFreeKeyExhausted();
                    if (freeOnly) {
                        diag('Gemini: безплатният дневен лимит свърши — продължавам с безплатен глас');
                        throw Object.assign(new Error('Безплатният дневен лимит на Gemini разказвача свърши за днес.'), { reason: 'APP_CAP', geminiFreeCap: true });
                    }
                    if (!st.apiKey) throw new Error('Безплатният дневен лимит на Gemini е изчерпан. Утре продължава безплатно.');
                }
            }
            if (!result) {
                this._checkSpendingCap(st, spec);
                result = await geminiSynthesize({ ...req, apiKey: st.apiKey });
            }
            recordUsage({
                engine: 'gemini', inTokens: result.inTokens, outTokens: result.outTokens,
                usd: free ? 0 : geminiCost(st.geminiModel, result.inTokens, result.outTokens), mode: free ? 'free' : '',
            });
        }
        const took = (performance.now() - t0) / 1000;
        const prev = this.synthSeconds[st.engine];
        this.synthSeconds[st.engine] = prev ? prev * 0.6 + took * 0.4 : took;
        const dur = result.dur || await blobDuration(result.blob);
        return { key: spec.key, blob: result.blob, dur, chars: spec.chars, bookId: book.id };
    }

    // Microsoft neural voices: one request per passage, inside the free characters
    async _synthesizeAzure(spec, book, st) {
        if (!st.azureKey || !st.azureRegion) {
            throw Object.assign(new Error('Добавете ключ и регион за Microsoft гласовете в настройките.'), { reason: 'AZURE_SETUP' });
        }
        const billed = azureBilledChars(spec.text);
        if (azureFreeLeft() < billed) {
            diag('Microsoft: безплатните знаци за месеца свършиха — спрях');
            throw Object.assign(new Error('Безплатните знаци на Microsoft гласовете за този месец свършиха.'), { reason: 'APP_CAP', azureCap: true });
        }
        const t0 = performance.now();
        let result;
        try {
            result = await azureSynthesize({
                key: st.azureKey, region: st.azureRegion, text: spec.text, voice: st.azureVoice,
                locale: LOCALES[spec.lang || this._lang()] || 'bg-BG',
                onSplit: (e) => diag(`Microsoft: откъсът е прочетен на две части — ${e.message} (гл. ${spec.c + 1})`),
            });
        } catch (e) {
            if (e.reason === 'AZURE_QUOTA') throw Object.assign(new Error(e.message), { reason: 'APP_CAP', azureCap: true });
            throw e;
        }
        recordUsage({ engine: 'azure', chars: result.chars });
        const took = (performance.now() - t0) / 1000;
        const prev = this.synthSeconds.azure;
        this.synthSeconds.azure = prev ? prev * 0.6 + took * 0.4 : took;
        const dur = await blobDuration(result.blob);
        return { key: spec.key, blob: result.blob, dur, chars: spec.chars, bookId: book.id };
    }

    // ---------- remote playback ----------

    // Short opening piece of a chunk, so playback starts within seconds. The split
    // point depends only on the text, so the pieces get the same cache keys every time.
    _fastMin() {
        return this.book?.chunkV >= 2 ? FAST_START_V2.min : FAST_START_CHARS;
    }

    _fastSplit(m, s0, s1) {
        let n = 0, k = s0;
        if (this.book?.chunkV >= 2) {
            // End the opening piece with a paragraph, so the join sounds like a pause
            while (k < s1 - 1 && n < FAST_START_V2.max) {
                n += m.sentences[k].speak.length + 1;
                k++;
                if (n >= FAST_START_V2.min && m.sentences[k].p !== m.sentences[k - 1].p) return k;
            }
            k = s0; n = 0;
        }
        while (k < s1 - 1 && n < this._fastMin()) { n += m.sentences[k].speak.length + 1; k++; }
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
            const starts = this._boundaries(m);
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
                    return this._playSpec(piece, session, { sentence: s, offsetFrac: charLen(m, x, s) / piece.chars });
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
        for (let attempt = 0; ; attempt++) {
            try {
                rec = await this._ensure(spec);
                break;
            } catch (e) {
                if (session !== this.session) return;
                // Lost connection or a busy server: wait and try again instead of stopping
                const transient = e?.retryable || e?.status === 0 || (typeof navigator !== 'undefined' && navigator.onLine === false);
                if (!transient || attempt >= PLAY_RETRIES.length || !this.playing || /APP_CAP|BATCH_PENDING/.test(e?.reason || '')) { this._fail(e); return; }
                this.dispatchEvent(new CustomEvent('retrying', { detail: { seconds: PLAY_RETRIES[attempt], message: e.message } }));
                await waitOnline(PLAY_RETRIES[attempt] * 1000);
                if (session !== this.session || !this.playing) return;
            }
        }
        if (session !== this.session || !this.playing) { this.loading = false; this._emit('state'); return; }
        spec.dur = rec.dur;
        if (rec.dur > 0) this._learnRate(rec.chars, rec.dur);
        this._releaseUrl();
        const badAudio = async (e) => {
            diag(`откъсът не може да се възпроизведе (${e.message || e.name}) — взимам го наново`);
            this.queue.delete(spec.key);
            await db.del('audio', spec.key).catch(() => {});
            if (session !== this.session) return;
            if (opts.refetched) return this._fail(e);
            return this._playSpec(spec, session, { ...opts, refetched: true });
        };
        if (this.audio.isNative) {
            try { await this.audio.loadBlob(rec.blob); } catch (e) {
                if (session !== this.session || !this.playing || e.name === 'AbortError') return;
                return badAudio(e);
            }
            if (session !== this.session || !this.playing) { this.loading = false; this._emit('state'); return; }
            // Android's own length of the passage is exact
            if (this.audio.duration > 0) { spec.dur = this.audio.duration; if (!rec.dur) rec.dur = spec.dur; }
        } else {
            this._url = URL.createObjectURL(rec.blob);
            this.audio.src = this._url;
        }
        this.audio.playbackRate = this.rate;
        // Starting inside a passage (tap on a sentence, resume): at the sentence's real
        // start in the audio when it is known, otherwise by characters
        if (opts.sentence != null) {
            const marks = await this._marksFor(spec, rec, 2500);
            if (session !== this.session || !this.playing) return;
            const t = marks?.[opts.sentence - spec.s0];
            if (t != null) { opts.offset = t; opts.offsetFrac = 0; }
        } else {
            this._marksFor(spec, rec);
        }
        if (opts.offsetFrac) opts.offset = opts.offsetFrac * rec.dur;
        const startAt = opts.offset ? Math.min(opts.offset, (rec.dur || spec.dur || 1e9) - 0.5)
            : opts.offsetFromEnd ? Math.max(0, rec.dur - opts.offsetFromEnd) : 0;
        // play() can be refused for a moment (audio focus, the WebView waking up):
        // try again before giving up instead of stopping the book
        for (let attempt = 0; ; attempt++) {
            try {
                if (startAt > 0 && attempt === 0) {
                    if (!this.audio.isNative) await new Promise((r) => { this.audio.addEventListener('loadedmetadata', r, { once: true }); });
                    this.audio.currentTime = startAt;
                }
                await this.audio.play();
                break;
            } catch (e) {
                if (session !== this.session || !this.playing) return;
                diag(`play() отказа (${e.name || ''} ${e.message || ''}), опит ${attempt + 1}`);
                // The passage itself cannot be decoded (damaged in the cache or a cut-off
                // download): throw it away and get it once more instead of stopping
                if (e.name === 'NotSupportedError') return badAudio(e);
                if (attempt >= 3) { this._fail(e); return; }
                await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
                if (session !== this.session || !this.playing) return;
            }
        }
        this._started = Date.now();
        this.loading = false;
        this._emit('state');
        this._updateMediaSession();
        this._prefetchedFor = null;
    }

    // The listener heard a bad passage (a skipped word, noise, an odd reading): forget it
    // and narrate it again — every request is a new performance. which: 'current' or
    // 'previous'. Plays the new version from its beginning.
    async redoPassage(which = 'current') {
        const spec = which === 'previous' ? this.history[this.history.length - 1] : this.current;
        if (!spec || this.engine === 'device') return false;
        diag(`по ваша молба откъсът се чете наново (гл. ${spec.c + 1}, изр. ${spec.s0 + 1}–${spec.s1})`);
        const session = ++this.session;
        // loading first: this pause is ours, not the listener's
        this.loading = true;
        this._emit('state');
        this.audio.pause();
        this.queue.delete(spec.key);
        this._marking?.delete(spec.key);
        await db.del('audio', spec.key).catch(() => {});
        if (session !== this.session) return false;
        if (which === 'previous') this.history.pop();
        this.playing = true;
        this.pos = { c: spec.c, s: spec.s0 };
        this._emit('position');
        const fresh = { ...spec, marks: null, dur: 0, fresh: true };
        this._playSpec(fresh, session);
        return true;
    }

    // Start time of every sentence of a passage in its audio (see align.js), worked out
    // once and kept with the cached audio. Sentences that are not read (notes) start
    // where the next spoken one starts. wait: ms to wait for it, otherwise in background.
    _marksFor(spec, rec, wait = 0) {
        const n = spec.s1 - spec.s0;
        if (rec.marks?.length === n) { spec.marks = rec.marks; return Promise.resolve(rec.marks); }
        this._marking = this._marking || new Map();
        let p = this._marking.get(spec.key);
        if (!p) {
            const m = this.model(spec.c);
            const spoken = [];
            for (let i = spec.s0; i < spec.s1; i++) if (m.sentences[i].speak) spoken.push(i);
            p = (async () => {
                const t = await sentenceMarks(rec.blob, spoken.map((i) => m.sentences[i].speak.length));
                if (!t || t.length !== spoken.length) return null;
                const marks = new Array(n);
                let k = spoken.length - 1;
                for (let i = spec.s1 - 1; i >= spec.s0; i--) {
                    if (k >= 0 && spoken[k] === i) { marks[i - spec.s0] = t[k]; k--; }
                    else marks[i - spec.s0] = i + 1 < spec.s1 ? marks[i + 1 - spec.s0] : (rec.dur || t[t.length - 1]);
                }
                rec.marks = marks;
                db.audioPut(rec).catch(() => {});
                return marks;
            })().catch(() => null).finally(() => this._marking.delete(spec.key));
            this._marking.set(spec.key, p);
        }
        p.then((marks) => { if (marks) spec.marks = marks; });
        if (!wait) return p;
        return Promise.race([p, new Promise((r) => setTimeout(() => r(null), wait))]);
    }

    // Just-in-time: synthesize the next chunk only when the current one is about
    // to end (with a margin based on how long synthesis really takes), so pausing
    // or stopping never leaves paid-for audio nobody asked for.
    // Google HD within the free monthly characters costs nothing, so it works two
    // passages ahead from the moment a passage starts: a slow network, a phone that
    // throttles the page with the screen off, or a retry never leaves a gap.
    async _prefetch(spec, session, depth = 1) {
        let cur = spec;
        // Night-studio book with another voice: only download what the server made
        const remoteOnly = this.getSettings().engine !== 'cloud' && !!this.book?.factory;
        for (let i = 0; i < depth; i++) {
            const next = await this._specAfter(cur);
            if (!next || session !== this.session) return;
            try { this._marksFor(next, await this._ensure(next, { remoteOnly: remoteOnly && i > 0 })); } catch { return; }
            if (session !== this.session) return;
            cur = next;
        }
    }

    _eagerPrefetch() {
        const st = this.getSettings();
        return st.engine === 'cloud' || st.engine === 'azure' || !!this.book?.factory;
    }

    _prefetchMargin() {
        if (this._eagerPrefetch()) return Infinity;
        const avg = this.synthSeconds[this.engine] || (this.engine === 'gemini' ? 20 : 4);
        return avg * 2 + 8;
    }

    _bindAudio() {
        const a = this.audio;
        a.addEventListener('timeupdate', () => {
            if (!this.current || !this.playing) return;
            const dur = this.current.dur || a.duration;
            if (!dur) return;
            const m = this.model(this.current.c);
            let s = this.current.s0;
            const marks = this.current.marks;
            if (marks) {
                // The real start of each sentence, found in the audio (align.js)
                for (let i = 0; i < marks.length; i++) if (marks[i] <= a.currentTime + 0.05) s = this.current.s0 + i;
            } else {
                // Until then: elapsed time vs character length
                const target = Math.min(1, a.currentTime / dur) * this.current.chars;
                let acc = 0;
                for (let i = this.current.s0; i < this.current.s1; i++) {
                    acc += m.sentences[i].speak.length + 1;
                    s = i;
                    if (acc >= target) break;
                }
            }
            if (s !== this.pos.s || this.current.c !== this.pos.c) {
                this.pos = { c: this.current.c, s };
                this._emit('position');
                this._prefetchTranslation(this.current.c, s);
            }
            const left = (dur - a.currentTime) / (a.playbackRate || 1);
            if (left < this._prefetchMargin() && this._prefetchedFor !== this.current.key) {
                this._prefetchedFor = this.current.key;
                this._prefetch(this.current, this.session, this._eagerPrefetch() ? 2 : 1);
            }
            this._emit('time');
        });
        a.addEventListener('ended', () => {
            if (unlockClip() || !this.playing || !this.current) return;
            this._advance();
        });
        // The silent clip used to unlock audio on the first tap is not playback
        const unlockClip = () => (a.currentSrc || a.src || '').startsWith('data:');
        this._bindAudioState(a, unlockClip);
    }

    // The passage has been heard to the end: go on with the next one.
    async _advance() {
        const done = this.current;
        this.history.push(done);
        if (this.history.length > 30) this.history.shift();
        const session = ++this.session;
        let next;
        const slow = setTimeout(() => { if (session === this.session) { this.loading = true; this._emit('state'); } }, 400);
        try { next = await this._specAfter(done); } catch (e) { clearTimeout(slow); if (session === this.session) this._fail(e); return; }
        clearTimeout(slow);
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
    }

    _bindAudioState(a, unlockClip) {
        // The 'pause' event comes just before 'ended' at the end of every passage. With
        // MP3 the reported duration is an estimate, so a.ended can still be false then;
        // treating that as "paused by the user" stopped the book at a join.
        const atEnd = () => a.ended || (a.duration > 0 && a.currentTime >= a.duration - 0.35);
        a.addEventListener('pause', () => {
            if (unlockClip()) return;
            // Paused externally (headphones unplugged, lock screen)
            if (this.playing && !atEnd() && this.engine !== 'device' && !this.loading) {
                diag(`спряно отвън${a.pausedBy === 'focus' ? ' (Android даде звука на друго — разговор, навигация)' : a.pausedBy === 'noisy' ? ' (слушалките са изключени)' : ''} на ${a.currentTime.toFixed(1)} от ${(a.duration || 0).toFixed(1)} сек.`);
                this.playing = false;
                this._emit('state');
                this._emit('save');
            }
        });
        a.addEventListener('play', () => {
            if (unlockClip()) return;
            if (!this.playing) { this.playing = true; this._emit('state'); }
        });
        // A passage that cannot be decoded (damaged in the cache, cut-off download) gave
        // no 'ended' and no error, just silence. Drop it and narrate the place again.
        a.addEventListener('error', () => {
            if (unlockClip() || !this.playing || !this.current || this.loading) return;
            const bad = this.current;
            diag(`аудиото на откъса не се възпроизвежда (код ${a.error?.code || '?'}) — взимам го наново`);
            this.queue.delete(bad.key);
            db.del('audio', bad.key).catch(() => {});
            this._recover('грешка в аудиото');
        });
        this._watchdog();
    }

    // Self-healing: whatever the cause (audio focus, the WebView paused with the screen
    // off, an event that never came), if the book should be playing but the audio
    // stands still, playback restarts from the sentence being read. Cached audio is
    // reused, so this costs nothing.
    _watchdog() {
        let lastT = -1, still = 0, loadingSince = 0;
        setInterval(() => {
            if (!this.playing || this.engine === 'device' || this._seekTimer || !this.book) { still = 0; lastT = -1; loadingSince = 0; return; }
            const a = this.audio;
            if (this.loading) {
                // Synthesis with retries has its own limits; only a load that never ends
                loadingSince = loadingSince || Date.now();
                if (Date.now() - loadingSince > 240000) {
                    loadingSince = 0;
                    this._recover('зареждането не приключи');
                }
                still = 0;
                return;
            }
            loadingSince = 0;
            if (!this.current) return;
            const t = a.currentTime;
            if (a.paused || a.ended || t === lastT) still++;
            else still = 0;
            lastT = t;
            // Only a clear stall: 10 s ended/paused while it should play, 16 s with the
            // clock standing still. A join between passages takes well under a second.
            const limit = a.paused || a.ended ? 5 : 8;
            if (still >= limit && Date.now() - (this._started || 0) > 4000) {
                still = 0;
                this._recover(a.ended ? 'следващият откъс не тръгна' : a.paused ? 'аудиото спря без пауза от вас' : 'аудиото замръзна');
            }
        }, 2000);
    }

    _recover(why) {
        if (Date.now() - (this._lastRecover || 0) < 8000) return;
        this._lastRecover = Date.now();
        const a = this.audio;
        const spec = this.current;
        const t = a.currentTime || 0;
        const dur = spec?.dur || a.duration || 0;
        diag(`възстановяване: ${why} (откъс ${spec ? `гл. ${spec.c + 1}, изр. ${spec.s0 + 1}–${spec.s1}` : '—'}, ${t.toFixed(1)}/${dur.toFixed(1)} сек., ${a.paused ? 'пауза' : 'свири'}${a.ended ? ', край' : ''}${a.isNative ? ', Android' : ''})`);
        // loading first: the 'pause' this causes must not count as a pause by the listener
        this.loading = true;
        this._emit('state');
        a.pause();
        if (!spec) { this.loading = false; this._startAt(this.pos.c, this.pos.s); return; }
        // Continue exactly where the sound stopped — never from the estimated sentence,
        // which could be ahead of the voice and skip text
        if (a.ended || (dur && t >= dur - 0.3)) { this.loading = false; this._advance(); return; }
        this._playSpec(spec, ++this.session, { offset: Math.max(0.01, t - 0.5) });
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
                // Stopped or another book opened while the sentence was being handed over
                if (session !== this.session) { if (!this.playing) Native.stopSpeaking().catch(() => {}); return; }
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
            title: this.book.chapterTitles?.[this.pos.c] || this.chapters[this.pos.c]?.title || this.book.title,
            artist: this.book.author || '',
            album: this.book.title,
            artwork,
        });
    }
}

// ---------- free Gemini key (project without billing) ----------

const FREE_KEY_STATE = 'rz_free_key_exhausted';

function todayPacific() {
    // Gemini free quotas reset at midnight Pacific time
    return new Date(Date.now() - 8 * 3600 * 1000).toISOString().slice(0, 10);
}

export function usableFreeKey(st) {
    if (!st.geminiFreeKey) return '';
    return localStorage.getItem(FREE_KEY_STATE) === todayPacific() ? '' : st.geminiFreeKey;
}

// Verified narrator models the free key can still use today: the chosen one first
const FREE_MODELS_STATE = 'rz_free_models_exhausted';

function exhaustedModels() {
    try {
        const x = JSON.parse(localStorage.getItem(FREE_MODELS_STATE) || '{}');
        return x.day === todayPacific() ? x.models || [] : [];
    } catch { return []; }
}

function markModelExhausted(model) {
    const models = [...new Set([...exhaustedModels(), model])];
    try { localStorage.setItem(FREE_MODELS_STATE, JSON.stringify({ day: todayPacific(), models })); } catch {}
}

function freeModels(st) {
    let known = [];
    try { known = JSON.parse(localStorage.getItem('rz_gemini_models') || '[]'); } catch {}
    const all = [st.geminiModel, ...known.filter((m) => isVerifiedGeminiModel(m) && !/native|live|dialog/.test(m))];
    const used = exhaustedModels();
    return [...new Set(all)].filter((m) => m && !used.includes(m));
}

function markFreeKeyExhausted() {
    localStorage.setItem(FREE_KEY_STATE, todayPacific());
}

function waitOnline(ms) {
    return new Promise((resolve) => {
        const done = () => { clearTimeout(t); window.removeEventListener('online', done); resolve(); };
        const t = setTimeout(done, ms);
        window.addEventListener('online', done);
    });
}

function blobDuration(blob) {
    return new Promise((resolve) => {
        const a = new Audio();
        const url = URL.createObjectURL(blob);
        let finished = false;
        const done = (d) => { if (finished) return; finished = true; clearTimeout(timer); URL.revokeObjectURL(url); a.removeAttribute('src'); resolve(d); };
        // Never wait forever: a passage without a known length still plays (and the
        // player takes the length from the playing audio)
        const timer = setTimeout(() => done(0), 5000);
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
