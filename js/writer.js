// The writer: a Gemini text model writes the narration before it is voiced.
//   mode 'topic'   — only a topic or a line of thought is given; the text is written from it
//   mode 'rewrite' — a source text is given; it is retold following the scenario
// Both follow the scenario (js/scenario.js, editable) and aim at its length (≥ 25 000
// characters). Models write far shorter than asked when asked for everything at once,
// so the text is written in parts: first a plan (the scenario's acts, each with its
// share of the length and, for a topic, checked facts from Google Search), then each
// act in turn, with the end of the text so far, so it reads as one story. Short acts
// are expanded until the whole reaches the length.
// Works in the browser and in Node (scripts/narrate.mjs --topic / --rewrite).

import { fetchJson, withRetry } from './engines.js';
import { SCENARIO } from './scenario.js';

const BASE = 'https://generativelanguage.googleapis.com/v1beta';

// How a text must be written so a voice reads it smoothly (Chirp 3 HD / Azure read
// exactly what they get: an abbreviation, a bracket or a symbol breaks the melody).
export const SPOKEN_RULES = `ПРАВИЛА ЗА ЗАПИС ЗА ГЛАС (текстът ще бъде прочетен от синтезиран глас дума по дума):
- Само изречения в абзаци. Без заглавия, списъци, номерации, таблици, Markdown, емоджита, бележки под линия.
- Изреченията — ясни, най-много около 25–30 думи; дългото изречение се разделя на две. Без вложени подчинени изречения едно в друго.
- Без скоби. Пояснението в скоба става отделно изречение или се вплита със запетаи.
- Без съкращения: „т.е.“ → „тоест“, „напр.“ → „например“, „и др.“ → „и други“, „в.“ → „век“, „г.“ → „година“, „млн.“ → „милиона“, „млрд.“ → „милиарда“, „хил.“ → „хиляди“, „проф.“ → „професор“, „д-р“ → „доктор“.
- Без символи: „%“ → „процента“, „°C“ → „градуса по Целзий“, „=“, „+“, „→“, „/“, „&“ се изписват с думи.
- Мерните единици с думи: „км“ → „километра“, „кг“ → „килограма“, „м/с“ → „метра в секунда“, „нм“ → „нанометра“.
- Числата — както се изговарят естествено. Много големи или много малки числа се закръгляват и изписват с думи („около сто милиарда неврона“), формули и уравнения се описват с думи, без да се изписват.
- Латинските и чуждите имена — на кирилица, както се произнасят на български (Хелмхолц, Кахнеман); латински термини само ако са утвърдени и тогава на кирилица.
- Препратки към литература, години в скоби, URL адреси и цитиране на източници не се пишат.
- Пряката реч — без тирета в началото на реда; „казва той“ се вплита в изречението.
- Кавички, тирета и точка и запетая — пестеливо; повтарящи се „и“, „но“ в началото на изреченията се избягват.`;
export const WRITER_FALLBACK = 'gemini-3.6-flash';   // 2.5 Flash is deprecated (routed elsewhere from 1.12.2026)
const SKIP = /lite|tts|image|live|audio|embed|thinking|exp|learnlm|robotics|computer|nano|gemma/i;

// The newest Flash (or Pro) text model this key can use, e.g. gemini-3-flash-preview
export async function pickWriterModel(apiKey, kind = 'flash') {
    try {
        const data = await fetchJson(`${BASE}/models?pageSize=200&key=${encodeURIComponent(apiKey)}`, {}, 20000);
        const re = new RegExp(`^models/gemini-(\\d+(?:\\.\\d+)?)-${kind}(-preview(?:-[\\d-]+)?|-\\d{3})?$`);
        const list = (data.models || [])
            .filter((m) => (m.supportedGenerationMethods || []).includes('generateContent'))
            .map((m) => ({ id: m.name.replace('models/', ''), m: m.name.match(re) }))
            .filter((x) => x.m && !SKIP.test(x.id))
            .map((x) => ({ id: x.id, v: parseFloat(x.m[1]), preview: !!x.m[2] && x.m[2].startsWith('-preview'), dated: /\d/.test(x.m[2] || '') }))
            .sort((a, b) => b.v - a.v || a.preview - b.preview || a.dated - b.dated);
        return list[0]?.id || WRITER_FALLBACK;
    } catch {
        return WRITER_FALLBACK;
    }
}

