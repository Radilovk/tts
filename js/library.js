// "Открий" — a curated catalog of public-domain books from legal open libraries:
//   Project Gutenberg (via the Gutendex API) and Wikisource.
// Only books that are public domain in the EU (all authors and translators died
// more than 70 years ago) are shown; their narration is shared between listeners.

import { bookFromHtmlChapters, parseBook } from './parsers.js';
import { isNative } from './native.js';
import { libraryApi } from './shared.js';

const GUTENDEX = 'https://gutendex.com/books/';
const CACHE_PREFIX = 'rz_shelf_';
const CACHE_HOURS = 24;

// Classic Bulgarian authors on Wikisource (all public domain in the EU)
const BG_AUTHORS = [
    ['Иван Вазов', 1921], ['Алеко Константинов', 1897], ['Елин Пелин', 1949], ['Йордан Йовков', 1937],
    ['Христо Ботев', 1876], ['Любен Каравелов', 1879], ['Захари Стоянов', 1889], ['Пейо Яворов', 1914],
    ['Христо Смирненски', 1923], ['Димчо Дебелянов', 1916], ['Пенчо Славейков', 1912], ['Антон Страшимиров', 1937],
    ['Тодор Влайков', 1943], ['Михалаки Георгиев', 1916], ['Стоян Михайловски', 1927], ['Кирил Христов', 1944],
];

export const SHELVES = [
    { id: 'bg', title: 'Българска класика', note: 'Wikisource', kind: 'wikisource-authors', lang: 'bg' },
    { id: 'world', title: 'Световна класика на български', note: 'AI превод · Project Gutenberg', kind: 'gutendex', params: { languages: 'en' }, translateTo: 'bg' },
    { id: 'ru', title: 'Руска класика', note: 'оригинал', kind: 'gutendex', params: { languages: 'ru' } },
    { id: 'de', title: 'Deutsche Klassiker', note: 'Original', kind: 'gutendex', params: { languages: 'de' } },
    { id: 'fr', title: 'Classiques français', note: 'original', kind: 'gutendex', params: { languages: 'fr' } },
    { id: 'es', title: 'Clásicos en español', note: 'original', kind: 'gutendex', params: { languages: 'es' } },
    { id: 'it', title: 'Classici italiani', note: 'originale', kind: 'gutendex', params: { languages: 'it' } },
];

// ---------- rights ----------

// Public domain in the EU: life + 70 years, counted from 1 January after the death.
export function euPublicDomain(people, year = new Date().getFullYear()) {
    if (!people?.length) return false;
    return people.every((p) => Number.isInteger(p.death_year) && p.death_year <= year - 71);
}

// ---------- cache ----------

function cacheGet(key) {
    try {
        const v = JSON.parse(localStorage.getItem(CACHE_PREFIX + key) || 'null');
        if (v && Date.now() - v.at < CACHE_HOURS * 3600e3) return v.data;
    } catch {}
    return null;
}

function cacheSet(key, data) {
    try { localStorage.setItem(CACHE_PREFIX + key, JSON.stringify({ at: Date.now(), data })); } catch {}
}

// ---------- Project Gutenberg ----------

function authorName(a) {
    // "Austen, Jane" → "Jane Austen"
    const m = (a?.name || '').match(/^([^,]+),\s*(.+)$/);
    return m ? `${m[2]} ${m[1]}` : (a?.name || '');
}

function gutenbergItem(b, shelf) {
    return {
        source: 'gutenberg', id: String(b.id), key: `pg-${b.id}`,
        title: b.title.replace(/\s*[:;]\s*$/, ''),
        author: b.authors.map(authorName).join(', '),
        lang: (b.languages || [])[0] || 'en',
        cover: b.formats?.['image/jpeg'] || '',
        downloads: b.download_count || 0,
        translateTo: shelf?.translateTo || null,
    };
}

export async function loadShelf(shelf, page = 1) {
    if (shelf.kind === 'wikisource-authors') {
        return { items: BG_AUTHORS.map(([name, died]) => ({ source: 'wikisource-author', title: name, author: `† ${died}`, lang: shelf.lang, died })), next: null };
    }
    const cacheKey = `${shelf.id}_${page}`;
    const hit = cacheGet(cacheKey);
    if (hit) return hit;
    const params = new URLSearchParams({ ...shelf.params, copyright: 'false', mime_type: 'application/epub', page: String(page) });
    const r = await fetch(`${GUTENDEX}?${params}`);
    if (!r.ok) throw new Error('Каталогът не отговаря. Опитайте след малко.');
    const data = await r.json();
    const items = data.results
        .filter((b) => euPublicDomain(b.authors) && (b.translators?.length ? euPublicDomain(b.translators) : true))
        .map((b) => gutenbergItem(b, shelf));
    const out = { items, next: data.next ? page + 1 : null };
    cacheSet(cacheKey, out);
    return out;
}

