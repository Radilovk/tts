// Разказвач library worker (Cloudflare).
//
//   GET  /health                         → { ok, audio, trans }
//   GET  /gutenberg/:id.epub             → Project Gutenberg EPUB with CORS (edge-cached)
//   GET  /audio/:key   HEAD /audio/:key   → shared narration chunk from R2
//   PUT  /audio/:key                     → store a chunk; the key must be the SHA-1 of
//                                          "voice|lang|text" sent in the headers
//   GET  /trans/:key   PUT /trans/:key    → shared chapter translation (JSON)
//   GET  /proxy?url=…                    → open libraries without browser CORS (arXiv, OAPEN,
//                                          Internet Archive, Gutenberg); allow-listed hosts only
//   GET  /community?q=…                  → books shared by readers (title, author, source, rights)
//   GET  /community/:id                  → one shared book (parsed text, JSON)
//   POST /community                      → share a book: text + source + rights declaration
//   POST /community/:id/report           → notice of infringement: the book is hidden at once
//   POST /community/:id/restore          → (admin, ADMIN_TOKEN) show a reported book again
//
// Night studio (whole books narrated on the server while the app is closed). No secrets
// to set up anywhere:
//   • the app sends its Gemini key in "X-Rz-Key"; the jobs are filed under a hash of it,
//     so each key sees only its own books; the key itself travels inside the job (it is
//     what pays for the narration);
//   • the runner (.github/workflows/night-studio.yml in Radilovk/tts) proves itself with
//     the OIDC token GitHub signs for every workflow run — verified here against GitHub's
//     public keys — and may then read every job. Runner calls add ?o=<owner>.
//   POST   /jobs                         → queue a book: { title, engine, mode, items:[{key,vk,lang,text,req}] }
//   GET    /jobs                         → state of every job (the runner and the app)
//   GET    /jobs/:id                     → state of one job
//   GET    /jobs/:id/book                → the full job with texts and requests (the runner)
//   PUT    /jobs/:id                     → update the state (the runner: progress, batches, cost)
//   DELETE /jobs/:id                     → cancel / forget a job
//
// Google HD free characters (the app stops Google HD before they run out):
//   GET  /usage                          → { month, cloud: { tier: chars } } for the key in X-Rz-Key
//   POST /usage  { tier, chars }         → add the characters of one request; returns the totals
// The count is filed under a hash of the key, so the phone app, the browser and other
// devices that use the same key add up. Months are Google's billing months (Pacific time).
// The runner (.github/workflows/night-studio.yml) stores finished passages through
// PUT /audio/:key, so the player finds them by the same keys as any cached passage.
//
// Only public-domain books use the shared store (the app decides; see js/library.js).
// Every chunk is synthesized once and then served to every listener.

const ALLOWED_ORIGINS = [
    'https://radilovk.github.io',
    'https://biocode.website',
    'https://localhost',      // Android app (Capacitor)
    'capacitor://localhost',
];
const MAX_AUDIO_BYTES = 12 * 1024 * 1024;
const MAX_TRANS_BYTES = 2 * 1024 * 1024;
const MAX_PROXY_BYTES = 80 * 1024 * 1024;
const MAX_BOOK_BYTES = 6 * 1024 * 1024;
const MAX_JOB_BYTES = 40 * 1024 * 1024;
const RIGHTS = ['pd', 'own', 'cc0', 'cc-by', 'cc-by-sa'];
const PROXY_HOSTS = [/^(export\.)?arxiv\.org$/, /^library\.oapen\.org$/, /^([\w-]+\.)*archive\.org$/, /^(www\.)?gutenberg\.org$/];

function cors(req) {
    const origin = req.headers.get('Origin') || '';
    const ok = ALLOWED_ORIGINS.includes(origin) || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
    return {
        'Access-Control-Allow-Origin': ok ? origin : ALLOWED_ORIGINS[0],
        'Access-Control-Allow-Methods': 'GET, HEAD, PUT, POST, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, X-Rz-Voice, X-Rz-Lang, X-Rz-Text, X-Rz-Key, Authorization',
        'Access-Control-Max-Age': '86400',
        Vary: 'Origin',
    };
}

