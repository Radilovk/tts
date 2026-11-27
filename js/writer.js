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
// Each task gets the model that fits it (Google's guidance, docs/choosing-a-model):
//   plan  — the story's structure and its facts (with Google Search): the deepest
//           reasoning for science and knowledge work — Gemini 4 Neon, thinking high;
//   write — the acts: long, precise, vivid prose by the plan — Neon as well;
//   edit  — the same text in a form for the voice (rules only, no new content) —
//           Gemini 4 Hydrogen (frontier class, fewer invented claims), thinking medium.
// The list is tried in order: a model the key cannot use (Neon needs the paid tier, a
// model missing for the key) gives way to the next one and is not asked again this session.
// Each task goes to the model that does it best for the least money (Gemini 4, per 1M
// tokens, output incl. thinking: Neon $3/$15 — deep reasoning, science, knowledge work;
// Hydrogen $1.50/$7.50 — fast, cheap, 5× fewer invented claims than 3.8 Flash). Where the
// quality matters and the output is small (so the price gap is pennies), the better model
// (Neon) is used; where the work is mechanical or high-volume, the cheaper one (Hydrogen).
//   plan   — small JSON, but sets the depth of the whole story: Neon, high
//   write  — the narration itself, the thing that must be deep and true: Neon, high
//            (≈ $0.15–0.30 more than Hydrogen for a whole video — negligible, so the better one)
//   edit   — reshape the same text for the voice, no new content, runs on the WHOLE text:
//            Hydrogen (mechanical, high-volume → the cheaper model), medium
//   scenes — what each shot shows + visual metaphors, needs the whole narrative: Neon, high
//   look   — judge which thumbnail fits a sentence; perception, many calls, tiny output:
//            Hydrogen, low thinking (speed and cost; the extra depth buys nothing here)
export const TASKS = {
    plan: { models: ['gemini-4-neon', 'gemini-4-hydrogen', 'gemini-3.8-flash'], thinking: 'high', label: 'план' },
    write: { models: ['gemini-4-neon', 'gemini-4-hydrogen', 'gemini-3.8-flash'], thinking: 'high', label: 'писане' },
    edit: { models: ['gemini-4-hydrogen', 'gemini-3.8-flash'], thinking: 'medium', label: 'редакция' },
    scenes: { models: ['gemini-4-neon', 'gemini-4-hydrogen', 'gemini-3.8-flash'], thinking: 'high', label: 'сцени' },
    look: { models: ['gemini-4-hydrogen', 'gemini-3.8-flash'], thinking: 'low', label: 'подбор на кадър' },
};
export const WRITER_FALLBACK = 'gemini-4-hydrogen';
const unusable = new Set();     // models this key cannot use (this session)
let listed = null;              // the models the key lists (null = unknown)

async function listModels(apiKey) {
    if (listed) return listed;
    try {
        const data = await fetchJson(`${BASE}/models?pageSize=500&key=${encodeURIComponent(apiKey)}`, {}, 20000);
        listed = new Set((data.models || []).filter((m) => (m.supportedGenerationMethods || []).includes('generateContent')).map((m) => m.name.replace('models/', '')));
    } catch {
        listed = new Set();
    }
    return listed;
}

// The models to try for a task, best first (an explicit model — e.g. --model — goes first)
async function modelsFor(apiKey, task, override = '') {
    const all = await listModels(apiKey);
    let list = TASKS[task]?.models || TASKS.write.models;
    if (all.size) {
        const known = list.filter((m) => all.has(m));
        if (known.length) list = known;
    }
    list = list.filter((m) => !unusable.has(m));
    if (override) list = [override, ...list.filter((m) => m !== override)];
    return list.length ? list : [WRITER_FALLBACK];
}

// The model a task would use now (shown to the user; kind 'flash'/'pro' kept for old calls)
export async function pickWriterModel(apiKey, task = 'write') {
    return (await modelsFor(apiKey, TASKS[task] ? task : 'write'))[0];
}

