// Voice engines.
//   device — the phone's own TTS (free, offline)
//   cloud  — Google Cloud Text-to-Speech, Chirp 3 HD voices (1M free chars/month)
//   gemini — Gemini TTS, steerable "narrator" intonation (paid per audio token)

import { LOCALES } from './text.js';
import { encodeOpus } from './opus.js';
import { isNative, nativeVoices, nativeVoiceLabel, onNativeVoices } from './native.js';

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

// Gemini TTS list prices in USD per 1M tokens (text in / audio out), by model family.
// Date-aware: Gemini 3.8 Flash TTS is discounted until the end of 2026.
// Source: ai.google.dev/gemini-api/docs/pricing — check there when prices change.
export function geminiPrice(model, date = new Date()) {
    const m = model || '';
    if (/3\.8-flash/.test(m)) return date < new Date('2027-01-01T00:00:00Z') ? { in: 0.5, out: 9 } : { in: 0.5, out: 18 };
    if (/2\.5-flash/.test(m)) return { in: 0.5, out: 10 };
    if (/3\.1-flash/.test(m)) return { in: 1, out: 20 };
    if (/2\.5-pro/.test(m)) return { in: 1, out: 20 };
    if (/pro/.test(m)) return { in: 1, out: 20, guess: true };
    return { in: 0.5, out: 10, guess: true };
}

export function geminiCost(model, inTokens, outTokens, batch = false) {
    const p = geminiPrice(model);
    return (inTokens * p.in + outTokens * p.out) / 1e6 * (batch ? 0.5 : 1);
}

// Models confirmed to treat the style line as direction (not read it aloud).
// Others can still be chosen by hand in the settings.
const VERIFIED_TTS = /^gemini-2\.5-flash(-preview)?-tts/;

export function isVerifiedGeminiModel(model) {
    return VERIFIED_TTS.test(model || '');
}

// The cheapest verified TTS model the key can use
export function cheapestGeminiModel(models) {
    const usable = (models || []).filter((m) => isVerifiedGeminiModel(m));
    return usable.sort((a, b) => geminiPrice(a).out - geminiPrice(b).out || b.localeCompare(a))[0] || GEMINI_DEFAULT_MODEL;
}

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
    constructor(message, status, retryable, info = {}) {
        super(message);
        this.status = status;
        this.retryable = retryable;
        this.reason = info.reason || '';
        this.project = info.project || '';
        this.fixUrl = info.fixUrl || '';
    }
}