async function downloadGutenberg(id) {
    const direct = `https://www.gutenberg.org/cache/epub/${id}/pg${id}.epub`; // text-only, ~0.5 MB
    if (isNative && window.Capacitor?.Plugins?.CapacitorHttp) {
        // The Android app downloads natively, without the CORS proxy
        const res = await window.Capacitor.Plugins.CapacitorHttp.request({ url: direct, method: 'GET', responseType: 'blob' });
        if (res.status >= 400 || !res.data) throw new Error('Книгата не можа да се изтегли.');
        const bin = atob(res.data);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        return new Blob([bytes], { type: 'application/epub+zip' });
    }
    const api = libraryApi();
    if (!api) throw new Error('Сървърът на библиотеката още не е включен.');
    const r = await fetch(`${api}/gutenberg/${id}.epub`);
    if (!r.ok) throw new Error('Книгата не можа да се изтегли.');
    return r.blob();
}

// ---------- Wikisource ----------

const WS = (lang) => `https://${lang}.wikisource.org/w/api.php`;
const STRIP = '.ws-noexport, .noprint, #headertemplate, .headertemplate, .navbox, .mw-editsection, sup.reference, .references, .mw-references-wrap, #toc, .toc, .ws-summary, .metadata, table.licenseContainer, .licenseContainer';

async function wsApi(lang, params) {
    const q = new URLSearchParams({ format: 'json', formatversion: '2', origin: '*', ...params });
    const r = await fetch(`${WS(lang)}?${q}`);
    if (!r.ok) throw new Error('Wikisource не отговаря. Опитайте след малко.');
    const d = await r.json();
    if (d.error) throw new Error(d.error.info || 'Wikisource грешка');
    return d;
}

async function wsPage(lang, title) {
    const d = await wsApi(lang, { action: 'parse', page: title, prop: 'text|displaytitle', redirects: '1', disableeditsection: '1' });
    const doc = new DOMParser().parseFromString(d.parse.text, 'text/html');
    // Links in document order (needed for chapter order)
    const links = [...doc.querySelectorAll('a[href^="/wiki/"]')]
        .map((a) => decodeURIComponent(a.getAttribute('href').slice(6)).replace(/_/g, ' ').split('#')[0]);
    doc.querySelectorAll(STRIP).forEach((n) => n.remove());
    return { title: d.parse.title, html: doc.body.innerHTML, text: doc.body.textContent || '', links };
}

// Works listed on an author's page ("Автор:Иван Вазов")
export async function wikisourceWorks(lang, author) {
    const cacheKey = `ws_${lang}_${author}`;
    const hit = cacheGet(cacheKey);
    if (hit) return hit;
    const prefix = lang === 'bg' ? 'Автор:' : 'Author:';
    let works = [];
    try {
        const p = await wsPage(lang, prefix + author);
        works = [...new Set(p.links.filter((t) => !t.includes(':') && !t.includes('/')))];
    } catch {}
    if (!works.length) {
        const d = await wsApi(lang, { action: 'query', list: 'search', srsearch: author, srnamespace: '0', srlimit: '40' });
        works = d.query.search.map((x) => x.title).filter((t) => !t.includes('/'));
    }
    const items = works.slice(0, 80).map((t) => ({ source: 'wikisource', id: t, title: t, author, lang }));
    cacheSet(cacheKey, items);
    return items;
}

async function downloadWikisource(item, onProgress) {
    const main = await wsPage(item.lang, item.id);
    const prefix = main.title + '/';
    const subs = [...new Set(main.links.filter((t) => t.startsWith(prefix)))].slice(0, 300);
    let chapters;
    if (!subs.length) {
        chapters = [{ title: '', html: main.html }];
    } else {
        chapters = [];
        let done = 0;
        for (let i = 0; i < subs.length; i += 4) {
            const batch = await Promise.all(subs.slice(i, i + 4).map((t) => wsPage(item.lang, t).catch(() => null)));
            for (const p of batch) {
                if (p && p.text.trim().length > 40) chapters.push({ title: p.title.slice(prefix.length).replace(/\//g, ' · '), html: p.html });
            }
            done += 4;
            onProgress?.(Math.min(1, done / subs.length));
        }
        if (!chapters.length) chapters = [{ title: '', html: main.html }];
    }
    return bookFromHtmlChapters({ title: main.title, author: item.author, chapters });
}

// ---------- public ----------

// Fetch and parse a catalog book. Returns the parsed book plus its source info.
export async function fetchCatalogBook(item, onProgress) {
    if (item.source === 'gutenberg') {
        onProgress?.(0.1);
        const blob = await downloadGutenberg(item.id);
        onProgress?.(0.5);
        const book = await parseBook(new File([blob], `${item.title}.epub`), (p) => onProgress?.(0.5 + p / 2));
        if (!book.author) book.author = item.author;
        return book;
    }
    if (item.source === 'wikisource') return downloadWikisource(item, onProgress);
    throw new Error('Непознат източник.');
}

export async function sourceKey(item) {
    if (item.source === 'gutenberg') return `pg-${item.id}`;
    const buf = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(`${item.lang}:${item.id}`));
    return 'ws-' + [...new Uint8Array(buf)].slice(0, 8).map((b) => b.toString(16).padStart(2, '0')).join('');
}