function textOf(data) {
    const parts = data?.candidates?.[0]?.content?.parts || [];
    return parts.filter((p) => !p.thought && typeof p.text === 'string').map((p) => p.text).join('').trim();
}

// The newest Flash models "think" at length before every answer by default (minutes for
// a long part). Writing a story by a detailed plan, and editing, need little of that:
// thinking_level "low" — the fastest level every current Flash model accepts.
let thinkingOk = true;

// Every request is timed in the app's diagnostics (Настройки → Диагностика), so a slow
// answer shows its real cause: the model, a retry, a 429, a stall.
let logFn = null;
export function setWriterLog(fn) { logFn = fn; }
const log = (m) => { try { logFn?.(m); } catch {} };

const IDLE_MS = 45000;      // nothing for this long while streaming: the request is stuck
const TOTAL_MS = 300000;

function httpError(status, data) {
    const msg = data?.error?.message || `HTTP ${status}`;
    return Object.assign(new Error(status === 429 ? 'Достигнат лимит на заявките към Gemini. Опитвам отново…' : msg), {
        status, retryable: status === 429 || status >= 500, raw: msg + ' ' + JSON.stringify(data?.error?.details || []),
    });
}

// One streamed answer (server-sent events): the text arrives as it is written, so the
// progress shows real characters, and a stalled request is cut after IDLE_MS instead of
// waiting minutes for nothing. → { text, inTokens, outTokens, finish }
async function streamOnce(url, body, signal, onDelta) {
    const ctrl = new AbortController();
    const abort = () => ctrl.abort();
    signal?.addEventListener('abort', abort, { once: true });
    let idle = 0, why = '', reader = null;
    // Cut: abort the request and also release a read that is waiting (some streams do not
    // end on abort)
    const cut = (w) => { why = w; ctrl.abort(); reader?.cancel().catch(() => {}); };
    const arm = () => { clearTimeout(idle); idle = setTimeout(() => cut('idle'), IDLE_MS); };
    const total = setTimeout(() => cut('total'), TOTAL_MS);
    try {
        arm();
        const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: ctrl.signal });
        if (!res.ok) {
            let data = null;
            try { data = await res.json(); } catch {}
            throw httpError(res.status, Array.isArray(data) ? data[0] : data);
        }
        reader = res.body.getReader();
        const dec = new TextDecoder();
        let buf = '', text = '', usage = {}, finish = '';
        for (;;) {
            const { value, done } = await reader.read();
            if (why) throw new DOMException('Cut', 'AbortError');
            if (done) break;
            arm();
            buf += dec.decode(value, { stream: true });
            let nl;
            while ((nl = buf.indexOf('\n')) >= 0) {
                const line = buf.slice(0, nl).trim();
                buf = buf.slice(nl + 1);
                if (!line.startsWith('data:')) continue;
                let d;
                try { d = JSON.parse(line.slice(5)); } catch { continue; }
                if (d.error) throw httpError(d.error.code || 500, d);
                const piece = textOf(d);
                if (piece) { text += piece; onDelta?.(text.length); }
                if (d.usageMetadata) usage = d.usageMetadata;
                finish = d?.candidates?.[0]?.finishReason || finish;
            }
        }
        return { text: text.trim(), inTokens: usage.promptTokenCount || 0, outTokens: (usage.candidatesTokenCount || 0) + (usage.thoughtsTokenCount || 0), finish };
    } catch (e) {
        if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
        if (e.name === 'AbortError') {
            throw Object.assign(new Error(why === 'idle' ? `Gemini не изпрати нищо ${IDLE_MS / 1000} сек. — питам наново` : 'Gemini не отговори навреме — питам наново'), { status: 0, retryable: true });
        }
        if (e.status) throw e;
        throw Object.assign(new Error((typeof navigator === 'undefined' || navigator.onLine) ? 'Мрежова грешка.' : 'Няма интернет връзка.'), { status: 0, retryable: true });
    } finally {
        clearTimeout(idle);
        clearTimeout(total);
        signal?.removeEventListener('abort', abort);
    }
}

