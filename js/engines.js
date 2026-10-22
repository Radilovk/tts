// Voice engines.
//   device — the phone's own TTS (free, offline)
//   cloud  — Google Cloud Text-to-Speech, Chirp 3 HD voices (1M free chars/month)
//   gemini — Gemini TTS, steerable "narrator" intonation (paid per audio token)

import { LOCALES } from './text.js';

export const GEMINI_VOICES = [
    ['Kore', 'жен., уверен'], ['Aoede', 'жен., лек'], ['Leda', 'жен., младежки'], ['Zephyr', 'жен., ярък'],
    ['Callirrhoe', 'жен., спокоен'], ['Autonoe', 'жен., ясен'], ['Despina', 'жен., топъл'], ['Erinome', 'жен., ясен'],
    ['Laomedeia', 'жен., жизнен'], ['Achernar', 'жен., мек'], ['Gacrux', 'жен., зрял'], ['Pulcherrima', 'жен., открит'],
    ['Vindemiatrix', 'жен., нежен'], ['Sulafat', 'жен., топъл'],
    ['Charon', 'мъж., разказвач'], ['Puck', 'мъж., жив'], ['Fenrir', 'мъж., вълнуващ'], ['Orus', 'мъж., твърд'],
    ['Enceladus', 'мъж., приглушен'], ['Iapetus', 'мъж., ясен'], ['Umbriel', 'мъж., спокоен'], ['Algieba', 'мъж., мек'],
    ['Algenib', 'мъж., дрезгав'], ['Rasalgethi', 'мъж., вещ'], ['Alnilam', 'мъж., твърд'], ['Schedar', 'мъж., равен'],
    ['Achird', 'мъж., приятелски'], ['Zubenelgenubi', 'мъж., непринуден'], ['Sadachbia', 'мъж., жив'], ['Sadaltager', 'мъж., вещ'],
];

export const GEMINI_DEFAULT_MODEL = 'gemini-2.5-flash-preview-tts';

export const NARRATION_STYLES = {
    intriguing: {
        label: 'Интригуващ',
        bg: 'Прочети като завладяващ разказвач на аудиокниги: жива, естествена интонация, лека интрига и напрежение там, където сюжетът го иска, кратки паузи преди важните моменти. Репликите на героите предавай с лека промяна в тона, без да преиграваш. Не добавяй и не пропускай думи',
        en: 'Read as a captivating audiobook narrator: lively, natural intonation, a touch of suspense where the story calls for it, brief pauses before key moments. Give the characters’ lines a slight change of tone without overacting. Do not add or skip words',
    },
    warm: {
        label: 'Топъл',
        bg: 'Прочети с топъл, спокоен и уютен глас, като разказвач, който чете любима книга на близък човек. Естествен ритъм, меки паузи. Не добавяй и не пропускай думи',
        en: 'Read in a warm, calm and cosy voice, like a narrator reading a beloved book to someone close. Natural rhythm, soft pauses. Do not add or skip words',
    },
    dramatic: {
        label: 'Драматичен',
        bg: 'Прочети драматично и изразително, като актьор в радиотеатър: ясно изразени емоции, динамика в темпото, напрежение в кулминациите и различен тон за отделните герои. Не добавяй и не пропускай думи',
        en: 'Read dramatically and expressively, like an actor in a radio play: clear emotions, dynamic pacing, tension at climaxes and a distinct tone for each character. Do not add or skip words',
    },
    clear: {
        label: 'Ясен',
        bg: 'Прочети ясно, спокойно и с равномерно темпо, с естествена интонация — подходящо за научнопопулярна книга. Не добавяй и не пропускай думи',
        en: 'Read clearly and calmly at an even pace with natural intonation, suited to non-fiction. Do not add or skip words',
    },
};

// Approximate list prices (USD) used only for the cost estimate shown to the user.
export const PRICES = {
    cloud: {
        // per 1M characters, monthly free characters
        'Chirp3-HD': { per1M: 30, free: 1_000_000, label: 'Chirp 3 HD' },
        Neural2: { per1M: 16, free: 1_000_000, label: 'Neural2' },
        Wavenet: { per1M: 4, free: 4_000_000, label: 'WaveNet' },
        Standard: { per1M: 4, free: 4_000_000, label: 'Standard' },
        Studio: { per1M: 160, free: 1_000_000, label: 'Studio' },
        Other: { per1M: 16, free: 0, label: 'Друг' },
    },
    gemini: { inPer1M: 0.5, outPer1M: 10, tokensPerSecond: 25 },
};

