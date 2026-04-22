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
    const FAST_START_CHARS = 300; // First chunk max size for faster playback start
    const MIN_CHUNK_LENGTH = 50;  // Minimum sensible chunk length for sentence-break detection

    // Language instructions for TTS
    const LANGUAGE_INSTRUCTIONS = {
        bg: 'Прочети следния текст на български език с ясна дикция: ',
        en: 'Read the following text in English with clear pronunciation: ',
        auto: '', // No instruction, let the model auto-detect
    };

    // ==================== DOM Elements ====================
    const $ = (sel) => document.querySelector(sel);

    const els = {
        // Settings
        apiKey: $('#apiKey'),
        modelSelect: $('#modelSelect'),
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
        streamPlayedTime: 0,      // cumulative played time before current chunk
        streamGeneratingIndex: -1, // chunk index currently being generated
        streamPlaybackSpeed: 1.0,  // current playback speed
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

    // ==================== Text Chunking Helpers ====================
    // Find a good sentence break at or before maxChars for fast-start first chunk.
    function findSentenceBreak(text, maxChars) {
        if (text.length <= maxChars) return text.length;
        const snippet = text.substring(0, maxChars);
        // Find the last sentence-ending punctuation
        const match = snippet.match(/^([\s\S]*[.!?।\n])/);
        if (match && match[0].trim().length >= MIN_CHUNK_LENGTH) {
            return match[0].length;
        }
        // Fall back to last whitespace
        const wsIdx = snippet.lastIndexOf(' ');
        return wsIdx > MIN_CHUNK_LENGTH ? wsIdx + 1 : maxChars;
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
    }

    // ==================== Settings ====================
    function loadSettings() {
        const get = (key, fallback) => localStorage.getItem(key) || fallback;

        els.apiKey.value = get(STORAGE_KEYS.API_KEY, '');
        els.modelSelect.value = get(STORAGE_KEYS.MODEL, 'gemini-2.5-flash-preview-tts');
        els.voiceSelect.value = get(STORAGE_KEYS.VOICE, 'Kore');
        els.speedSlider.value = get(STORAGE_KEYS.SPEED, '1.0');
        els.autoPlay.checked = get(STORAGE_KEYS.AUTO_PLAY, 'true') === 'true';
        els.chunkSize.value = get(STORAGE_KEYS.CHUNK_SIZE, '500');
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
        });
        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState === 'hidden') {
                savePlaybackPosition();
            }
        });
        // Periodic auto-save every 15 seconds during playback
        setInterval(() => {
            if (state.streamMode && state.isStreamPlaying && !els.audioPlayer.paused) {
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

        // Apply to currently playing audio
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
                els.audioPlayer.play().catch(() => {});
                updatePlayPauseIcon();
            });
            navigator.mediaSession.setActionHandler('pause', () => {
                els.audioPlayer.pause();
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
            });
            if (el.type === 'text' || el.type === 'password' || el.tagName === 'TEXTAREA') {
                el.addEventListener('input', () => {
                    saveSettings();
                    updateGenerateButton();
                    checkOnboarding();
                });
            }
        });

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

        // Track current time for seek slider
        els.audioPlayer.addEventListener('timeupdate', () => {
            if (state.streamMode) {
                updateSeekSliderFromPlayback();
            }
        });

        // Update play/pause icon on play/pause events
        els.audioPlayer.addEventListener('play', updatePlayPauseIcon);
        els.audioPlayer.addEventListener('pause', () => {
            savePlaybackPosition();
            updatePlayPauseIcon();
        });

        // Streaming playback: when a chunk finishes, play next in queue
        els.audioPlayer.addEventListener('ended', () => {
            if (state.streamMode) {
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
        const model = els.modelSelect.value;
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
        if (els.audioPlayer.paused) {
            els.audioPlayer.play().catch(() => {
                showToast('Натиснете ▶ за възпроизвеждане', 'info');
            });
        } else {
            els.audioPlayer.pause();
            savePlaybackPosition();
        }
        updatePlayPauseIcon();
    }

    function updatePlayPauseIcon() {
        const playIcon = els.btnPlayPause.querySelector('.icon-play');
        const pauseIcon = els.btnPlayPause.querySelector('.icon-pause');
        if (els.audioPlayer.paused) {
            playIcon.style.display = '';
            pauseIcon.style.display = 'none';
        } else {
            playIcon.style.display = 'none';
            pauseIcon.style.display = '';
        }
    }

    function skipTime(seconds) {
        if (!state.streamMode && !state.streamChunkWavs.length) return;

        const currentTime = els.audioPlayer.currentTime || 0;
        const absoluteTime = state.streamPlayedTime + currentTime;
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

        // If same chunk, just seek within it
        if (targetChunk === state.streamCurrentChunk && state.streamChunkWavs[targetChunk]) {
            els.audioPlayer.currentTime = offsetInChunk;
        } else {
            seekToChunk(targetChunk, offsetInChunk);
        }

        // Update seek slider
        const percent = (targetTime / estimatedTotal) * 100;
        els.seekSlider.value = Math.min(percent, 100);
        els.seekPosition.textContent = formatDuration(targetTime);
    }

    function savePlaybackPosition() {
        if (!state.streamMode && !state.streamChunkWavs.length) return;

        const currentTime = els.audioPlayer.currentTime || 0;
        const absoluteTime = state.streamPlayedTime + currentTime;

        state.savedPosition = {
            chunkIndex: state.streamCurrentChunk,
            offsetInChunk: currentTime,
            absoluteTime: absoluteTime,
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
            // Fast-start: for texts longer than FAST_START_CHARS, extract a small first
            // chunk so audio starts playing much sooner (within the first 300 chars).
            let chunks;
            if (text.length > FAST_START_CHARS && text.length > chunkSize) {
                const breakAt = findSentenceBreak(text, FAST_START_CHARS);
                const firstChunk = text.substring(0, breakAt).trim();
                const restText = text.substring(breakAt).trim();
                if (firstChunk && restText) {
                    chunks = [firstChunk, ...splitTextIntoChunks(restText, chunkSize)];
                } else {
                    chunks = splitTextIntoChunks(text, chunkSize);
                }
            } else {
                chunks = splitTextIntoChunks(text, chunkSize);
            }

            // Capture voice/model/lang at generation start for consistent timbre
            const model = els.modelSelect.value;
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

        // If resuming, start generating from the resume chunk
        // but generate sequentially from the resume point for buffering
        const startIndex = resumeChunkIndex;
        state.streamCurrentChunk = startIndex;

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

            // Skip if this chunk was already generated (e.g. after a seek)
            if (state.streamChunkWavs[i]) {
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

            // Generate TTS for this chunk — same model/voice/lang for consistency
            showProgress(
                chunks.length > 1
                    ? `Реч: част ${i + 1} от ${chunks.length}...`
                    : 'Генериране на реч...',
                false,
                ((i + (translateMode ? 0.5 : 0)) / chunks.length) * 100
            );

            const result = await generateAudioChunk(
                ttsText, apiKey, model, voice, lang, controller.signal
            );

            state.streamPcmChunks[i] = result.audioData;
            if (result.sampleRate) {
                state.streamSampleRate = result.sampleRate;
            }

            // Convert chunk to WAV
            const chunkWav = pcmToWav(result.audioData, state.streamSampleRate);
            state.streamChunkWavs[i] = chunkWav;

            // Calculate duration of this chunk
            // 16-bit PCM = 2 bytes per sample
            const chunkDuration = (result.audioData.byteLength / 2) / state.streamSampleRate;
            state.streamChunkDurations[i] = chunkDuration;
            state.streamTotalDuration = state.streamChunkDurations.reduce((a, b) => a + b, 0);

            // Update seek slider total
            updateSeekSliderTotal();

            // Start playback immediately when the current chunk is ready
            if (i === state.streamCurrentChunk && !state.isStreamPlaying) {
                if (i === startIndex && resumeOffsetInChunk > 0) {
                    // Resume from saved offset within the chunk
                    seekToChunk(i, resumeOffsetInChunk);
                } else {
                    playChunkByIndex(i);
                }
            }

            // Pre-load next chunk if this chunk is the one after the currently playing
            if (i === state.streamCurrentChunk + 1) {
                preloadNextChunk();
            }

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
    }

    function stopGeneration() {
        if (state.abortController) {
            state.abortController.abort();
            state.abortController = null;
        }
        // Stop streaming playback and save position
        if (state.streamMode) {
            savePlaybackPosition();
            els.audioPlayer.pause();
            // Don't cleanup if we have generated chunks (allow seek)
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
    function playChunkByIndex(index) {
        if (index < 0 || index >= state.streamChunkWavs.length) return;
        if (!state.streamChunkWavs[index]) return; // not generated yet

        state.isStreamPlaying = true;
        state.streamCurrentChunk = index;

        // Calculate played time before this chunk
        state.streamPlayedTime = 0;
        for (let j = 0; j < index; j++) {
            state.streamPlayedTime += state.streamChunkDurations[j] || 0;
        }

        // Check if this chunk was already pre-loaded
        if (state.preloadedChunkIndex === index && state.preloadedChunkUrl) {
            // Use pre-loaded URL (already warmed in browser cache)
            if (state.streamCurrentUrl) {
                URL.revokeObjectURL(state.streamCurrentUrl);
            }
            state.streamCurrentUrl = state.preloadedChunkUrl;
            state.preloadedChunkUrl = null;
            state.preloadedChunkIndex = -1;
        } else {
            // Revoke previous chunk URL
            if (state.streamCurrentUrl) {
                URL.revokeObjectURL(state.streamCurrentUrl);
            }
            state.streamCurrentUrl = URL.createObjectURL(state.streamChunkWavs[index]);
        }

        els.audioPlayer.src = state.streamCurrentUrl;
        els.audioPlayer.playbackRate = state.streamPlaybackSpeed;
        els.playerSection.classList.remove('hidden');

        updateSeekChunkInfo();

        els.audioPlayer.play().catch(() => {
            showToast('Натиснете ▶ за възпроизвеждане', 'info');
        });

        // Pre-load next chunk for seamless transition
        preloadNextChunk();
    }

    function playNextStreamChunk() {
        const nextIndex = state.streamCurrentChunk + 1;

        if (nextIndex >= state.streamChunks.length) {
            // All chunks played
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
            // Next chunk is ready — use pre-loaded URL for seamless transition
            playChunkByIndex(nextIndex);
        } else {
            // Next chunk not ready yet, wait for it
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
        // All chunks generated and played — set combined audio for replay/download
        if (state.currentAudioUrl) {
            els.audioPlayer.src = state.currentAudioUrl;
            els.audioPlayer.playbackRate = state.streamPlaybackSpeed;
        }
        state.streamMode = false;
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

        // If playback already finished (single chunk case), set combined audio now
        if (!state.isStreamPlaying && state.streamChunkWavs.every(w => w !== null)) {
            els.audioPlayer.src = state.currentAudioUrl;
            els.audioPlayer.playbackRate = state.streamPlaybackSpeed;
            els.playerSection.classList.remove('hidden');
            state.streamMode = false;
        }
    }

    function cleanupStreamState() {
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

        const currentTime = els.audioPlayer.currentTime || 0;
        const absoluteTime = state.streamPlayedTime + currentTime;
        const percent = (absoluteTime / estimatedTotal) * 100;

        els.seekSlider.value = Math.min(percent, 100);
        els.seekPosition.textContent = formatDuration(absoluteTime);
        els.seekDuration.textContent = formatDuration(estimatedTotal);
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

        state.streamCurrentChunk = chunkIndex;
        state.streamPlayedTime = 0;
        for (let j = 0; j < chunkIndex; j++) {
            state.streamPlayedTime += state.streamChunkDurations[j] || 0;
        }

        // Revoke previous URL
        if (state.streamCurrentUrl) {
            URL.revokeObjectURL(state.streamCurrentUrl);
        }

        const url = URL.createObjectURL(state.streamChunkWavs[chunkIndex]);
        state.streamCurrentUrl = url;

        els.audioPlayer.src = url;
        els.audioPlayer.playbackRate = state.streamPlaybackSpeed;

        // If an offset within the chunk was requested, seek to it once loaded
        if (offsetInChunk && offsetInChunk > 0) {
            const onCanPlay = () => {
                els.audioPlayer.currentTime = offsetInChunk;
                els.audioPlayer.removeEventListener('canplay', onCanPlay);
            };
            els.audioPlayer.addEventListener('canplay', onCanPlay);
        }

        state.isStreamPlaying = true;
        state.streamMode = true;
        updateSeekChunkInfo();

        els.audioPlayer.play().catch(() => {
            showToast('Натиснете ▶ за възпроизвеждане', 'info');
        });

        // Pre-load next chunk for seamless transition
        preloadNextChunk();
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

        // Pause playback while we wait
        els.audioPlayer.pause();
        state.isStreamPlaying = false;

        // Wait until generateSpeech's finally block has cleaned up
        while (state.isGenerating) {
            await new Promise(resolve => setTimeout(resolve, 50));
        }

        state.isSeeking = false;

        // Update position tracking to the target chunk
        state.streamCurrentChunk = targetChunk;
        state.streamPlayedTime = 0;
        for (let j = 0; j < targetChunk; j++) {
            state.streamPlayedTime += state.streamChunkDurations[j] || 0;
        }
        updateSeekChunkInfo();

        // Re-read settings (same as original generation)
        const chunks = state.streamChunks;
        const model = els.modelSelect.value;
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
        // Split by sentence-ending punctuation
        const sentences = text.split(/(?<=[.!?。！？\n])\s*/);
        let currentChunk = '';

        for (const sentence of sentences) {
            if (!sentence.trim()) continue;

            if (sentence.length > maxSize) {
                // Flush current chunk first
                if (currentChunk.trim()) {
                    chunks.push(currentChunk.trim());
                    currentChunk = '';
                }
                // Split long sentence by words
                const words = sentence.split(/\s+/);
                for (const word of words) {
                    if ((currentChunk + ' ' + word).length > maxSize) {
                        if (currentChunk.trim()) {
                            chunks.push(currentChunk.trim());
                        }
                        currentChunk = word;
                    } else {
                        currentChunk += (currentChunk ? ' ' : '') + word;
                    }
                }
            } else if ((currentChunk + ' ' + sentence).length > maxSize) {
                if (currentChunk.trim()) {
                    chunks.push(currentChunk.trim());
                }
                currentChunk = sentence;
            } else {
                currentChunk += (currentChunk ? ' ' : '') + sentence;
            }
        }

        if (currentChunk.trim()) {
            chunks.push(currentChunk.trim());
        }

        return chunks.length > 0 ? chunks : [text];
    }

    async function generateAudioChunk(text, apiKey, model, voice, lang, signal) {
        // Build the text with language instruction and optional voice prompt.
        // Note: systemInstruction is not supported by Gemini TTS preview models,
        // so style guidance is prepended inline before the actual text to read.
        const langInstruction = LANGUAGE_INSTRUCTIONS[lang] || '';
        const voicePromptText = els.voicePrompt.value.trim();
        let promptText = '';
        if (voicePromptText) {
            promptText += voicePromptText + '\n\n';
        }
        if (langInstruction) {
            promptText += langInstruction;
        }
        promptText += text;

        const requestBody = {
            contents: [{
                parts: [{
                    text: promptText
                }]
            }],
            generationConfig: {
                responseModalities: ['AUDIO'],
                speechConfig: {
                    voiceConfig: {
                        prebuiltVoiceConfig: {
                            voiceName: voice
                        }
                    }
                }
            }
        };

        const response = await fetchWithTimeout(
            `${API_BASE}/${model}:generateContent?key=${apiKey}`,
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

        const data = await response.json();

        // Parse response — can be a single object or array (streaming format)
        const candidates = Array.isArray(data) ? data : [data];
        let audioBase64 = '';
        let mimeType = 'audio/L16;rate=24000';

        for (const item of candidates) {
            const candidateList = item.candidates || [];
            for (const candidate of candidateList) {
                if (candidate.content && candidate.content.parts) {
                    for (const part of candidate.content.parts) {
                        if (part.inlineData) {
                            audioBase64 += part.inlineData.data;
                            if (part.inlineData.mimeType) {
                                mimeType = part.inlineData.mimeType;
                            }
                        }
                    }
                }
            }
        }

        if (!audioBase64) {
            // Check if the model returned text instead of audio
            const textResponse = extractTextFromResponse(data);
            if (textResponse) {
                throw new Error('Моделът върна текст вместо аудио. Проверете дали моделът поддържа TTS.');
            }
            throw new Error('Не е получено аудио от API. Проверете дали избраният модел поддържа TTS.');
        }

        // Parse sample rate from mime type
        let sampleRate = 24000;
        const rateMatch = mimeType.match(/rate=(\d+)/);
        if (rateMatch) {
            sampleRate = parseInt(rateMatch[1]);
        }

        // Decode base64 to ArrayBuffer
        const binaryString = atob(audioBase64);
        const audioData = new Uint8Array(binaryString.length);
        for (let i = 0; i < binaryString.length; i++) {
            audioData[i] = binaryString.charCodeAt(i);
        }

        return { audioData: audioData.buffer, sampleRate };
    }

    // ==================== Audio Processing ====================
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