async function generate({ apiKey, model, system, prompt, search = false, json = false, maxTokens = 16384, signal, onDelta, what = '' }) {
    const body = (thinking) => ({
        systemInstruction: { parts: [{ text: system }] },
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: {
            temperature: json ? 0.6 : 0.85, maxOutputTokens: maxTokens,
            ...(json && !search ? { responseMimeType: 'application/json' } : {}),
            ...(thinking ? { thinkingConfig: { thinkingLevel: 'low' } } : {}),
        },
        ...(search ? { tools: [{ google_search: {} }] } : {}),
    });
    const url = `${BASE}/models/${model}:streamGenerateContent?alt=sse&key=${encodeURIComponent(apiKey)}`;
    let tries = 0;
    const send = (thinking) => withRetry(async () => {
        tries++;
        const t0 = Date.now();
        try {
            const r = await streamOnce(url, body(thinking), signal, onDelta);
            log(`Gemini ${model}${what ? ` (${what})` : ''}: ${((Date.now() - t0) / 1000).toFixed(0)} сек., ${r.text.length} знака, ${r.outTokens} токена${tries > 1 ? `, опит ${tries}` : ''}`);
            return r;
        } catch (e) {
            log(`Gemini ${model}${what ? ` (${what})` : ''}: ${((Date.now() - t0) / 1000).toFixed(0)} сек. — ${e.message}`);
            throw e;
        }
    }, signal, 4);
    try {
        return await send(thinkingOk);
    } catch (e) {
        // A model without thinking levels: ask once more without, and never again
        if (!thinkingOk || e.status !== 400 || !/think/i.test(e.message + (e.raw || ''))) throw e;
        thinkingOk = false;
        return send(false);
    }
}

function parseJson(t) {
    const s = t.indexOf('{'), e = t.lastIndexOf('}');
    if (s < 0 || e <= s) throw new Error('Планът на текста не се получи.');
    return JSON.parse(t.slice(s, e + 1));
}

// Plain paragraphs for the ear: no Markdown, headings, lists or stage directions
export function cleanNarration(t) {
    return String(t || '')
        .replace(/\r/g, '')
        .replace(/^\s*#{1,6}\s+.*$/gm, '')
        .replace(/^\s*(?:\*\*)?(?:Пролог|Разгръщане|Откритие|Разширяване|Неочакван извод|Финал|Раздел \d+|Част \d+)(?:\*\*)?\s*[:.]?\s*$/gim, '')
        .replace(/^\s*\[[^\]]{0,60}\]\s*$/gm, '')          // [музика], [пауза]
        .replace(/\*\*([^*]+)\*\*/g, '$1').replace(/(^|\s)\*([^*\n]+)\*/g, '$1$2').replace(/__([^_]+)__/g, '$1')
        .replace(/^\s*(?:[-*•]|\d+[.)])\s+/gm, '')
        .replace(/[ \t]+/g, ' ')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

const len = (parts) => parts.reduce((a, p) => a + p.length, 0) + Math.max(0, parts.length - 1) * 2;