function json(req, data, status = 200) {
    return new Response(JSON.stringify(data), { status, headers: { ...cors(req), 'Content-Type': 'application/json' } });
}

async function sha1Hex(str) {
    const buf = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(str));
    return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function b64ToUtf8(b64) {
    const bin = atob(b64);
    return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
}

async function gutenberg(req, id, ctx) {
    const cache = caches.default;
    const cacheKey = new Request(`https://cache.razkazvach/gutenberg/v2/${id}.epub`);
    let res = await cache.match(cacheKey);
    if (!res) {
        const urls = [
            // Text-only EPUB with cover: ~0.5 MB instead of ~25 MB with all illustrations
            `https://www.gutenberg.org/cache/epub/${id}/pg${id}.epub`,
            `https://www.gutenberg.org/ebooks/${id}.epub.noimages`,
            `https://www.gutenberg.org/cache/epub/${id}/pg${id}-images-3.epub`,
        ];
        for (const u of urls) {
            const r = await fetch(u, { headers: { 'User-Agent': 'RazkazvachLibrary/1.0 (+https://github.com/Radilovk/tts)' } });
            if (r.ok && (r.headers.get('content-type') || '').includes('epub')) {
                res = new Response(r.body, {
                    headers: { 'Content-Type': 'application/epub+zip', 'Cache-Control': 'public, max-age=2592000' },
                });
                ctx.waitUntil(cache.put(cacheKey, res.clone()));
                break;
            }
        }
        if (!res) return json(req, { error: 'Книгата не е намерена в Project Gutenberg.' }, 404);
    }
    const out = new Response(res.body, res);
    for (const [k, v] of Object.entries(cors(req))) out.headers.set(k, v);
    return out;
}

async function proxy(req, ctx) {
    let target;
    try { target = new URL(new URL(req.url).searchParams.get('url') || ''); } catch { return json(req, { error: 'bad url' }, 400); }
    if (target.protocol !== 'https:' || !PROXY_HOSTS.some((re) => re.test(target.hostname))) return json(req, { error: 'host not allowed' }, 403);
    const cache = caches.default;
    const cacheKey = new Request(`https://cache.razkazvach/proxy/${encodeURIComponent(target.href)}`);
    let res = await cache.match(cacheKey);
    if (!res) {
        const r = await fetch(target.href, { headers: { 'User-Agent': 'RazkazvachLibrary/1.0 (+https://github.com/Radilovk/tts)' }, redirect: 'follow' });
        const len = Number(r.headers.get('content-length') || 0);
        if (len > MAX_PROXY_BYTES) return json(req, { error: 'too large' }, 413);
        res = new Response(r.body, {
            status: r.status,
            headers: { 'Content-Type': r.headers.get('content-type') || 'application/octet-stream', 'Cache-Control': 'public, max-age=86400' },
        });
        if (r.ok) ctx.waitUntil(cache.put(cacheKey, res.clone()));
    }
    const out = new Response(res.body, res);
    for (const [k, v] of Object.entries(cors(req))) out.headers.set(k, v);
    return out;
}