export function cloudTier(voiceName = '') {
    for (const k of ['Chirp3-HD', 'Neural2', 'Wavenet', 'Standard', 'Studio']) {
        if (voiceName.includes(k)) return k;
    }
    return 'Other';
}

class ApiError extends Error {
    constructor(message, status, retryable) {
        super(message);
        this.status = status;
        this.retryable = retryable;
    }
}

async function fetchJson(url, options, timeoutMs, signal) {
    const ctrl = new AbortController();
    const onAbort = () => ctrl.abort();
    signal?.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
        const res = await fetch(url, { ...options, signal: ctrl.signal });
        let data = null;
        try { data = await res.json(); } catch {}
        if (!res.ok) {
            const msg = data?.error?.message || `HTTP ${res.status}`;
            throw new ApiError(friendlyError(res.status, msg), res.status, res.status === 429 || res.status >= 500);
        }
        return data;
    } catch (e) {
        if (e instanceof ApiError) throw e;
        if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
        if (e.name === 'AbortError') throw new ApiError('Сървърът не отговори навреме.', 0, true);
        throw new ApiError(navigator.onLine ? 'Мрежова грешка.' : 'Няма интернет връзка.', 0, true);
    } finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
    }
}

function friendlyError(status, msg) {
    if (/API key not valid|API_KEY_INVALID/i.test(msg)) return 'Невалиден API ключ.';
    if (/has not been used|is disabled|SERVICE_DISABLED/i.test(msg)) {
        return 'Cloud Text-to-Speech API не е включен за този ключ. Включете го в Google Cloud Console.';
    }
    if (/billing/i.test(msg)) return 'За Google Cloud TTS трябва да е активирано плащане (безплатните 1M знака остават безплатни).';
    if (status === 429) return 'Достигнат лимит на заявките. Опитвам отново…';
    if (status === 403) return 'Достъпът е отказан: ' + msg;
    return msg;
}

async function withRetry(fn, signal, tries = 3) {
    let lastErr;
    for (let i = 0; i < tries; i++) {
        try { return await fn(); } catch (e) {
            lastErr = e;
            if (e.name === 'AbortError' || !e.retryable || i === tries - 1) throw e;
            const wait = e.status === 429 ? 8000 * (i + 1) : 1500 * 2 ** i;
            await new Promise((r, j) => {
                const t = setTimeout(r, wait);
                signal?.addEventListener('abort', () => { clearTimeout(t); j(new DOMException('Cancelled', 'AbortError')); }, { once: true });
            });
        }
    }
    throw lastErr;
}

function base64ToBytes(b64) {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
}

// ---------- Google Cloud TTS ----------

const CLOUD_BASE = 'https://texttospeech.googleapis.com/v1';

export const cloudAudioFormat = (() => {
    const a = document.createElement('audio');
    return a.canPlayType('audio/ogg; codecs="opus"') ? { enc: 'OGG_OPUS', mime: 'audio/ogg' } : { enc: 'MP3', mime: 'audio/mpeg' };
})();

export async function cloudVoices(apiKey, lang) {
    const locale = LOCALES[lang] || lang;
    const data = await fetchJson(`${CLOUD_BASE}/voices?languageCode=${encodeURIComponent(locale)}&key=${encodeURIComponent(apiKey)}`, {}, 20000);
    const order = ['Chirp3-HD', 'Neural2', 'Wavenet', 'Standard', 'Studio', 'Other'];
    return (data.voices || [])
        .filter((v) => v.languageCodes.some((c) => c.toLowerCase().startsWith(lang)))
        .filter((v) => !/Chirp-HD|Polyglot|News|Casual/.test(v.name) || v.name.includes('Chirp3-HD'))
        .map((v) => ({ name: v.name, gender: v.ssmlGender, tier: cloudTier(v.name), locale: v.languageCodes[0] }))
        .sort((a, b) => order.indexOf(a.tier) - order.indexOf(b.tier) || a.name.localeCompare(b.name));
}

