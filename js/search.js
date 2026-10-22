// World book search across legal open sources. Every source is queried in
// parallel; results come back as catalog items that can be downloaded, translated,
// read, listened to and exported. Only books that may be freely copied are offered.

import { euPublicDomain, gutenbergItem } from './library.js';
import { libraryApi } from './shared.js';
import { recordUsage } from './usage.js';

const YEAR = new Date().getFullYear();
const LANG3 = { eng: 'en', rus: 'ru', ger: 'de', fre: 'fr', spa: 'es', ita: 'it', bul: 'bg', ukr: 'uk', srp: 'sr', lat: 'la', gre: 'el', pol: 'pl', por: 'pt', dut: 'nl' };

export const SOURCES = {
    gutenberg: { label: 'Project Gutenberg', rights: 'Обществено достояние' },
    ia: { label: 'Internet Archive', rights: 'Обществено достояние (скан)' },
    wikisource: { label: 'Wikisource', rights: 'Обществено достояние' },
    arxiv: { label: 'arXiv', rights: 'Научна статия · отворен достъп' },
    oapen: { label: 'OAPEN', rights: 'Научна книга · отворен достъп' },
};

async function json(url, opts) {
    const r = await fetch(url, opts);
    if (!r.ok) throw new Error(String(r.status));
    return r.json();
}

// ---------- sources ----------

async function searchGutenberg(q) {
    const d = await json(`https://gutendex.com/books/?${new URLSearchParams({ search: q, copyright: 'false' })}`);
    return d.results
        .filter((b) => euPublicDomain(b.authors) && (b.translators?.length ? euPublicDomain(b.translators) : true))
        .slice(0, 20)
        .map((b) => ({ ...gutenbergItem(b), shareable: true }));
}

const authorDeath = new Map();
async function deathYear(key) {
    if (authorDeath.has(key)) return authorDeath.get(key);
    const p = json(`https://openlibrary.org/authors/${key}.json`)
        .then((a) => Number((String(a.death_date || '').match(/(\d{3,4})\s*$/) || [])[1]) || null)
        .catch(() => null);
    authorDeath.set(key, p);
    return p;
}

async function searchOpenLibrary(q) {
    const params = new URLSearchParams({
        q: `${q} ebook_access:public`,
        fields: 'key,title,author_name,author_key,ia,first_publish_year,language,cover_i',
        limit: '30',
    });
    const d = await json(`https://openlibrary.org/search.json?${params}`);
    const docs = d.docs.filter((x) => x.ia?.length);
    // Public domain in the EU: authors died 70+ years ago (or the work is very old)
    const checked = await Promise.all(docs.map(async (x) => {
        const deaths = await Promise.all((x.author_key || []).slice(0, 3).map(deathYear));
        const known = deaths.length && deaths.every((y) => Number.isInteger(y));
        const ok = known ? deaths.every((y) => y <= YEAR - 71) : (x.first_publish_year && x.first_publish_year <= 1870);
        return ok ? x : null;
    }));
    return checked.filter(Boolean).slice(0, 20).map((x) => ({
        source: 'ia', id: x.ia[0], ia: x.ia, key: '',
        title: x.title, author: (x.author_name || []).join(', '),
        lang: LANG3[(x.language || [])[0]] || (x.language || [])[0] || 'en',
        cover: x.cover_i ? `https://covers.openlibrary.org/b/id/${x.cover_i}-M.jpg` : '',
        // Translators are unknown here, so the narration stays private to this listener
        year: x.first_publish_year, shareable: false,
    }));
}

async function searchWikisource(q, lang) {
    const params = new URLSearchParams({ action: 'query', list: 'search', srsearch: q, srnamespace: '0', srlimit: '12', format: 'json', formatversion: '2', origin: '*' });
    const d = await json(`https://${lang}.wikisource.org/w/api.php?${params}`);
    return d.query.search
        .filter((x) => !x.title.includes('/'))
        // bg.wikisource holds Bulgarian public-domain texts; other Wikisources follow US rules
        .map((x) => ({ source: 'wikisource', id: x.title, title: x.title, author: '', lang, shareable: lang === 'bg' }));
}

async function viaServerText(url) {
    const api = libraryApi();
    if (!api) throw new Error('no server');
    const r = await fetch(`${api}/proxy?url=${encodeURIComponent(url)}`);
    if (!r.ok) throw new Error(String(r.status));
    return r.text();
}