// → { title, text, model, inTokens, outTokens, plan }
// onProgress(fraction, label)
// onPart(i, text, total): each act as soon as it is written — the caller edits and voices it
// while the next one is being written. expand=false (with onPart): no rewriting at the end
// (a voiced act is never replaced), so each act is asked a little longer from the start.
export async function writeNarration({ apiKey, model, mode, input, scenario = SCENARIO, minChars = 25000, search = true, signal, onProgress, onPart, expand = true }) {
    if (!apiKey) throw new Error('Нужен е Google (Gemini) API ключ.');
    const material = String(input || '').trim();
    if (!material) throw new Error(mode === 'topic' ? 'Въведете тема.' : 'Няма текст за преработка.');
    model ||= await pickWriterModel(apiKey);
    const usage = { inTokens: 0, outTokens: 0 };
    const call = async (o) => {
        const r = await generate({ apiKey, model, signal, ...o });
        usage.inTokens += r.inTokens; usage.outTokens += r.outTokens;
        return r;
    };
    const goal = Math.round(minChars * (expand ? 1.1 : 1.2));
    scenario = `${scenario}\n\n${SPOKEN_RULES}`;
    const source = mode === 'topic' ? `ТЕМА / РАЗСЪЖДЕНИЕ:\n${material}` : `НАУЧЕН МАТЕРИАЛ (преразкажи го по сценария; не добавяй твърдения, които не следват от него или от установената наука):\n${material}`;

    // 1. The plan: the scenario's acts with their share of the length (+ facts for a topic)
    onProgress?.(0.02, 'Планирам разказа…');
    const planPrompt = `${source}

Направи план за аудиоразказа по сценария. Върни САМО JSON:
{"title": "заглавие", "facts": ["проверени факти, имена, години, експерименти, които разказът ще използва${mode === 'topic' ? ' — само реални, проверими' : ' — от материала'}"],
 "sections": [{"name": "Пролог", "beats": "какво точно се случва в тази част, кои идеи и примери", "chars": 3500}, ...]}
Частите следват драматургията на сценария (пролог, разгръщане, откритие, разширяване, неочакван извод, финал); може разгръщането и разширяването да са по две части. Сборът на "chars" е около ${goal} знака.`;
    let plan;
    try {
        plan = parseJson((await call({ system: scenario, prompt: planPrompt, search: search && mode === 'topic', json: true, maxTokens: 8192, what: 'план' })).text);
    } catch (e) {
        if (e.name === 'AbortError') throw e;
        // Without search (not every key/model allows it), then once more as plain JSON
        plan = parseJson((await call({ system: scenario, prompt: planPrompt, json: true, maxTokens: 8192, what: 'план без търсене' })).text);
    }
    const sections = (plan.sections || []).filter((s) => s && s.name).slice(0, 10);
    if (!sections.length) throw new Error('Планът на текста не се получи.');
    const sum = sections.reduce((a, s) => a + (Number(s.chars) || 0), 0) || 1;
    for (const s of sections) s.chars = Math.max(1500, Math.round((Number(s.chars) || sum / sections.length) / sum * goal));
    const planText = `Заглавие: ${plan.title || ''}\nФакти: ${(plan.facts || []).join('; ')}\nЧасти:\n${sections.map((s, i) => `${i + 1}. ${s.name} (~${s.chars} знака): ${s.beats || ''}`).join('\n')}`;

    // 2. Each act in turn, continuing the text so far
    const parts = [];
    const writePart = async (i, extra = '') => {
        const s = sections[i];
        const before = parts.slice(0, i).join('\n\n');
        const prompt = `${source}

ПЛАН НА ЦЕЛИЯ РАЗКАЗ:
${planText}

${before ? `ТЕКСТЪТ ДОТУК (последната част):\n…${before.slice(-5000)}\n\n` : ''}Напиши част ${i + 1} от ${sections.length}: „${s.name}“ — ${s.beats || ''}
Обем: около ${s.chars} знака (не по-малко от ${Math.round(s.chars * 0.85)}). ${extra}
Продължи естествено от текста дотук, без да повтаряш вече казаното${i === sections.length - 1 ? '; това е финалът на целия разказ' : '; не завършвай разказа — следват още части'}.
Върни само самия текст за четене на глас: абзаци, разделени с празен ред, без заглавия, без номера, без Markdown, без бележки за музика или паузи.`;
        const label = `Пиша: ${s.name} (${i + 1}/${sections.length})`;
        const r = await call({
            system: scenario, prompt, what: s.name, maxTokens: Math.round(s.chars * 0.8) + 4096,
            onDelta: (n) => onProgress?.(0.08 + 0.8 * i / sections.length, `${label} · ${n} знака`),
        });
        return cleanNarration(r.text);
    };
    for (let i = 0; i < sections.length; i++) {
        onProgress?.(0.08 + 0.8 * i / sections.length, `Пиша: ${sections[i].name} (${i + 1}/${sections.length})`);
        parts[i] = await writePart(i);
        onPart?.(i, parts[i], sections.length);
    }

    // 3. Too short: the acts furthest below their share are written again, longer
    for (let round = 0; expand && round < 3 && len(parts) < minChars; round++) {
        const order = sections.map((s, i) => ({ i, gap: s.chars - parts[i].length })).sort((a, b) => b.gap - a.gap);
        const i = order[0].i;
        onProgress?.(0.9, `Разширявам: ${sections[i].name}`);
        const need = Math.max(sections[i].chars, parts[i].length + (minChars - len(parts)) + 800);
        sections[i].chars = need;
        const longer = await writePart(i, `Предишният вариант беше твърде кратък (${parts[i].length} знака) — напиши частта по-подробно и по-дълбоко, с повече конкретни механизми и примери, без пълнеж.`);
        if (longer.length > parts[i].length) parts[i] = longer;
    }
    onProgress?.(1, '');
    const text = parts.filter(Boolean).join('\n\n');
    return { title: String(plan.title || '').trim(), text, model, ...usage, plan: { ...plan, sections } };
}

