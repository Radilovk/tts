// Book parsers: EPUB, PDF, FB2, DOCX, TXT, Markdown, HTML.
// Every parser returns { title, author, lang, cover: Blob|null, chapters: [{ title, paras: [string] }] }.

import { normalizeSpace, detectLang } from './text.js';

const JSZIP_URL = 'https://cdn.jsdelivr.net/npm/jszip@3.10.1/dist/jszip.min.js';
const PDFJS_URL = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.2.67/build/pdf.min.mjs';
const PDFJS_WORKER = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.2.67/build/pdf.worker.min.mjs';

export const ACCEPT = '.epub,.pdf,.fb2,.docx,.txt,.md,.markdown,.html,.htm,.xhtml';

export async function parseBook(file, onProgress = () => {}) {
    const name = file.name || 'книга';
    const ext = (name.match(/\.([a-z0-9]+)$/i) || [, ''])[1].toLowerCase();
    const baseTitle = name.replace(/\.[^.]+$/, '').replace(/[_]+/g, ' ').trim();
    let book;
    switch (ext) {
        case 'epub': book = await parseEpub(file, onProgress); break;
        case 'pdf': book = await parsePdf(file, onProgress); break;
        case 'fb2': book = await parseFb2(file); break;
        case 'docx': book = await parseDocx(file); break;
        case 'html': case 'htm': case 'xhtml': book = parseHtml(await decodeText(file)); break;
        case 'md': case 'markdown': book = parsePlain(await decodeText(file), true); break;
        default: book = parsePlain(await decodeText(file), false);
    }
    book.chapters = tidyChapters(book.chapters);
    if (!book.chapters.length) throw new Error('Не открих текст в този файл.');
    book.title = normalizeSpace(book.title || '').replace(/^(untitled|unknown|без заглавие|microsoft word.*)$/i, '') || baseTitle;
    book.author = normalizeSpace(book.author || '');
    const sample = book.chapters.slice(0, 4).map((c) => c.paras.join(' ')).join(' ');
    book.lang = detectLang(sample) || (book.lang || 'bg').slice(0, 2).toLowerCase();
    return book;
}

// ---------- helpers ----------

function loadScript(src, globalName) {
    if (window[globalName]) return Promise.resolve(window[globalName]);
    return new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = src;
        s.onload = () => resolve(window[globalName]);
        s.onerror = () => reject(new Error('Няма връзка за зареждане на четеца на файлове.'));
        document.head.appendChild(s);
    });
}

async function decodeText(file) {
    const buf = await file.arrayBuffer();
    return decodeBuffer(buf);
}

// UTF-8 first; fall back to windows-1251, which is still common for Bulgarian texts.
function decodeBuffer(buf, hint) {
    if (hint) {
        try { return new TextDecoder(hint).decode(buf); } catch {}
    }
    const utf = new TextDecoder('utf-8').decode(buf);
    const bad = (utf.match(/�/g) || []).length;
    if (bad > utf.length * 0.001 + 2) {
        try { return new TextDecoder('windows-1251').decode(buf); } catch {}
    }
    return utf.replace(/^﻿/, '');
}

const BLOCK_TAGS = new Set([
    'p', 'div', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'li', 'blockquote', 'section', 'article',
    'tr', 'pre', 'dd', 'dt', 'figcaption', 'td', 'ul', 'ol', 'table', 'body', 'header', 'footer',
    'aside', 'figure', 'main', 'center',
    // FB2
    'v', 'subtitle', 'title', 'text-author', 'stanza', 'poem', 'epigraph', 'cite', 'empty-line',
]);
const SKIP_TAGS = new Set(['script', 'style', 'head', 'nav', 'svg', 'math', 'img', 'image', 'audio', 'video', 'binary', 'noscript']);
const HEADING = /^h[1-3]$/;