// Pull the machine-readable cause out of a Google API error: the reason code,
// the project number behind the key and the console link that fixes it.
function errorInfo(data) {
    const err = data?.error || {};
    const msg = err.message || '';
    const details = err.details || [];
    const info = details.find((d) => /ErrorInfo/.test(d['@type'] || '')) || {};
    let reason = info.reason || '';
    if (!reason) {
        if (/API key not valid/i.test(msg)) reason = 'API_KEY_INVALID';
        else if (/billing/i.test(msg)) reason = 'BILLING_DISABLED';
        else if (/has not been used|is disabled/i.test(msg)) reason = 'SERVICE_DISABLED';
        else if (/are blocked/i.test(msg)) reason = 'API_KEY_SERVICE_BLOCKED';
        else if (/referer|referrer/i.test(msg)) reason = 'API_KEY_HTTP_REFERRER_BLOCKED';
    }
    const project = String(info.metadata?.consumer || '').replace('projects/', '') ||
        (msg.match(/project(?:\s*#|\s)\s*(\d+)/i) || [])[1] || '';
    const help = details.find((d) => /Help/.test(d['@type'] || ''))?.links?.[0]?.url || '';
    const inMsg = (msg.match(/https:\/\/console\.[^\s"]+/) || [])[0]?.replace(/[.,)]+$/, '') || '';
    return { reason, project, fixUrl: info.metadata?.activationUrl || inMsg || help };
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
            const info = errorInfo(data);
            throw new ApiError(friendlyError(res.status, msg, info.reason), res.status, res.status === 429 || res.status >= 500, info);
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

function friendlyError(status, msg, reason) {
    switch (reason) {
        case 'API_KEY_INVALID': return 'Невалиден API ключ.';
        case 'SERVICE_DISABLED': return 'Google HD гласовете не са включени за този ключ.';
        case 'BILLING_DISABLED': return 'Google HD изисква свързан профил за плащане (първият 1M знака месечно остава безплатен).';
        case 'API_KEY_SERVICE_BLOCKED': return 'Ключът е ограничен и не позволява Text-to-Speech.';
        case 'API_KEY_HTTP_REFERRER_BLOCKED': return 'Ключът не е разрешен за този сайт.';
    }
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

// MP3 plays everywhere (Opera, Huawei WebView, Safari); size is about the same as Opus here.
export const cloudAudioFormat = { enc: 'MP3', mime: 'audio/mpeg' };

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

export const CLOUD_LINKS = {
    aiStudioKey: 'https://aistudio.google.com/apikey',
    enableApi: (p) => `https://console.cloud.google.com/apis/library/texttospeech.googleapis.com${p ? '?project=' + p : ''}`,
    billing: (p) => `https://console.cloud.google.com/billing/linkedaccount${p ? '?project=' + p : ''}`,
    credentials: (p) => `https://console.cloud.google.com/apis/credentials${p ? '?project=' + p : ''}`,
    budgets: 'https://console.cloud.google.com/billing/budgets',
};

const DIAG_SAMPLE = {
    bg: 'Готово. Така ще звучи вашата книга.',
    en: 'All set. This is how your book will sound.',
};

// Walk through everything Google HD needs and report the first missing piece:
//   key -> Text-to-Speech API enabled -> billing linked.
// Each step: 'ok' | 'fail' | 'wait'. A failing step carries the console link
// for *this key's* project, so the user lands on exactly the right page.
export async function cloudDiagnose(apiKey, lang = 'bg') {
    const r = { key: 'wait', api: 'wait', billing: 'wait', failed: null, message: '', fixUrl: '', project: '', voices: null, voice: '', sample: null };
    if (!apiKey) {
        Object.assign(r, { key: 'fail', failed: 'key', message: 'Добавете API ключ.', fixUrl: CLOUD_LINKS.aiStudioKey });
        return r;
    }
    const fail = (e) => {
        r.project = e.project || '';
        const p = r.project;
        switch (e.reason) {
            case 'API_KEY_INVALID':
                return Object.assign(r, { key: 'fail', failed: 'key', message: 'Ключът е невалиден — копирайте го отново.', fixUrl: CLOUD_LINKS.aiStudioKey });
            case 'API_KEY_HTTP_REFERRER_BLOCKED':
                return Object.assign(r, { key: 'fail', failed: 'key', message: `Ключът не позволява сайта ${location.host}. Добавете го към разрешените адреси на ключа.`, fixUrl: CLOUD_LINKS.credentials(p) });
            case 'SERVICE_DISABLED':
                return Object.assign(r, { key: 'ok', api: 'fail', failed: 'api', message: 'Натиснете „Включи“ на страницата, която ще се отвори, после се върнете тук.', fixUrl: e.fixUrl || CLOUD_LINKS.enableApi(p) });
            case 'API_KEY_SERVICE_BLOCKED':
                return Object.assign(r, { key: 'ok', api: 'fail', failed: 'api', message: 'Ключът е ограничен само за някои услуги. Отворете ключа и добавете „Cloud Text-to-Speech API“ към разрешените (или махнете ограничението за API).', fixUrl: CLOUD_LINKS.credentials(p) });
            case 'BILLING_DISABLED':
                return Object.assign(r, { key: 'ok', api: 'ok', billing: 'fail', failed: 'billing', message: 'Свържете профил за плащане към проекта. Google не таксува до 1M знака месечно (~20 ч слушане).', fixUrl: (e.fixUrl && /billing/.test(e.fixUrl)) ? e.fixUrl : CLOUD_LINKS.billing(p) });
            default:
                return Object.assign(r, { failed: r.key === 'ok' ? (r.api === 'ok' ? 'billing' : 'api') : 'key', message: e.message || 'Неизвестна грешка.' });
        }
    };
    try {
        let voices = await cloudVoices(apiKey, lang);
        r.key = 'ok';
        r.api = 'ok';
        r.voices = voices;
        if (!voices.length) voices = await cloudVoices(apiKey, 'en');
        const v = voices.find((x) => x.tier === 'Chirp3-HD' && /Charon|Kore|Aoede/.test(x.name)) || voices.find((x) => x.tier === 'Chirp3-HD') || voices[0];
        if (!v) return Object.assign(r, { failed: 'api', api: 'fail', message: 'Google не върна гласове.' });
        const text = DIAG_SAMPLE[v.locale.slice(0, 2)] || DIAG_SAMPLE.en;
        const { blob } = await cloudSynthesize({ apiKey, text, voice: v.name, locale: v.locale });
        r.billing = 'ok';
        r.voice = v.name;
        r.sample = blob;
        r.sampleChars = text.length;
        return r;
    } catch (e) {
        if (e.name === 'AbortError') throw e;
        return fail(e);
    }
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

// How a native audiobook narrator sounds in each language (stress, melody, pace).
// Kept short: the narrator follows it, and it is never part of the read text.
const LANGUAGE_NOTES = {
    bg: 'Текстът е на български — използвай естествено българско произношение, правилни ударения и мелодия на изречението, както при професионален български разказвач',
    en: 'The text is in English — use natural native English pronunciation, stress and sentence melody, like a professional audiobook narrator',
    ru: 'The text is in Russian — read it in Russian with native pronunciation, correct word stress and natural Russian intonation, like a professional Russian audiobook narrator',
    uk: 'The text is in Ukrainian — read it in Ukrainian with native pronunciation, correct stress and natural Ukrainian intonation',
    sr: 'The text is in Serbian — read it in Serbian with native pronunciation, correct pitch accent and natural Serbian intonation',
    de: 'The text is in German — read it in German with native pronunciation and natural German sentence melody, like a professional German Hörbuch narrator',
    fr: 'The text is in French — read it in French with native pronunciation, liaisons and natural French intonation, like a professional French livre audio narrator',
    es: 'The text is in Spanish — read it in Spanish with native pronunciation and natural Spanish intonation, like a professional Spanish audiolibro narrator',
    it: 'The text is in Italian — read it in Italian with native pronunciation and natural Italian intonation, like a professional Italian audiolibro narrator',
};

// Every passage is a separate request and the model remembers nothing between them,
// so each one is told it continues one long recording in the same voice and pace.
const CONTINUITY = {
    bg: 'Това е откъс от един непрекъснат запис на аудиокнига: запази същия глас, тембър, височина, сила и темпо от първата до последната дума, без да започваш наново с различна енергия',
    en: 'This is a passage from one continuous audiobook recording: keep the same voice, timbre, pitch, loudness and pace from the first word to the last, without starting afresh with different energy',
};

export function geminiPrompt(text, style, lang, customStyle) {
    const s = NARRATION_STYLES[style] || NARRATION_STYLES.intriguing;
    const directive = (style === 'custom' && customStyle?.trim()) || (lang === 'bg' ? s.bg : s.en);
    const note = LANGUAGE_NOTES[lang];
    const cont = lang === 'bg' ? CONTINUITY.bg : CONTINUITY.en;
    return `${directive}.${note ? ' ' + note + '.' : ''} ${cont}.\n\n${text}`;
}

// A fixed seed and a slightly lower temperature make passages sound alike. Below ~0.5
// the TTS models are reported to return no audio, so 0.7 stays on the safe side.
const STEADY = { temperature: 0.7, seed: 1234 };
const STEADY_FLAG = 'rz_gemini_steady';

function steadyState() {
    try { return localStorage.getItem(STEADY_FLAG) || ''; } catch { return ''; }
}

function setSteadyState(v) {
    try { localStorage.setItem(STEADY_FLAG, v); } catch {}
}

// steady: null = use it only if the API has already accepted it (batch requests,
// which cannot be retried one by one)
export function geminiRequestBody({ text, voice, style, customStyle, lang, steady = null }) {
    const use = steady ?? steadyState() === 'ok';
    return {
        contents: [{ parts: [{ text: geminiPrompt(text, style, lang, customStyle) }] }],
        generationConfig: {
            responseModalities: ['AUDIO'],
            speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } },
            ...(use ? STEADY : {}),
        },
    };
}

// Turn a generateContent response (interactive or from a batch) into compact audio:
// Ogg/Opus when the browser can encode it (~12× smaller), WAV otherwise.
export async function geminiParseAudio(data) {
    const part = data?.candidates?.[0]?.content?.parts?.find((p) => p.inlineData?.data);
    if (!part) {
        const reason = data?.candidates?.[0]?.finishReason;
        throw new ApiError(reason === 'SAFETY' || reason === 'PROHIBITED_CONTENT'
            ? 'Gemini отказа да прочете този откъс (филтър за съдържание).'
            : 'Gemini не върна аудио.', 0, reason !== 'SAFETY');
    }
    const rate = Number((part.inlineData.mimeType || '').match(/rate=(\d+)/)?.[1] || 24000);
    const pcm = base64ToBytes(part.inlineData.data);
    const trimmed = levelLoudness(trimSilence(pcm, rate));
    const usage = data.usageMetadata || {};
    return {
        blob: (await encodeOpus(trimmed, rate)) || pcmToWav(trimmed, rate),
        dur: trimmed.length / rate,
        inTokens: usage.promptTokenCount || 0,
        outTokens: usage.candidatesTokenCount || Math.round(pcm.length / 2 / rate * PRICES.gemini.tokensPerSecond),
    };
}

// retry429=false lets the caller switch keys at once when a free daily quota runs out.
export async function geminiSynthesize({ apiKey, model, text, voice, style, customStyle, lang, signal, retry429 = true }) {
    const send = async (steady) => {
        const body = geminiRequestBody({ text, voice, style, customStyle, lang, steady });
        const call = () => fetchJson(`${GEMINI_BASE}/models/${model}:generateContent?key=${encodeURIComponent(apiKey)}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        }, 180000, signal);
        return retry429 ? withRetry(call, signal) : call();
    };
    const steady = steadyState() !== 'off';
    let data;
    try {
        data = await send(steady);
        if (steady && steadyState() !== 'ok') setSteadyState('ok');
    } catch (e) {
        // The model does not take seed/temperature: remember that and read without them
        if (!steady || e.status !== 400) throw e;
        setSteadyState('off');
        data = await send(false);
    }
    return geminiParseAudio(data);
}

// ---------- Gemini Batch API (half price, finished within minutes to hours) ----------

export async function geminiBatchSubmit({ apiKey, model, items, name }) {
    const body = {
        batch: {
            display_name: name,
            input_config: { requests: { requests: items.map((it) => ({ request: it.request, metadata: { key: it.key } })) } },
        },
    };
    const data = await fetchJson(`${GEMINI_BASE}/models/${model}:batchGenerateContent?key=${encodeURIComponent(apiKey)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    }, 60000);
    if (!data?.name) throw new ApiError('Gemini не прие партидата.', 0, false);
    return data.name;
}

export async function geminiBatchGet(apiKey, name) {
    const data = await fetchJson(`${GEMINI_BASE}/${name}?key=${encodeURIComponent(apiKey)}`, {}, 120000);
    const meta = data.metadata || {};
    const state = meta.state || data.state || '';
    const box = data.response?.inlinedResponses || meta.output?.inlinedResponses || data.output?.inlinedResponses || {};
    const list = Array.isArray(box) ? box : (box.inlinedResponses || []);
    const done = !!data.done || /SUCCEEDED|FAILED|CANCELLED|EXPIRED/.test(state);
    return {
        state,
        done,
        ok: done && !/FAILED|CANCELLED|EXPIRED/.test(state) && !data.error,
        error: data.error?.message || '',
        responses: list.map((r) => ({ key: r.metadata?.key, response: r.response, error: r.error?.message })),
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

// Bring every passage to the same speech loudness, so one is never louder or quieter
// than the one before. Only voiced samples are measured; peaks are softly limited.
const TARGET_RMS = 3300; // ≈ -20 dBFS
function levelLoudness(view) {
    let sum = 0, n = 0;
    for (let i = 0; i < view.length; i += 4) {
        const x = view[i];
        if (x > 500 || x < -500) { sum += x * x; n++; }
    }
    if (n < 1000) return view;
    const gain = Math.max(0.6, Math.min(2.2, TARGET_RMS / Math.sqrt(sum / n)));
    if (Math.abs(gain - 1) < 0.05) return view;
    const out = new Int16Array(view.length);
    const knee = 24000;
    for (let i = 0; i < view.length; i++) {
        let y = view[i] * gain;
        const a = Math.abs(y);
        if (a > knee) y = Math.sign(y) * (knee + (32767 - knee) * Math.tanh((a - knee) / (32767 - knee)));
        out[i] = y;
    }
    return out;
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
    if (isNative) {
        // Android: every installed voice of every engine, best quality first
        return nativeVoices()
            .filter((v) => v.language === lang || v.locale.toLowerCase().startsWith(lang))
            .sort((a, b) => b.quality - a.quality || Number(a.network) - Number(b.network) || a.name.localeCompare(b.name))
            .map((v, i) => ({ voiceURI: v.name, name: nativeVoiceLabel(v, i), lang: v.locale, localService: !v.network, native: true }));
    }
    if (!('speechSynthesis' in window)) return [];
    const all = speechSynthesis.getVoices();
    const match = all.filter((v) => v.lang.toLowerCase().replace('_', '-').startsWith(lang));
    // Prefer the higher quality network/neural voices first
    const rank = (v) => (/natural|neural|online|enhanced|premium|google/i.test(v.name) ? 0 : 1) + (v.localService ? 0.5 : 0);
    return match.sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
}

export function onDeviceVoicesChanged(cb) {
    if (isNative) onNativeVoices(cb);
    else if ('speechSynthesis' in window) speechSynthesis.addEventListener('voiceschanged', cb);
}