async function audio(req, env, key) {
    if (!env.AUDIO) return json(req, { error: 'Общият аудио кеш не е включен.' }, 503);
    if (!/^[0-9a-f]{40}$/.test(key)) return json(req, { error: 'bad key' }, 400);
    const objKey = `a/${key.slice(0, 2)}/${key}`;

    if (req.method === 'GET' || req.method === 'HEAD') {
        const obj = req.method === 'HEAD' ? await env.AUDIO.head(objKey) : await env.AUDIO.get(objKey);
        if (!obj) return new Response(null, { status: 404, headers: cors(req) });
        const headers = {
            ...cors(req),
            'Content-Type': obj.httpMetadata?.contentType || 'audio/wav',
            'Cache-Control': 'public, max-age=31536000, immutable',
            'X-Rz-Dur': obj.customMetadata?.dur || '',
            'X-Rz-Chars': obj.customMetadata?.chars || '',
            'Access-Control-Expose-Headers': 'X-Rz-Dur, X-Rz-Chars',
        };
        return new Response(req.method === 'HEAD' ? null : obj.body, { headers });
    }

    if (req.method === 'PUT') {
        // The key must match the text it claims to be, so nobody can fill another text's slot
        let voice = '';
        try { voice = decodeURIComponent(req.headers.get('X-Rz-Voice') || ''); } catch {}
        const lang = req.headers.get('X-Rz-Lang') || '';
        let text = '';
        try { text = b64ToUtf8(req.headers.get('X-Rz-Text') || ''); } catch { return json(req, { error: 'bad text' }, 400); }
        if (!voice || !text || (await sha1Hex(`${voice}|${lang}|${text}`)) !== key) return json(req, { error: 'key mismatch' }, 400);
        const type = req.headers.get('Content-Type') || '';
        if (!/^audio\/(wav|mpeg|ogg)/.test(type)) return json(req, { error: 'bad type' }, 415);
        const len = Number(req.headers.get('Content-Length') || 0);
        if (!len || len > MAX_AUDIO_BYTES) return json(req, { error: 'bad size' }, 413);
        if (await env.AUDIO.head(objKey)) return json(req, { ok: true, existed: true });
        const url = new URL(req.url);
        await env.AUDIO.put(objKey, req.body, {
            httpMetadata: { contentType: type },
            customMetadata: { dur: url.searchParams.get('dur') || '', chars: String(text.length), voice },
        });
        return json(req, { ok: true });
    }
    return json(req, { error: 'method' }, 405);
}

