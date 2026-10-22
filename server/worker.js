// Разказвач library worker (Cloudflare).
//
//   GET  /health                         → { ok, audio, trans }
//   GET  /gutenberg/:id.epub             → Project Gutenberg EPUB with CORS (edge-cached)
//   GET  /audio/:key   HEAD /audio/:key   → shared narration chunk from R2
//   PUT  /audio/:key                     → store a chunk; the key must be the SHA-1 of
//                                          "voice|lang|text" sent in the headers
//   GET  /trans/:key   PUT /trans/:key    → shared chapter translation (JSON)
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

function cors(req) {
    const origin = req.headers.get('Origin') || '';
    const ok = ALLOWED_ORIGINS.includes(origin) || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
    return {
        'Access-Control-Allow-Origin': ok ? origin : ALLOWED_ORIGINS[0],
        'Access-Control-Allow-Methods': 'GET, HEAD, PUT, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, X-Rz-Voice, X-Rz-Lang, X-Rz-Text',
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

export default {
    async fetch(req, env, ctx) {
        if (req.method === 'OPTIONS') return new Response(null, { headers: cors(req) });
        const url = new URL(req.url);
        const path = decodeURIComponent(url.pathname);
        try {
            if (path === '/health') return json(req, { ok: true, audio: !!env.AUDIO, trans: !!env.AUDIO });
            let m = path.match(/^\/gutenberg\/(\d{1,7})\.epub$/);
            if (m && req.method === 'GET') return gutenberg(req, m[1], ctx);
            m = path.match(/^\/audio\/([0-9a-f]{40})$/);
            if (m) return audio(req, env, m[1]);
            m = path.match(/^\/trans\/(.+)$/);
            if (m) return trans(req, env, m[1]);
            return json(req, { error: 'not found' }, 404);
        } catch (e) {
            return json(req, { error: String(e?.message || e) }, 500);
        }
    },
};