async function searchArxiv(q) {
    const xml = await viaServerText(`https://export.arxiv.org/api/query?${new URLSearchParams({ search_query: `all:${q}`, max_results: '12' })}`);
    const doc = new DOMParser().parseFromString(xml, 'application/xml');
    return [...doc.getElementsByTagName('entry')].map((e) => {
        const get = (t) => e.getElementsByTagName(t)[0]?.textContent?.trim() || '';
        const id = get('id').replace(/^https?:\/\/arxiv\.org\/abs\//, '');
        const pdf = [...e.getElementsByTagName('link')].find((l) => l.getAttribute('title') === 'pdf')?.getAttribute('href') || `https://arxiv.org/pdf/${id}`;
        return {
            source: 'arxiv', id, title: get('title').replace(/\s+/g, ' '),
            author: [...e.getElementsByTagName('author')].map((a) => a.textContent.trim()).slice(0, 3).join(', '),
            lang: 'en', pdf: pdf.replace(/^http:/, 'https:'), year: Number(get('published').slice(0, 4)) || null,
            shareable: false, // arXiv licences vary: reading is fine, sharing the narration is not
        };
    });
}

async function searchOapen(q) {
    const url = `https://library.oapen.org/rest/search?${new URLSearchParams({ query: q, expand: 'metadata,bitstreams', limit: '12' })}`;
    // OAPEN refuses data-centre addresses, so the listener's own connection goes first
    const list = await json(url).catch(async () => JSON.parse(await viaServerText(url)));
    return (Array.isArray(list) ? list : []).map((it) => {
        const md = (k) => (it.metadata || []).filter((m) => m.key === k).map((m) => m.value);
        const pdf = (it.bitstreams || []).find((b) => /pdf/i.test(b.mimeType || b.name || ''));
        if (!pdf) return null;
        return {
            source: 'oapen', id: it.handle || it.uuid, title: it.name || md('dc.title')[0] || '',
            author: md('dc.contributor.author').slice(0, 3).join(', '),
            lang: (md('dc.language')[0] || 'en').slice(0, 2).toLowerCase(),
            pdf: `https://library.oapen.org${pdf.retrieveLink}`, shareable: false,
        };
    }).filter(Boolean);
}

// Search everything; onResults(source, items, error) is called as each source answers.
export async function searchBooks(q, readerLang, onResults) {
    const tasks = {
        gutenberg: () => searchGutenberg(q),
        ia: () => searchOpenLibrary(q),
        wikisource: async () => {
            const langs = [...new Set([readerLang, 'bg', 'en'])];
            return (await Promise.all(langs.map((l) => searchWikisource(q, l).catch(() => [])))).flat();
        },
        arxiv: () => searchArxiv(q),
        oapen: () => searchOapen(q),
    };
    await Promise.all(Object.entries(tasks).map(async ([src, fn]) => {
        try { onResults(src, await fn(), null); } catch (e) { onResults(src, [], e); }
    }));
}

// ---------- titles in the reader's language ----------

const TT_KEY = 'rz_titles_';

function ttCache(lang) {
    try { return JSON.parse(localStorage.getItem(TT_KEY + lang) || '{}'); } catch { return {}; }
}

// Translate titles and transliterate author names of foreign items (Gemini Flash-Lite,
// one small request per screen, cached). Items get titleT / authorT.
export async function localizeTitles(items, lang, apiKey) {
    const cache = ttCache(lang);
    const id = (it) => `${it.source}:${it.id}`;
    const todo = items.filter((it) => it.lang && it.lang !== lang && !cache[id(it)]);
    if (todo.length && apiKey) {
        const names = { bg: 'Bulgarian', en: 'English', ru: 'Russian', de: 'German', fr: 'French', es: 'Spanish', it: 'Italian', uk: 'Ukrainian', sr: 'Serbian' };
        const input = todo.map((it) => ({ t: it.title, a: it.author || '' }));
        const prompt = `Translate these book titles into ${names[lang] || lang} the way they are known in published translations (keep them short), and write the author names the way they are spelled in ${names[lang] || lang}. Return ONLY a JSON array with exactly ${input.length} objects {"t": title, "a": author}, same order.\n\n${JSON.stringify(input)}`;
        try {
            const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent?key=${encodeURIComponent(apiKey)}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    contents: [{ parts: [{ text: prompt }] }],
                    generationConfig: { temperature: 0.2, responseMimeType: 'application/json', thinkingConfig: { thinkingBudget: 0 } },
                }),
            });
            const data = await r.json();
            const u = data.usageMetadata || {};
            recordUsage({ engine: 'translate', inTokens: u.promptTokenCount || 0, outTokens: u.candidatesTokenCount || 0 });
            const out = JSON.parse(data.candidates?.[0]?.content?.parts?.map((p) => p.text || '').join('') || '[]');
            if (Array.isArray(out) && out.length === todo.length) {
                todo.forEach((it, i) => { cache[id(it)] = [String(out[i]?.t || it.title), String(out[i]?.a || it.author || '')]; });
                try { localStorage.setItem(TT_KEY + lang, JSON.stringify(cache)); } catch {}
            }
        } catch {}
    }
    for (const it of items) {
        const c = cache[id(it)];
        if (c) { it.titleT = c[0]; it.authorT = c[1]; }
    }
    return items;
}