// A refusal that means "this key cannot use this model", not "try again later"
function modelRefused(e) {
    const t = `${e.message} ${e.raw || ''}`;
    if (e.status === 403 || e.status === 404) return true;
    if (e.status === 429 && /limit:\s*0|free[_ ]?tier|FreeTier|billing|paid tier/i.test(t)) return true;
    return e.status === 400 && /model|not (found|supported)|unsupported/i.test(t) && !/think/i.test(t);
}

function textOf(data) {
    const parts = data?.candidates?.[0]?.content?.parts || [];
    return parts.filter((p) => !p.thought && typeof p.text === 'string').map((p) => p.text).join('').trim();
}

// Thinking is left on, at the level the task needs (see TASKS); thought summaries are
// streamed too (includeThoughts), so a long think is visible and never mistaken for a
// stalled request. A model that does not take a thinking level is asked without it.
const noThinkingLevel = new Set();

// Every request is timed in the app's diagnostics (Настройки → Диагностика), so a slow
// answer shows its real cause: the model, a retry, a 429, a stall.
let logFn = null;
export function setWriterLog(fn) { logFn = fn; }
const log = (m) => { try { logFn?.(m); } catch {} };

const FIRST_MS = 150000;    // until the first chunk (a deep think may take a while)
const IDLE_MS = 60000;      // between chunks: nothing for this long means the request is stuck
const TOTAL_MS = 600000;

function httpError(status, data) {
    const msg = data?.error?.message || `HTTP ${status}`;
    const raw = msg + ' ' + JSON.stringify(data?.error?.details || []);
    const e = Object.assign(new Error(status === 429 ? 'Достигнат лимит на заявките към Gemini. Опитвам отново…' : msg), {
        status, retryable: status === 429 || status >= 500, raw,
    });
    if (modelRefused(e)) e.retryable = false;     // "limit: 0" is no limit to wait out: next model at once
    return e;
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
    let got = false;
    const arm = () => { clearTimeout(idle); idle = setTimeout(() => cut('idle'), got ? IDLE_MS : FIRST_MS); };
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
            got = true;
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
                if (piece) { text += piece; onDelta?.(text.length, false); }
                else if (d?.candidates?.[0]?.content?.parts?.some((p) => p.thought)) onDelta?.(text.length, true);
                if (d.usageMetadata) usage = d.usageMetadata;
                finish = d?.candidates?.[0]?.finishReason || finish;
            }
        }
        return { text: text.trim(), inTokens: usage.promptTokenCount || 0, outTokens: (usage.candidatesTokenCount || 0) + (usage.thoughtsTokenCount || 0), finish };
    } catch (e) {
        if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
        if (e.name === 'AbortError') {
            throw Object.assign(new Error(why === 'idle' ? `Gemini не изпрати нищо ${(got ? IDLE_MS : FIRST_MS) / 1000} сек. — питам наново` : 'Gemini не отговори навреме — питам наново'), { status: 0, retryable: true });
        }
        if (e.status) throw e;
        throw Object.assign(new Error((typeof navigator === 'undefined' || navigator.onLine) ? 'Мрежова грешка.' : 'Няма интернет връзка.'), { status: 0, retryable: true });
    } finally {
        clearTimeout(idle);
        clearTimeout(total);
        signal?.removeEventListener('abort', abort);
    }
}