export async function cloudSynthesize({ apiKey, text, voice, locale, signal }) {
    const body = {
        input: { text },
        voice: { languageCode: locale, name: voice },
        audioConfig: { audioEncoding: cloudAudioFormat.enc },
    };
    const data = await withRetry(() => fetchJson(`${CLOUD_BASE}/text:synthesize?key=${encodeURIComponent(apiKey)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    }, 60000, signal), signal);
    if (!data?.audioContent) throw new ApiError('Не е получено аудио.', 0, true);
    return { blob: new Blob([base64ToBytes(data.audioContent)], { type: cloudAudioFormat.mime }), chars: text.length };
}

// ---------- Gemini TTS ----------

const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta';

export async function geminiModels(apiKey) {
    const data = await fetchJson(`${GEMINI_BASE}/models?pageSize=200&key=${encodeURIComponent(apiKey)}`, {}, 20000);
    return (data.models || [])
        .map((m) => m.name.replace(/^models\//, ''))
        .filter((n) => /tts/i.test(n))
        .sort((a, b) => (b.includes('flash') - a.includes('flash')) || b.localeCompare(a));
}

export function geminiPrompt(text, style, lang, customStyle) {
    const s = NARRATION_STYLES[style] || NARRATION_STYLES.intriguing;
    const directive = (style === 'custom' && customStyle?.trim()) || (lang === 'bg' ? s.bg : s.en);
    const langNote = lang === 'bg' ? ' Текстът е на български — използвай естествено българско произношение и ударения.' : '';
    return `${directive}.${langNote}\n\n${text}`;
}

export async function geminiSynthesize({ apiKey, model, text, voice, style, customStyle, lang, signal }) {
    const body = {
        contents: [{ parts: [{ text: geminiPrompt(text, style, lang, customStyle) }] }],
        generationConfig: {
            responseModalities: ['AUDIO'],
            speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } },
        },
    };
    const data = await withRetry(() => fetchJson(`${GEMINI_BASE}/models/${model}:generateContent?key=${encodeURIComponent(apiKey)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    }, 180000, signal), signal);
    const part = data?.candidates?.[0]?.content?.parts?.find((p) => p.inlineData?.data);
    if (!part) {
        const reason = data?.candidates?.[0]?.finishReason;
        throw new ApiError(reason === 'SAFETY' || reason === 'PROHIBITED_CONTENT'
            ? 'Gemini отказа да прочете този откъс (филтър за съдържание).'
            : 'Gemini не върна аудио.', 0, reason !== 'SAFETY');
    }
    const rate = Number((part.inlineData.mimeType || '').match(/rate=(\d+)/)?.[1] || 24000);
    const pcm = base64ToBytes(part.inlineData.data);
    const usage = data.usageMetadata || {};
    return {
        blob: pcmToWav(trimSilence(pcm, rate), rate),
        inTokens: usage.promptTokenCount || 0,
        outTokens: usage.candidatesTokenCount || Math.round(pcm.length / 2 / rate * PRICES.gemini.tokensPerSecond),
    };
}

// Trim long leading/trailing silence (keeps ~0.25 s so chunks join naturally).
function trimSilence(bytes, rate) {
    const view = new Int16Array(bytes.buffer, bytes.byteOffset, Math.floor(bytes.length / 2));
    const threshold = 400;
    const keep = Math.round(rate * 0.25);
    let start = 0, end = view.length - 1;
    while (start < view.length && Math.abs(view[start]) < threshold) start++;
    while (end > start && Math.abs(view[end]) < threshold) end--;
    start = Math.max(0, start - keep);
    end = Math.min(view.length, end + keep);
    return view.slice(start, end);
}

function pcmToWav(int16, rate) {
    const dataLen = int16.length * 2;
    const buf = new ArrayBuffer(44 + dataLen);
    const v = new DataView(buf);
    const str = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
    str(0, 'RIFF'); v.setUint32(4, 36 + dataLen, true); str(8, 'WAVE');
    str(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
    v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
    str(36, 'data'); v.setUint32(40, dataLen, true);
    new Int16Array(buf, 44).set(int16);
    return new Blob([buf], { type: 'audio/wav' });
}

// ---------- Device (Web Speech API) ----------

export function deviceVoices(lang) {
    if (!('speechSynthesis' in window)) return [];
    const all = speechSynthesis.getVoices();
    const match = all.filter((v) => v.lang.toLowerCase().replace('_', '-').startsWith(lang));
    // Prefer the higher quality network/neural voices first
    const rank = (v) => (/natural|neural|online|enhanced|premium|google/i.test(v.name) ? 0 : 1) + (v.localService ? 0.5 : 0);
    return match.sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
}

export function onDeviceVoicesChanged(cb) {
    if ('speechSynthesis' in window) speechSynthesis.addEventListener('voiceschanged', cb);
}
