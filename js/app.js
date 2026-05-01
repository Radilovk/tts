/* ==============================
   Gemini TTS — Application Logic
   Fully client-side, no backend required.
   Uses Google AI (generativelanguage.googleapis.com) which supports CORS.
   ============================== */

(function () {
    'use strict';

    // ==================== Constants ====================
    const STORAGE_KEYS = {
        API_KEY: 'gemini_tts_api_key',
        MODEL: 'gemini_tts_model',
        CUSTOM_MODEL: 'gemini_tts_custom_model',
        VOICE: 'gemini_tts_voice',
        SPEED: 'gemini_tts_speed',
        AUTO_PLAY: 'gemini_tts_autoplay',
        CHUNK_SIZE: 'gemini_tts_chunk_size',
        THEME: 'gemini_tts_theme',
        HISTORY: 'gemini_tts_history',
        TRANSLATION_MODEL: 'gemini_tts_translation_model',
        TTS_LANGUAGE: 'gemini_tts_language',
        PLAYBACK_SPEED: 'gemini_tts_playback_speed',
        VOICE_PROMPT: 'gemini_tts_voice_prompt',
        LIBRARY: 'gemini_tts_library',
        PLAYBACK_POSITION: 'gemini_tts_playback_position',
        BOOK_POSITIONS: 'gemini_tts_book_positions',
        LAST_BOOK_ID: 'gemini_tts_last_book_id',
    };

    // Only generativelanguage.googleapis.com supports CORS from browser.
    // Vertex AI (aiplatform.googleapis.com) requires a backend proxy.
    const API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

    const MAX_HISTORY_ITEMS = 50;
    const API_TIMEOUT_MS = 120000; // 2 minutes per chunk
    const MAX_BUFFER_AHEAD = 2; // Buffer at most 2 chunks ahead of playback
    const SPEED_OPTIONS = [0.5, 0.75, 1.0, 1.25, 1.5, 1.75, 2.0];
    const CHUNK_WAIT_INTERVAL_MS = 200;
    const MAX_RETRIES = 3;        // Retries for failed TTS API requests

    // Instruction prefix appended to continuation chunks (2nd chunk onwards) so the
    // model maintains the same voice character, pace and intonation across API calls.
    const CONTINUATION_PREFIXES = {
        bg: 'Продължи четенето точно в същия стил, темп и тоналност на гласа — не променяй начина на четене.\n\n',
        en: 'Continue reading in exactly the same style, pace and vocal tone — do not change the way you read.\n\n',
        de: 'Lies weiter in genau demselben Stil, Tempo und Tonfall — ändere die Leseart nicht.\n\n',
        fr: 'Continuez la lecture dans exactement le même style, rythme et ton vocal — ne changez pas la façon de lire.\n\n',
        es: 'Continúa leyendo en exactamente el mismo estilo, ritmo y tono vocal — no cambies la manera de leer.\n\n',
        it: 'Continua a leggere esattamente nello stesso stile, ritmo e tono vocale — non cambiare il modo di leggere.\n\n',
        ru: 'Продолжай читать в точно таком же стиле, темпе и тональности голоса — не меняй манеру чтения.\n\n',
        pl: 'Kontynuuj czytanie w dokładnie tym samym stylu, tempie i tonie głosu — nie zmieniaj sposobu czytania.\n\n',
        nl: 'Ga verder met lezen in exact dezelfde stijl, tempo en vocale toon — verander de manier van lezen niet.\n\n',
        pt: 'Continue lendo exatamente no mesmo estilo, ritmo e tom vocal — não mude a forma de ler.\n\n',
        zh: '继续以完全相同的风格、节奏和语调朗读——不要改变朗读方式。\n\n',
        ja: '全く同じスタイル、ペース、声のトーンで読み続けてください——読み方を変えないでください。\n\n',
        ar: 'استمر في القراءة بنفس الأسلوب والإيقاع ونبرة الصوت تمامًا — لا تغيّر طريقة القراءة.\n\n',
        tr: 'Okumaya tam olarak aynı tarz, tempo ve ses tonuyla devam et — okuma biçimini değiştirme.\n\n',
        auto: 'Continue reading in exactly the same style, pace and vocal tone — do not change the way you read.\n\n',
    };

    // Language instructions for TTS
    // Each instruction emphasises a steady, consistent reading style so that when
    // a long text is split across multiple API calls the voice sounds uniform.
    const LANGUAGE_INSTRUCTIONS = {
        bg: 'Прочети следния текст на български с ясна и постоянна дикция, равномерен темп и естествена интонация: ',
        en: 'Read the following text in English with clear, consistent pronunciation, steady pace and natural intonation: ',
        de: 'Lies den folgenden Text auf Deutsch mit klarer, gleichmäßiger Aussprache und natürlicher Intonation vor: ',
        fr: 'Lisez le texte suivant en français avec une prononciation claire, un rythme régulier et une intonation naturelle : ',
        es: 'Lee el siguiente texto en español con pronunciación clara, ritmo constante y entonación natural: ',
        it: 'Leggi il seguente testo in italiano con pronuncia chiara, ritmo costante e intonazione naturale: ',
        ru: 'Прочитай следующий текст на русском языке с чёткой, равномерной дикцией и естественной интонацией: ',
        pl: 'Przeczytaj poniższy tekst po polsku wyraźną, równomierną dykcją i naturalną intonacją: ',
        nl: 'Lees de volgende tekst in het Nederlands voor met duidelijke, consistente uitspraak en een natuurlijke intonatie: ',
        pt: 'Leia o seguinte texto em português com pronúncia clara, ritmo constante e entonação natural: ',
        zh: '请用普通话以清晰、平稳的语气和自然的语调朗读以下文本：',
        ja: '以下のテキストを日本語で、明確で一定のペース、自然なイントネーションで読み上げてください：',
        ar: 'اقرأ النص التالي باللغة العربية بنطق واضح ووتيرة ثابتة ونبرة طبيعية: ',
        tr: 'Aşağıdaki metni Türkçe olarak açık, tutarlı bir telaffuz ve doğal bir tonlamayla oku: ',
        auto: '', // No instruction, let the model auto-detect
    };

    // ==================== Gapless Audio Player ====================
    // Schedules PCM buffers back-to-back using Web Audio API so transitions
    // between streaming chunks play with zero audible gap.
    class GaplessPlayer {
        constructor() {
            this._ctx = null;
            this._analyser = null;
            this._sampleRate = 24000;
            this._nextPlayAt = 0;
            this._sessionStartCtxTime = 0;
            this._sessionStartOffset = 0; // seconds of audio already "played" before this session
            this._isPlaying = false;
            this._isPaused = false;
            this._playbackRate = 1.0;
            this._totalScheduled = 0;    // seconds of audio buffered (normal speed)
            this._activeSources = [];
            this._finished = false;
            this._rafId = null;
            // Callbacks
            this.onTimeUpdate = null;
            this.onEnded = null;
            this.onPlay = null;
            this.onPause = null;
        }

        _getCtx() {
            if (!this._ctx || this._ctx.state === 'closed') {
                this._ctx = new (window.AudioContext || window.webkitAudioContext)(
                    { sampleRate: this._sampleRate }
                );
                // Create analyser node for waveform visualization
                this._analyser = this._ctx.createAnalyser();
                this._analyser.fftSize = 128;
                this._analyser.smoothingTimeConstant = 0.75;
                this._analyser.connect(this._ctx.destination);
            }
            return this._ctx;
        }

        // Append a raw PCM (16-bit LE) ArrayBuffer for gapless playback.
        // Returns the duration (in seconds at normal speed) of the buffer.
        feed(pcmBuffer, sampleRate) {
            if (sampleRate && sampleRate !== this._sampleRate) {
                this._sampleRate = sampleRate;
            }
            const ctx = this._getCtx();
            if (ctx.state === 'suspended') { ctx.resume(); }

            const int16 = new Int16Array(pcmBuffer);
            if (int16.length === 0) return 0;

            const float32 = new Float32Array(int16.length);
            for (let k = 0; k < int16.length; k++) {
                float32[k] = int16[k] / 32768.0;
            }

            const audioBuf = ctx.createBuffer(1, float32.length, this._sampleRate);
            audioBuf.copyToChannel(float32, 0);

            const source = ctx.createBufferSource();
            source.buffer = audioBuf;
            source.playbackRate.value = this._playbackRate;
            // Connect through analyser for waveform visualization
            source.connect(this._analyser || ctx.destination);

            if (!this._isPlaying) {
                const startDelay = 0.05; // 50 ms startup buffer
                this._nextPlayAt = ctx.currentTime + startDelay;
                this._sessionStartCtxTime = ctx.currentTime + startDelay;
                this._totalScheduled = 0;
                this._isPlaying = true;
                this._isPaused = false;
                this._finished = false;
                this._startRAF();
                if (this.onPlay) this.onPlay();
            }

            const scheduleAt = Math.max(this._nextPlayAt, ctx.currentTime + 0.01);
            source.start(scheduleAt);

            const bufDuration = float32.length / this._sampleRate;
            const wallDuration = bufDuration / this._playbackRate;
            this._nextPlayAt = scheduleAt + wallDuration;
            this._totalScheduled += bufDuration;

            source.addEventListener('ended', () => {
                const idx = this._activeSources.indexOf(source);
                if (idx !== -1) this._activeSources.splice(idx, 1);
                if (this._activeSources.length === 0 && this._finished) {
                    this._isPlaying = false;
                    this._stopRAF();
                    if (this.onEnded) this.onEnded();
                }
            });
            this._activeSources.push(source);

            return bufDuration;
        }

        // Signal that no more PCM data will be fed; fires onEnded when drained.
        finish() {
            this._finished = true;
            if (this._isPlaying && this._activeSources.length === 0) {
                this._isPlaying = false;
                this._stopRAF();
                if (this.onEnded) this.onEnded();
            }
        }

        pause() {
            if (!this._isPlaying || this._isPaused || !this._ctx) return;
            this._sessionStartOffset = this.currentTime;
            this._isPaused = true;
            this._ctx.suspend();
            this._stopRAF();
            if (this.onPause) this.onPause();
        }

        resume() {
            if (!this._isPaused || !this._isPlaying || !this._ctx) return;
            this._ctx.resume().then(() => {
                if (!this._ctx) return;
                this._sessionStartCtxTime = this._ctx.currentTime;
                this._isPaused = false;
                this._startRAF();
                if (this.onPlay) this.onPlay();
            });
        }

        stop() {
            this._stopRAF();
            this._finished = true;
            for (const src of this._activeSources) { try { src.stop(0); } catch {} }
            this._activeSources = [];
            if (this._ctx) { this._ctx.close().catch(() => {}); this._ctx = null; }
            this._analyser = null;
            this._isPlaying = false;
            this._isPaused = false;
            this._nextPlayAt = 0;
            this._sessionStartCtxTime = 0;
            this._sessionStartOffset = 0;
            this._totalScheduled = 0;
        }

        get currentTime() {
            if (!this._isPlaying) return this._sessionStartOffset;
            if (this._isPaused) return this._sessionStartOffset;
            if (!this._ctx) return this._sessionStartOffset;
            const elapsed = (this._ctx.currentTime - this._sessionStartCtxTime) * this._playbackRate;
            return this._sessionStartOffset + Math.max(0, elapsed);
        }

        get totalDuration() { return this._totalScheduled; }
        get paused() { return !this._isPlaying || this._isPaused; }
        get analyser() { return this._analyser; }

        set playbackRate(rate) {
            const prev = this._playbackRate;
            this._playbackRate = rate;
            for (const src of this._activeSources) { src.playbackRate.value = rate; }
            // Adjust next-schedule clock for new rate
            if (this._isPlaying && !this._isPaused && this._ctx && prev !== rate && prev > 0) {
                const remaining = this._totalScheduled - this.currentTime;
                if (remaining > 0) {
                    this._nextPlayAt = this._ctx.currentTime + remaining / rate;
                }
            }
        }
        get playbackRate() { return this._playbackRate; }

        _startRAF() {
            if (this._rafId) return;
            let lastTime = -1;
            const tick = () => {
                if (!this._isPlaying || this._isPaused) { this._rafId = null; return; }
                const ct = this.currentTime;
                if (Math.abs(ct - lastTime) >= 0.25) {
                    lastTime = ct;
                    if (this.onTimeUpdate) this.onTimeUpdate(ct);
                }
                this._rafId = requestAnimationFrame(tick);
            };
            this._rafId = requestAnimationFrame(tick);
        }

        _stopRAF() {
            if (this._rafId) { cancelAnimationFrame(this._rafId); this._rafId = null; }
        }
    }

    // ==================== Gemini Live Session (WebSocket) ====================
    // Manages a persistent WebSocket to the Gemini Multimodal Live API.
    // Reusing one connection across TTS requests gives ~150–300 ms first-audio
    // latency instead of ~500 ms per new HTTPS request.
    // Used automatically when a model whose name contains "live" is selected.
    class GeminiLiveSession {
        constructor() {
            this._ws          = null;
            this._state       = 'closed'; // 'closed'|'connecting'|'ready'|'generating'
            this._apiKey      = null;
            this._model       = null;
            this._voice       = null;
            this._setupAge    = 0;        // Date.now() when setup last completed
            this._setupResolve = null;
            this._setupReject  = null;
            this._chunkResolve = null;
            this._chunkReject  = null;
            this._onPcmChunk   = null;
            this._pcmAccum     = [];
            this._sampleRate   = 24000;
        }

        // Ensure the session is open and configured for the given api-key/model/voice.
        // Silently reconnects when the config changes or the session is approaching
        // the 12-minute mark (Google enforces a 15-minute hard limit per session).
        async ensureReady(apiKey, model, voice) {
            const age        = Date.now() - this._setupAge;
            const configSame = apiKey === this._apiKey &&
                               model  === this._model  &&
                               voice  === this._voice;
            const wsOpen     = this._ws && this._ws.readyState === WebSocket.OPEN;

            if (this._state === 'ready' && wsOpen && configSame && age < 12 * 60 * 1000) {
                return; // Healthy session — reuse
            }

            this.close();
            await this._openSocket(apiKey, model, voice);
        }

        _openSocket(apiKey, model, voice) {
            return new Promise((resolve, reject) => {
                const wsUrl = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=${apiKey}`;
                let ws;
                try {
                    ws = new WebSocket(wsUrl);
                } catch (e) {
                    reject(new Error(`Live API: не може да се отвори WebSocket: ${e.message}`));
                    return;
                }

                this._ws          = ws;
                this._state       = 'connecting';
                this._apiKey      = apiKey;
                this._model       = model;
                this._voice       = voice;
                this._setupResolve = resolve;
                this._setupReject  = reject;

                const timeout = setTimeout(() => {
                    if (this._state === 'connecting') {
                        this.close();
                        reject(new Error('Live API: времето за свързване изтече'));
                    }
                }, 15000);

                ws.onopen = () => {
                    clearTimeout(timeout);
                    const setupMsg = {
                        setup: {
                            model: `models/${model}`,
                            generationConfig: {
                                responseModalities: ['AUDIO'],
                                speechConfig: {
                                    voiceConfig: {
                                        prebuiltVoiceConfig: { voiceName: voice }
                                    }
                                }
                            }
                        }
                    };
                    try {
                        ws.send(JSON.stringify(setupMsg));
                    } catch (e) {
                        this.close();
                        reject(new Error(`Live API setup грешка: ${e.message}`));
                    }
                };

                ws.onmessage = (event) => this._handleMessage(event);

                ws.onerror = () => {
                    clearTimeout(timeout);
                    const err = new Error('Live API: WebSocket грешка');
                    if (this._state === 'connecting') {
                        this.close();
                        reject(err);
                    } else {
                        this._failChunk(err);
                    }
                };

                ws.onclose = () => {
                    clearTimeout(timeout);
                    const wasConnecting = this._state === 'connecting';
                    this._state = 'closed';
                    if (wasConnecting && this._setupReject) {
                        const r       = this._setupReject;
                        this._setupResolve = null;
                        this._setupReject  = null;
                        r(new Error('Live API: връзката е затворена преди готовност'));
                    }
                    this._failChunk(new Error('Live API: връзката е затворена неочаквано'));
                };
            });
        }

        _handleMessage(event) {
            let msg;
            try { msg = JSON.parse(event.data); } catch { return; }

            // Session ready
            if (msg.setupComplete !== undefined) {
                this._state    = 'ready';
                this._setupAge = Date.now();
                if (this._setupResolve) {
                    const r           = this._setupResolve;
                    this._setupResolve = null;
                    this._setupReject  = null;
                    r();
                }
                return;
            }

            // Audio content streaming back
            if (msg.serverContent) {
                const sc = msg.serverContent;
                if (sc.modelTurn && sc.modelTurn.parts) {
                    for (const part of sc.modelTurn.parts) {
                        if (part.inlineData && part.inlineData.data) {
                            const m = part.inlineData.mimeType &&
                                      part.inlineData.mimeType.match(/rate=(\d+)/);
                            if (m) this._sampleRate = parseInt(m[1]);
                            const pcm = base64ToPcmBuffer(part.inlineData.data);
                            if (pcm) {
                                this._pcmAccum.push(pcm);
                                if (this._onPcmChunk) this._onPcmChunk(pcm, this._sampleRate);
                            }
                        }
                    }
                }
                // Model finished its turn
                if (sc.turnComplete) {
                    this._state = 'ready';
                    if (this._chunkResolve) {
                        const allPcm       = combineArrayBuffers(this._pcmAccum);
                        const r            = this._chunkResolve;
                        this._pcmAccum     = [];
                        this._chunkResolve = null;
                        this._chunkReject  = null;
                        this._onPcmChunk   = null;
                        r({ audioData: allPcm, sampleRate: this._sampleRate });
                    }
                }
            }

            // API-level error
            if (msg.error) {
                this._state = 'ready';
                this._failChunk(new Error(msg.error.message || 'Live API грешка'));
            }
        }

        _failChunk(err) {
            if (!this._chunkReject) return;
            const r           = this._chunkReject;
            this._chunkResolve = null;
            this._chunkReject  = null;
            this._onPcmChunk   = null;
            this._pcmAccum     = [];
            r(err);
        }

        // Send a text turn and stream PCM back via onPcmChunk until turnComplete.
        // Returns { audioData: ArrayBuffer, sampleRate: number } when done.
        generateChunk(text, onPcmChunk, signal) {
            if (this._state !== 'ready') {
                return Promise.reject(new Error('Live сесията не е готова'));
            }

            return new Promise((resolve, reject) => {
                if (signal && signal.aborted) {
                    return reject(new DOMException('Cancelled', 'AbortError'));
                }

                this._state        = 'generating';
                this._chunkResolve = resolve;
                this._chunkReject  = reject;
                this._onPcmChunk   = onPcmChunk;
                this._pcmAccum     = [];

                const onAbort = () => {
                    if (!this._chunkReject) return;
                    const r           = this._chunkReject;
                    this._chunkResolve = null;
                    this._chunkReject  = null;
                    this._onPcmChunk   = null;
                    this._pcmAccum     = [];
                    this._state        = 'ready';
                    // Ask the model to stop mid-stream
                    if (this._ws && this._ws.readyState === WebSocket.OPEN) {
                        try {
                            this._ws.send(JSON.stringify({ clientContent: { turnComplete: true } }));
                        } catch {}
                    }
                    r(new DOMException('Cancelled', 'AbortError'));
                };
                if (signal) signal.addEventListener('abort', onAbort, { once: true });

                try {
                    this._ws.send(JSON.stringify({
                        clientContent: {
                            turns: [{ role: 'user', parts: [{ text }] }],
                            turnComplete: true
                        }
                    }));
                } catch (e) {
                    this._state        = 'ready';
                    this._chunkResolve = null;
                    this._chunkReject  = null;
                    this._onPcmChunk   = null;
                    reject(new Error(`Live send грешка: ${e.message}`));
                }
            });
        }

        close() {
            if (this._ws) {
                this._ws.onmessage = null;
                this._ws.onerror   = null;
                this._ws.onclose   = null;
                try { this._ws.close(); } catch {}
                this._ws = null;
            }
            this._state        = 'closed';
            this._setupResolve = null;
            this._setupReject  = null;
            this._failChunk(new DOMException('Cancelled', 'AbortError'));
            // Reset chunk callbacks (failChunk already cleared them)
        }

        get isReady() {
            return this._state === 'ready' &&
                   this._ws !== null &&
                   this._ws.readyState === WebSocket.OPEN;
        }
    }

    // Singleton — kept alive across TTS requests for low latency.
    const geminiLiveSession = new GeminiLiveSession();

    // Returns true when model name indicates a Live (WebSocket) model.
    function isLiveModel(model) {
        return typeof model === 'string' && model.includes('live');
    }

    // ==================== DOM Elements ====================
    const $ = (sel) => document.querySelector(sel);

    const els = {
        // Settings
        apiKey: $('#apiKey'),
        modelSelect: $('#modelSelect'),
        customModel: $('#customModel'),
        btnClearCustomModel: $('#btnClearCustomModel'),
        voiceSelect: $('#voiceSelect'),
        speedSlider: $('#speedSlider'),
        speedValue: $('#speedValue'),
        autoPlay: $('#autoPlay'),
        chunkSize: $('#chunkSize'),
        translationModel: $('#translationModel'),
        ttsLanguage: $('#ttsLanguage'),
        voicePrompt: $('#voicePrompt'),
        btnToggleKey: $('#btnToggleKey'),
        btnTestKey: $('#btnTestKey'),
        keyStatus: $('#keyStatus'),
        btnPreviewVoice: $('#btnPreviewVoice'),
        btnClearHistory: $('#btnClearHistory'),
        btnClearAll: $('#btnClearAll'),

        // Quick settings (main page, synced with settings panel)
        quickVoice: $('#quickVoice'),
        quickLang: $('#quickLang'),

        // Panels
        settingsPanel: $('#settingsPanel'),
        settingsOverlay: $('#settingsOverlay'),
        historyPanel: $('#historyPanel'),
        historyOverlay: $('#historyOverlay'),
        historyList: $('#historyList'),
        libraryPanel: $('#libraryPanel'),
        libraryOverlay: $('#libraryOverlay'),
        libraryList: $('#libraryList'),

        // Header buttons
        btnSettings: $('#btnSettings'),
        btnCloseSettings: $('#btnCloseSettings'),
        btnHistory: $('#btnHistory'),
        btnCloseHistory: $('#btnCloseHistory'),
        btnLibrary: $('#btnLibrary'),
        btnCloseLibrary: $('#btnCloseLibrary'),
        btnAddBook: $('#btnAddBook'),
        libraryFileInput: $('#libraryFileInput'),
        btnTheme: $('#btnTheme'),

        // Welcome
        welcomeBanner: $('#welcomeBanner'),
        btnOpenSettingsWelcome: $('#btnOpenSettingsWelcome'),

        // Text
        textInput: $('#textInput'),
        charCount: $('#charCount'),
        btnPaste: $('#btnPaste'),
        btnTranslateMain: $('#btnTranslateMain'),
        btnClear: $('#btnClear'),
        fileInput: $('#fileInput'),
        btnUpload: $('#btnUpload'),
        dropZone: $('#dropZone'),

        // Translation
        translateToggle: $('#translateToggle'),
        translationPreview: $('#translationPreview'),
        translatedText: $('#translatedText'),
        btnCopyTranslation: $('#btnCopyTranslation'),
        btnUseTranslation: $('#btnUseTranslation'),

        // Controls
        btnGenerate: $('#btnGenerate'),
        btnStop: $('#btnStop'),
        progressSection: $('#progressSection'),
        progressFill: $('#progressFill'),
        progressText: $('#progressText'),

        // Player
        playerSection: $('#playerSection'),
        playerTitle: $('#playerTitle'),
        playerMeta: $('#playerMeta'),
        audioPlayer: $('#audioPlayer'),
        btnPlayPause: $('#btnPlayPause'),
        btnSkipBack: $('#btnSkipBack'),
        btnSkipForward: $('#btnSkipForward'),
        seekBar: $('#seekBar'),
        seekSlider: $('#seekSlider'),
        seekPosition: $('#seekPosition'),
        seekChunkInfo: $('#seekChunkInfo'),
        seekDuration: $('#seekDuration'),
        btnSpeedToggle: $('#btnSpeedToggle'),
        speedToggleLabel: $('#speedToggleLabel'),
        audioPlayerNext: $('#audioPlayerNext'),
        waveformCanvas: $('#waveformCanvas'),
        btnReaderView: $('#btnReaderView'),
        btnSleepTimer: $('#btnSleepTimer'),
        sleepTimerLabel: $('#sleepTimerLabel'),
        sleepTimerDropdown: $('#sleepTimerDropdown'),
        btnDownloadPlayer: $('#btnDownloadPlayer'),
        readerView: $('#readerView'),
        readerContent: $('#readerContent'),
        btnCloseReaderView: $('#btnCloseReaderView'),

        // Other
        toastContainer: $('#toastContainer'),
        offlineBanner: $('#offlineBanner'),
    };

    // ==================== State ====================
    let state = {
        isGenerating: false,
        currentAudioBlob: null,
        currentAudioUrl: null,
        translatedContent: '',
        history: [],
        library: [],
        abortController: null,
        // Streaming playback pipeline
        audioQueue: [],
        isStreamPlaying: false,
        streamPcmChunks: [],
        streamSampleRate: 24000,
        streamMode: false,
        streamFinished: false,
        streamCurrentUrl: null,
        // Seek & buffering state
        streamChunks: [],         // all text chunks
        streamChunkWavs: [],      // WAV blobs per chunk (null if not yet generated)
        streamChunkDurations: [], // duration in seconds per chunk
        streamCurrentChunk: 0,    // currently playing chunk index
        streamTotalDuration: 0,   // estimated total duration
        streamPlayedTime: 0,      // cumulative played time before current GaplessPlayer session
        streamGeneratingIndex: -1, // chunk index currently being generated
        streamPlaybackSpeed: 1.0,  // current playback speed
        // Gapless Web Audio API player (used for streaming TTS playback)
        gaplessPlayer: null,
        // Pause/resume position
        savedPosition: null,      // { chunkIndex, offsetInChunk, absoluteTime }
        // Per-book tracking
        currentBookId: null,      // ID of the currently loaded library book
        estimatedCharRate: 0.05,  // seconds per character (refined as chunks are generated)
        // Pre-loading for seamless transitions
        preloadedChunkUrl: null,
        preloadedChunkIndex: -1,
        // Seek state
        isSeeking: false,          // true while an abort-and-restart seek is in progress
        currentDisplayText: '',    // display text stored for seek restarts
        // PWA install
        deferredInstallPrompt: null,
        // Media session / wake lock
        wakeLock: null,
        // Reader view
        chunkOffsets: [],          // [{start, end}] of each chunk in the display text
        readerViewActive: false,   // is reader view shown?
        lastHighlightedChunk: -1,  // last chunk index highlighted in reader view
        // Waveform animation
        waveformRafId: null,
        waveformDataArray: null,
        // Sleep timer
        sleepTimer: null,
        sleepTimerMinutes: 0,
        sleepTimerStartTime: 0,
    };

    // ==================== API Key Helpers ====================
    // Returns true when a key was injected at build time via the GEMINI_API_KEY secret.
    function hasPreconfiguredKey() {
        return typeof window.PRECONFIGURED_API_KEY === 'string' &&
            window.PRECONFIGURED_API_KEY !== '__GEMINI_API_KEY__' &&
            window.PRECONFIGURED_API_KEY.trim().length > 0;
    }

    // Returns the effective API key: build-time pre-configured key takes priority,
    // then falls back to the user-entered key stored in localStorage.
    function getEffectiveApiKey() {
        if (hasPreconfiguredKey()) {
            return window.PRECONFIGURED_API_KEY.trim();
        }
        return els.apiKey.value.trim();
    }

    // Returns the active model ID: user-entered custom model takes priority
    // over the dropdown selection, allowing any valid Gemini model to be used.
    function getActiveModel() {
        const custom = els.customModel ? els.customModel.value.trim() : '';
        return custom || els.modelSelect.value;
    }

    // Create a GaplessPlayer wired to the current UI/state callbacks.
    function createGaplessPlayer() {
        const player = new GaplessPlayer();
        player.playbackRate = state.streamPlaybackSpeed;
        player.onTimeUpdate = (ct) => {
            if (state.streamMode) {
                updateSeekSliderFromPlayback();
                // Update reader view highlight when chunk changes
                if (state.readerViewActive) {
                    updateReaderHighlight(state.streamCurrentChunk);
                }
            }
        };
        player.onPlay = () => {
            state.isStreamPlaying = true;
            updatePlayPauseIcon();
            startWaveform();
        };
        player.onPause = () => {
            state.isStreamPlaying = false;
            updatePlayPauseIcon();
            stopWaveform();
        };
        player.onEnded = () => {
            state.isStreamPlaying = false;
            updatePlayPauseIcon();
            stopWaveform();
            if (state.streamFinished) {
                onStreamPlaybackComplete();
            }
            savePlaybackPosition();
            releaseWakeLock();
        };
        return player;
    }

    // ==================== Text Chunking Helpers ====================
    // Compute character offsets of each chunk in the original text.
    // Used by the reader view to highlight the currently playing chunk.
    function computeChunkOffsets(originalText, chunks) {
        const offsets = [];
        let searchFrom = 0;
        for (const chunk of chunks) {
            const chunkTrimmed = chunk.trim();
            let idx = originalText.indexOf(chunkTrimmed, searchFrom);
            if (idx === -1) {
                // Fallback: use last known position
                idx = searchFrom;
            }
            offsets.push({ start: idx, end: idx + chunkTrimmed.length });
            searchFrom = idx + chunkTrimmed.length;
        }
        return offsets;
    }

    // ==================== Waveform Visualization ====================
    function startWaveform() {
        if (state.waveformRafId) return;
        const canvas = els.waveformCanvas;
        if (!canvas) return;
        canvas.classList.add('active');

        const draw = () => {
            const player = state.gaplessPlayer;
            const analyser = player ? player.analyser : null;

            if (!analyser || !state.isStreamPlaying) {
                drawWaveformIdle(canvas);
                state.waveformRafId = null;
                return;
            }

            if (!state.waveformDataArray || state.waveformDataArray.length !== analyser.frequencyBinCount) {
                state.waveformDataArray = new Uint8Array(analyser.frequencyBinCount);
            }
            analyser.getByteFrequencyData(state.waveformDataArray);
            drawWaveformBars(canvas, state.waveformDataArray);
            state.waveformRafId = requestAnimationFrame(draw);
        };
        state.waveformRafId = requestAnimationFrame(draw);
    }

    function stopWaveform() {
        if (state.waveformRafId) {
            cancelAnimationFrame(state.waveformRafId);
            state.waveformRafId = null;
        }
        const canvas = els.waveformCanvas;
        if (canvas) {
            canvas.classList.remove('active');
            drawWaveformIdle(canvas);
        }
        state.waveformDataArray = null;
    }

    function drawWaveformBars(canvas, data) {
        const ctx2d = canvas.getContext('2d');
        if (!ctx2d) return;

        const dpr = window.devicePixelRatio || 1;
        const w = canvas.offsetWidth * dpr;
        const h = canvas.offsetHeight * dpr;
        if (canvas.width !== w || canvas.height !== h) {
            canvas.width = w;
            canvas.height = h;
        }

        ctx2d.clearRect(0, 0, w, h);

        const barCount = Math.min(data.length, 40);
        const barGap = 2 * dpr;
        const barWidth = Math.max(2, (w - barGap * (barCount - 1)) / barCount);
        const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
        const color1 = isDark ? '#818cf8' : '#6366f1';
        const color2 = isDark ? '#c084fc' : '#8b5cf6';

        const gradient = ctx2d.createLinearGradient(0, 0, w, 0);
        gradient.addColorStop(0, color1);
        gradient.addColorStop(1, color2);
        ctx2d.fillStyle = gradient;

        for (let i = 0; i < barCount; i++) {
            const value = data[i] / 255;
            const barHeight = Math.max(2 * dpr, value * h * 0.9);
            const x = i * (barWidth + barGap);
            const y = (h - barHeight) / 2;
            const radius = barWidth / 2;
            ctx2d.beginPath();
            ctx2d.roundRect
                ? ctx2d.roundRect(x, y, barWidth, barHeight, radius)
                : ctx2d.rect(x, y, barWidth, barHeight);
            ctx2d.fill();
        }
    }

    function drawWaveformIdle(canvas) {
        const ctx2d = canvas.getContext('2d');
        if (!ctx2d) return;
        const dpr = window.devicePixelRatio || 1;
        const w = canvas.offsetWidth * dpr;
        const h = canvas.offsetHeight * dpr;
        if (canvas.width !== w || canvas.height !== h) {
            canvas.width = w;
            canvas.height = h;
        }
        ctx2d.clearRect(0, 0, w, h);

        const barCount = 40;
        const barGap = 2 * dpr;
        const barWidth = Math.max(2, (w - barGap * (barCount - 1)) / barCount);
        const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
        ctx2d.fillStyle = isDark ? 'rgba(100,116,139,0.3)' : 'rgba(148,163,184,0.4)';

        for (let i = 0; i < barCount; i++) {
            const barHeight = 3 * dpr;
            const x = i * (barWidth + barGap);
            const y = (h - barHeight) / 2;
            ctx2d.fillRect(x, y, barWidth, barHeight);
        }
    }

    // ==================== Reader View ====================
    function toggleReaderView(force) {
        const show = force !== undefined ? force : !state.readerViewActive;
        state.readerViewActive = show;

        if (show) {
            els.readerView.classList.remove('hidden');
            els.btnReaderView.classList.add('active');
            // Render current state
            if (state.currentDisplayText) {
                renderReaderView(state.currentDisplayText, state.lastHighlightedChunk);
            }
        } else {
            els.readerView.classList.add('hidden');
            els.btnReaderView.classList.remove('active');
        }
    }

    function renderReaderView(text, highlightChunk) {
        if (!state.readerViewActive || !els.readerContent) return;
        if (!text) { els.readerContent.innerHTML = ''; return; }

        const offsets = state.chunkOffsets;
        if (!offsets || offsets.length === 0 || highlightChunk < 0) {
            // No chunk info: show full text
            els.readerContent.textContent = text;
            return;
        }

        const chunk = offsets[highlightChunk];
        if (!chunk) {
            els.readerContent.textContent = text;
            return;
        }

        // Build three segments: before (done), current (highlighted), after
        const before = text.substring(0, chunk.start);
        const current = text.substring(chunk.start, chunk.end);
        const after = text.substring(chunk.end);

        const div = els.readerContent;
        div.innerHTML =
            '<span class="chunk-done">' + escapeHtml(before) + '</span>' +
            '<mark class="chunk-highlight" id="chunkHighlightMark">' + escapeHtml(current) + '</mark>' +
            '<span>' + escapeHtml(after) + '</span>';

        // Smooth-scroll to highlighted chunk
        const mark = div.querySelector('#chunkHighlightMark');
        if (mark) {
            mark.scrollIntoView({ block: 'center', behavior: 'smooth' });
        }
    }

    function updateReaderHighlight(chunkIndex) {
        if (!state.readerViewActive) return;
        if (chunkIndex === state.lastHighlightedChunk) return;
        state.lastHighlightedChunk = chunkIndex;
        renderReaderView(state.currentDisplayText, chunkIndex);
    }

    // ==================== Sleep Timer ====================
    function setSleepTimer(minutes) {
        if (state.sleepTimer) {
            clearTimeout(state.sleepTimer);
            state.sleepTimer = null;
        }
        state.sleepTimerMinutes = minutes;
        if (minutes > 0) {
            state.sleepTimerStartTime = Date.now();
            state.sleepTimer = setTimeout(() => {
                stopGeneration();
                showToast('🌙 Таймерът изтече — спряно', 'info', 5000);
                state.sleepTimer = null;
                state.sleepTimerMinutes = 0;
                updateSleepTimerButton();
            }, minutes * 60 * 1000);
        }
        updateSleepTimerButton();
        // Close dropdown
        els.sleepTimerDropdown.classList.add('hidden');
    }

    function updateSleepTimerButton() {
        const label = els.sleepTimerLabel;
        if (!label) return;
        if (state.sleepTimerMinutes > 0) {
            label.textContent = state.sleepTimerMinutes + 'm';
            label.classList.remove('hidden');
            els.btnSleepTimer.classList.add('active');
        } else {
            label.classList.add('hidden');
            els.btnSleepTimer.classList.remove('active');
        }
    }

    // ==================== Initialization ====================
    function init() {
        loadSettings();
        loadHistory();
        loadLibrary();
        loadPlaybackSpeed();
        loadSavedPosition();
        bindEvents();
        updateUI();
        checkOnboarding();
        setupOfflineDetection();
        registerServiceWorker();
        setupMediaSession();
        setupPwaInstall();
        setupPositionAutoSave();
        restoreLastBook();
        // Pre-warm Live WebSocket if a live model is already selected
        prewarmLiveSession();
        // Initialize waveform canvas with idle state
        if (els.waveformCanvas) {
            setTimeout(() => drawWaveformIdle(els.waveformCanvas), 100);
        }
    }

    // ==================== Settings ====================
    function loadSettings() {
        const get = (key, fallback) => localStorage.getItem(key) || fallback;

        els.apiKey.value = get(STORAGE_KEYS.API_KEY, '');
        els.modelSelect.value = get(STORAGE_KEYS.MODEL, 'gemini-2.5-flash-preview-tts');
        if (els.customModel) els.customModel.value = get(STORAGE_KEYS.CUSTOM_MODEL, '');
        els.voiceSelect.value = get(STORAGE_KEYS.VOICE, 'Kore');
        els.speedSlider.value = get(STORAGE_KEYS.SPEED, '1.0');
        els.autoPlay.checked = get(STORAGE_KEYS.AUTO_PLAY, 'true') === 'true';
        els.chunkSize.value = get(STORAGE_KEYS.CHUNK_SIZE, '3000');
        els.translationModel.value = get(STORAGE_KEYS.TRANSLATION_MODEL, 'gemini-2.5-flash-lite');
        els.ttsLanguage.value = get(STORAGE_KEYS.TTS_LANGUAGE, 'bg');
        els.voicePrompt.value = get(STORAGE_KEYS.VOICE_PROMPT, '');

        // Sync quick settings on main page
        if (els.quickVoice) els.quickVoice.value = get(STORAGE_KEYS.VOICE, 'Kore');
        if (els.quickLang) els.quickLang.value = get(STORAGE_KEYS.TTS_LANGUAGE, 'bg');

        // Hide the manual API key entry when the key is pre-configured at build time.
        if (hasPreconfiguredKey()) {
            const group = document.getElementById('apiKeyGroup');
            if (group) group.classList.add('hidden');
        }

        // Theme
        const theme = get(STORAGE_KEYS.THEME, getPreferredTheme());
        document.documentElement.setAttribute('data-theme', theme);

        updateSpeedLabel();
    }

    function getPreferredTheme() {
        if (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) {
            return 'dark';
        }
        return 'light';
    }

    function saveSettings() {
        // API key is stored in localStorage by design — this is a client-side only app
        // and the key is entered and managed entirely by the user on their own device.
        localStorage.setItem(STORAGE_KEYS.API_KEY, els.apiKey.value); // nosemgrep: clear-text-storage
        localStorage.setItem(STORAGE_KEYS.MODEL, els.modelSelect.value);
        if (els.customModel) localStorage.setItem(STORAGE_KEYS.CUSTOM_MODEL, els.customModel.value.trim());
        localStorage.setItem(STORAGE_KEYS.VOICE, els.voiceSelect.value);
        localStorage.setItem(STORAGE_KEYS.SPEED, els.speedSlider.value);
        localStorage.setItem(STORAGE_KEYS.AUTO_PLAY, els.autoPlay.checked);
        localStorage.setItem(STORAGE_KEYS.CHUNK_SIZE, els.chunkSize.value);
        localStorage.setItem(STORAGE_KEYS.TRANSLATION_MODEL, els.translationModel.value);
        localStorage.setItem(STORAGE_KEYS.TTS_LANGUAGE, els.ttsLanguage.value);
        localStorage.setItem(STORAGE_KEYS.VOICE_PROMPT, els.voicePrompt.value);
    }

    // ==================== Onboarding ====================
    function checkOnboarding() {
        const hasKey = getEffectiveApiKey().length > 0;
        if (!hasKey) {
            els.welcomeBanner.classList.remove('hidden');
        } else {
            els.welcomeBanner.classList.add('hidden');
        }
    }

    // ==================== Offline Detection ====================
    function setupOfflineDetection() {
        function updateOnlineStatus() {
            if (!navigator.onLine) {
                els.offlineBanner.classList.remove('hidden');
            } else {
                els.offlineBanner.classList.add('hidden');
            }
        }

        window.addEventListener('online', updateOnlineStatus);
        window.addEventListener('offline', updateOnlineStatus);
        updateOnlineStatus();
    }

    // ==================== Service Worker ====================
    function registerServiceWorker() {
        if ('serviceWorker' in navigator) {
            navigator.serviceWorker.register('sw.js').catch(() => {
                // Service worker registration failed — not critical
            });
        }
    }

    // ==================== PWA Install ====================
    function setupPwaInstall() {
        window.addEventListener('beforeinstallprompt', (e) => {
            e.preventDefault();
            state.deferredInstallPrompt = e;
            const installGroup = document.getElementById('pwaInstallGroup');
            if (installGroup) {
                installGroup.style.display = '';
            }
        });

        const btnInstall = document.getElementById('btnInstallPwa');
        if (btnInstall) {
            btnInstall.addEventListener('click', async () => {
                if (!state.deferredInstallPrompt) {
                    showToast('Приложението вече е инсталирано или не може да се инсталира от този браузър', 'info');
                    return;
                }
                state.deferredInstallPrompt.prompt();
                const result = await state.deferredInstallPrompt.userChoice;
                if (result.outcome === 'accepted') {
                    showToast('Приложението е инсталирано! 📲', 'success');
                }
                state.deferredInstallPrompt = null;
                const installGroup = document.getElementById('pwaInstallGroup');
                if (installGroup) {
                    installGroup.style.display = 'none';
                }
            });
        }

        window.addEventListener('appinstalled', () => {
            state.deferredInstallPrompt = null;
            const installGroup = document.getElementById('pwaInstallGroup');
            if (installGroup) {
                installGroup.style.display = 'none';
            }
            showToast('Приложението е инсталирано успешно! 🎉', 'success');
        });
    }

    // ==================== Auto-save Position ====================
    function setupPositionAutoSave() {
        window.addEventListener('beforeunload', () => {
            savePlaybackPosition();
            geminiLiveSession.close();
        });
        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState === 'hidden') {
                savePlaybackPosition();
            }
        });
        // Periodic auto-save every 15 seconds during playback
        setInterval(() => {
            if (state.streamMode && state.isStreamPlaying) {
                savePlaybackPosition();
            }
        }, 15000);
    }

    // ==================== Playback Speed (cached) ====================
    function loadPlaybackSpeed() {
        const saved = localStorage.getItem(STORAGE_KEYS.PLAYBACK_SPEED);
        if (saved) {
            state.streamPlaybackSpeed = parseFloat(saved) || 1.0;
        }
        updateSpeedToggleLabel();
    }

    function savePlaybackSpeed() {
        localStorage.setItem(STORAGE_KEYS.PLAYBACK_SPEED, String(state.streamPlaybackSpeed));
    }

    function cyclePlaybackSpeed() {
        const current = state.streamPlaybackSpeed;
        const idx = SPEED_OPTIONS.indexOf(current);
        const nextIdx = (idx + 1) % SPEED_OPTIONS.length;
        state.streamPlaybackSpeed = SPEED_OPTIONS[nextIdx];
        savePlaybackSpeed();
        updateSpeedToggleLabel();

        // Apply to GaplessPlayer (streaming mode) or HTML audio element (replay mode)
        if (state.gaplessPlayer) {
            state.gaplessPlayer.playbackRate = state.streamPlaybackSpeed;
        }
        if (els.audioPlayer.src) {
            els.audioPlayer.playbackRate = state.streamPlaybackSpeed;
        }
        // Also sync the settings slider
        els.speedSlider.value = state.streamPlaybackSpeed;
        updateSpeedLabel();
        saveSettings();
    }

    function updateSpeedToggleLabel() {
        if (els.speedToggleLabel) {
            els.speedToggleLabel.textContent = state.streamPlaybackSpeed.toFixed(1) + 'x';
        }
    }

    // ==================== Media Session & Wake Lock ====================
    function setupMediaSession() {
        if ('mediaSession' in navigator) {
            navigator.mediaSession.metadata = new MediaMetadata({
                title: 'Google AI Studio TTS',
                artist: 'Четец на глас',
                album: 'TTS',
            });

            navigator.mediaSession.setActionHandler('play', () => {
                if (state.gaplessPlayer && state.streamMode) {
                    state.gaplessPlayer.resume();
                } else {
                    els.audioPlayer.play().catch(() => {});
                }
                updatePlayPauseIcon();
            });
            navigator.mediaSession.setActionHandler('pause', () => {
                if (state.gaplessPlayer && state.streamMode) {
                    state.gaplessPlayer.pause();
                } else {
                    els.audioPlayer.pause();
                }
                savePlaybackPosition();
                updatePlayPauseIcon();
            });
            navigator.mediaSession.setActionHandler('seekbackward', () => {
                skipTime(-10);
            });
            navigator.mediaSession.setActionHandler('seekforward', () => {
                skipTime(10);
            });
            navigator.mediaSession.setActionHandler('previoustrack', () => {
                skipTime(-10);
            });
            navigator.mediaSession.setActionHandler('nexttrack', () => {
                skipTime(10);
            });
        }
    }

    async function requestWakeLock() {
        if ('wakeLock' in navigator) {
            try {
                state.wakeLock = await navigator.wakeLock.request('screen');
                state.wakeLock.addEventListener('release', () => {
                    state.wakeLock = null;
                });
            } catch {
                // Wake Lock not available or denied — not critical
            }
        }
    }

    function releaseWakeLock() {
        if (state.wakeLock) {
            state.wakeLock.release().catch(() => {});
            state.wakeLock = null;
        }
    }

    // ==================== Events ====================
    function bindEvents() {
        // Settings panel
        els.btnSettings.addEventListener('click', () => togglePanel('settings', true));
        els.btnCloseSettings.addEventListener('click', () => togglePanel('settings', false));
        els.settingsOverlay.addEventListener('click', () => togglePanel('settings', false));

        // History panel
        els.btnHistory.addEventListener('click', () => togglePanel('history', true));
        els.btnCloseHistory.addEventListener('click', () => togglePanel('history', false));
        els.historyOverlay.addEventListener('click', () => togglePanel('history', false));

        // Library panel
        els.btnLibrary.addEventListener('click', () => togglePanel('library', true));
        els.btnCloseLibrary.addEventListener('click', () => togglePanel('library', false));
        els.libraryOverlay.addEventListener('click', () => togglePanel('library', false));
        els.btnAddBook.addEventListener('click', () => els.libraryFileInput.click());
        els.libraryFileInput.addEventListener('change', handleLibraryFileUpload);

        // Theme toggle
        els.btnTheme.addEventListener('click', toggleTheme);

        // API key visibility
        els.btnToggleKey.addEventListener('click', toggleKeyVisibility);

        // Test API key
        els.btnTestKey.addEventListener('click', testApiKey);

        // Preview voice
        els.btnPreviewVoice.addEventListener('click', previewVoice);

        // Welcome banner
        if (els.btnOpenSettingsWelcome) {
            els.btnOpenSettingsWelcome.addEventListener('click', () => togglePanel('settings', true));
        }

        // Settings save on change
        const settingsElements = [
            els.apiKey, els.modelSelect, els.voiceSelect,
            els.speedSlider, els.autoPlay, els.chunkSize,
            els.translationModel, els.ttsLanguage, els.voicePrompt,
        ];
        settingsElements.forEach(el => {
            el.addEventListener('change', () => {
                saveSettings();
                updateGenerateButton();
                checkOnboarding();
                // Sync quick settings when main settings change
                if (el === els.voiceSelect && els.quickVoice) {
                    els.quickVoice.value = els.voiceSelect.value;
                }
                if (el === els.ttsLanguage && els.quickLang) {
                    els.quickLang.value = els.ttsLanguage.value;
                }
                // Pre-warm Live session on model/voice change; clean up if switching away
                if (el === els.modelSelect || el === els.voiceSelect) {
                    if (isLiveModel(getActiveModel())) {
                        prewarmLiveSession();
                    } else {
                        geminiLiveSession.close();
                    }
                }
            });
            if (el.type === 'text' || el.type === 'password' || el.tagName === 'TEXTAREA') {
                el.addEventListener('input', () => {
                    saveSettings();
                    updateGenerateButton();
                    checkOnboarding();
                });
            }
        });

        // Custom model input — save on change and re-evaluate live session
        if (els.customModel) {
            const onCustomModelChange = () => {
                saveSettings();
                updateGenerateButton();
                if (isLiveModel(getActiveModel())) {
                    prewarmLiveSession();
                } else {
                    geminiLiveSession.close();
                }
            };
            els.customModel.addEventListener('change', onCustomModelChange);
            els.customModel.addEventListener('input', onCustomModelChange);
        }
        if (els.btnClearCustomModel) {
            els.btnClearCustomModel.addEventListener('click', () => {
                els.customModel.value = '';
                saveSettings();
                updateGenerateButton();
                if (isLiveModel(getActiveModel())) {
                    prewarmLiveSession();
                } else {
                    geminiLiveSession.close();
                }
            });
        }

        // Quick settings on main page — sync back to settings panel and save
        if (els.quickVoice) {
            els.quickVoice.addEventListener('change', () => {
                els.voiceSelect.value = els.quickVoice.value;
                saveSettings();
            });
        }
        if (els.quickLang) {
            els.quickLang.addEventListener('change', () => {
                els.ttsLanguage.value = els.quickLang.value;
                saveSettings();
            });
        }

        // Translation toggle in settings
        els.translateToggle.addEventListener('change', () => {
            const on = els.translateToggle.checked;
            if (!on) {
                els.translationPreview.classList.add('hidden');
                state.translatedContent = '';
            }
            updateGenerateButton();
        });

        // Translation copy/use
        els.btnCopyTranslation.addEventListener('click', () => {
            copyToClipboard(state.translatedContent);
        });
        els.btnUseTranslation.addEventListener('click', () => {
            els.textInput.value = state.translatedContent;
            els.translateToggle.checked = false;
            els.translateToggle.dispatchEvent(new Event('change'));
            updateCharCount();
            showToast('Преведеният текст е зареден', 'success');
        });

        // Speed slider real-time update
        els.speedSlider.addEventListener('input', () => {
            updateSpeedLabel();
            state.streamPlaybackSpeed = parseFloat(els.speedSlider.value);
            savePlaybackSpeed();
            updateSpeedToggleLabel();
            if (els.audioPlayer.src) {
                els.audioPlayer.playbackRate = state.streamPlaybackSpeed;
            }
        });

        // Text input
        els.textInput.addEventListener('input', updateCharCount);
        els.btnPaste.addEventListener('click', pasteFromClipboard);
        els.btnTranslateMain.addEventListener('click', translateAndReplace);
        els.btnClear.addEventListener('click', clearText);

        // File upload
        els.btnUpload.addEventListener('click', () => els.fileInput.click());
        els.fileInput.addEventListener('change', handleFileUpload);

        // Drag & drop
        const dropZone = els.dropZone;
        dropZone.addEventListener('dragover', (e) => {
            e.preventDefault();
            e.stopPropagation();
            dropZone.classList.add('drag-over');
        });
        dropZone.addEventListener('dragleave', (e) => {
            e.preventDefault();
            e.stopPropagation();
            dropZone.classList.remove('drag-over');
        });
        dropZone.addEventListener('drop', (e) => {
            e.preventDefault();
            e.stopPropagation();
            dropZone.classList.remove('drag-over');
            if (e.dataTransfer.files.length > 0) {
                handleFile(e.dataTransfer.files[0]);
            }
        });

        // Generate / Stop
        els.btnGenerate.addEventListener('click', generateSpeech);
        els.btnStop.addEventListener('click', stopGeneration);

        // Clear data
        els.btnClearHistory.addEventListener('click', () => {
            if (confirm('Сигурни ли сте, че искате да изчистите историята?')) {
                state.history = [];
                saveHistory();
                renderHistory();
                showToast('Историята е изчистена', 'info');
            }
        });

        els.btnClearAll.addEventListener('click', () => {
            if (confirm('Сигурни ли сте, че искате да изчистите всички данни? Това включва API ключа и настройките.')) {
                Object.values(STORAGE_KEYS).forEach(key => localStorage.removeItem(key));
                location.reload();
            }
        });

        // Audio player events
        els.audioPlayer.addEventListener('loadedmetadata', () => {
            const dur = els.audioPlayer.duration;
            if (isFinite(dur)) {
                const size = state.currentAudioBlob
                    ? formatFileSize(state.currentAudioBlob.size)
                    : '';
                els.playerMeta.textContent = `${formatDuration(dur)}${size ? ' · ' + size : ''}`;
            }
        });

        // Track current time for seek slider (non-streaming mode)
        els.audioPlayer.addEventListener('timeupdate', () => {
            if (state.streamMode && !state.gaplessPlayer) {
                updateSeekSliderFromPlayback();
            }
        });

        // Update play/pause icon on play/pause events (non-streaming mode)
        els.audioPlayer.addEventListener('play', () => {
            if (!state.gaplessPlayer) updatePlayPauseIcon();
        });
        els.audioPlayer.addEventListener('pause', () => {
            if (!state.gaplessPlayer) {
                savePlaybackPosition();
                updatePlayPauseIcon();
            }
        });

        // Chunk-end handler used after replay (streamMode=false) or as fallback
        els.audioPlayer.addEventListener('ended', () => {
            if (state.streamMode && !state.gaplessPlayer) {
                playNextStreamChunk();
            }
            updatePlayPauseIcon();
        });

        // Seek slider interaction
        // `input` fires while dragging — only update the time label (no actual seek)
        els.seekSlider.addEventListener('input', () => {
            if (state.streamMode || state.streamChunkWavs.length > 0) {
                handleSeekSliderPreview();
            }
        });
        // `change` fires on mouse/touch release — commit the seek
        els.seekSlider.addEventListener('change', () => {
            if (state.streamMode || state.streamChunkWavs.length > 0) {
                handleSeekSliderInput();
            }
        });

        // Play/Pause button
        els.btnPlayPause.addEventListener('click', togglePlayPause);

        // Skip buttons
        els.btnSkipBack.addEventListener('click', () => skipTime(-10));
        els.btnSkipForward.addEventListener('click', () => skipTime(10));

        // Speed toggle button
        els.btnSpeedToggle.addEventListener('click', cyclePlaybackSpeed);

        // Reader view toggle
        if (els.btnReaderView) {
            els.btnReaderView.addEventListener('click', () => toggleReaderView());
        }
        if (els.btnCloseReaderView) {
            els.btnCloseReaderView.addEventListener('click', () => toggleReaderView(false));
        }

        // Sleep timer
        if (els.btnSleepTimer) {
            els.btnSleepTimer.addEventListener('click', (e) => {
                e.stopPropagation();
                els.sleepTimerDropdown.classList.toggle('hidden');
            });
        }
        if (els.sleepTimerDropdown) {
            els.sleepTimerDropdown.querySelectorAll('.sleep-option').forEach(btn => {
                btn.addEventListener('click', () => {
                    const mins = parseInt(btn.dataset.minutes);
                    setSleepTimer(mins);
                    showToast(mins > 0 ? `🌙 Таймер: ${mins} мин` : '🌙 Таймер изключен', 'info');
                });
            });
            // Close dropdown when clicking elsewhere
            document.addEventListener('click', (e) => {
                if (!els.btnSleepTimer.contains(e.target) && !els.sleepTimerDropdown.contains(e.target)) {
                    els.sleepTimerDropdown.classList.add('hidden');
                }
            });
        }

        // Download button in player
        if (els.btnDownloadPlayer) {
            els.btnDownloadPlayer.addEventListener('click', downloadAudio);
        }

        // Keep playing when visibility changes (background/screen off)
        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState === 'visible' && state.streamMode) {
                requestWakeLock();
            }
        });

        // Keyboard shortcuts
        document.addEventListener('keydown', (e) => {
            // Ctrl+Enter = generate
            if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
                e.preventDefault();
                if (!els.btnGenerate.disabled && !state.isGenerating) {
                    generateSpeech();
                }
            }
            // Escape closes panels
            if (e.key === 'Escape') {
                togglePanel('settings', false);
                togglePanel('history', false);
                togglePanel('library', false);
            }
        });
    }

    // ==================== Panel Management ====================
    function togglePanel(panel, show) {
        const panelMap = {
            settings: { panel: els.settingsPanel, overlay: els.settingsOverlay },
            history: { panel: els.historyPanel, overlay: els.historyOverlay },
            library: { panel: els.libraryPanel, overlay: els.libraryOverlay },
        };
        const entry = panelMap[panel];
        if (!entry) return;
        const panelEl = entry.panel;
        const overlayEl = entry.overlay;

        if (show) {
            overlayEl.classList.remove('hidden');
            panelEl.classList.remove('hidden');
            // Force reflow for transition
            void panelEl.offsetHeight;
            requestAnimationFrame(() => {
                overlayEl.classList.add('visible');
                panelEl.classList.add('visible');
            });
            // Trap focus inside panel
            const firstFocusable = panelEl.querySelector('input, select, button, textarea');
            if (firstFocusable) {
                setTimeout(() => firstFocusable.focus(), 300);
            }
        } else {
            overlayEl.classList.remove('visible');
            panelEl.classList.remove('visible');
            setTimeout(() => {
                overlayEl.classList.add('hidden');
                panelEl.classList.add('hidden');
            }, 300);
        }
    }

    // ==================== Theme ====================
    function toggleTheme() {
        const current = document.documentElement.getAttribute('data-theme');
        const next = current === 'dark' ? 'light' : 'dark';
        document.documentElement.setAttribute('data-theme', next);
        localStorage.setItem(STORAGE_KEYS.THEME, next);
    }

    // ==================== Key Visibility ====================
    function toggleKeyVisibility() {
        const isPassword = els.apiKey.type === 'password';
        els.apiKey.type = isPassword ? 'text' : 'password';
        els.btnToggleKey.classList.toggle('showing-key', isPassword);
    }

    // ==================== API Key Test ====================
    async function testApiKey() {
        const apiKey = getEffectiveApiKey();
        if (!apiKey) {
            setKeyStatus('Въведете API ключ', 'error');
            return;
        }

        if (!navigator.onLine) {
            setKeyStatus('Няма интернет', 'error');
            return;
        }

        setKeyStatus('Тестване...', 'loading');
        els.btnTestKey.disabled = true;

        try {
            const response = await fetchWithTimeout(
                `${API_BASE}/gemini-2.5-flash-lite:generateContent?key=${apiKey}`,
                {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        contents: [{ parts: [{ text: 'Hi' }] }],
                        generationConfig: { maxOutputTokens: 5 },
                    }),
                },
                15000
            );

            if (response.ok) {
                setKeyStatus('✅ Ключът работи!', 'success');
            } else {
                const data = await response.json().catch(() => ({}));
                const msg = data.error?.message || `Грешка ${response.status}`;
                if (response.status === 400 && msg.includes('API key')) {
                    setKeyStatus('❌ Невалиден ключ', 'error');
                } else if (response.status === 403) {
                    setKeyStatus('❌ Ключът няма достъп', 'error');
                } else if (response.status === 429) {
                    setKeyStatus('⚠️ Квотата е надвишена', 'error');
                } else {
                    setKeyStatus(`❌ ${msg.substring(0, 60)}`, 'error');
                }
            }
        } catch (err) {
            if (err.name === 'AbortError') {
                setKeyStatus('⏱️ Таймаут — опитайте пак', 'error');
            } else {
                setKeyStatus('❌ Мрежова грешка', 'error');
            }
        } finally {
            els.btnTestKey.disabled = false;
        }
    }

    function setKeyStatus(text, type) {
        els.keyStatus.textContent = text;
        els.keyStatus.className = `key-status ${type}`;
    }

    // ==================== Voice Preview ====================
    async function previewVoice() {
        const apiKey = getEffectiveApiKey();
        if (!apiKey) {
            showToast('Въведете API ключ, за да чуете примерен глас', 'error');
            return;
        }

        const voice = els.voiceSelect.value;
        const model = getActiveModel();
        els.btnPreviewVoice.disabled = true;
        els.btnPreviewVoice.textContent = '⏳ Генериране...';

        try {
            const result = await generateAudioChunk(
                'Здравейте! Аз съм гласов асистент. Как мога да ви помогна днес?',
                apiKey,
                model,
                voice,
                'bg'
            );

            const wavBlob = pcmToWav(result.audioData, result.sampleRate);
            const url = URL.createObjectURL(wavBlob);

            // Play directly
            const tempAudio = new Audio(url);
            tempAudio.playbackRate = parseFloat(els.speedSlider.value);
            tempAudio.addEventListener('ended', () => URL.revokeObjectURL(url));
            tempAudio.addEventListener('error', () => URL.revokeObjectURL(url));
            await tempAudio.play();

            showToast(`Глас: ${voice}`, 'success');
        } catch (err) {
            showToast(`Грешка: ${err.message}`, 'error');
        } finally {
            els.btnPreviewVoice.disabled = false;
            els.btnPreviewVoice.textContent = '🔊 Чуй примерен глас';
        }
    }

    // ==================== Speed Label ====================
    function updateSpeedLabel() {
        els.speedValue.textContent = parseFloat(els.speedSlider.value).toFixed(1) + 'x';
    }

    // ==================== UI Updates ====================
    function updateUI() {
        updateCharCount();
        updateGenerateButton();
    }

    function updateCharCount() {
        const text = els.textInput.value;
        const chars = text.length;
        const words = text.trim() ? text.trim().split(/\s+/).length : 0;
        els.charCount.textContent = `${chars} символа · ${words} думи`;
        updateGenerateButton();
    }

    function updateGenerateButton() {
        const hasText = els.textInput.value.trim().length > 0;
        const hasKey = getEffectiveApiKey().length > 0;
        els.btnGenerate.disabled = !hasText || !hasKey || state.isGenerating;
    }

    function setGeneratingState(active) {
        state.isGenerating = active;
        els.btnGenerate.classList.toggle('hidden', active);
        els.btnStop.classList.toggle('hidden', !active);
        updateGenerateButton();
    }

    // ==================== Clipboard ====================
    async function pasteFromClipboard() {
        try {
            const text = await navigator.clipboard.readText();
            if (text) {
                els.textInput.value = text;
                updateCharCount();
                showToast('Текст поставен от клипборда', 'success');
            } else {
                showToast('Клипбордът е празен', 'info');
            }
        } catch {
            // Fallback: focus textarea so user can Ctrl+V
            els.textInput.focus();
            showToast('Натиснете Ctrl+V, за да поставите текст', 'info');
        }
    }

    function clearText() {
        if (els.textInput.value.trim() && !confirm('Изчистване на целия текст?')) {
            return;
        }
        els.textInput.value = '';
        updateCharCount();
        showToast('Текстът е изчистен', 'info');
    }

    async function copyToClipboard(text) {
        try {
            await navigator.clipboard.writeText(text);
            showToast('Копирано в клипборда', 'success');
        } catch {
            showToast('Неуспешно копиране', 'error');
        }
    }

    // ==================== File Handling ====================
    function handleFileUpload(e) {
        if (e.target.files.length > 0) {
            handleFile(e.target.files[0]);
            e.target.value = '';
        }
    }

    async function handleFile(file) {
        const maxSize = 10 * 1024 * 1024; // 10MB
        if (file.size > maxSize) {
            showToast('Файлът е твърде голям (макс. 10MB)', 'error');
            return;
        }

        const allowedExtensions = ['.txt', '.md', '.html', '.htm', '.srt', '.pdf', '.epub'];
        const ext = '.' + file.name.split('.').pop().toLowerCase();
        if (!allowedExtensions.includes(ext)) {
            showToast('Неподдържан формат. Използвайте: ' + allowedExtensions.join(', '), 'error');
            return;
        }

        try {
            let text = '';

            if (ext === '.pdf') {
                showToast('Зареждане на PDF файл...', 'info');
                text = await extractTextFromPdf(file);
            } else if (ext === '.epub') {
                showToast('Зареждане на EPUB файл...', 'info');
                text = await extractTextFromEpub(file);
            } else {
                text = await readFileAsText(file);

                // Strip HTML tags if HTML file
                if (ext === '.html' || ext === '.htm') {
                    const parser = new DOMParser();
                    const doc = parser.parseFromString(text, 'text/html');
                    text = doc.body.textContent || '';
                }

                // Clean up SRT format
                if (ext === '.srt') {
                    text = text
                        .replace(/^\d+\s*$/gm, '')
                        .replace(/\d{2}:\d{2}:\d{2},\d{3}\s*-->\s*\d{2}:\d{2}:\d{2},\d{3}/g, '')
                        .replace(/\n{3,}/g, '\n\n')
                        .trim();
                }
            }

            els.textInput.value = text;
            updateCharCount();
            showToast(`Файл „${escapeHtml(file.name)}" зареден (${formatFileSize(file.size)})`, 'success');
        } catch (err) {
            showToast(`Грешка при четене: ${err.message}`, 'error');
        }
    }

    function readFileAsText(file) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = (e) => resolve(e.target.result);
            reader.onerror = () => reject(new Error('Грешка при четене на файла'));
            reader.readAsText(file, 'UTF-8');
        });
    }

    // ==================== PDF / EPUB Support ====================
    async function loadPdfJs() {
        if (window.pdfjsLib) return window.pdfjsLib;

        const pdfjs = await import(
            /* webpackIgnore: true */
            'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.2.67/build/pdf.min.mjs'
        );
        pdfjs.GlobalWorkerOptions.workerSrc =
            'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.2.67/build/pdf.worker.min.mjs';
        window.pdfjsLib = pdfjs;
        return pdfjs;
    }

    function loadJSZip() {
        if (window.JSZip) return Promise.resolve(window.JSZip);

        return new Promise((resolve, reject) => {
            const script = document.createElement('script');
            script.src = 'https://cdn.jsdelivr.net/npm/jszip@3.10.1/dist/jszip.min.js';
            script.onload = () => resolve(window.JSZip);
            script.onerror = () => reject(new Error('Неуспешно зареждане на JSZip'));
            document.head.appendChild(script);
        });
    }

    async function extractTextFromPdf(file) {
        const pdfjs = await loadPdfJs();
        const arrayBuffer = await file.arrayBuffer();
        const pdf = await pdfjs.getDocument({ data: arrayBuffer }).promise;
        let fullText = '';

        for (let i = 1; i <= pdf.numPages; i++) {
            const page = await pdf.getPage(i);
            const content = await page.getTextContent();
            let pageText = '';
            for (const item of content.items) {
                pageText += item.str;
                // Preserve line breaks indicated by hasEOL
                if (item.hasEOL) {
                    pageText += '\n';
                }
            }
            if (pageText.trim()) {
                fullText += pageText.trim() + '\n\n';
            }
        }

        return fullText.trim();
    }

    async function extractTextFromEpub(file) {
        const JSZip = await loadJSZip();
        const arrayBuffer = await file.arrayBuffer();
        const zip = await JSZip.loadAsync(arrayBuffer);

        // Read container.xml to find the rootfile
        const containerFile = zip.file('META-INF/container.xml');
        if (!containerFile) {
            throw new Error('Невалиден EPUB файл (липсва container.xml)');
        }
        const containerXml = await containerFile.async('string');
        const parser = new DOMParser();
        const containerDoc = parser.parseFromString(containerXml, 'text/xml');
        const rootfileEl = containerDoc.querySelector('rootfile');
        if (!rootfileEl) {
            throw new Error('Невалиден EPUB файл (липсва rootfile)');
        }
        const rootfilePath = rootfileEl.getAttribute('full-path');

        // Read content.opf
        const opfFile = zip.file(rootfilePath);
        if (!opfFile) {
            throw new Error('Невалиден EPUB файл (липсва OPF)');
        }
        const opfContent = await opfFile.async('string');
        const opfDoc = parser.parseFromString(opfContent, 'text/xml');

        // Build manifest map (id -> href)
        const manifestMap = {};
        opfDoc.querySelectorAll('manifest item').forEach(item => {
            manifestMap[item.getAttribute('id')] = item.getAttribute('href');
        });

        // Get spine (reading order)
        const spineItems = opfDoc.querySelectorAll('spine itemref');
        const opfDir = rootfilePath.includes('/')
            ? rootfilePath.substring(0, rootfilePath.lastIndexOf('/') + 1)
            : '';

        // Extract text from each chapter in order
        let fullText = '';
        for (const itemRef of spineItems) {
            const idref = itemRef.getAttribute('idref');
            const href = manifestMap[idref];
            if (!href) continue;

            const filePath = opfDir + href;
            const fileObj = zip.file(filePath);
            if (!fileObj) continue;

            const html = await fileObj.async('string');
            const doc = parser.parseFromString(html, 'text/html');
            const text = doc.body ? doc.body.textContent : '';
            if (text.trim()) {
                fullText += text.trim() + '\n\n';
            }
        }

        return fullText.trim();
    }

    // ==================== Translation ====================
    async function translateText() {
        const text = els.textInput.value.trim();
        if (!text) return;

        const apiKey = getEffectiveApiKey();
        if (!apiKey) {
            showToast('Моля, въведете API ключ в настройките', 'error');
            return;
        }

        if (!navigator.onLine) {
            showToast('Няма интернет връзка', 'error');
            return;
        }

        state.isGenerating = true;
        updateGenerateButton();
        showProgress('Превеждане...', true);

        const controller = new AbortController();
        state.abortController = controller;

        try {
            const model = els.translationModel.value;
            const sanitizedText = sanitizeForPrompt(text);

            const response = await fetchWithTimeout(
                `${API_BASE}/${model}:generateContent?key=${apiKey}`,
                {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        contents: [{
                            parts: [{
                                text: `Преведи следния текст от английски на български. Върни САМО превода, без обяснения, без кавички и без допълнителен текст.\n\n---BEGIN TEXT---\n${sanitizedText}\n---END TEXT---`
                            }]
                        }],
                        generationConfig: {
                            temperature: 0.3,
                            maxOutputTokens: 8192,
                        }
                    }),
                    signal: controller.signal,
                },
                API_TIMEOUT_MS
            );

            if (!response.ok) {
                throw await createApiError(response);
            }

            const data = await response.json();
            const translated = extractTextFromResponse(data);

            if (!translated) {
                throw new Error('Не е получен превод от API');
            }

            state.translatedContent = translated;
            els.translatedText.textContent = translated;
            els.translationPreview.classList.remove('hidden');
            hideProgress();
            showToast('Текстът е преведен успешно', 'success');
        } catch (err) {
            hideProgress();
            if (err.name === 'AbortError') {
                showToast('Преводът е спрян', 'info');
            } else {
                showToast(`Грешка при превод: ${err.message}`, 'error');
            }
        } finally {
            state.isGenerating = false;
            state.abortController = null;
            updateGenerateButton();
        }
    }

    function extractTextFromResponse(data) {
        if (data.candidates && data.candidates.length > 0) {
            const candidate = data.candidates[0];
            if (candidate.content && candidate.content.parts) {
                return candidate.content.parts
                    .filter(p => p.text)
                    .map(p => p.text)
                    .join('');
            }
        }
        return null;
    }

    // Translate a single chunk of text (used in streaming pipeline)
    async function translateChunk(text, apiKey, signal) {
        const model = els.translationModel.value;
        const sanitizedText = sanitizeForPrompt(text);

        const response = await fetchWithTimeout(
            `${API_BASE}/${model}:generateContent?key=${apiKey}`,
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    contents: [{
                        parts: [{
                            text: `Преведи следния текст от английски на български. Върни САМО превода, без обяснения, без кавички и без допълнителен текст.\n\n---BEGIN TEXT---\n${sanitizedText}\n---END TEXT---`
                        }]
                    }],
                    generationConfig: {
                        temperature: 0.3,
                        maxOutputTokens: 8192,
                    }
                }),
                signal: signal,
            },
            API_TIMEOUT_MS
        );

        if (!response.ok) {
            throw await createApiError(response);
        }

        const data = await response.json();
        const translated = extractTextFromResponse(data);

        if (!translated) {
            throw new Error('Не е получен превод от API');
        }

        return translated;
    }

    // ==================== Translate & Replace (Main screen button) ====================
    async function translateAndReplace() {
        if (state.isGenerating) {
            showToast('Моля, изчакайте завършването на текущата операция', 'info');
            return;
        }
        await translateText();
        if (state.translatedContent) {
            els.textInput.value = state.translatedContent;
            updateCharCount();
        }
    }

    // ==================== Play/Pause & Skip ====================
    function togglePlayPause() {
        if (state.gaplessPlayer && state.streamMode) {
            // Streaming mode: delegate to GaplessPlayer
            if (state.gaplessPlayer.paused) {
                state.gaplessPlayer.resume();
            } else {
                state.gaplessPlayer.pause();
                savePlaybackPosition();
            }
        } else {
            // Replay / non-streaming mode: use HTML audio element
            if (els.audioPlayer.paused) {
                els.audioPlayer.play().catch(() => {
                    showToast('Натиснете ▶ за възпроизвеждане', 'info');
                });
            } else {
                els.audioPlayer.pause();
                savePlaybackPosition();
            }
        }
        updatePlayPauseIcon();
    }

    function updatePlayPauseIcon() {
        const playIcon = els.btnPlayPause.querySelector('.icon-play');
        const pauseIcon = els.btnPlayPause.querySelector('.icon-pause');
        const isPlaying = (state.gaplessPlayer && state.streamMode)
            ? !state.gaplessPlayer.paused
            : !els.audioPlayer.paused;
        if (isPlaying) {
            playIcon.style.display = 'none';
            pauseIcon.style.display = '';
        } else {
            playIcon.style.display = '';
            pauseIcon.style.display = 'none';
        }
    }

    function skipTime(seconds) {
        if (!state.streamMode && !state.streamChunkWavs.length) return;

        // Get absolute position from GaplessPlayer or HTML audio element
        const absoluteTime = state.gaplessPlayer
            ? state.streamPlayedTime + state.gaplessPlayer.currentTime
            : state.streamPlayedTime + (els.audioPlayer.currentTime || 0);
        const estimatedTotal = getEstimatedTotalDuration();
        const targetTime = Math.max(0, Math.min(absoluteTime + seconds, estimatedTotal));

        // Find the chunk that corresponds to this time
        let cumulative = 0;
        let targetChunk = 0;
        let offsetInChunk = 0;

        for (let i = 0; i < state.streamChunkDurations.length; i++) {
            const chunkDur = state.streamChunkDurations[i];
            if (cumulative + chunkDur > targetTime) {
                targetChunk = i;
                offsetInChunk = targetTime - cumulative;
                break;
            }
            cumulative += chunkDur;
            targetChunk = Math.min(i + 1, state.streamChunkDurations.length - 1);
        }

        // Always delegate to seekToChunk — GaplessPlayer cannot seek in-place
        seekToChunk(targetChunk, offsetInChunk);

        // Update seek slider
        const percent = (targetTime / estimatedTotal) * 100;
        els.seekSlider.value = Math.min(percent, 100);
        els.seekPosition.textContent = formatDuration(targetTime);
    }

    function savePlaybackPosition() {
        if (!state.streamMode && !state.streamChunkWavs.length) return;

        // Get current playback time from GaplessPlayer (streaming) or HTML audio (replay)
        const gaplessTime = state.gaplessPlayer ? state.gaplessPlayer.currentTime : 0;
        const htmlTime = els.audioPlayer.currentTime || 0;
        const absoluteTime = state.gaplessPlayer
            ? state.streamPlayedTime + gaplessTime
            : state.streamPlayedTime + htmlTime;

        // Derive chunk index and offset within chunk from absolute time
        let chunkIndex = state.streamCurrentChunk;
        let offsetInChunk = state.gaplessPlayer ? gaplessTime : htmlTime;
        if (state.gaplessPlayer) {
            let cumulative = 0;
            for (let i = 0; i < state.streamChunkDurations.length; i++) {
                const dur = state.streamChunkDurations[i];
                if (cumulative + dur > absoluteTime) {
                    chunkIndex = i;
                    offsetInChunk = absoluteTime - cumulative;
                    break;
                }
                cumulative += dur;
                chunkIndex = Math.min(i + 1, state.streamChunkDurations.length - 1);
                offsetInChunk = 0;
            }
        }

        state.savedPosition = {
            chunkIndex,
            offsetInChunk,
            absoluteTime,
            bookId: state.currentBookId || null,
        };

        // Persist to localStorage for cross-session resume
        try {
            localStorage.setItem(STORAGE_KEYS.PLAYBACK_POSITION, JSON.stringify(state.savedPosition));
        } catch {
            // localStorage might be full — not critical
        }

        // Save per-book position
        if (state.currentBookId) {
            saveBookPosition(state.currentBookId, state.savedPosition);
            // Persist last played book ID
            try {
                localStorage.setItem(STORAGE_KEYS.LAST_BOOK_ID, state.currentBookId);
            } catch {
                // not critical
            }
        }
    }

    function loadSavedPosition() {
        try {
            const saved = localStorage.getItem(STORAGE_KEYS.PLAYBACK_POSITION);
            if (saved) {
                state.savedPosition = JSON.parse(saved);
            }
        } catch {
            state.savedPosition = null;
        }

        // Restore last played book ID
        try {
            const lastBookId = localStorage.getItem(STORAGE_KEYS.LAST_BOOK_ID);
            if (lastBookId) {
                state.currentBookId = lastBookId;
            }
        } catch {
            // not critical
        }
    }

    function clearSavedPosition() {
        state.savedPosition = null;
        localStorage.removeItem(STORAGE_KEYS.PLAYBACK_POSITION);
        localStorage.removeItem(STORAGE_KEYS.LAST_BOOK_ID);
    }

    function restoreLastBook() {
        // If we have a last book ID and it's in the library, auto-load it
        if (!state.currentBookId) return;

        const book = state.library.find(b => b.id === state.currentBookId);
        if (!book) {
            // Book was deleted — clear stale references
            state.currentBookId = null;
            localStorage.removeItem(STORAGE_KEYS.LAST_BOOK_ID);
            return;
        }

        // Load the book text into the text area
        els.textInput.value = book.text;
        updateCharCount();

        // Load per-book saved position (more reliable than the generic one)
        const bookPos = loadBookPosition(book.id);
        if (bookPos && (bookPos.chunkIndex > 0 || bookPos.offsetInChunk > 0)) {
            state.savedPosition = bookPos;
        }
    }

    // ==================== Per-Book Position ====================
    function saveBookPosition(bookId, position) {
        try {
            let positions = {};
            const saved = localStorage.getItem(STORAGE_KEYS.BOOK_POSITIONS);
            if (saved) positions = JSON.parse(saved);
            positions[bookId] = position;
            localStorage.setItem(STORAGE_KEYS.BOOK_POSITIONS, JSON.stringify(positions));

            // Also update the library book's lastPosition for UI display
            const bookIndex = state.library.findIndex(b => b.id === bookId);
            if (bookIndex >= 0) {
                state.library[bookIndex].lastPosition = position.absoluteTime;
                saveLibrary();
            }
        } catch {
            // localStorage might be full — not critical
        }
    }

    function loadBookPosition(bookId) {
        try {
            const saved = localStorage.getItem(STORAGE_KEYS.BOOK_POSITIONS);
            if (saved) {
                const positions = JSON.parse(saved);
                return positions[bookId] || null;
            }
        } catch {
            // not critical
        }
        return null;
    }

    function clearBookPosition(bookId) {
        try {
            const saved = localStorage.getItem(STORAGE_KEYS.BOOK_POSITIONS);
            if (saved) {
                const positions = JSON.parse(saved);
                delete positions[bookId];
                localStorage.setItem(STORAGE_KEYS.BOOK_POSITIONS, JSON.stringify(positions));
            }
        } catch {
            // not critical
        }
    }

    // ==================== TTS Generation ====================
    async function generateSpeech() {
        const translateMode = els.translateToggle.checked;
        // In translate mode, always use original text (we translate per-segment)
        const text = translateMode ? els.textInput.value.trim() : getTextForSpeech();
        if (!text) {
            showToast('Моля, въведете текст', 'error');
            return;
        }

        const apiKey = getEffectiveApiKey();
        if (!apiKey) {
            showToast('Моля, въведете API ключ в настройките', 'error');
            togglePanel('settings', true);
            return;
        }

        if (!navigator.onLine) {
            showToast('Няма интернет връзка', 'error');
            return;
        }

        const controller = new AbortController();
        state.abortController = controller;
        setGeneratingState(true);
        showProgress('Подготовка...', true);

        // Initialize streaming state
        cleanupStreamState();
        state.streamMode = true;

        // Request wake lock for background playback
        requestWakeLock();

        try {
            const chunkSize = parseInt(els.chunkSize.value);
            // Split text into full-size chunks.  The SSE streaming endpoint delivers
            // the first PCM data almost immediately regardless of chunk length, so
            // there is no benefit in creating a tiny "fast-start" first chunk – it
            // only caused gaps and intonation breaks between chunks.
            const chunks = splitTextIntoChunks(text, chunkSize);

            // Capture voice/model/lang at generation start for consistent timbre
            const model = getActiveModel();
            const voice = els.voiceSelect.value;
            const lang = els.ttsLanguage.value;
            let translatedChunks = new Array(chunks.length).fill('');

            // Initialize chunk tracking
            state.streamChunks = chunks;
            state.streamChunkWavs = new Array(chunks.length).fill(null);
            state.streamChunkDurations = new Array(chunks.length).fill(0);
            state.streamPcmChunks = new Array(chunks.length).fill(null);
            state.streamCurrentChunk = 0;
            state.streamTotalDuration = 0;
            state.streamPlayedTime = 0;

            // Compute character offsets for reader view highlighting
            state.chunkOffsets = computeChunkOffsets(text, chunks);
            state.lastHighlightedChunk = -1;

            // Store display text so seek-restart can finalize audio correctly
            state.currentDisplayText = text;

            // Estimate initial durations for all chunks based on character count
            // This allows the slider to cover the entire book from the start
            for (let i = 0; i < chunks.length; i++) {
                state.streamChunkDurations[i] = chunks[i].length * state.estimatedCharRate;
            }
            state.streamTotalDuration = state.streamChunkDurations.reduce((a, b) => a + b, 0);

            // Show player section immediately for streaming
            els.playerTitle.textContent = text.substring(0, 60) + (text.length > 60 ? '...' : '');
            els.playerSection.classList.remove('hidden');
            updateSeekChunkInfo();

            // Update Media Session metadata
            if ('mediaSession' in navigator) {
                navigator.mediaSession.metadata = new MediaMetadata({
                    title: text.substring(0, 60) + (text.length > 60 ? '...' : ''),
                    artist: `Глас: ${voice}`,
                    album: 'Google AI Studio TTS',
                });
            }

            // Determine if we should resume from a saved position
            let resumeChunkIndex = 0;
            let resumeOffsetInChunk = 0;
            if (state.savedPosition && (state.savedPosition.chunkIndex > 0 || state.savedPosition.offsetInChunk > 0)) {
                // Only resume if the position belongs to the same book (or no book context)
                const posBookId = state.savedPosition.bookId || null;
                const currentBook = state.currentBookId || null;
                const isPositionValid = !posBookId || !currentBook || posBookId === currentBook;

                // Validate the saved position is within the current chunks
                if (isPositionValid && state.savedPosition.chunkIndex < chunks.length) {
                    resumeChunkIndex = state.savedPosition.chunkIndex;
                    resumeOffsetInChunk = state.savedPosition.offsetInChunk || 0;
                }
                state.savedPosition = null;
            }

            // Generate chunks with max 2 buffered ahead
            await generateChunksWithBuffering(
                chunks, apiKey, model, voice, lang, translateMode,
                translatedChunks, controller, resumeChunkIndex, resumeOffsetInChunk
            );

            // All chunks generated
            state.streamFinished = true;
            const translatedFullText = translatedChunks.join('\n');

            // If translate mode, update the translation preview and display text
            if (translateMode && translatedFullText) {
                state.translatedContent = translatedFullText;
                state.currentDisplayText = translatedFullText;
                els.translatedText.textContent = translatedFullText;
                els.translationPreview.classList.remove('hidden');
            }

            // Create combined WAV for download/replay
            finalizeStreamAudio(state.currentDisplayText);

            hideProgress();
            showToast('Речта е генерирана успешно! 🎉', 'success');

            // Add to history
            addToHistory(
                state.currentDisplayText,
                state.currentAudioBlob,
                voice,
                model
            );
        } catch (err) {
            hideProgress();
            if (err.name === 'AbortError') {
                // isSeeking means this abort was triggered by a user seek — suppress toast
                if (!state.isSeeking) {
                    showToast('Генерирането е спряно', 'info');
                }
            } else {
                showToast(`Грешка: ${err.message}`, 'error');
            }
            // When seeking, keep existing chunks intact for the restart
            if (!state.isSeeking) {
                // Don't cleanup if we have some chunks already (allow replay)
                if (state.streamChunkWavs.every(w => w === null)) {
                    cleanupStreamState();
                } else {
                    state.streamFinished = true;
                    finalizeStreamAudio(state.currentDisplayText || text);
                }
            }
        } finally {
            // When seeking, the seek handler will call setGeneratingState(true) again;
            // we still call false here so state.isGenerating becomes false and the
            // seek-poll loop can unblock.
            setGeneratingState(false);
            state.abortController = null;
        }
    }

    async function generateChunksWithBuffering(
        chunks, apiKey, model, voice, lang, translateMode,
        translatedChunks, controller, resumeChunkIndex, resumeOffsetInChunk
    ) {
        resumeChunkIndex = resumeChunkIndex || 0;
        resumeOffsetInChunk = resumeOffsetInChunk || 0;

        const startIndex = resumeChunkIndex;
        state.streamCurrentChunk = startIndex;

        // Set absolute start offset for GaplessPlayer time-tracking
        state.streamPlayedTime = resumeOffsetInChunk;
        for (let j = 0; j < startIndex; j++) {
            state.streamPlayedTime += state.streamChunkDurations[j] || 0;
        }

        // Create a fresh GaplessPlayer for this (re)start
        if (state.gaplessPlayer) {
            state.gaplessPlayer.stop();
        }
        state.gaplessPlayer = createGaplessPlayer();

        // Number of bytes to skip in the first chunk when resuming mid-chunk
        let resumeSkipBytes = Math.floor(resumeOffsetInChunk * state.streamSampleRate) * 2;

        // Callback fed to generateAudioChunk: forwards each PCM piece to GaplessPlayer
        // as it arrives from the SSE stream, enabling playback to begin before the
        // full chunk has been received.
        const onPcmChunk = (pcm, sr) => {
            if (!state.gaplessPlayer || !state.streamMode) return;
            if (resumeSkipBytes > 0) {
                if (pcm.byteLength <= resumeSkipBytes) {
                    resumeSkipBytes -= pcm.byteLength;
                    return; // skip this PCM piece entirely
                }
                // Partial skip
                pcm = pcm.slice(resumeSkipBytes);
                resumeSkipBytes = 0;
            }
            state.gaplessPlayer.feed(pcm, sr);
        };

        // Pre-translate start + buffer segments before TTS generation
        if (translateMode) {
            const preTranslateEnd = Math.min(startIndex + MAX_BUFFER_AHEAD + 1, chunks.length);
            for (let j = startIndex; j < preTranslateEnd; j++) {
                if (controller.signal.aborted) {
                    throw new DOMException('Cancelled', 'AbortError');
                }
                showProgress(
                    `Превод: част ${j + 1} от ${chunks.length}...`,
                    false,
                    ((j - startIndex + 1) / (preTranslateEnd - startIndex)) * 30
                );
                translatedChunks[j] = await translateChunk(chunks[j], apiKey, controller.signal);
            }
        }

        for (let i = startIndex; i < chunks.length; i++) {
            // Check if cancelled
            if (controller.signal.aborted) {
                throw new DOMException('Cancelled', 'AbortError');
            }

            // Wait if we're more than MAX_BUFFER_AHEAD chunks ahead of playback
            while (i - state.streamCurrentChunk >= MAX_BUFFER_AHEAD
                   && !controller.signal.aborted
                   && state.streamMode) {
                await new Promise(resolve => setTimeout(resolve, CHUNK_WAIT_INTERVAL_MS));
            }

            if (controller.signal.aborted) {
                throw new DOMException('Cancelled', 'AbortError');
            }

            // Skip if already generated; feed PCM to GaplessPlayer for continuity
            if (state.streamChunkWavs[i]) {
                if (state.gaplessPlayer && state.streamPcmChunks[i] && i > startIndex) {
                    state.gaplessPlayer.feed(state.streamPcmChunks[i], state.streamSampleRate);
                }
                continue;
            }

            state.streamGeneratingIndex = i;

            let ttsText = chunks[i];

            // If translate mode, use pre-translated text or translate now
            if (translateMode) {
                if (translatedChunks[i]) {
                    ttsText = translatedChunks[i];
                } else {
                    showProgress(
                        chunks.length > 1
                            ? `Превод: част ${i + 1} от ${chunks.length}...`
                            : 'Превеждане...',
                        false,
                        (i / chunks.length) * 100
                    );

                    ttsText = await translateChunk(chunks[i], apiKey, controller.signal);
                    translatedChunks[i] = ttsText;
                }
            }

            // Generate TTS for this chunk — streaming via SSE so audio starts playing
            // as soon as the first PCM data arrives (onPcmChunk feeds GaplessPlayer)
            showProgress(
                chunks.length > 1
                    ? `Реч: част ${i + 1} от ${chunks.length}...`
                    : 'Генериране на реч...',
                false,
                ((i + (translateMode ? 0.5 : 0)) / chunks.length) * 100
            );

            // After the first chunk, the skip-bytes logic no longer applies.
            // Wrap the callback with a leading-silence skipper for chunks 2+ so that
            // the silence padding the TTS model prepends to each response is consumed
            // before it reaches GaplessPlayer, eliminating audible inter-chunk gaps.
            const chunkCallback = i === startIndex ? onPcmChunk : makeLeadingSilenceSkipper(
                (pcm, sr) => {
                    if (state.gaplessPlayer && state.streamMode) {
                        state.gaplessPlayer.feed(pcm, sr);
                    }
                },
                state.streamSampleRate
            );

            const result = await generateAudioChunkWithRetry(
                ttsText, apiKey, model, voice, lang, controller.signal, chunkCallback,
                /* isContinuation */ i > startIndex
            );

            if (result.sampleRate) {
                state.streamSampleRate = result.sampleRate;
            }

            // Trim leading/trailing silence so chunk boundaries are seamless.
            // This removes the silence padding the TTS model adds at the start
            // and end of every response, which is the primary cause of audible gaps.
            const pcmData = trimPcmSilence(result.audioData, state.streamSampleRate);
            state.streamPcmChunks[i] = pcmData;

            // Convert trimmed chunk to WAV (kept for seek / download / replay)
            const chunkWav = pcmToWav(pcmData, state.streamSampleRate);
            state.streamChunkWavs[i] = chunkWav;

            // Calculate exact duration of this chunk (16-bit PCM = 2 bytes per sample)
            const chunkDuration = (pcmData.byteLength / 2) / state.streamSampleRate;
            state.streamChunkDurations[i] = chunkDuration;
            state.streamTotalDuration = state.streamChunkDurations.reduce((a, b) => a + b, 0);

            // Update seek slider total
            updateSeekSliderTotal();

            // Pre-translate next buffer segment for seamless pipeline
            if (translateMode) {
                const nextToTranslate = i + MAX_BUFFER_AHEAD + 1;
                if (nextToTranslate < chunks.length && !translatedChunks[nextToTranslate]) {
                    try {
                        translatedChunks[nextToTranslate] = await translateChunk(
                            chunks[nextToTranslate], apiKey, controller.signal
                        );
                    } catch {
                        // Will retry when reaching this chunk in the main loop
                    }
                }
            }

            showProgress(
                chunks.length > 1
                    ? `Част ${i + 1} от ${chunks.length} ✓`
                    : 'Финализиране...',
                false,
                ((i + 1) / chunks.length) * 100
            );
        }

        state.streamGeneratingIndex = -1;
        // Signal GaplessPlayer that all audio has been fed
        if (state.gaplessPlayer) {
            state.gaplessPlayer.finish();
        }
    }

    function stopGeneration() {
        if (state.abortController) {
            state.abortController.abort();
            state.abortController = null;
        }
        // Stop streaming playback and save position
        if (state.streamMode) {
            savePlaybackPosition();
            // Stop GaplessPlayer (streaming) and HTML audio (replay)
            if (state.gaplessPlayer) {
                state.gaplessPlayer.pause();
            }
            els.audioPlayer.pause();
            // Don't cleanup if we have generated chunks (allow seek / replay)
            if (state.streamChunkWavs.some(w => w !== null)) {
                state.streamFinished = true;
                state.isStreamPlaying = false;
            } else {
                cleanupStreamState();
            }
        }
        updatePlayPauseIcon();
        releaseWakeLock();
    }

    // ==================== Streaming Playback Queue ====================
    // playChunkByIndex is kept as a fallback for the HTML audio element
    // (used in non-GaplessPlayer contexts such as replay after finalizeStreamAudio).
    function playChunkByIndex(index) {
        if (index < 0 || index >= state.streamChunkWavs.length) return;
        if (!state.streamChunkWavs[index]) return; // not generated yet

        state.isStreamPlaying = true;
        state.streamCurrentChunk = index;

        if (state.streamCurrentUrl) {
            URL.revokeObjectURL(state.streamCurrentUrl);
        }
        state.streamCurrentUrl = URL.createObjectURL(state.streamChunkWavs[index]);
        els.audioPlayer.src = state.streamCurrentUrl;
        els.audioPlayer.playbackRate = state.streamPlaybackSpeed;
        els.playerSection.classList.remove('hidden');

        updateSeekChunkInfo();
        els.audioPlayer.play().catch(() => {
            showToast('Натиснете ▶ за възпроизвеждане', 'info');
        });
    }

    // playNextStreamChunk is used as a fallback when no GaplessPlayer is active
    // (e.g. after replay mode is engaged via onStreamPlaybackComplete).
    function playNextStreamChunk() {
        if (state.gaplessPlayer) return; // GaplessPlayer handles transitions
        const nextIndex = state.streamCurrentChunk + 1;

        if (nextIndex >= state.streamChunks.length) {
            state.isStreamPlaying = false;
            if (state.streamCurrentUrl) {
                URL.revokeObjectURL(state.streamCurrentUrl);
                state.streamCurrentUrl = null;
            }
            if (state.streamFinished) {
                onStreamPlaybackComplete();
            }
            savePlaybackPosition();
            releaseWakeLock();
            return;
        }

        if (state.streamChunkWavs[nextIndex]) {
            playChunkByIndex(nextIndex);
        } else {
            state.streamCurrentChunk = nextIndex;
            state.isStreamPlaying = false;
            updateSeekChunkInfo();

            const waitForChunk = () => {
                if (!state.streamMode) return;
                if (state.streamChunkWavs[nextIndex]) {
                    playChunkByIndex(nextIndex);
                } else {
                    setTimeout(waitForChunk, CHUNK_WAIT_INTERVAL_MS);
                }
            };
            waitForChunk();
        }
    }

    function enqueueStreamChunk(wavBlob) {
        const url = URL.createObjectURL(wavBlob);
        state.audioQueue.push({ wavBlob, url });

        // If nothing is playing yet, start playback
        if (!state.isStreamPlaying && els.autoPlay.checked) {
            playNextStreamChunk();
        }
    }

    function onStreamPlaybackComplete() {
        // All chunks generated and played — hand off to HTML audio element for replay/download
        if (state.currentAudioUrl) {
            els.audioPlayer.src = state.currentAudioUrl;
            els.audioPlayer.playbackRate = state.streamPlaybackSpeed;
        }
        // Stop GaplessPlayer now that we're in replay mode
        if (state.gaplessPlayer) {
            state.gaplessPlayer.stop();
            state.gaplessPlayer = null;
        }
        state.streamMode = false;
        stopWaveform();
        releaseWakeLock();
    }

    function finalizeStreamAudio(displayText) {
        const generatedChunks = state.streamPcmChunks.filter(c => c);
        if (generatedChunks.length === 0) return;

        const combinedPcm = combineArrayBuffers(generatedChunks);
        const fullWav = pcmToWav(combinedPcm, state.streamSampleRate);

        if (state.currentAudioUrl) {
            URL.revokeObjectURL(state.currentAudioUrl);
        }

        state.currentAudioBlob = fullWav;
        state.currentAudioUrl = URL.createObjectURL(fullWav);

        els.playerTitle.textContent =
            displayText.substring(0, 60) + (displayText.length > 60 ? '...' : '');

        // If GaplessPlayer is no longer active and all chunks are ready, switch to replay mode
        if (!state.isStreamPlaying && state.streamChunkWavs.every(w => w !== null)) {
            if (state.gaplessPlayer) {
                state.gaplessPlayer.stop();
                state.gaplessPlayer = null;
            }
            els.audioPlayer.src = state.currentAudioUrl;
            els.audioPlayer.playbackRate = state.streamPlaybackSpeed;
            els.playerSection.classList.remove('hidden');
            state.streamMode = false;
        }
    }

    function cleanupStreamState() {
        // Stop and destroy GaplessPlayer
        if (state.gaplessPlayer) {
            state.gaplessPlayer.stop();
            state.gaplessPlayer = null;
        }
        // Revoke currently playing chunk URL
        if (state.streamCurrentUrl) {
            URL.revokeObjectURL(state.streamCurrentUrl);
            state.streamCurrentUrl = null;
        }
        // Revoke pre-loaded chunk URL
        if (state.preloadedChunkUrl) {
            URL.revokeObjectURL(state.preloadedChunkUrl);
            state.preloadedChunkUrl = null;
            state.preloadedChunkIndex = -1;
        }
        for (const entry of state.audioQueue) {
            URL.revokeObjectURL(entry.url);
        }
        state.audioQueue = [];
        state.isStreamPlaying = false;
        state.streamPcmChunks = [];
        state.streamSampleRate = 24000;
        state.streamMode = false;
        state.streamFinished = false;
        state.streamChunks = [];
        state.streamChunkWavs = [];
        state.streamChunkDurations = [];
        state.streamCurrentChunk = 0;
        state.streamTotalDuration = 0;
        state.streamPlayedTime = 0;
        state.streamGeneratingIndex = -1;
        state.chunkOffsets = [];
        state.lastHighlightedChunk = -1;
        stopWaveform();
        releaseWakeLock();
    }

    // ==================== Estimated Duration ====================
    function getEstimatedTotalDuration() {
        let knownDuration = 0;
        let knownChars = 0;
        let unknownChars = 0;

        for (let i = 0; i < state.streamChunks.length; i++) {
            const chunkText = state.streamChunks[i] || '';
            if (state.streamChunkDurations[i] > 0) {
                knownDuration += state.streamChunkDurations[i];
                knownChars += chunkText.length;
            } else {
                unknownChars += chunkText.length;
            }
        }

        if (unknownChars === 0) return knownDuration;

        // Use known ratio if available, otherwise use default estimate
        const charRate = knownChars > 0
            ? knownDuration / knownChars
            : state.estimatedCharRate;

        // Update the estimated char rate for future use
        if (knownChars > 0) {
            state.estimatedCharRate = charRate;
        }

        return knownDuration + (unknownChars * charRate);
    }

    // ==================== Pre-load Next Chunk ====================
    function preloadNextChunk() {
        const nextIndex = state.streamCurrentChunk + 1;
        if (nextIndex >= state.streamChunks.length) return;
        if (!state.streamChunkWavs[nextIndex]) return;
        if (state.preloadedChunkIndex === nextIndex) return;

        // Clean up previous preloaded URL
        if (state.preloadedChunkUrl) {
            URL.revokeObjectURL(state.preloadedChunkUrl);
        }

        state.preloadedChunkUrl = URL.createObjectURL(state.streamChunkWavs[nextIndex]);
        state.preloadedChunkIndex = nextIndex;

        // Pre-load into hidden audio element to warm browser cache
        if (els.audioPlayerNext) {
            els.audioPlayerNext.src = state.preloadedChunkUrl;
            els.audioPlayerNext.playbackRate = state.streamPlaybackSpeed;
            els.audioPlayerNext.load();
        }
    }

    // ==================== Seek Slider ====================
    function updateSeekSliderFromPlayback() {
        if (!state.streamMode) return;
        const estimatedTotal = getEstimatedTotalDuration();
        if (estimatedTotal <= 0) return;

        // Prefer GaplessPlayer time; fall back to HTML audio element for replay mode
        const absoluteTime = state.gaplessPlayer
            ? state.streamPlayedTime + state.gaplessPlayer.currentTime
            : state.streamPlayedTime + (els.audioPlayer.currentTime || 0);
        const percent = (absoluteTime / estimatedTotal) * 100;

        els.seekSlider.value = Math.min(percent, 100);
        els.seekPosition.textContent = formatDuration(absoluteTime);
        els.seekDuration.textContent = formatDuration(estimatedTotal);

        // Keep state.streamCurrentChunk in sync with actual playback position
        let cumulative = 0;
        for (let i = 0; i < state.streamChunkDurations.length; i++) {
            if (cumulative + state.streamChunkDurations[i] > absoluteTime) {
                if (state.streamCurrentChunk !== i) {
                    state.streamCurrentChunk = i;
                    updateSeekChunkInfo();
                }
                break;
            }
            cumulative += state.streamChunkDurations[i];
        }
    }

    function updateSeekSliderTotal() {
        const estimatedTotal = getEstimatedTotalDuration();
        if (estimatedTotal > 0) {
            els.seekDuration.textContent = formatDuration(estimatedTotal);
        }
    }

    function updateSeekChunkInfo() {
        const total = state.streamChunks.length;
        if (total > 1) {
            els.seekChunkInfo.textContent = `Част ${state.streamCurrentChunk + 1}/${total}`;
        } else {
            els.seekChunkInfo.textContent = '';
        }
    }

    // Called on slider `input` (dragging) — only update the time display, do not seek yet
    function handleSeekSliderPreview() {
        const percent = parseFloat(els.seekSlider.value);
        const estimatedTotal = getEstimatedTotalDuration();
        if (estimatedTotal > 0) {
            els.seekPosition.textContent = formatDuration((percent / 100) * estimatedTotal);
        }
    }

    // Called on slider `change` (release) — perform the actual seek
    function handleSeekSliderInput() {
        if (state.isSeeking) {
            showToast('Преместването е в процес — моля, изчакайте...', 'info');
            return;
        }
        const percent = parseFloat(els.seekSlider.value);
        const estimatedTotal = getEstimatedTotalDuration();
        const targetTime = (percent / 100) * estimatedTotal;

        // Find the chunk that corresponds to this time
        let cumulative = 0;
        let targetChunk = 0;
        let offsetInChunk = 0;

        for (let i = 0; i < state.streamChunkDurations.length; i++) {
            const chunkDur = state.streamChunkDurations[i];
            if (cumulative + chunkDur > targetTime) {
                targetChunk = i;
                offsetInChunk = targetTime - cumulative;
                break;
            }
            cumulative += chunkDur;
            targetChunk = Math.min(i + 1, state.streamChunkDurations.length - 1);
        }

        els.seekPosition.textContent = formatDuration(targetTime);

        // Seek to the target chunk
        seekToChunk(targetChunk, offsetInChunk);
    }

    function seekToChunk(chunkIndex, offsetInChunk = 0) {
        if (chunkIndex < 0 || chunkIndex >= state.streamChunks.length) return;

        if (!state.streamChunkWavs[chunkIndex]) {
            // Chunk not yet generated — abort current generation and restart from here
            if (!state.isSeeking) {
                jumpToUngeneratedChunk(chunkIndex, offsetInChunk);
            }
            return;
        }

        // Stop the current GaplessPlayer session
        if (state.gaplessPlayer) {
            state.gaplessPlayer.stop();
            state.gaplessPlayer = null;
        }

        // Update position tracking
        state.streamCurrentChunk = chunkIndex;
        state.streamPlayedTime = 0;
        for (let j = 0; j < chunkIndex; j++) {
            state.streamPlayedTime += state.streamChunkDurations[j] || 0;
        }
        state.streamPlayedTime += offsetInChunk;

        // Create a fresh GaplessPlayer and feed the target chunk (with skip)
        state.gaplessPlayer = createGaplessPlayer();

        const pcm = state.streamPcmChunks[chunkIndex];
        if (pcm) {
            const skipBytes = Math.floor(offsetInChunk * state.streamSampleRate) * 2;
            const feedPcm = (skipBytes > 0 && skipBytes < pcm.byteLength)
                ? pcm.slice(skipBytes)
                : (skipBytes >= pcm.byteLength ? null : pcm);
            if (feedPcm) {
                state.gaplessPlayer.feed(feedPcm, state.streamSampleRate);
            }
        }

        // Feed any subsequent already-generated chunks for seamless continuation
        for (let i = chunkIndex + 1; i < state.streamChunkWavs.length; i++) {
            if (state.streamChunkWavs[i] && state.streamPcmChunks[i]) {
                state.gaplessPlayer.feed(state.streamPcmChunks[i], state.streamSampleRate);
            } else {
                break; // generation pipeline will feed the rest via onPcmChunk
            }
        }

        state.isStreamPlaying = true;
        state.streamMode = true;
        els.playerSection.classList.remove('hidden');
        updateSeekChunkInfo();
        updatePlayPauseIcon();
        startWaveform();
        if (state.readerViewActive) updateReaderHighlight(chunkIndex);
    }

    // Abort current generation and restart from an ungenerated target chunk.
    // Existing generated chunks are preserved so backward seeking still works.
    async function jumpToUngeneratedChunk(targetChunk, offsetInChunk) {
        if (targetChunk < 0 || targetChunk >= state.streamChunks.length) return;

        const apiKey = getEffectiveApiKey();
        if (!apiKey) return;

        // Signal to generateSpeech's catch/finally that this abort is intentional
        state.isSeeking = true;

        // Abort any running generation
        if (state.abortController) {
            state.abortController.abort();
        }

        // Pause GaplessPlayer and HTML audio while we wait
        if (state.gaplessPlayer) {
            state.gaplessPlayer.stop();
            state.gaplessPlayer = null;
        }
        els.audioPlayer.pause();
        state.isStreamPlaying = false;

        // Wait until generateSpeech's finally block has cleaned up
        while (state.isGenerating) {
            await new Promise(resolve => setTimeout(resolve, 50));
        }

        state.isSeeking = false;

        // streamCurrentChunk and streamPlayedTime will be set by generateChunksWithBuffering
        updateSeekChunkInfo();

        // Re-read settings (same as original generation)
        const chunks = state.streamChunks;
        const model = getActiveModel();
        const voice = els.voiceSelect.value;
        const lang = els.ttsLanguage.value;
        const translateMode = els.translateToggle.checked;
        const translatedChunks = new Array(chunks.length).fill('');

        const controller = new AbortController();
        state.abortController = controller;
        state.streamFinished = false;
        state.streamMode = true;
        setGeneratingState(true);
        showProgress(`Генериране на част ${targetChunk + 1} от ${chunks.length}...`, true);

        try {
            await generateChunksWithBuffering(
                chunks, apiKey, model, voice, lang, translateMode,
                translatedChunks, controller, targetChunk, offsetInChunk
            );

            state.streamFinished = true;
            if (state.currentDisplayText) {
                finalizeStreamAudio(state.currentDisplayText);
            }
            hideProgress();
        } catch (err) {
            hideProgress();
            if (err.name !== 'AbortError') {
                showToast(`Грешка: ${err.message}`, 'error');
            }
            if (state.streamChunkWavs.some(w => w !== null)) {
                state.streamFinished = true;
            }
        } finally {
            setGeneratingState(false);
            if (state.abortController === controller) {
                state.abortController = null;
            }
        }
    }

    function getTextForSpeech() {
        if (els.translateToggle.checked && state.translatedContent) {
            return state.translatedContent;
        }
        return els.textInput.value.trim();
    }

    function splitTextIntoChunks(text, maxSize) {
        if (text.length <= maxSize) return [text];

        const chunks = [];

        // First, try to split by double-newlines (paragraphs) to preserve structure
        const paragraphs = text.split(/\n{2,}/);

        for (const para of paragraphs) {
            const trimmedPara = para.trim();
            if (!trimmedPara) continue;

            if (trimmedPara.length <= maxSize) {
                // Whole paragraph fits — keep it together for better voice flow
                if (chunks.length > 0 && (chunks[chunks.length - 1] + '\n\n' + trimmedPara).length <= maxSize) {
                    chunks[chunks.length - 1] += '\n\n' + trimmedPara;
                } else {
                    chunks.push(trimmedPara);
                }
                continue;
            }

            // Paragraph too long — split by sentences
            const sentences = trimmedPara.split(/(?<=[.!?।。！？;])\s+/);
            let currentChunk = '';

            for (const sentence of sentences) {
                if (!sentence.trim()) continue;

                if (sentence.length > maxSize) {
                    if (currentChunk.trim()) {
                        chunks.push(currentChunk.trim());
                        currentChunk = '';
                    }
                    // Split long sentence by words
                    const words = sentence.split(/\s+/);
                    for (const word of words) {
                        if ((currentChunk + ' ' + word).length > maxSize) {
                            if (currentChunk.trim()) chunks.push(currentChunk.trim());
                            currentChunk = word;
                        } else {
                            currentChunk += (currentChunk ? ' ' : '') + word;
                        }
                    }
                } else if ((currentChunk + ' ' + sentence).length > maxSize) {
                    if (currentChunk.trim()) chunks.push(currentChunk.trim());
                    currentChunk = sentence;
                } else {
                    currentChunk += (currentChunk ? ' ' : '') + sentence;
                }
            }
            if (currentChunk.trim()) chunks.push(currentChunk.trim());
        }

        return chunks.length > 0 ? chunks : [text];
    }

    // Decode a base64-aligned string to a 16-bit PCM ArrayBuffer.
    // Any trailing odd byte is silently dropped to maintain int16 alignment.
    function base64ToPcmBuffer(aligned) {
        const binary = atob(aligned);
        const bytes = new Uint8Array(binary.length);
        for (let k = 0; k < binary.length; k++) bytes[k] = binary.charCodeAt(k);
        const evenLen = bytes.length - (bytes.length % 2);
        return evenLen > 0 ? bytes.slice(0, evenLen).buffer : null;
    }

    // Parse a Gemini streamGenerateContent SSE response body,
    // yielding each PCM chunk as { pcm: ArrayBuffer, sampleRate: number }
    // (or { text: string } when the model returns text instead of audio).
    async function* parseAudioSSE(bodyStream, signal) {
        const reader = bodyStream.getReader();
        const decoder = new TextDecoder();
        let lineBuffer = '';
        let base64Residual = '';
        let sampleRate = 24000;
        try {
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                if (signal && signal.aborted) {
                    throw new DOMException('Cancelled', 'AbortError');
                }
                lineBuffer += decoder.decode(value, { stream: true });

                let newlineIdx;
                while ((newlineIdx = lineBuffer.indexOf('\n')) !== -1) {
                    const line = lineBuffer.slice(0, newlineIdx).trimEnd();
                    lineBuffer = lineBuffer.slice(newlineIdx + 1);
                    if (!line.startsWith('data: ')) continue;
                    const data = line.slice(6).trim();
                    if (!data || data === '[DONE]') continue;

                    try {
                        const json = JSON.parse(data);
                        if (json.error) {
                            throw new Error(json.error.message || 'API streaming error');
                        }
                        const parts = json.candidates?.[0]?.content?.parts || [];
                        for (const part of parts) {
                            if (part.inlineData?.data) {
                                const m = part.inlineData.mimeType?.match(/rate=(\d+)/);
                                if (m) sampleRate = parseInt(m[1]);
                                // Accumulate base64 and decode in complete 4-char groups
                                const full = base64Residual + part.inlineData.data;
                                const alignedLen = Math.floor(full.length / 4) * 4;
                                base64Residual = full.slice(alignedLen);
                                const aligned = full.slice(0, alignedLen);
                                if (!aligned) continue;
                                const pcm = base64ToPcmBuffer(aligned);
                                if (pcm) yield { pcm, sampleRate };
                            } else if (part.text) {
                                yield { text: part.text, pcm: null, sampleRate };
                            }
                        }
                    } catch (parseErr) {
                        if (parseErr.name === 'AbortError') throw parseErr;
                        // Skip malformed SSE events silently
                    }
                }
            }

            // Flush any remaining base64 residual
            if (base64Residual.length >= 4) {
                const alignedLen = Math.floor(base64Residual.length / 4) * 4;
                const aligned = base64Residual.slice(0, alignedLen);
                try {
                    const pcm = base64ToPcmBuffer(aligned);
                    if (pcm) yield { pcm, sampleRate };
                } catch {}
            }
        } finally {
            reader.releaseLock();
        }
    }

    // Generate audio for a single text chunk using the streaming SSE endpoint.
    // onPcmChunk(pcm, sampleRate) is called for each PCM piece as it arrives,
    // enabling GaplessPlayer to start before the full response is received.
    // isContinuation=true signals that this is not the first chunk; a prefix
    // is prepended to encourage the model to maintain the same voice character.
    async function generateAudioChunk(text, apiKey, model, voice, lang, signal, onPcmChunk, isContinuation) {
        const langInstruction = LANGUAGE_INSTRUCTIONS[lang] || '';
        const voicePromptText = els.voicePrompt.value.trim();
        let promptText = '';
        if (voicePromptText) {
            promptText += voicePromptText + '\n\n';
        }
        // For subsequent chunks, tell the model to continue in the same style so
        // intonation, pace and timbre remain consistent across API call boundaries.
        if (isContinuation) {
            promptText += CONTINUATION_PREFIXES[lang] || CONTINUATION_PREFIXES.en;
        }
        if (langInstruction) {
            promptText += langInstruction;
        }
        promptText += text;

        const requestBody = {
            contents: [{
                parts: [{ text: promptText }]
            }],
            generationConfig: {
                responseModalities: ['AUDIO'],
                speechConfig: {
                    voiceConfig: {
                        prebuiltVoiceConfig: { voiceName: voice }
                    }
                }
            }
        };

        // Use the streaming endpoint so audio starts arriving immediately
        const response = await fetchWithTimeout(
            `${API_BASE}/${model}:streamGenerateContent?alt=sse&key=${apiKey}`,
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(requestBody),
                signal: signal,
            },
            API_TIMEOUT_MS
        );

        if (!response.ok) {
            throw await createApiError(response);
        }

        const pcmChunks = [];
        let sampleRate = 24000;
        let hasAudio = false;
        const textParts = [];

        for await (const chunk of parseAudioSSE(response.body, signal)) {
            if (chunk.pcm) {
                sampleRate = chunk.sampleRate;
                pcmChunks.push(chunk.pcm);
                hasAudio = true;
                if (onPcmChunk) onPcmChunk(chunk.pcm, chunk.sampleRate);
            } else if (chunk.text) {
                textParts.push(chunk.text);
            }
        }

        if (!hasAudio) {
            if (textParts.length > 0) {
                throw new Error('Моделът върна текст вместо аудио. Проверете дали моделът поддържа TTS.');
            }
            throw new Error('Не е получено аудио от API. Проверете дали избраният модел поддържа TTS.');
        }

        return { audioData: combineArrayBuffers(pcmChunks), sampleRate };
    }

    // Generate audio for a text chunk using the Gemini Live WebSocket API.
    // Mirrors generateAudioChunk but routes through geminiLiveSession instead
    // of a fresh HTTPS request, delivering audio with ~150–300 ms first-packet
    // latency instead of ~500 ms.
    async function generateAudioChunkLive(text, apiKey, model, voice, lang, signal, onPcmChunk, isContinuation) {
        const langInstruction = LANGUAGE_INSTRUCTIONS[lang] || '';
        const voicePromptText = els.voicePrompt.value.trim();
        let promptText = '';
        if (voicePromptText) promptText += voicePromptText + '\n\n';
        if (isContinuation) promptText += CONTINUATION_PREFIXES[lang] || CONTINUATION_PREFIXES.en;
        if (langInstruction) promptText += langInstruction;
        promptText += text;

        await geminiLiveSession.ensureReady(apiKey, model, voice);
        const result = await geminiLiveSession.generateChunk(promptText, onPcmChunk, signal);

        if (!result || !result.audioData || result.audioData.byteLength === 0) {
            throw new Error('Live API: не е получено аудио. Проверете дали моделът поддържа TTS.');
        }
        return result;
    }

    // Pre-warm the Live WebSocket so the first request has zero connection overhead.
    function prewarmLiveSession() {
        const model  = getActiveModel();
        if (!isLiveModel(model)) return;
        const apiKey = getEffectiveApiKey();
        if (!apiKey) return;
        const voice  = els.voiceSelect.value;
        geminiLiveSession.ensureReady(apiKey, model, voice).catch(() => {
            // Pre-warm failure is not critical — session will connect on first use
        });
    }

    // Wrapper around generateAudioChunk that retries up to MAX_RETRIES times
    // with exponential backoff for transient network / server errors.
    // For Live models it routes to generateAudioChunkLive and retries once with
    // a fresh connection.
    async function generateAudioChunkWithRetry(text, apiKey, model, voice, lang, signal, onPcmChunk, isContinuation) {
        if (isLiveModel(model)) {
            try {
                return await generateAudioChunkLive(text, apiKey, model, voice, lang, signal, onPcmChunk, isContinuation);
            } catch (err) {
                if (err.name === 'AbortError') throw err;
                // Retry once with a fresh WebSocket connection
                geminiLiveSession.close();
                return await generateAudioChunkLive(text, apiKey, model, voice, lang, signal, onPcmChunk, isContinuation);
            }
        }

        let lastError;
        for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
            if (signal && signal.aborted) throw new DOMException('Cancelled', 'AbortError');
            try {
                // Only pass the streaming onPcmChunk callback on the first attempt.
                // On retries the first attempt's partial PCM data was already discarded
                // or never fed to GaplessPlayer (cb=null below), so we collect the full
                // result and return it; generateChunksWithBuffering will re-feed it.
                const cb = attempt === 0 ? onPcmChunk : null;
                return await generateAudioChunk(text, apiKey, model, voice, lang, signal, cb, isContinuation);
            } catch (err) {
                if (err.name === 'AbortError') throw err;
                lastError = err;
                if (attempt < MAX_RETRIES - 1) {
                    const delayMs = Math.pow(2, attempt) * 1000; // 1s, 2s
                    await new Promise(resolve => setTimeout(resolve, delayMs));
                }
            }
        }
        throw lastError;
    }
    // ==================== Audio Processing ====================

    // Trim leading and trailing silence from a 16-bit LE PCM ArrayBuffer.
    // Applies a short fade-in and fade-out to avoid clicks at chunk boundaries.
    // Returns a new ArrayBuffer (or the original if nothing needs trimming).
    function trimPcmSilence(pcmBuffer, sampleRate) {
        sampleRate = sampleRate || 24000;
        const samples = new Int16Array(pcmBuffer);
        const len = samples.length;
        if (len === 0) return pcmBuffer;

        const THRESHOLD    = 250;                              // ~0.76% of 32768 (-42 dBFS)
        const MARGIN       = Math.floor(sampleRate * 0.006);  // 6 ms margin (keep natural attack)
        const FADE_IN_LEN  = Math.floor(sampleRate * 0.004);  // 4 ms fade-in
        const FADE_OUT_LEN = Math.floor(sampleRate * 0.015);  // 15 ms fade-out

        // Find first and last non-silent samples
        let first = -1;
        for (let k = 0; k < len; k++) {
            if (Math.abs(samples[k]) > THRESHOLD) { first = k; break; }
        }
        if (first === -1) return pcmBuffer; // entirely silent — leave untouched

        let last = first;
        for (let k = len - 1; k >= first; k--) {
            if (Math.abs(samples[k]) > THRESHOLD) { last = k; break; }
        }

        const start = Math.max(0, first - MARGIN);
        const end   = Math.min(len, last + 1 + MARGIN);

        if (start === 0 && end === len) return pcmBuffer; // nothing to trim

        // Copy trimmed slice into a new typed array so we can apply fades in-place
        const trimmed = new Int16Array(samples.buffer, start * 2, end - start).slice();

        // Fade-in
        const fadeIn = Math.min(FADE_IN_LEN, trimmed.length);
        for (let k = 0; k < fadeIn; k++) {
            trimmed[k] = Math.round(trimmed[k] * (k / fadeIn));
        }

        // Fade-out
        const fadeOut = Math.min(FADE_OUT_LEN, trimmed.length);
        const foStart = trimmed.length - fadeOut;
        for (let k = 0; k < fadeOut; k++) {
            trimmed[foStart + k] = Math.round(trimmed[foStart + k] * (1 - (k + 1) / (fadeOut + 1)));
        }

        return trimmed.buffer;
    }

    // Returns a wrapper around feedFn that skips leading silence in the first
    // PCM piece(s) of a streaming chunk.  Once the first non-silent sample is
    // found, subsequent calls pass straight through.  Used for chunks 2+
    // so that silence padding at the start of each chunk is eaten before the
    // player schedules it, eliminating audible gaps between chunks.
    function makeLeadingSilenceSkipper(feedFn, sampleRate) {
        const sr        = sampleRate || 24000;
        const THRESHOLD = 250;
        const MARGIN    = Math.floor(sr * 0.006);  // 6 ms keep-before-sound
        const FADE_IN   = Math.floor(sr * 0.004);  // 4 ms fade-in
        const MAX_BUF   = sr;                       // 1 s safety limit

        let done   = false;
        let acc    = [];   // array of Int16Array pieces
        let accLen = 0;    // total sample count accumulated

        return (pcm, inSr) => {
            if (done) { feedFn(pcm, inSr); return; }

            acc.push(new Int16Array(pcm));
            accLen += pcm.byteLength >> 1; // / 2

            // Flatten all accumulated pieces
            const combined = new Int16Array(accLen);
            let off = 0;
            for (const c of acc) { combined.set(c, off); off += c.length; }

            // Search for first non-silent sample
            let first = -1;
            for (let k = 0; k < combined.length; k++) {
                if (Math.abs(combined[k]) > THRESHOLD) { first = k; break; }
            }

            // If still all silence and under the safety limit, keep buffering
            if (first === -1 && accLen < MAX_BUF) return;

            // Either found sound or hit safety limit — commit and pass through
            done  = true;
            acc   = [];
            accLen = 0;

            const from    = first === -1 ? 0 : Math.max(0, first - MARGIN);
            const trimmed = combined.slice(from);

            const fadeLen = Math.min(FADE_IN, trimmed.length);
            for (let k = 0; k < fadeLen; k++) {
                trimmed[k] = Math.round(trimmed[k] * (k / fadeLen));
            }

            if (trimmed.length > 0) feedFn(trimmed.buffer, inSr);
        };
    }

    function combineArrayBuffers(buffers) {
        const totalLength = buffers.reduce((sum, buf) => sum + buf.byteLength, 0);
        const combined = new Uint8Array(totalLength);
        let offset = 0;
        for (const buf of buffers) {
            combined.set(new Uint8Array(buf), offset);
            offset += buf.byteLength;
        }
        return combined.buffer;
    }

    function pcmToWav(pcmBuffer, sampleRate, numChannels, bitsPerSample) {
        sampleRate = sampleRate || 24000;
        numChannels = numChannels || 1;
        bitsPerSample = bitsPerSample || 16;

        const pcmData = new Uint8Array(pcmBuffer);
        const byteRate = sampleRate * numChannels * (bitsPerSample / 8);
        const blockAlign = numChannels * (bitsPerSample / 8);
        const dataSize = pcmData.length;
        const headerSize = 44;
        const totalSize = headerSize + dataSize;

        const buffer = new ArrayBuffer(totalSize);
        const view = new DataView(buffer);

        // RIFF header
        writeString(view, 0, 'RIFF');
        view.setUint32(4, totalSize - 8, true);
        writeString(view, 8, 'WAVE');

        // fmt chunk
        writeString(view, 12, 'fmt ');
        view.setUint32(16, 16, true); // chunk size
        view.setUint16(20, 1, true);  // PCM format
        view.setUint16(22, numChannels, true);
        view.setUint32(24, sampleRate, true);
        view.setUint32(28, byteRate, true);
        view.setUint16(32, blockAlign, true);
        view.setUint16(34, bitsPerSample, true);

        // data chunk
        writeString(view, 36, 'data');
        view.setUint32(40, dataSize, true);

        // Copy PCM data
        const wavData = new Uint8Array(buffer);
        wavData.set(pcmData, headerSize);

        return new Blob([buffer], { type: 'audio/wav' });
    }

    function writeString(view, offset, string) {
        for (let i = 0; i < string.length; i++) {
            view.setUint8(offset + i, string.charCodeAt(i));
        }
    }

    // ==================== API Helpers ====================
    async function fetchWithTimeout(url, options, timeoutMs) {
        // Create a timeout abort controller
        const timeoutController = new AbortController();
        const timeout = setTimeout(() => timeoutController.abort(), timeoutMs);

        // If caller provided a signal, listen for external abort too
        const externalSignal = options.signal;
        if (externalSignal) {
            if (externalSignal.aborted) {
                clearTimeout(timeout);
                throw new DOMException('Aborted', 'AbortError');
            }
            externalSignal.addEventListener('abort', () => timeoutController.abort());
        }

        try {
            const response = await fetch(url, {
                ...options,
                signal: timeoutController.signal,
            });
            return response;
        } finally {
            clearTimeout(timeout);
        }
    }

    async function createApiError(response) {
        let message;
        try {
            const data = await response.json();
            message = data.error?.message || `HTTP грешка ${response.status}`;
        } catch {
            message = `HTTP грешка ${response.status}`;
        }

        // User-friendly error messages
        if (response.status === 400) {
            if (message.includes('API key')) {
                return new Error('Невалиден API ключ. Проверете в настройките.');
            }
            return new Error(`Невалидна заявка: ${message.substring(0, 100)}`);
        }
        if (response.status === 403) {
            return new Error('API ключът няма достъп до този модел. Проверете разрешенията.');
        }
        if (response.status === 429) {
            return new Error('Квотата е надвишена. Изчакайте малко и опитайте пак.');
        }
        if (response.status === 500 || response.status === 503) {
            return new Error('Сървърът на Google е претоварен. Опитайте пак след малко.');
        }
        return new Error(message);
    }

    // ==================== Progress ====================
    function showProgress(text, indeterminate, percent) {
        indeterminate = indeterminate || false;
        percent = percent || 0;

        els.progressSection.classList.remove('hidden');
        els.progressText.textContent = text;

        if (indeterminate) {
            els.progressFill.classList.add('indeterminate');
            els.progressFill.style.width = '';
        } else {
            els.progressFill.classList.remove('indeterminate');
            els.progressFill.style.width = Math.min(percent, 100) + '%';
        }
    }

    function hideProgress() {
        els.progressSection.classList.add('hidden');
        els.progressFill.classList.remove('indeterminate');
        els.progressFill.style.width = '0%';
    }

    // ==================== Library ====================
    function loadLibrary() {
        try {
            const saved = localStorage.getItem(STORAGE_KEYS.LIBRARY);
            state.library = saved ? JSON.parse(saved) : [];
        } catch {
            state.library = [];
        }
        renderLibrary();
    }

    function saveLibrary() {
        try {
            localStorage.setItem(STORAGE_KEYS.LIBRARY, JSON.stringify(state.library));
        } catch {
            // localStorage might be full — trim library text
            if (state.library.length > 0) {
                showToast('Паметта е пълна. Опитайте да изтриете стари книги.', 'error');
            }
        }
    }

    function handleLibraryFileUpload(e) {
        if (e.target.files.length > 0) {
            addBookToLibrary(e.target.files[0]);
            e.target.value = '';
        }
    }

    async function addBookToLibrary(file) {
        const maxSize = 10 * 1024 * 1024;
        if (file.size > maxSize) {
            showToast('Файлът е твърде голям (макс. 10MB)', 'error');
            return;
        }

        const allowedExtensions = ['.txt', '.md', '.html', '.htm', '.srt', '.pdf', '.epub'];
        const dotIndex = file.name.lastIndexOf('.');
        const ext = dotIndex >= 0 ? file.name.substring(dotIndex).toLowerCase() : '';
        if (!allowedExtensions.includes(ext)) {
            showToast('Неподдържан формат. Използвайте: ' + allowedExtensions.join(', '), 'error');
            return;
        }

        try {
            let text = '';

            if (ext === '.pdf') {
                showToast('Зареждане на PDF файл...', 'info');
                text = await extractTextFromPdf(file);
            } else if (ext === '.epub') {
                showToast('Зареждане на EPUB файл...', 'info');
                text = await extractTextFromEpub(file);
            } else {
                text = await readFileAsText(file);
                if (ext === '.html' || ext === '.htm') {
                    const parser = new DOMParser();
                    const doc = parser.parseFromString(text, 'text/html');
                    text = doc.body.textContent || '';
                }
                if (ext === '.srt') {
                    text = text
                        .replace(/^\d+\s*$/gm, '')
                        .replace(/\d{2}:\d{2}:\d{2},\d{3}\s*-->\s*\d{2}:\d{2}:\d{2},\d{3}/g, '')
                        .replace(/\n{3,}/g, '\n\n')
                        .trim();
                }
            }

            const book = {
                id: crypto.randomUUID ? crypto.randomUUID() : Date.now().toString() + Math.random().toString(36).slice(2),
                name: file.name,
                text: text,
                addedDate: new Date().toISOString(),
                lastPosition: 0,
            };

            state.library.push(book);
            saveLibrary();
            renderLibrary();
            showToast(`Книга „${escapeHtml(file.name)}" добавена в библиотеката`, 'success');
        } catch (err) {
            showToast(`Грешка при добавяне: ${err.message}`, 'error');
        }
    }

    function renderLibrary() {
        if (state.library.length === 0) {
            els.libraryList.innerHTML = '<p class="empty-state">Все още няма добавени книги.<br><small>Добавете книга чрез бутона по-горе.</small></p>';
            return;
        }

        els.libraryList.innerHTML = state.library.map((book, index) => {
            const charCount = book.text ? book.text.length : 0;
            const wordCount = book.text && book.text.trim().length > 0 ? book.text.trim().split(/\s+/).length : 0;
            const savedPos = loadBookPosition(book.id);
            const hasPosition = savedPos && savedPos.absoluteTime > 0;
            const positionLabel = hasPosition ? formatDuration(savedPos.absoluteTime) : '';
            return `
                <div class="library-item" data-index="${index}">
                    <span class="library-item-title">📖 ${escapeHtml(book.name)}</span>
                    <div class="library-item-meta">
                        <span>${charCount} символа · ${wordCount} думи</span>
                        <span>${formatDate(book.addedDate)}</span>
                    </div>
                    ${hasPosition ? `<div class="library-item-resume-badge">⏸ Спряно на ${positionLabel}</div>` : ''}
                    <div class="library-item-actions">
                        ${hasPosition ? `<button class="btn btn-primary btn-sm library-resume" data-index="${index}" type="button">▶️ Продължи</button>` : ''}
                        <button class="btn btn-outline btn-sm library-load" data-index="${index}" type="button">📝 Зареди</button>
                        <button class="btn btn-outline btn-sm btn-danger library-delete" data-index="${index}" type="button">🗑️ Изтрий</button>
                    </div>
                </div>
            `;
        }).join('');

        // Bind library events
        els.libraryList.querySelectorAll('.library-load').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const idx = parseInt(btn.dataset.index);
                if (idx >= 0 && idx < state.library.length) {
                    const book = state.library[idx];
                    state.currentBookId = book.id;
                    try { localStorage.setItem(STORAGE_KEYS.LAST_BOOK_ID, book.id); } catch { /* not critical */ }
                    els.textInput.value = book.text;
                    updateCharCount();
                    togglePanel('library', false);
                    showToast(`Книга „${escapeHtml(book.name)}" заредена`, 'success');
                }
            });
        });

        els.libraryList.querySelectorAll('.library-resume').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const idx = parseInt(btn.dataset.index);
                if (idx >= 0 && idx < state.library.length) {
                    const book = state.library[idx];
                    state.currentBookId = book.id;
                    try { localStorage.setItem(STORAGE_KEYS.LAST_BOOK_ID, book.id); } catch { /* not critical */ }
                    els.textInput.value = book.text;
                    updateCharCount();
                    togglePanel('library', false);

                    // Load saved position and auto-generate
                    const savedPos = loadBookPosition(book.id);
                    if (savedPos) {
                        state.savedPosition = savedPos;
                    }

                    showToast(`Книга „${escapeHtml(book.name)}" — продължаване от ${formatDuration(savedPos ? savedPos.absoluteTime : 0)}`, 'success');

                    // Auto-start generation if we have an API key
                    if (getEffectiveApiKey()) {
                        setTimeout(() => generateSpeech(), 300);
                    }
                }
            });
        });

        els.libraryList.querySelectorAll('.library-delete').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const idx = parseInt(btn.dataset.index);
                if (idx >= 0 && idx < state.library.length) {
                    const bookId = state.library[idx].id;
                    const name = state.library[idx].name;
                    if (confirm(`Изтриване на „${name}" от библиотеката?`)) {
                        clearBookPosition(bookId);
                        // Clear last book reference if this was the last played book
                        if (state.currentBookId === bookId) {
                            state.currentBookId = null;
                            localStorage.removeItem(STORAGE_KEYS.LAST_BOOK_ID);
                        }
                        state.library.splice(idx, 1);
                        saveLibrary();
                        renderLibrary();
                        showToast(`Книга „${escapeHtml(name)}" изтрита`, 'info');
                    }
                }
            });
        });
    }

    // ==================== Download ====================
    function downloadAudio() {
        if (!state.currentAudioBlob) {
            showToast('Няма аудио за изтегляне', 'error');
            return;
        }

        const text = getTextForSpeech();
        const fileName = generateFileName(text);
        const link = document.createElement('a');
        link.href = state.currentAudioUrl;
        link.download = fileName;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        showToast('Аудио файлът е изтеглен', 'success');
    }

    function generateFileName(text) {
        const preview = text.substring(0, 30)
            .replace(/[^a-zA-Zа-яА-ЯёЁ0-9\s]/g, '')
            .trim()
            .replace(/\s+/g, '_');
        const timestamp = new Date().toISOString().slice(0, 19).replace(/[:-]/g, '');
        return `tts_${preview || 'audio'}_${timestamp}.wav`;
    }

    // ==================== History ====================
    function loadHistory() {
        try {
            const saved = localStorage.getItem(STORAGE_KEYS.HISTORY);
            state.history = saved ? JSON.parse(saved) : [];
        } catch {
            state.history = [];
        }
        renderHistory();
    }

    function saveHistory() {
        // Only save metadata — audio blobs are too large for localStorage
        const historyData = state.history.map(item => ({
            text: item.text,
            voice: item.voice,
            model: item.model,
            date: item.date,
        }));
        try {
            localStorage.setItem(STORAGE_KEYS.HISTORY, JSON.stringify(historyData));
        } catch {
            // localStorage might be full — trim history
            if (state.history.length > 10) {
                state.history = state.history.slice(0, 10);
                saveHistory();
            }
        }
    }

    function addToHistory(text, audioBlob, voice, model) {
        const item = {
            text: text.substring(0, 300),
            voice: voice,
            model: model,
            date: new Date().toISOString(),
            audioBlob: audioBlob, // kept in memory only, lost on page reload
        };

        state.history.unshift(item);
        if (state.history.length > MAX_HISTORY_ITEMS) {
            state.history = state.history.slice(0, MAX_HISTORY_ITEMS);
        }

        saveHistory();
        renderHistory();
    }

    function renderHistory() {
        if (state.history.length === 0) {
            els.historyList.innerHTML = '<p class="empty-state">Все още няма генерирани записи.</p>';
            return;
        }

        els.historyList.innerHTML = state.history.map((item, index) => {
            const hasAudio = !!item.audioBlob;
            const modelShort = item.model ? item.model.replace('gemini-2.5-', '').replace('-preview-tts', '') : '';
            return `
                <div class="history-item" data-index="${index}">
                    <span class="history-item-text">${escapeHtml(item.text)}</span>
                    <div class="history-item-meta">
                        <span>${escapeHtml(item.voice || '')} · ${escapeHtml(modelShort)}</span>
                        <span>${formatDate(item.date)}</span>
                    </div>
                    <div class="history-item-actions">
                        <button class="btn btn-outline btn-sm history-load" data-index="${index}" type="button">📝 Зареди</button>
                        ${hasAudio ? `<button class="btn btn-outline btn-sm history-play" data-index="${index}" type="button">▶️ Пусни</button>` : '<span style="font-size:0.7rem;color:var(--text-muted)">🔇 няма аудио</span>'}
                    </div>
                </div>
            `;
        }).join('');

        // Bind history events
        els.historyList.querySelectorAll('.history-load').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const idx = parseInt(btn.dataset.index);
                if (idx >= 0 && idx < state.history.length) {
                    els.textInput.value = state.history[idx].text;
                    updateCharCount();
                    togglePanel('history', false);
                    showToast('Текстът е зареден от историята', 'info');
                }
            });
        });

        els.historyList.querySelectorAll('.history-play').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const idx = parseInt(btn.dataset.index);
                if (idx >= 0 && idx < state.history.length) {
                    const item = state.history[idx];
                    if (item.audioBlob) {
                        if (state.currentAudioUrl) {
                            URL.revokeObjectURL(state.currentAudioUrl);
                        }
                        state.currentAudioBlob = item.audioBlob;
                        state.currentAudioUrl = URL.createObjectURL(item.audioBlob);
                        els.audioPlayer.src = state.currentAudioUrl;
                        els.audioPlayer.playbackRate = parseFloat(els.speedSlider.value);
                        els.playerTitle.textContent = item.text.substring(0, 60) + (item.text.length > 60 ? '...' : '');
                        els.playerSection.classList.remove('hidden');
                        els.audioPlayer.play().catch(() => {});
                        togglePanel('history', false);
                    }
                }
            });
        });
    }

    // ==================== Toast ====================
    function showToast(message, type, duration) {
        type = type || 'info';
        duration = duration || 3500;

        const toast = document.createElement('div');
        toast.className = `toast ${type}`;
        toast.textContent = message;
        els.toastContainer.appendChild(toast);

        // Fade out then remove
        setTimeout(() => {
            toast.classList.add('fade-out');
            setTimeout(() => {
                if (toast.parentNode) {
                    toast.remove();
                }
            }, 300);
        }, duration - 300);
    }

    // ==================== Helpers ====================
    function escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }

    /**
     * Limit user text length before including it in a prompt.
     * The text is wrapped in delimiters at the call site to separate it from instructions.
     */
    function sanitizeForPrompt(text) {
        const maxLen = 50000;
        if (text.length > maxLen) {
            text = text.substring(0, maxLen);
        }
        return text;
    }

    function formatDuration(seconds) {
        const mins = Math.floor(seconds / 60);
        const secs = Math.floor(seconds % 60);
        return `${mins}:${secs.toString().padStart(2, '0')}`;
    }

    function formatFileSize(bytes) {
        if (bytes < 1024) return bytes + ' B';
        if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
        return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
    }

    function formatDate(isoString) {
        try {
            const date = new Date(isoString);
            return date.toLocaleDateString('bg-BG', {
                day: '2-digit',
                month: '2-digit',
                hour: '2-digit',
                minute: '2-digit',
            });
        } catch {
            return '';
        }
    }

    // ==================== Start ====================
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