// parts: the user's message as parts (text and inline images) instead of a prompt string
export async function generate({ apiKey, task = 'write', model: override = '', system, prompt, parts = null, search = false, json = false, maxTokens = 16384, signal, onDelta, what = '' }) {
    const level = TASKS[task]?.thinking || 'high';
    const body = (thinking) => ({
        systemInstruction: { parts: [{ text: system }] },
        contents: [{ role: 'user', parts: parts || [{ text: prompt }] }],
        generationConfig: {
            temperature: json ? 0.6 : 0.85, maxOutputTokens: maxTokens,
            ...(json && !search ? { responseMimeType: 'application/json' } : {}),
            thinkingConfig: { includeThoughts: true, ...(thinking ? { thinkingLevel: level } : {}) },
        },
        ...(search ? { tools: [{ google_search: {} }] } : {}),
    });
    let lastErr = null;
    for (const model of await modelsFor(apiKey, task, override)) {
        const url = `${BASE}/models/${model}:streamGenerateContent?alt=sse&key=${encodeURIComponent(apiKey)}`;
        const name = `Gemini ${model} (${what || TASKS[task]?.label || task}${TASKS[task] ? `, мислене ${level}` : ''})`;
        let tries = 0;
        const send = (thinking) => withRetry(async () => {
            tries++;
            const t0 = Date.now();
            try {
                const r = await streamOnce(url, body(thinking), signal, (n, thinkingNow) => onDelta?.(n, thinkingNow, model));
                log(`${name}: ${((Date.now() - t0) / 1000).toFixed(0)} сек., ${r.text.length} знака, ${r.outTokens} токена${tries > 1 ? `, опит ${tries}` : ''}`);
                return { ...r, model };
            } catch (e) {
                log(`${name}: ${((Date.now() - t0) / 1000).toFixed(0)} сек. — ${e.message}`);
                throw e;
            }
        }, signal, 4);
        try {
            try {
                return await send(!noThinkingLevel.has(model));
            } catch (e) {
                // This model does not take a thinking level: ask once more without it
                if (noThinkingLevel.has(model) || e.status !== 400 || !/think/i.test(e.message + (e.raw || ''))) throw e;
                noThinkingLevel.add(model);
                return await send(false);
            }
        } catch (e) {
            if (e.name === 'AbortError' || !modelRefused(e)) throw e;
            unusable.add(model);
            log(`${model} не е достъпен с този ключ — минавам на следващия модел`);
            lastErr = e;
        }
    }
    throw lastErr || new Error('Няма достъпен модел за писане.');
}

export function parseJson(t) {
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
export async function writeNarration({ apiKey, model = '', mode, input, scenario = SCENARIO, minChars = 25000, search = true, signal, onProgress, onPart, expand = true }) {
    if (!apiKey) throw new Error('Нужен е Google (Gemini) API ключ.');
    const material = String(input || '').trim();
    if (!material) throw new Error(mode === 'topic' ? 'Въведете тема.' : 'Няма текст за преработка.');
    const usage = { inTokens: 0, outTokens: 0 };
    const used = new Set();
    const call = async (o) => {
        const r = await generate({ apiKey, model, signal, ...o });
        usage.inTokens += r.inTokens; usage.outTokens += r.outTokens;
        used.add(r.model);
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
        plan = parseJson((await call({ system: scenario, prompt: planPrompt, search: search && mode === 'topic', json: true, maxTokens: 32768, what: 'план', task: 'plan' })).text);
    } catch (e) {
        if (e.name === 'AbortError') throw e;
        // Without search (not every key/model allows it), then once more as plain JSON
        plan = parseJson((await call({ system: scenario, prompt: planPrompt, json: true, maxTokens: 32768, what: 'план без търсене', task: 'plan' })).text);
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
            system: scenario, prompt, what: s.name, task: 'write', maxTokens: Math.round(s.chars * 0.8) + 24576,
            onDelta: (n, thinking, m) => onProgress?.(0.08 + 0.8 * i / sections.length, `${label} · ${m} · ${thinking && !n ? 'обмисля…' : `${n} знака`}`),
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
    return { title: String(plan.title || '').trim(), text, model: [...used].join(', '), ...usage, plan: { ...plan, sections } };
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
export async function editForVoice({ apiKey, model = '', text, signal, onProgress }) {
    if (!apiKey) throw new Error('Нужен е Google (Gemini) API ключ.');
    const list = pieces(text);
    const out = new Array(list.length);
    let inTokens = 0, outTokens = 0, kept = 0, done = 0, next = 0;
    // Pieces are independent (each gets the end of the one before as context): 3 at a time
    const one = async (i) => {
        const before = i ? `(Предходният откъс завършва така: „…${list[i - 1].slice(-300)}“)\n\n` : '';
        const r = await generate({ apiKey, model, system: EDITOR, prompt: `${before}ОТКЪС ЗА РЕДАКЦИЯ:\n\n${list[i]}`, maxTokens: Math.round(list[i].length * 0.8) + 16384, signal, task: 'edit', what: `редакция ${i + 1}/${list.length}` });
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
    return { text: out.join('\n\n'), model: model || (await pickWriterModel(apiKey, 'edit')), inTokens, outTokens, kept };
}
