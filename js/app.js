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
    };

    // Only generativelanguage.googleapis.com supports CORS from browser.
    // Vertex AI (aiplatform.googleapis.com) requires a backend proxy.
    const API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

    const MAX_HISTORY_ITEMS = 50;
    const API_TIMEOUT_MS = 120000; // 2 minutes per chunk

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
        btnToggleKey: $('#btnToggleKey'),
        btnTestKey: $('#btnTestKey'),
        keyStatus: $('#keyStatus'),
        btnPreviewVoice: $('#btnPreviewVoice'),
        btnClearHistory: $('#btnClearHistory'),
        btnClearAll: $('#btnClearAll'),

        // Panels
        settingsPanel: $('#settingsPanel'),
        settingsOverlay: $('#settingsOverlay'),
        historyPanel: $('#historyPanel'),
        historyOverlay: $('#historyOverlay'),
        historyList: $('#historyList'),

        // Header buttons
        btnSettings: $('#btnSettings'),
        btnCloseSettings: $('#btnCloseSettings'),
        btnHistory: $('#btnHistory'),
        btnCloseHistory: $('#btnCloseHistory'),
        btnTheme: $('#btnTheme'),

        // Welcome
        welcomeBanner: $('#welcomeBanner'),
        btnOpenSettingsWelcome: $('#btnOpenSettingsWelcome'),

        // Text
        textInput: $('#textInput'),
        charCount: $('#charCount'),
        btnPaste: $('#btnPaste'),
        btnClear: $('#btnClear'),
        fileInput: $('#fileInput'),
        btnUpload: $('#btnUpload'),
        dropZone: $('#dropZone'),

        // Translation
        translateToggle: $('#translateToggle'),
        translationStatus: $('#translationStatus'),
        translationPreview: $('#translationPreview'),
        translatedText: $('#translatedText'),
        btnTranslate: $('#btnTranslate'),
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
        btnDownload: $('#btnDownload'),
        btnRegenerate: $('#btnRegenerate'),

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
        abortController: null,
        // Streaming playback pipeline
        audioQueue: [],
        isStreamPlaying: false,
        streamPcmChunks: [],
        streamSampleRate: 24000,
        streamMode: false,
        streamFinished: false,
    };

    // ==================== Initialization ====================
    function init() {
        loadSettings();
        loadHistory();
        bindEvents();
        updateUI();
        checkOnboarding();
        setupOfflineDetection();
        registerServiceWorker();
    }

    // ==================== Settings ====================
    function loadSettings() {
        const get = (key, fallback) => localStorage.getItem(key) || fallback;

        els.apiKey.value = get(STORAGE_KEYS.API_KEY, '');
        els.modelSelect.value = get(STORAGE_KEYS.MODEL, 'gemini-2.5-flash-preview-tts');
        els.voiceSelect.value = get(STORAGE_KEYS.VOICE, 'Kore');
        els.speedSlider.value = get(STORAGE_KEYS.SPEED, '1.0');
        els.autoPlay.checked = get(STORAGE_KEYS.AUTO_PLAY, 'true') === 'true';
        els.chunkSize.value = get(STORAGE_KEYS.CHUNK_SIZE, '1000');
        els.translationModel.value = get(STORAGE_KEYS.TRANSLATION_MODEL, 'gemini-2.5-flash-lite');
        els.ttsLanguage.value = get(STORAGE_KEYS.TTS_LANGUAGE, 'bg');

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
    }

    // ==================== Onboarding ====================
    function checkOnboarding() {
        const hasKey = els.apiKey.value.trim().length > 0;
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
            els.translationModel, els.ttsLanguage,
        ];
        settingsElements.forEach(el => {
            el.addEventListener('change', () => {
                saveSettings();
                updateGenerateButton();
                checkOnboarding();
            });
            if (el.type === 'text' || el.type === 'password') {
                el.addEventListener('input', () => {
                    saveSettings();
                    updateGenerateButton();
                    checkOnboarding();
                });
            }
        });

        // Speed slider real-time update
        els.speedSlider.addEventListener('input', () => {
            updateSpeedLabel();
            if (els.audioPlayer.src) {
                els.audioPlayer.playbackRate = parseFloat(els.speedSlider.value);
            }
        });

        // Text input
        els.textInput.addEventListener('input', updateCharCount);
        els.btnPaste.addEventListener('click', pasteFromClipboard);
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

        // Translation toggle
        els.translateToggle.addEventListener('change', () => {
            const on = els.translateToggle.checked;
            els.btnTranslate.classList.toggle('hidden', !on);
            els.translationStatus.classList.toggle('hidden', !on);
            if (!on) {
                els.translationPreview.classList.add('hidden');
                state.translatedContent = '';
            }
            updateGenerateButton();
        });

        // Translation
        els.btnTranslate.addEventListener('click', translateText);
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

        // Generate / Stop
        els.btnGenerate.addEventListener('click', generateSpeech);
        els.btnRegenerate.addEventListener('click', generateSpeech);
        els.btnStop.addEventListener('click', stopGeneration);

        // Download
        els.btnDownload.addEventListener('click', downloadAudio);

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

        // Streaming playback: when a chunk finishes, play next in queue
        els.audioPlayer.addEventListener('ended', () => {
            if (state.streamMode) {
                playNextStreamChunk();
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
            }
        });
    }

    // ==================== Panel Management ====================
    function togglePanel(panel, show) {
        const panelEl = panel === 'settings' ? els.settingsPanel : els.historyPanel;
        const overlayEl = panel === 'settings' ? els.settingsOverlay : els.historyOverlay;

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
        const apiKey = els.apiKey.value.trim();
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
        const apiKey = els.apiKey.value.trim();
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
        const hasKey = els.apiKey.value.trim().length > 0;
        els.btnGenerate.disabled = !hasText || !hasKey || state.isGenerating;
        els.btnTranslate.disabled = !hasText || !hasKey || state.isGenerating;
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
            const pageText = content.items.map(item => item.str).join(' ');
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

        const apiKey = els.apiKey.value.trim();
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

    // ==================== TTS Generation ====================
    async function generateSpeech() {
        const translateMode = els.translateToggle.checked;
        // In translate mode, always use original text (we translate per-segment)
        const text = translateMode ? els.textInput.value.trim() : getTextForSpeech();
        if (!text) {
            showToast('Моля, въведете текст', 'error');
            return;
        }

        const apiKey = els.apiKey.value.trim();
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

        try {
            const chunkSize = parseInt(els.chunkSize.value);
            const chunks = splitTextIntoChunks(text, chunkSize);
            const model = els.modelSelect.value;
            const voice = els.voiceSelect.value;
            const lang = els.ttsLanguage.value;
            let translatedFullText = '';

            // Show player section immediately for streaming
            els.playerTitle.textContent = text.substring(0, 60) + (text.length > 60 ? '...' : '');

            for (let i = 0; i < chunks.length; i++) {
                // Check if cancelled
                if (controller.signal.aborted) {
                    throw new DOMException('Cancelled', 'AbortError');
                }

                let ttsText = chunks[i];

                // If translate mode, translate this chunk first
                if (translateMode) {
                    showProgress(
                        chunks.length > 1
                            ? `Превод: част ${i + 1} от ${chunks.length}...`
                            : 'Превеждане...',
                        false,
                        (i / chunks.length) * 100
                    );

                    ttsText = await translateChunk(chunks[i], apiKey, controller.signal);
                    translatedFullText += (translatedFullText ? '\n' : '') + ttsText;
                }

                // Generate TTS for this chunk
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

                state.streamPcmChunks.push(result.audioData);
                if (result.sampleRate) {
                    state.streamSampleRate = result.sampleRate;
                }

                // Convert chunk to WAV and enqueue for immediate playback
                const chunkWav = pcmToWav(result.audioData, state.streamSampleRate);
                enqueueStreamChunk(chunkWav);

                showProgress(
                    chunks.length > 1
                        ? `Част ${i + 1} от ${chunks.length} ✓`
                        : 'Финализиране...',
                    false,
                    ((i + 1) / chunks.length) * 100
                );
            }

            // All chunks generated
            state.streamFinished = true;

            // If translate mode, update the translation preview
            if (translateMode && translatedFullText) {
                state.translatedContent = translatedFullText;
                els.translatedText.textContent = translatedFullText;
                els.translationPreview.classList.remove('hidden');
            }

            // Create combined WAV for download/replay
            finalizeStreamAudio(translateMode ? translatedFullText : text);

            hideProgress();
            showToast('Речта е генерирана успешно! 🎉', 'success');

            // Add to history
            addToHistory(
                translateMode ? translatedFullText : text,
                state.currentAudioBlob,
                voice,
                model
            );
        } catch (err) {
            hideProgress();
            if (err.name === 'AbortError') {
                showToast('Генерирането е спряно', 'info');
            } else {
                showToast(`Грешка: ${err.message}`, 'error');
            }
            cleanupStreamState();
        } finally {
            setGeneratingState(false);
            state.abortController = null;
        }
    }

    function stopGeneration() {
        if (state.abortController) {
            state.abortController.abort();
            state.abortController = null;
        }
        // Stop streaming playback
        if (state.streamMode) {
            els.audioPlayer.pause();
            cleanupStreamState();
        }
    }

    // ==================== Streaming Playback Queue ====================
    function enqueueStreamChunk(wavBlob) {
        const url = URL.createObjectURL(wavBlob);
        state.audioQueue.push({ wavBlob, url });

        // If nothing is playing yet, start playback
        if (!state.isStreamPlaying && els.autoPlay.checked) {
            playNextStreamChunk();
        }
    }

    function playNextStreamChunk() {
        if (state.audioQueue.length === 0) {
            state.isStreamPlaying = false;
            // If all chunks are generated and done playing, set combined audio
            if (state.streamFinished) {
                onStreamPlaybackComplete();
            }
            return;
        }

        state.isStreamPlaying = true;
        const entry = state.audioQueue.shift();

        els.audioPlayer.src = entry.url;
        els.audioPlayer.playbackRate = parseFloat(els.speedSlider.value);
        els.playerSection.classList.remove('hidden');

        els.audioPlayer.play().catch(() => {
            showToast('Натиснете ▶ за възпроизвеждане', 'info');
        });
    }

    function onStreamPlaybackComplete() {
        // All chunks generated and played — set combined audio for replay/download
        if (state.currentAudioUrl) {
            els.audioPlayer.src = state.currentAudioUrl;
            els.audioPlayer.playbackRate = parseFloat(els.speedSlider.value);
        }
        state.streamMode = false;
    }

    function finalizeStreamAudio(displayText) {
        if (state.streamPcmChunks.length === 0) return;

        const combinedPcm = combineArrayBuffers(state.streamPcmChunks);
        const fullWav = pcmToWav(combinedPcm, state.streamSampleRate);

        if (state.currentAudioUrl) {
            URL.revokeObjectURL(state.currentAudioUrl);
        }

        state.currentAudioBlob = fullWav;
        state.currentAudioUrl = URL.createObjectURL(fullWav);

        els.playerTitle.textContent =
            displayText.substring(0, 60) + (displayText.length > 60 ? '...' : '');

        // If playback already finished (single chunk case), set combined audio now
        if (!state.isStreamPlaying && state.audioQueue.length === 0) {
            els.audioPlayer.src = state.currentAudioUrl;
            els.audioPlayer.playbackRate = parseFloat(els.speedSlider.value);
            els.playerSection.classList.remove('hidden');
            state.streamMode = false;
        }
    }

    function cleanupStreamState() {
        for (const entry of state.audioQueue) {
            URL.revokeObjectURL(entry.url);
        }
        state.audioQueue = [];
        state.isStreamPlaying = false;
        state.streamPcmChunks = [];
        state.streamSampleRate = 24000;
        state.streamMode = false;
        state.streamFinished = false;
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
        // Build the text with language instruction
        const langInstruction = LANGUAGE_INSTRUCTIONS[lang] || '';
        const promptText = langInstruction ? langInstruction + text : text;

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
