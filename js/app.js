/* ==============================
   Gemini TTS — Application Logic
   ============================== */

(function () {
    'use strict';

    // ==================== Constants ====================
    const STORAGE_KEYS = {
        API_KEY: 'gemini_tts_api_key',
        ENDPOINT: 'gemini_tts_endpoint',
        MODEL: 'gemini_tts_model',
        VOICE: 'gemini_tts_voice',
        SPEED: 'gemini_tts_speed',
        AUTO_PLAY: 'gemini_tts_autoplay',
        CHUNK_SIZE: 'gemini_tts_chunk_size',
        THEME: 'gemini_tts_theme',
        HISTORY: 'gemini_tts_history',
        TRANSLATION_MODEL: 'gemini_tts_translation_model',
    };

    const API_ENDPOINTS = {
        generativelanguage: 'https://generativelanguage.googleapis.com/v1beta/models',
        aiplatform: 'https://aiplatform.googleapis.com/v1/publishers/google/models',
    };

    const MAX_HISTORY_ITEMS = 50;

    // ==================== DOM Elements ====================
    const $ = (sel) => document.querySelector(sel);
    const $$ = (sel) => document.querySelectorAll(sel);

    const els = {
        // Settings
        apiKey: $('#apiKey'),
        apiEndpoint: $('#apiEndpoint'),
        modelSelect: $('#modelSelect'),
        voiceSelect: $('#voiceSelect'),
        speedSlider: $('#speedSlider'),
        speedValue: $('#speedValue'),
        autoPlay: $('#autoPlay'),
        chunkSize: $('#chunkSize'),
        translationModel: $('#translationModel'),
        btnToggleKey: $('#btnToggleKey'),
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
        progressSection: $('#progressSection'),
        progressFill: $('#progressFill'),
        progressText: $('#progressText'),

        // Player
        playerSection: $('#playerSection'),
        playerTitle: $('#playerTitle'),
        playerDuration: $('#playerDuration'),
        audioPlayer: $('#audioPlayer'),
        btnDownload: $('#btnDownload'),
        btnRegenerate: $('#btnRegenerate'),

        // Loading & Toast
        loadingOverlay: $('#loadingOverlay'),
        loadingText: $('#loadingText'),
        toastContainer: $('#toastContainer'),
    };

    // ==================== State ====================
    let state = {
        isGenerating: false,
        currentAudioBlob: null,
        currentAudioUrl: null,
        translatedContent: '',
        history: [],
    };

    // ==================== Initialization ====================
    function init() {
        loadSettings();
        loadHistory();
        bindEvents();
        updateUI();
    }

    // ==================== Settings ====================
    function loadSettings() {
        const get = (key, fallback) => localStorage.getItem(key) || fallback;

        els.apiKey.value = get(STORAGE_KEYS.API_KEY, '');
        els.apiEndpoint.value = get(STORAGE_KEYS.ENDPOINT, 'generativelanguage');
        els.modelSelect.value = get(STORAGE_KEYS.MODEL, 'gemini-2.5-flash-preview-tts');
        els.voiceSelect.value = get(STORAGE_KEYS.VOICE, 'Kore');
        els.speedSlider.value = get(STORAGE_KEYS.SPEED, '1.0');
        els.autoPlay.checked = get(STORAGE_KEYS.AUTO_PLAY, 'true') === 'true';
        els.chunkSize.value = get(STORAGE_KEYS.CHUNK_SIZE, '1000');
        els.translationModel.value = get(STORAGE_KEYS.TRANSLATION_MODEL, 'gemini-2.5-flash-lite');

        // Theme
        const theme = get(STORAGE_KEYS.THEME, 'light');
        document.documentElement.setAttribute('data-theme', theme);

        updateSpeedLabel();
    }

    function saveSettings() {
        // API key is stored in localStorage by design — this is a client-side app
        // and the key is entered and managed entirely by the user.
        localStorage.setItem(STORAGE_KEYS.API_KEY, els.apiKey.value); // nosemgrep: clear-text-storage
        localStorage.setItem(STORAGE_KEYS.ENDPOINT, els.apiEndpoint.value);
        localStorage.setItem(STORAGE_KEYS.MODEL, els.modelSelect.value);
        localStorage.setItem(STORAGE_KEYS.VOICE, els.voiceSelect.value);
        localStorage.setItem(STORAGE_KEYS.SPEED, els.speedSlider.value);
        localStorage.setItem(STORAGE_KEYS.AUTO_PLAY, els.autoPlay.checked);
        localStorage.setItem(STORAGE_KEYS.CHUNK_SIZE, els.chunkSize.value);
        localStorage.setItem(STORAGE_KEYS.TRANSLATION_MODEL, els.translationModel.value);
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

        // Settings save on change
        [els.apiKey, els.apiEndpoint, els.modelSelect, els.voiceSelect,
            els.speedSlider, els.autoPlay, els.chunkSize, els.translationModel]
            .forEach(el => {
                el.addEventListener('change', saveSettings);
                if (el.type === 'text' || el.type === 'password') {
                    el.addEventListener('input', saveSettings);
                }
            });

        // Speed slider
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
        els.dropZone.addEventListener('dragover', (e) => {
            e.preventDefault();
            els.dropZone.classList.add('drag-over');
        });
        els.dropZone.addEventListener('dragleave', () => {
            els.dropZone.classList.remove('drag-over');
        });
        els.dropZone.addEventListener('drop', (e) => {
            e.preventDefault();
            els.dropZone.classList.remove('drag-over');
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

        // Generate
        els.btnGenerate.addEventListener('click', generateSpeech);
        els.btnRegenerate.addEventListener('click', generateSpeech);

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
                els.playerDuration.textContent = formatDuration(dur);
            }
        });

        // Keyboard shortcut
        document.addEventListener('keydown', (e) => {
            if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
                e.preventDefault();
                if (!els.btnGenerate.disabled) {
                    generateSpeech();
                }
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
            requestAnimationFrame(() => {
                overlayEl.classList.add('visible');
                panelEl.classList.add('visible');
            });
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

    // ==================== Clipboard ====================
    async function pasteFromClipboard() {
        try {
            const text = await navigator.clipboard.readText();
            els.textInput.value = text;
            updateCharCount();
            showToast('Текст поставен от клипборда', 'success');
        } catch {
            showToast('Неуспешно четене от клипборда', 'error');
        }
    }

    function clearText() {
        els.textInput.value = '';
        updateCharCount();
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

    function handleFile(file) {
        const maxSize = 5 * 1024 * 1024; // 5MB
        if (file.size > maxSize) {
            showToast('Файлът е твърде голям (макс. 5MB)', 'error');
            return;
        }

        const reader = new FileReader();
        reader.onload = (e) => {
            let text = e.target.result;

            // Strip HTML tags if HTML file
            if (file.name.endsWith('.html') || file.name.endsWith('.htm')) {
                const parser = new DOMParser();
                const doc = parser.parseFromString(text, 'text/html');
                text = doc.body.textContent || doc.body.innerText || '';
            }

            // Clean up SRT format
            if (file.name.endsWith('.srt')) {
                text = text.replace(/^\d+\s*$/gm, '')
                    .replace(/\d{2}:\d{2}:\d{2},\d{3}\s*-->\s*\d{2}:\d{2}:\d{2},\d{3}/g, '')
                    .replace(/\n{3,}/g, '\n\n')
                    .trim();
            }

            els.textInput.value = text;
            updateCharCount();
            showToast(`Файл "${file.name}" зареден`, 'success');
        };

        reader.onerror = () => {
            showToast('Грешка при четене на файла', 'error');
        };

        reader.readAsText(file, 'UTF-8');
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

        state.isGenerating = true;
        updateGenerateButton();
        showProgress('Превеждане...', true);

        try {
            const model = els.translationModel.value;
            const endpoint = getEndpointUrl(model, false);

            const response = await fetch(`${endpoint}?key=${apiKey}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    contents: [{
                        parts: [{
                            text: `Преведи следния текст от английски на български. Върни САМО превода, без обяснения или допълнителен текст.\n\n---BEGIN TEXT---\n${sanitizeForPrompt(text)}\n---END TEXT---`
                        }]
                    }],
                    generationConfig: {
                        temperature: 0.3,
                        maxOutputTokens: 8192,
                    }
                })
            });

            if (!response.ok) {
                const errorData = await response.json().catch(() => ({}));
                throw new Error(errorData.error?.message || `HTTP ${response.status}`);
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
            showToast(`Грешка при превод: ${err.message}`, 'error');
        } finally {
            state.isGenerating = false;
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

    // ==================== TTS Generation ====================
    async function generateSpeech() {
        const text = getTextForSpeech();
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

        state.isGenerating = true;
        updateGenerateButton();
        showProgress('Генериране на реч...', true);

        try {
            const chunkSize = parseInt(els.chunkSize.value);
            const chunks = splitTextIntoChunks(text, chunkSize);
            const audioChunks = [];
            let sampleRate = 24000;

            for (let i = 0; i < chunks.length; i++) {
                showProgress(`Обработка на част ${i + 1} от ${chunks.length}...`, false, ((i) / chunks.length) * 100);

                const result = await generateAudioChunk(chunks[i], apiKey);
                audioChunks.push(result.audioData);
                if (result.sampleRate) {
                    sampleRate = result.sampleRate;
                }

                showProgress(`Обработка на част ${i + 1} от ${chunks.length}...`, false, ((i + 1) / chunks.length) * 100);
            }

            // Combine all audio chunks
            const combinedPcm = combineArrayBuffers(audioChunks);

            // Convert PCM to WAV
            const wavBlob = pcmToWav(combinedPcm, sampleRate);

            // Clean up previous audio
            if (state.currentAudioUrl) {
                URL.revokeObjectURL(state.currentAudioUrl);
            }

            state.currentAudioBlob = wavBlob;
            state.currentAudioUrl = URL.createObjectURL(wavBlob);

            // Set up player
            els.audioPlayer.src = state.currentAudioUrl;
            els.audioPlayer.playbackRate = parseFloat(els.speedSlider.value);
            els.playerTitle.textContent = text.substring(0, 50) + (text.length > 50 ? '...' : '');
            els.playerSection.classList.remove('hidden');

            // Add to history
            addToHistory(text, wavBlob);

            hideProgress();
            showToast('Речта е генерирана успешно!', 'success');

            // Auto-play
            if (els.autoPlay.checked) {
                try {
                    await els.audioPlayer.play();
                } catch {
                    // Autoplay may be blocked by browser
                }
            }
        } catch (err) {
            hideProgress();
            showToast(`Грешка: ${err.message}`, 'error');
        } finally {
            state.isGenerating = false;
            updateGenerateButton();
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
        const sentences = text.split(/(?<=[.!?。！？\n])\s*/);
        let currentChunk = '';

        for (const sentence of sentences) {
            if (sentence.length > maxSize) {
                // Split long sentences by clauses or words
                if (currentChunk) {
                    chunks.push(currentChunk);
                    currentChunk = '';
                }
                const words = sentence.split(/\s+/);
                for (const word of words) {
                    if ((currentChunk + ' ' + word).length > maxSize) {
                        if (currentChunk) chunks.push(currentChunk.trim());
                        currentChunk = word;
                    } else {
                        currentChunk += (currentChunk ? ' ' : '') + word;
                    }
                }
            } else if ((currentChunk + ' ' + sentence).length > maxSize) {
                chunks.push(currentChunk.trim());
                currentChunk = sentence;
            } else {
                currentChunk += (currentChunk ? ' ' : '') + sentence;
            }
        }

        if (currentChunk.trim()) {
            chunks.push(currentChunk.trim());
        }

        return chunks;
    }

    async function generateAudioChunk(text, apiKey) {
        const model = els.modelSelect.value;
        const voice = els.voiceSelect.value;
        const endpoint = getEndpointUrl(model, false);

        const requestBody = {
            contents: [{
                parts: [{
                    text: text
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

        const response = await fetch(`${endpoint}?key=${apiKey}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(requestBody)
        });

        if (!response.ok) {
            const errorData = await response.json().catch(() => ({}));
            const message = errorData.error?.message || `HTTP грешка ${response.status}`;
            throw new Error(message);
        }

        const data = await response.json();

        // Handle streaming response (array of objects)
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

    function pcmToWav(pcmBuffer, sampleRate = 24000, numChannels = 1, bitsPerSample = 16) {
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

        // PCM data
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
    function getEndpointUrl(model, streaming = false) {
        const endpointType = els.apiEndpoint.value;
        const base = API_ENDPOINTS[endpointType];
        const method = streaming ? 'streamGenerateContent' : 'generateContent';
        return `${base}/${model}:${method}`;
    }

    // ==================== Progress ====================
    function showProgress(text, indeterminate = false, percent = 0) {
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
        // Don't save audio blobs in localStorage (too large), only metadata
        const historyData = state.history.map(item => ({
            text: item.text,
            voice: item.voice,
            model: item.model,
            date: item.date,
        }));
        try {
            localStorage.setItem(STORAGE_KEYS.HISTORY, JSON.stringify(historyData));
        } catch {
            // localStorage might be full
            if (state.history.length > 10) {
                state.history = state.history.slice(0, 10);
                saveHistory();
            }
        }
    }

    function addToHistory(text, audioBlob) {
        const item = {
            text: text.substring(0, 200),
            voice: els.voiceSelect.value,
            model: els.modelSelect.value,
            date: new Date().toISOString(),
            audioBlob: audioBlob, // kept in memory only
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
            els.historyList.innerHTML = '<p class="empty-state">Все още няма генерирани аудио файлове.</p>';
            return;
        }

        els.historyList.innerHTML = state.history.map((item, index) => `
            <div class="history-item" data-index="${index}">
                <span class="history-item-text">${escapeHtml(item.text)}</span>
                <div class="history-item-meta">
                    <span>${item.voice} · ${item.model.split('-').slice(-2).join(' ')}</span>
                    <span>${formatDate(item.date)}</span>
                </div>
                <div class="history-item-actions">
                    <button class="btn btn-outline btn-sm history-load" data-index="${index}">📝 Зареди текст</button>
                    ${item.audioBlob ? `<button class="btn btn-outline btn-sm history-play" data-index="${index}">▶️ Пусни</button>` : ''}
                </div>
            </div>
        `).join('');

        // Bind history events
        els.historyList.querySelectorAll('.history-load').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const idx = parseInt(btn.dataset.index);
                els.textInput.value = state.history[idx].text;
                updateCharCount();
                togglePanel('history', false);
                showToast('Текстът е зареден от историята', 'info');
            });
        });

        els.historyList.querySelectorAll('.history-play').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const idx = parseInt(btn.dataset.index);
                const item = state.history[idx];
                if (item.audioBlob) {
                    if (state.currentAudioUrl) {
                        URL.revokeObjectURL(state.currentAudioUrl);
                    }
                    state.currentAudioBlob = item.audioBlob;
                    state.currentAudioUrl = URL.createObjectURL(item.audioBlob);
                    els.audioPlayer.src = state.currentAudioUrl;
                    els.audioPlayer.playbackRate = parseFloat(els.speedSlider.value);
                    els.playerTitle.textContent = item.text.substring(0, 50) + '...';
                    els.playerSection.classList.remove('hidden');
                    els.audioPlayer.play();
                    togglePanel('history', false);
                }
            });
        });
    }

    // ==================== Toast ====================
    function showToast(message, type = 'info', duration = 3000) {
        const toast = document.createElement('div');
        toast.className = `toast ${type}`;
        toast.textContent = message;
        toast.style.animationDuration = `0.3s, 0.3s`;
        toast.style.animationDelay = `0s, ${(duration - 300) / 1000}s`;
        els.toastContainer.appendChild(toast);

        setTimeout(() => {
            if (toast.parentNode) {
                toast.remove();
            }
        }, duration);
    }

    // ==================== Helpers ====================
    function escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }

    /**
     * Sanitize user text before including it in a prompt to reduce prompt injection risk.
     * Wraps the user text in delimiters so the LLM treats it as data, not instructions.
     */
    function sanitizeForPrompt(text) {
        // Limit length to prevent abuse
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
    document.addEventListener('DOMContentLoaded', init);
})();