// ---------- review and edit for the voice ----------
//
// Any text (written by the model or pasted) goes through an editor pass before it is
// voiced: the content stays, only the form changes so it reads smoothly aloud (rules
// above; grammar and punctuation fixed). Done in pieces of ~6000 characters at
// paragraph ends; a piece that comes back much shorter or longer than it went in
// (something left out, or added) keeps its original form.

const EDITOR = `Ти си редактор на текстове за аудиокниги и документални разкази на български език. Получаваш откъс от текст, който ще бъде прочетен от синтезиран глас. Редактирай го така, че да звучи гладко и естествено на глас, без да променяш съдържанието.
Запази всички факти, имена, идеи, примери, реда им и стила на автора. Не съкращавай, не обобщавай, не добавяй нови твърдения, не коментирай.
Поправи граматиката, пунктуацията и правописа. Свържи абзаците естествено там, където преходът е рязък.

${SPOKEN_RULES}

Върни само редактирания текст — абзаци, разделени с празен ред.`;

function pieces(text, max = 6000) {
    const paras = String(text).split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
    const out = [];
    let cur = '';
    for (const p of paras) {
        if (cur && cur.length + p.length + 2 > max) { out.push(cur); cur = ''; }
        cur = cur ? `${cur}\n\n${p}` : p;
    }
    if (cur) out.push(cur);
    return out;
}

// → { text, model, inTokens, outTokens, kept } (kept: pieces left as they were)
export async function editForVoice({ apiKey, model, text, signal, onProgress }) {
    if (!apiKey) throw new Error('Нужен е Google (Gemini) API ключ.');
    model ||= await pickWriterModel(apiKey);
    const list = pieces(text);
    const out = new Array(list.length);
    let inTokens = 0, outTokens = 0, kept = 0, done = 0, next = 0;
    // Pieces are independent (each gets the end of the one before as context): 3 at a time
    const one = async (i) => {
        const before = i ? `(Предходният откъс завършва така: „…${list[i - 1].slice(-300)}“)\n\n` : '';
        const r = await generate({ apiKey, model, system: EDITOR, prompt: `${before}ОТКЪС ЗА РЕДАКЦИЯ:\n\n${list[i]}`, maxTokens: Math.round(list[i].length * 0.8) + 4096, signal, what: `редакция ${i + 1}/${list.length}` });
        inTokens += r.inTokens; outTokens += r.outTokens;
        const t = cleanNarration(r.text);
        const ratio = t.length / list[i].length;
        if (t && ratio > 0.85 && ratio < 1.35 && r.finish !== 'MAX_TOKENS') out[i] = t;
        else { out[i] = list[i]; kept++; }
        onProgress?.(++done / list.length, `Редактирам за слушане: ${done} от ${list.length}`);
    };
    onProgress?.(0, `Редактирам за слушане: 0 от ${list.length}`);
    await Promise.all(Array.from({ length: Math.min(3, list.length) }, async () => { while (next < list.length) await one(next++); }));
    onProgress?.(1, '');
    return { text: out.join('\n\n'), model, inTokens, outTokens, kept };
}