// Walk a DOM subtree and return text blocks: [{ t, h }] (h = heading)
function extractBlocks(root, opts = {}) {
    const out = [];
    let buf = '';
    let isHeading = false;
    const flush = () => {
        const t = normalizeSpace(buf);
        if (t) out.push({ t, h: isHeading });
        buf = '';
    };
    (function walk(node) {
        for (const n of node.childNodes) {
            if (n.nodeType === 3) { buf += n.nodeValue; continue; }
            if (n.nodeType !== 1) continue;
            const tag = (n.localName || n.nodeName).toLowerCase();
            if (SKIP_TAGS.has(tag)) continue;
            if (opts.skip && opts.skip(n, tag)) continue;
            if (tag === 'br') { buf += ' '; continue; }
            // Footnote reference markers like <sup><a>12</a></sup>
            if ((tag === 'sup' || tag === 'a') && /^\s*[\[(]?\d{1,3}[\])]?\s*$/.test(n.textContent) &&
                (tag === 'a' || n.querySelector('a') || n.getAttribute('epub:type') === 'noteref')) continue;
            if (BLOCK_TAGS.has(tag)) {
                flush();
                const wasHeading = isHeading;
                if (HEADING.test(tag) || tag === 'title') isHeading = true;
                walk(n);
                flush();
                isHeading = wasHeading;
            } else {
                walk(n);
            }
        }
    })(root);
    flush();
    return out;
}

// Split a flat list of blocks into chapters at headings.
function blocksToChapters(blocks, fallbackTitle) {
    const chapters = [];
    let cur = null;
    for (const b of blocks) {
        if (b.h && b.t.length < 140) {
            if (cur && !cur.paras.length) { cur.title += '. ' + b.t; continue; }
            cur = { title: b.t, paras: [] };
            chapters.push(cur);
        } else {
            if (!cur) { cur = { title: fallbackTitle || '', paras: [] }; chapters.push(cur); }
            cur.paras.push(b.t);
        }
    }
    return chapters;
}

function tidyChapters(chapters) {
    const out = [];
    for (const c of chapters) {
        const paras = c.paras.map(normalizeSpace).filter((p) => p && /[\p{L}\p{N}]/u.test(p));
        const title = normalizeSpace(c.title || '');
        if (!paras.length) {
            // A heading with no text: carry it over to the next chapter's title
            if (title && out.length === 0) continue;
            continue;
        }
        out.push({ title, paras, auto: !!c.auto });
    }
    // Merge tiny fragments (cover pages, dedications) into the next chapter
    for (let i = out.length - 2; i >= 0; i--) {
        const len = out[i].paras.join(' ').length;
        if (len < 120 && !out[i].title) {
            out[i + 1].paras = [...out[i].paras, ...out[i + 1].paras];
            out.splice(i, 1);
        }
    }
    // Generated titles are shown in the chapter list but not read aloud
    out.forEach((c, i) => { if (!c.title) { c.title = `Част ${i + 1}`; c.auto = true; } });
    return out;
}

// ---------- EPUB ----------

function resolvePath(base, href) {
    const clean = decodeURIComponent(href.split('#')[0]);
    const parts = (base + clean).split('/');
    const stack = [];
    for (const p of parts) {
        if (p === '..') stack.pop();
        else if (p !== '.' && p !== '') stack.push(p);
    }
    return stack.join('/');
}