async function trans(req, env, key) {
    if (!env.AUDIO) return json(req, { error: 'Общият кеш не е включен.' }, 503);
    // source | target language | chapter | number of paragraphs
    if (!/^[a-z]+-[\w.-]{1,80}\|[a-z]{2}\|\d{1,4}\|\d{1,6}$/.test(key)) return json(req, { error: 'bad key' }, 400);
    const objKey = `t/${key}`;
    if (req.method === 'GET') {
        const obj = await env.AUDIO.get(objKey);
        if (!obj) return new Response(null, { status: 404, headers: cors(req) });
        return new Response(obj.body, { headers: { ...cors(req), 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=86400' } });
    }
    if (req.method === 'PUT') {
        const body = await req.text();
        if (body.length > MAX_TRANS_BYTES) return json(req, { error: 'bad size' }, 413);
        let data;
        try { data = JSON.parse(body); } catch { return json(req, { error: 'bad json' }, 400); }
        if (!data || !Array.isArray(data.paras) || typeof data.title !== 'string') return json(req, { error: 'bad shape' }, 400);
        if (data.paras.length !== Number(key.split('|')[3])) return json(req, { error: 'paragraph count mismatch' }, 400);
        // First good translation wins; it is then shared with everyone
        if (await env.AUDIO.head(objKey)) return json(req, { ok: true, existed: true });
        await env.AUDIO.put(objKey, body, { httpMetadata: { contentType: 'application/json' } });
        return json(req, { ok: true });
    }
    return json(req, { error: 'method' }, 405);
}

// ---------- books shared by readers ----------
// The reader who uploads a book names where it comes from and declares the legal
// basis (public domain, own work or a free licence). Anyone can report a book; a
// reported book disappears from the library until it is reviewed.

const cleanStr = (v, n) => String(v ?? '').replace(/[\u0000-\u001f]+/g, ' ').trim().slice(0, n);

async function communityList(req, env) {
    const q = cleanStr(new URL(req.url).searchParams.get('q'), 100).toLowerCase();
    const out = [];
    let cursor;
    do {
        const page = await env.AUDIO.list({ prefix: 'c/m/', cursor, include: ['customMetadata'], limit: 1000 });
        for (const o of page.objects) {
            const m = o.customMetadata || {};
            if (m.hidden === '1') continue;
            if (q && !`${m.title} ${m.author}`.toLowerCase().includes(q)) continue;
            out.push({ id: o.key.slice(4), title: m.title, author: m.author, lang: m.lang, rights: m.rights,
                source: m.source, by: m.by, year: Number(m.year) || null, uploaded: Number(m.uploaded) || 0 });
        }
        cursor = page.truncated ? page.cursor : null;
    } while (cursor && out.length < 2000);
    out.sort((a, b) => b.uploaded - a.uploaded);
    return json(req, { items: out.slice(0, q ? 40 : 30) });
}

async function communityGet(req, env, id) {
    const meta = await env.AUDIO.head(`c/m/${id}`);
    if (!meta || meta.customMetadata?.hidden === '1') return json(req, { error: 'Книгата не е налична.' }, 404);
    const obj = await env.AUDIO.get(`c/b/${id}`);
    if (!obj) return json(req, { error: 'Книгата не е налична.' }, 404);
    return new Response(obj.body, { headers: { ...cors(req), 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=300' } });
}

async function communityPost(req, env) {
    const body = await req.text();
    if (body.length > MAX_BOOK_BYTES) return json(req, { error: 'Книгата е твърде голяма (до 6 MB текст).' }, 413);
    let d;
    try { d = JSON.parse(body); } catch { return json(req, { error: 'bad json' }, 400); }
    const title = cleanStr(d.title, 200);
    const author = cleanStr(d.author, 200);
    const lang = cleanStr(d.lang, 5).toLowerCase();
    const source = cleanStr(d.source, 300);
    const rights = String(d.rights || '');
    const by = cleanStr(d.by, 60);
    const year = new Date().getFullYear();
    const death = Number(d.authorDeath) || 0;
    const trDeath = d.translatorDeath === null || d.translatorDeath === undefined || d.translatorDeath === '' ? null : Number(d.translatorDeath);
    if (!title || !source || source.length < 4) return json(req, { error: 'Нужни са заглавие и източник.' }, 400);
    if (!RIGHTS.includes(rights) || d.declare !== true) return json(req, { error: 'Нужна е декларация за правата.' }, 400);
    if (rights === 'pd') {
        // EU: free 70 years after the death of the author (and of the translator)
        if (!death || death > year - 71) return json(req, { error: `Обществено достояние е само ако авторът е починал до ${year - 71} г.` }, 400);
        if (trDeath !== null && (!trDeath || trDeath > year - 71)) return json(req, { error: `Преводът също трябва да е свободен: преводачът да е починал до ${year - 71} г.` }, 400);
    }
    if (!Array.isArray(d.chapters) || !d.chapters.length || d.chapters.length > 2000) return json(req, { error: 'Няма текст.' }, 400);
    const chapters = d.chapters.map((c) => ({
        title: cleanStr(c?.title, 300),
        paras: (Array.isArray(c?.paras) ? c.paras : []).map((p) => String(p ?? '').slice(0, 20000)).filter(Boolean),
    })).filter((c) => c.paras.length);
    if (!chapters.length) return json(req, { error: 'Няма текст.' }, 400);
    // The same text always gets the same id, so a book is stored once
    const id = (await sha1Hex(chapters.map((c) => c.paras.join('\n')).join('\n\n'))).slice(0, 20);
    const existing = await env.AUDIO.head(`c/m/${id}`);
    if (existing) {
        if (existing.customMetadata?.hidden === '1') return json(req, { error: 'Тази книга е премахната след сигнал.' }, 409);
        return json(req, { ok: true, id, existed: true });
    }
    const book = { title, author, lang, chapters, source, rights, by };
    await env.AUDIO.put(`c/b/${id}`, JSON.stringify(book), { httpMetadata: { contentType: 'application/json' } });
    await env.AUDIO.put(`c/m/${id}`, '', {
        customMetadata: {
            title, author, lang, source, rights, by, year: String(Number(d.year) || ''), uploaded: String(Date.now()),
            authorDeath: String(death || ''), translatorDeath: trDeath === null ? '' : String(trDeath),
            ip: req.headers.get('CF-Connecting-IP') || '', hidden: '0',
        },
    });
    return json(req, { ok: true, id });
}

async function setHidden(env, id, hidden) {
    const meta = await env.AUDIO.head(`c/m/${id}`);
    if (!meta) return false;
    await env.AUDIO.put(`c/m/${id}`, '', { customMetadata: { ...meta.customMetadata, hidden: hidden ? '1' : '0' } });
    return true;
}

async function communityReport(req, env, id) {
    let d = {};
    try { d = await req.json(); } catch {}
    const reason = cleanStr(d.reason, 2000);
    if (reason.length < 5) return json(req, { error: 'Опишете накратко нарушението.' }, 400);
    if (!(await setHidden(env, id, true))) return json(req, { error: 'not found' }, 404);
    await env.AUDIO.put(`c/r/${id}/${Date.now()}`, JSON.stringify({
        reason, contact: cleanStr(d.contact, 200), at: new Date().toISOString(), ip: req.headers.get('CF-Connecting-IP') || '',
    }), { httpMetadata: { contentType: 'application/json' } });
    return json(req, { ok: true });
}

async function communityRestore(req, env, id) {
    if (!env.ADMIN_TOKEN || req.headers.get('Authorization') !== `Bearer ${env.ADMIN_TOKEN}`) return json(req, { error: 'forbidden' }, 403);
    return (await setHidden(env, id, false)) ? json(req, { ok: true }) : json(req, { error: 'not found' }, 404);
}

// ---------- Google HD usage (free characters per key and month) ----------

const USAGE_TIERS = ['Chirp3-HD', 'Neural2', 'Wavenet', 'Standard', 'Studio', 'Other'];

function billingMonth(d = new Date()) {
    const p = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit' }).formatToParts(d);
    return `${p.find((x) => x.type === 'year').value}-${p.find((x) => x.type === 'month').value}`;
}

async function usage(req, env) {
    if (!env.AUDIO) return json(req, { error: 'Сървърът няма хранилище (R2).' }, 503);
    const owner = await studioOwner(req);
    if (!owner) return json(req, { error: 'Нужен е Google API ключ.' }, 403);
    const month = billingMonth();
    const path = `u/${owner}/${month}`;
    const obj = await env.AUDIO.get(path);
    const cloud = obj ? (await obj.json()).cloud || {} : {};
    if (req.method === 'POST') {
        const body = await req.json().catch(() => ({}));
        const tier = USAGE_TIERS.includes(body.tier) ? body.tier : 'Other';
        const chars = Math.floor(Number(body.chars));
        if (!(chars > 0 && chars <= 20000)) return json(req, { error: 'chars' }, 400);
        cloud[tier] = (cloud[tier] || 0) + chars;
        await env.AUDIO.put(path, JSON.stringify({ cloud }), { httpMetadata: { contentType: 'application/json' } });
    } else if (req.method !== 'GET') {
        return json(req, { error: 'method' }, 405);
    }
    return json(req, { month, cloud });
}

// ---------- night studio ----------

async function studioOwner(req) {
    const key = req.headers.get('X-Rz-Key') || '';
    if (!/^[\w-]{20,200}$/.test(key)) return '';
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('razkazvach-studio|' + key));
    return [...new Uint8Array(buf)].slice(0, 12).map((b) => b.toString(16).padStart(2, '0')).join('');
}

// ---- GitHub Actions OIDC (the runner) ----
const OIDC_ISSUER = 'https://token.actions.githubusercontent.com';
const OIDC_AUDIENCE = 'razkazvach-studio';
const RUNNER_REPO = 'radilovk/tts';
let jwksCache = null;

function b64urlBytes(s) {
    const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4));
    return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

async function isRunner(req) {
    const m = (req.headers.get('Authorization') || '').match(/^Bearer\s+([\w-]+)\.([\w-]+)\.([\w-]+)$/);
    if (!m) return false;
    try {
        const header = JSON.parse(new TextDecoder().decode(b64urlBytes(m[1])));
        const claims = JSON.parse(new TextDecoder().decode(b64urlBytes(m[2])));
        const now = Date.now() / 1000;
        if (header.alg !== 'RS256' || claims.iss !== OIDC_ISSUER || claims.aud !== OIDC_AUDIENCE) return false;
        if (!(claims.exp > now) || String(claims.repository || '').toLowerCase() !== RUNNER_REPO) return false;
        if (!jwksCache || jwksCache.at < Date.now() - 3600_000 || !jwksCache.keys.some((k) => k.kid === header.kid)) {
            const r = await fetch(`${OIDC_ISSUER}/.well-known/jwks`);
            jwksCache = { at: Date.now(), keys: (await r.json()).keys || [] };
        }
        const jwk = jwksCache.keys.find((k) => k.kid === header.kid);
        if (!jwk) return false;
        const key = await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
        return await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, b64urlBytes(m[3]), new TextEncoder().encode(`${m[1]}.${m[2]}`));
    } catch {
        return false;
    }
}

const STATE_FIELDS = ['status', 'done', 'failed', 'failedKeys', 'batches', 'freeDay', 'costUsd', 'usage', 'error', 'log'];

async function jobState(env, id, owner) {
    const obj = await env.AUDIO.get(`j/s/${owner}/${id}`);
    return obj ? obj.json() : null;
}

// owner '' (the runner): every owner's jobs
async function jobsList(req, env, owner) {
    const out = [];
    let cursor;
    const prefix = owner ? `j/s/${owner}/` : 'j/s/';
    do {
        const page = await env.AUDIO.list({ prefix, cursor, limit: 1000 });
        for (const o of page.objects) {
            const [, , own, id] = o.key.split('/');
            const st = id && await jobState(env, id, own);
            if (st) out.push({ ...st, owner: own });
        }
        cursor = page.truncated ? page.cursor : null;
    } while (cursor);
    out.sort((a, b) => a.created - b.created);
    return json(req, { jobs: out });
}

async function jobCreate(req, env, owner) {
    const body = await req.text();
    if (body.length > MAX_JOB_BYTES) return json(req, { error: 'Книгата е твърде голяма.' }, 413);
    let d;
    try { d = JSON.parse(body); } catch { return json(req, { error: 'bad json' }, 400); }
    if (!['gemini', 'cloud'].includes(d.engine)) return json(req, { error: 'bad engine' }, 400);
    if (!Array.isArray(d.items) || !d.items.length || d.items.length > 20000) return json(req, { error: 'Няма текст.' }, 400);
    for (const it of d.items) {
        if (!/^[0-9a-f]{40}$/.test(it?.key || '') || !it.text || !it.vk || !it.req) return json(req, { error: 'bad item' }, 400);
    }
    // The key that pays for the narration is the one the job was filed with
    d.apiKey = req.headers.get('X-Rz-Key');
    const id = crypto.randomUUID().replace(/-/g, '').slice(0, 20);
    const now = Date.now();
    const state = {
        id, created: now, updated: now, bookId: cleanStr(d.bookId, 60), title: cleanStr(d.title, 200), author: cleanStr(d.author, 200),
        engine: d.engine, model: cleanStr(d.model, 80), voice: cleanStr(d.voice, 80), mode: cleanStr(d.mode, 20) || 'batch',
        total: d.items.length, chars: d.items.reduce((n, it) => n + String(it.text).length, 0),
        status: 'queued', done: 0, failed: 0, batches: [], costUsd: 0, error: '', log: '',
    };
    await env.AUDIO.put(`j/b/${owner}/${id}`, JSON.stringify(d), { httpMetadata: { contentType: 'application/json' } });
    await env.AUDIO.put(`j/s/${owner}/${id}`, JSON.stringify(state), { httpMetadata: { contentType: 'application/json' } });
    return json(req, state);
}

async function jobUpdate(req, env, id, owner) {
    const st = await jobState(env, id, owner);
    if (!st) return json(req, { error: 'not found' }, 404);
    let d = {};
    try { d = await req.json(); } catch { return json(req, { error: 'bad json' }, 400); }
    for (const k of STATE_FIELDS) if (k in d) st[k] = d[k];
    st.updated = Date.now();
    await env.AUDIO.put(`j/s/${owner}/${id}`, JSON.stringify(st), { httpMetadata: { contentType: 'application/json' } });
    return json(req, st);
}

async function jobs(req, env, id, sub) {
    if (!env.AUDIO) return json(req, { error: 'Сървърът няма хранилище (R2).' }, 503);
    const runner = await isRunner(req);
    const owner = runner ? (new URL(req.url).searchParams.get('o') || '').replace(/[^0-9a-f]/g, '') : await studioOwner(req);
    if (!runner && !owner) return json(req, { error: 'Нужен е Google API ключ.' }, 403);
    if (!id && req.method === 'GET') return jobsList(req, env, owner);
    if (!id && req.method === 'POST') return runner ? json(req, { error: 'method' }, 405) : jobCreate(req, env, owner);
    if (!owner) return json(req, { error: 'owner' }, 400);
    if (id && sub === '/book' && req.method === 'GET') {
        const obj = await env.AUDIO.get(`j/b/${owner}/${id}`);
        if (!obj) return json(req, { error: 'not found' }, 404);
        return new Response(obj.body, { headers: { ...cors(req), 'Content-Type': 'application/json' } });
    }
    if (id && !sub && req.method === 'GET') {
        const st = await jobState(env, id, owner);
        return st ? json(req, st) : json(req, { error: 'not found' }, 404);
    }
    if (id && !sub && req.method === 'PUT') return jobUpdate(req, env, id, owner);
    if (id && !sub && req.method === 'DELETE') {
        await env.AUDIO.delete([`j/s/${owner}/${id}`, `j/b/${owner}/${id}`]);
        return json(req, { ok: true });
    }
    return json(req, { error: 'method' }, 405);
}

export default {
    async fetch(req, env, ctx) {
        if (req.method === 'OPTIONS') return new Response(null, { headers: cors(req) });
        const url = new URL(req.url);
        const path = decodeURIComponent(url.pathname);
        try {
            if (path === '/health') return json(req, { ok: true, audio: !!env.AUDIO, trans: !!env.AUDIO, studio: !!env.AUDIO });
            let m = path.match(/^\/gutenberg\/(\d{1,7})\.epub$/);
            if (m && req.method === 'GET') return gutenberg(req, m[1], ctx);
            if (path === '/proxy' && req.method === 'GET') return proxy(req, ctx);
            m = path.match(/^\/audio\/([0-9a-f]{40})$/);
            if (m) return audio(req, env, m[1]);
            if (path.startsWith('/community') && !env.AUDIO) return json(req, { error: 'Общата библиотека не е включена.' }, 503);
            if (path === '/community' && req.method === 'GET') return communityList(req, env);
            if (path === '/community' && req.method === 'POST') return communityPost(req, env);
            m = path.match(/^\/community\/([0-9a-f]{20})(\/report|\/restore)?$/);
            if (m && !m[2] && req.method === 'GET') return communityGet(req, env, m[1]);
            if (m && m[2] === '/report' && req.method === 'POST') return communityReport(req, env, m[1]);
            if (m && m[2] === '/restore' && req.method === 'POST') return communityRestore(req, env, m[1]);
            if (path === '/usage') return usage(req, env);
            m = path.match(/^\/jobs(?:\/([0-9a-f]{20})(\/book)?)?$/);
            if (m) return jobs(req, env, m[1], m[2]);
            m = path.match(/^\/trans\/(.+)$/);
            if (m) return trans(req, env, m[1]);
            return json(req, { error: 'not found' }, 404);
        } catch (e) {
            return json(req, { error: String(e?.message || e) }, 500);
        }
    },
};