function zipFile(zip, path) {
    return zip.file(path) || zip.file(new RegExp('^' + path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$', 'i'))[0] || null;
}

async function parseEpub(file, onProgress) {
    const JSZip = await loadScript(JSZIP_URL, 'JSZip');
    const zip = await JSZip.loadAsync(await file.arrayBuffer());
    const parser = new DOMParser();
    const containerFile = zip.file('META-INF/container.xml');
    if (!containerFile) throw new Error('Невалиден EPUB файл.');
    const container = parser.parseFromString(await containerFile.async('string'), 'application/xml');
    const opfPath = container.querySelector('rootfile')?.getAttribute('full-path');
    if (!opfPath) throw new Error('Невалиден EPUB файл.');
    const opfDir = opfPath.includes('/') ? opfPath.slice(0, opfPath.lastIndexOf('/') + 1) : '';
    const opf = parser.parseFromString(await zipFile(zip, opfPath).async('string'), 'application/xml');

    const DC = 'http://purl.org/dc/elements/1.1/';
    const dc = (name) => opf.getElementsByTagNameNS(DC, name)[0]?.textContent?.trim() || '';

    const manifest = {};
    for (const item of opf.getElementsByTagName('item')) {
        manifest[item.getAttribute('id')] = {
            href: resolvePath(opfDir, item.getAttribute('href') || ''),
            type: item.getAttribute('media-type') || '',
            props: item.getAttribute('properties') || '',
        };
    }

    // Cover image
    let cover = null;
    try {
        let coverItem = Object.values(manifest).find((m) => m.props.includes('cover-image'));
        if (!coverItem) {
            const metaCover = [...opf.getElementsByTagName('meta')].find((m) => m.getAttribute('name') === 'cover');
            if (metaCover) coverItem = manifest[metaCover.getAttribute('content')];
        }
        if (!coverItem) {
            coverItem = Object.entries(manifest).find(([id, m]) => /cover/i.test(id + m.href) && m.type.startsWith('image/'))?.[1];
        }
        if (coverItem && coverItem.type.startsWith('image/')) {
            const f = zipFile(zip, coverItem.href);
            if (f) cover = await shrinkImage(new Blob([await f.async('arraybuffer')], { type: coverItem.type }));
        }
    } catch {}

    // Table of contents titles (EPUB3 nav or EPUB2 NCX)
    const tocTitles = {};
    try {
        const navItem = Object.values(manifest).find((m) => m.props.split(/\s+/).includes('nav'));
        if (navItem) {
            const navDir = navItem.href.includes('/') ? navItem.href.slice(0, navItem.href.lastIndexOf('/') + 1) : '';
            const nav = parser.parseFromString(await zipFile(zip, navItem.href).async('string'), 'text/html');
            const tocNav = [...nav.querySelectorAll('nav')].find((n) => /toc/.test(n.getAttribute('epub:type') || n.id || '')) || nav.querySelector('nav');
            tocNav?.querySelectorAll('a[href]').forEach((a) => {
                const p = resolvePath(navDir, a.getAttribute('href'));
                if (!tocTitles[p]) tocTitles[p] = normalizeSpace(a.textContent);
            });
        }
        const ncxItem = Object.values(manifest).find((m) => m.type === 'application/x-dtbncx+xml');
        if (ncxItem && !Object.keys(tocTitles).length) {
            const ncxDir = ncxItem.href.includes('/') ? ncxItem.href.slice(0, ncxItem.href.lastIndexOf('/') + 1) : '';
            const ncx = parser.parseFromString(await zipFile(zip, ncxItem.href).async('string'), 'application/xml');
            for (const np of ncx.getElementsByTagName('navPoint')) {
                const src = np.getElementsByTagName('content')[0]?.getAttribute('src');
                const label = np.getElementsByTagName('text')[0]?.textContent;
                if (src && label) {
                    const p = resolvePath(ncxDir, src);
                    if (!tocTitles[p]) tocTitles[p] = normalizeSpace(label);
                }
            }
        }
    } catch {}

    const spine = [...opf.getElementsByTagName('itemref')]
        .filter((r) => r.getAttribute('linear') !== 'no')
        .map((r) => manifest[r.getAttribute('idref')])
        .filter((m) => m && /html|xml/.test(m.type) && !m.props.includes('nav'));

    const chapters = [];
    for (let i = 0; i < spine.length; i++) {
        onProgress((i + 1) / spine.length);
        const f = zipFile(zip, spine[i].href);
        if (!f) continue;
        const doc = parser.parseFromString(await f.async('string'), 'text/html');
        if (!doc.body) continue;
        const blocks = extractBlocks(doc.body, {
            skip: (n) => /footnote|endnote|rearnote|aside/.test(n.getAttribute('epub:type') || ''),
        });
        if (!blocks.length) continue;
        const tocTitle = tocTitles[spine[i].href];
        let title = tocTitle || '';
        // Drop the heading from the body when it duplicates the chapter title
        const firstHeading = blocks.findIndex((b) => b.h);
        if (firstHeading > -1 && firstHeading < 3) {
            const headingText = blocks.filter((b, k) => b.h && k <= firstHeading + 1).map((b) => b.t).join('. ');
            if (!title) title = headingText;
            const remaining = blocks.filter((b, k) => !(b.h && k <= firstHeading + 1));
            chapters.push({ title, paras: remaining.map((b) => b.t) });
        } else {
            chapters.push({ title, paras: blocks.map((b) => b.t) });
        }
    }

    return { title: dc('title'), author: dc('creator'), lang: dc('language'), cover, chapters };
}

// ---------- PDF ----------

async function loadPdfJs() {
    if (window.pdfjsLib) return window.pdfjsLib;
    const pdfjs = await import(/* webpackIgnore: true */ PDFJS_URL);
    pdfjs.GlobalWorkerOptions.workerSrc = PDFJS_WORKER;
    window.pdfjsLib = pdfjs;
    return pdfjs;
}

const CHAPTER_LINE = /^(глава|част|книга|пролог|епилог|увод|предговор|послеслов|chapter|part|book|prologue|epilogue|introduction|preface)(?![\p{L}])[\s\p{L}\d.:–—-]{0,40}$/iu;

async function parsePdf(file, onProgress) {
    const pdfjs = await loadPdfJs();
    const pdf = await pdfjs.getDocument({ data: await file.arrayBuffer() }).promise;
    const pages = [];
    for (let i = 1; i <= pdf.numPages; i++) {
        onProgress(i / pdf.numPages * 0.9);
        const page = await pdf.getPage(i);
        const content = await page.getTextContent();
        const lines = [];
        let cur = null;
        for (const it of content.items) {
            if (typeof it.str !== 'string') continue;
            const y = it.transform[5];
            const x = it.transform[4];
            const h = Math.abs(it.transform[3]) || it.height || 10;
            if (!cur || Math.abs(y - cur.y) > h * 0.5) {
                if (cur && cur.text.trim()) lines.push(cur);
                cur = { text: '', y, x, h, right: x };
            }
            cur.text += it.str;
            cur.right = Math.max(cur.right, x + (it.width || 0));
            if (it.hasEOL) { if (cur.text.trim()) lines.push(cur); cur = null; }
        }
        if (cur && cur.text.trim()) lines.push(cur);
        pages.push(lines);
    }

    const totalLines = pages.reduce((n, p) => n + p.length, 0);
    if (totalLines < 5) throw new Error('Този PDF няма текстов слой (вероятно е сканиран).');

    // Repeated headers/footers and page numbers
    const edgeCount = {};
    const key = (t) => t.replace(/\d+/g, '#').replace(/\s+/g, ' ').trim().toLowerCase();
    pages.forEach((lines) => {
        [lines[0], lines[1], lines[lines.length - 1], lines[lines.length - 2]].forEach((l) => {
            if (l) edgeCount[key(l.text)] = (edgeCount[key(l.text)] || 0) + 1;
        });
    });
    const repeatLimit = Math.max(3, pages.length * 0.25);
    const isNoise = (l, idx, lines) => {
        const t = l.text.trim();
        if (/^[-–—\s]*\d{1,4}[-–—\s]*$/.test(t)) return true;
        const edge = idx < 2 || idx >= lines.length - 2;
        return edge && edgeCount[key(t)] >= repeatLimit;
    };

    // Join lines into paragraphs
    const paras = []; // { t, page, heading }
    let buf = '';
    let bufPage = 0;
    const flush = (heading = false) => {
        const t = normalizeSpace(buf);
        if (t) paras.push({ t, page: bufPage, heading });
        buf = '';
    };
    pages.forEach((lines, pi) => {
        const clean = lines.filter((l, i) => !isNoise(l, i, lines));
        if (!clean.length) return;
        const left = Math.min(...clean.map((l) => l.x));
        const right = Math.max(...clean.map((l) => l.right));
        const width = right - left || 1;
        const gaps = [];
        for (let i = 1; i < clean.length; i++) gaps.push(Math.abs(clean[i - 1].y - clean[i].y));
        const typicalGap = gaps.length ? gaps.slice().sort((a, b) => a - b)[Math.floor(gaps.length / 2)] : 14;
        const bodyH = clean.map((l) => l.h).sort((a, b) => a - b)[Math.floor(clean.length / 2)];
        clean.forEach((l, i) => {
            const text = l.text.replace(/\s+$/, '');
            const t = text.trim();
            const isHeading = t.length < 80 && (CHAPTER_LINE.test(t) || l.h > bodyH * 1.35);
            if (isHeading) {
                flush();
                bufPage = pi;
                buf = t;
                flush(true);
                return;
            }
            const prev = clean[i - 1];
            let newPara = !buf;
            if (prev && buf) {
                const gap = Math.abs(prev.y - l.y);
                const prevShort = (prev.right - left) < width * 0.8;
                const indented = l.x - left > width * 0.03;
                if (gap > typicalGap * 1.6 || (prevShort && /[.!?…:"»”]$/.test(prev.text.trim())) ||
                    (indented && /[.!?…:"»”]$/.test(buf.trim())) || /^[—–-]\s/.test(t)) newPara = true;
            }
            if (newPara && buf) flush();
            if (!buf) bufPage = pi;
            // Dehyphenate words split over lines
            if (/[\p{L}]-$/u.test(buf) && /^\p{Ll}/u.test(t)) buf = buf.slice(0, -1) + t;
            else buf += (buf ? ' ' : '') + t;
        });
    });
    flush();

    // Chapters from the PDF outline when available
    let starts = [];
    try {
        const outline = await pdf.getOutline();
        if (outline && outline.length > 1) {
            for (const item of outline) {
                let dest = item.dest;
                if (typeof dest === 'string') dest = await pdf.getDestination(dest);
                if (!Array.isArray(dest)) continue;
                const pageIndex = await pdf.getPageIndex(dest[0]);
                starts.push({ page: pageIndex, title: normalizeSpace(item.title || '') });
            }
            starts.sort((a, b) => a.page - b.page);
        }
    } catch { starts = []; }

    let chapters = [];
    if (starts.length > 1) {
        let si = -1;
        let cur = { title: '', paras: [] };
        chapters.push(cur);
        for (const p of paras) {
            while (si + 1 < starts.length && p.page >= starts[si + 1].page) {
                si++;
                cur = { title: starts[si].title, paras: [] };
                chapters.push(cur);
            }
            if (p.heading && cur.paras.length === 0 && cur.title &&
                p.t.toLowerCase().replace(/\W/g, '') === cur.title.toLowerCase().replace(/\W/g, '')) continue;
            cur.paras.push(p.t);
        }
    } else {
        chapters = blocksToChapters(paras.map((p) => ({ t: p.t, h: p.heading && CHAPTER_LINE.test(p.t) })), '');
        // Large books without detectable chapters: split by pages so the list stays usable
        if (chapters.length < 2 && pages.length > 20) {
            chapters = [];
            const step = 12;
            for (let from = 0; from < pages.length; from += step) {
                const part = paras.filter((p) => p.page >= from && p.page < from + step).map((p) => p.t);
                if (part.length) chapters.push({ title: `Стр. ${from + 1}–${Math.min(from + step, pages.length)}`, paras: part, auto: true });
            }
        }
    }

    let cover = null;
    try {
        const page = await pdf.getPage(1);
        const vp = page.getViewport({ scale: 1 });
        const scale = 360 / vp.width;
        const view = page.getViewport({ scale });
        const canvas = document.createElement('canvas');
        canvas.width = view.width;
        canvas.height = view.height;
        await page.render({ canvasContext: canvas.getContext('2d'), viewport: view }).promise;
        cover = await new Promise((r) => canvas.toBlob(r, 'image/jpeg', 0.8));
    } catch {}

    let meta = {};
    try { meta = (await pdf.getMetadata()).info || {}; } catch {}
    onProgress(1);
    return { title: meta.Title, author: meta.Author, cover, chapters };
}

// ---------- FB2 ----------

async function parseFb2(file) {
    const buf = await file.arrayBuffer();
    const head = new TextDecoder('ascii').decode(buf.slice(0, 200));
    const enc = (head.match(/encoding=["']([\w-]+)["']/i) || [])[1];
    const xml = decodeBuffer(buf, enc);
    const doc = new DOMParser().parseFromString(xml, 'application/xml');
    const byTag = (root, tag) => [...root.getElementsByTagName(tag)];
    const titleInfo = byTag(doc, 'title-info')[0];
    const title = titleInfo ? byTag(titleInfo, 'book-title')[0]?.textContent : '';
    const authorEl = titleInfo ? byTag(titleInfo, 'author')[0] : null;
    const author = authorEl
        ? ['first-name', 'middle-name', 'last-name'].map((t) => byTag(authorEl, t)[0]?.textContent || '').join(' ')
        : '';
    const lang = titleInfo ? byTag(titleInfo, 'lang')[0]?.textContent : '';

    let cover = null;
    try {
        const img = titleInfo && byTag(titleInfo, 'coverpage')[0]?.getElementsByTagName('image')[0];
        const href = img && [...img.attributes].find((a) => /href$/.test(a.name))?.value.replace('#', '');
        const bin = href && byTag(doc, 'binary').find((b) => b.getAttribute('id') === href);
        if (bin) {
            const bytes = Uint8Array.from(atob(bin.textContent.replace(/\s+/g, '')), (c) => c.charCodeAt(0));
            cover = await shrinkImage(new Blob([bytes], { type: bin.getAttribute('content-type') || 'image/jpeg' }));
        }
    } catch {}

    const bodies = byTag(doc, 'body').filter((b) => !/notes|comments/.test(b.getAttribute('name') || ''));
    const chapters = [];
    const walkSection = (sec) => {
        const childSections = [...sec.children].filter((c) => c.localName === 'section');
        const titleEl = [...sec.children].find((c) => c.localName === 'title');
        const secTitle = titleEl ? normalizeSpace(extractBlocks(titleEl).map((b) => b.t).join('. ')) : '';
        const blocks = extractBlocks(sec, { skip: (n, tag) => tag === 'section' || n === titleEl });
        if (blocks.length || !childSections.length) chapters.push({ title: secTitle, paras: blocks.map((b) => b.t) });
        else if (secTitle && childSections.length) {
            // Part heading: prefix it to the first sub-chapter
            const before = chapters.length;
            childSections.forEach(walkSection);
            if (chapters[before]) chapters[before].title = secTitle + (chapters[before].title ? '. ' + chapters[before].title : '');
            return;
        }
        childSections.forEach(walkSection);
    };
    for (const body of bodies) {
        const sections = [...body.children].filter((c) => c.localName === 'section');
        if (sections.length) sections.forEach(walkSection);
        else chapters.push({ title: '', paras: extractBlocks(body).map((b) => b.t) });
    }
    return { title, author, lang, cover, chapters };
}

// ---------- DOCX ----------

async function parseDocx(file) {
    const JSZip = await loadScript(JSZIP_URL, 'JSZip');
    const zip = await JSZip.loadAsync(await file.arrayBuffer());
    const docFile = zip.file('word/document.xml');
    if (!docFile) throw new Error('Невалиден DOCX файл.');
    const doc = new DOMParser().parseFromString(await docFile.async('string'), 'application/xml');
    const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
    const blocks = [];
    for (const p of doc.getElementsByTagNameNS(W, 'p')) {
        const style = p.getElementsByTagNameNS(W, 'pStyle')[0]?.getAttributeNS(W, 'val') || '';
        let t = '';
        for (const n of p.getElementsByTagNameNS(W, '*')) {
            if (n.localName === 't') t += n.textContent;
            else if (n.localName === 'tab' || n.localName === 'br') t += ' ';
        }
        t = normalizeSpace(t);
        if (t) blocks.push({ t, h: /heading|title|заглавие/i.test(style) && t.length < 140 });
    }
    let title = '', author = '';
    try {
        const core = zip.file('docProps/core.xml');
        if (core) {
            const c = new DOMParser().parseFromString(await core.async('string'), 'application/xml');
            title = c.getElementsByTagNameNS('http://purl.org/dc/elements/1.1/', 'title')[0]?.textContent || '';
            author = c.getElementsByTagNameNS('http://purl.org/dc/elements/1.1/', 'creator')[0]?.textContent || '';
        }
    } catch {}
    return { title, author, cover: null, chapters: blocksToChapters(blocks, '') };
}

// ---------- HTML / TXT / MD ----------

function parseHtml(html) {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const blocks = extractBlocks(doc.body || doc.documentElement);
    return { title: doc.title, author: '', cover: null, chapters: blocksToChapters(blocks, '') };
}

const TXT_CHAPTER = /^\s*(глава|част|книга|пролог|епилог|chapter|part|prologue|epilogue)(?![\p{L}]).{0,60}$|^\s*([IVXLC]{1,6}|\d{1,3})\.?\s*$/iu;

function parsePlain(text, markdown) {
    text = text.replace(/\r\n?/g, '\n');
    const hasBlankLines = /\n\s*\n/.test(text);
    const rawParas = hasBlankLines ? text.split(/\n\s*\n/) : text.split('\n');
    const blocks = [];
    for (let raw of rawParas) {
        if (markdown) {
            const lines = raw.split('\n');
            // Markdown headings can sit directly above a paragraph
            while (lines.length && /^#{1,3}\s/.test(lines[0])) {
                blocks.push({ t: normalizeSpace(lines.shift().replace(/^#+\s*/, '')), h: true });
            }
            raw = lines.join('\n')
                .replace(/!\[[^\]]*]\([^)]*\)/g, '')
                .replace(/\[([^\]]+)]\([^)]*\)/g, '$1')
                .replace(/^[>\-*+]\s+/gm, '')
                .replace(/[*_`]+/g, '');
        }
        const t = normalizeSpace(raw.replace(/([\p{L}])-\n(\p{Ll})/gu, '$1$2'));
        if (!t) continue;
        blocks.push({ t, h: !markdown && t.length < 70 && TXT_CHAPTER.test(t) });
    }
    return { title: '', author: '', cover: null, chapters: blocksToChapters(blocks, '') };
}

// ---------- images ----------

async function shrinkImage(blob, maxW = 400) {
    try {
        const bmp = await createImageBitmap(blob);
        const scale = Math.min(1, maxW / bmp.width);
        const canvas = document.createElement('canvas');
        canvas.width = Math.round(bmp.width * scale);
        canvas.height = Math.round(bmp.height * scale);
        canvas.getContext('2d').drawImage(bmp, 0, 0, canvas.width, canvas.height);
        return await new Promise((r) => canvas.toBlob(r, 'image/jpeg', 0.82));
    } catch {
        return blob;
    }
}
