// Free picture and footage sources for the video pipeline (scripts/video/make-video.mjs).
//
// Each search returns candidates in one shape:
//   { id, source, kind: 'photo'|'video', url, thumb, width, height, duration?, author, page, license, resolve? }
// (`resolve()` — when the file URL needs one more request, made only for the chosen shot.)
// Footage first: Pixabay and Pexels (key), and without a key Wikimedia Commons video (archival
// films, newsreels, microscopy, lectures — history and science) and NASA video (space, Earth,
// physics). Photos (only when no footage fits): Wikimedia Commons, NASA, Openverse. With a free key (GitHub
// secret): Pixabay (PIXABAY_API_KEY — photos and videos, no attribution required, results
// kept 24 h), Pexels (PEXELS_API_KEY — attribution link to Pexels). Search parameters
// follow MoneyPrinterTurbo (harry0703/MoneyPrinterTurbo, MIT): landscape, at least the
// output size, smallest rendition that still fills it.

const UA = 'Razkazvach-video/1.0 (https://github.com/Radilovk/tts)';
const W = 1920, H = 1080;

const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
// Wikimedia answers 429 quickly to parallel clients: its requests go one at a time, ~1 per second
let commonsQueue = Promise.resolve();
function commonsJson(url) {
    const run = commonsQueue.then(() => getJson(url));
    commonsQueue = run.catch(() => {}).then(() => sleep(1100));
    return run;
}

async function getJson(url, headers = {}) {
    for (let i = 0; i < 4; i++) {
        const r = await fetch(url, { headers: { 'User-Agent': UA, ...headers } });
        if (r.status === 429) { await sleep(5000 * (i + 1)); continue; }
        if (!r.ok) throw new Error(`${new URL(url).host}: HTTP ${r.status}`);
        return r.json();
    }
    throw new Error(`${new URL(url).host}: лимит на заявките`);
}

const strip = (s) => String(s || '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();

// ---- Pixabay (key) ----
export async function pixabay(query, kind, key) {
    if (!key) return [];
    if (kind === 'video') {
        const d = await getJson(`https://pixabay.com/api/videos/?${new URLSearchParams({ key, q: query, video_type: 'film', per_page: '20', safesearch: 'true' })}`);
        return (d.hits || []).flatMap((v) => {
            // smallest rendition that fills 1920×1080 (large is usually 4K)
            const r = Object.values(v.videos || {}).filter((x) => x?.url && x.width >= W && x.height >= H && x.width >= x.height)
                .sort((a, b) => a.width * a.height - b.width * b.height)[0];
            if (!r) return [];
            return [{
                id: `pixabay-v-${v.id}`, source: 'Pixabay', kind: 'video', url: r.url, thumb: r.thumbnail || v.videos?.tiny?.thumbnail || '',
                width: r.width, height: r.height, duration: v.duration, author: v.user || '', page: v.pageURL || '', license: 'Pixabay Content License',
            }];
        }).filter((c) => c.thumb);
    }
    const d = await getJson(`https://pixabay.com/api/?${new URLSearchParams({ key, q: query, image_type: 'photo', orientation: 'horizontal', min_width: String(W), per_page: '20', safesearch: 'true' })}`);
    return (d.hits || []).map((h) => ({
        id: `pixabay-p-${h.id}`, source: 'Pixabay', kind: 'photo', url: h.largeImageURL, thumb: h.webformatURL || h.previewURL,
        width: h.imageWidth, height: h.imageHeight, author: h.user || '', page: h.pageURL || '', license: 'Pixabay Content License',
    }));
}

// ---- Pexels (key) ----
export async function pexels(query, kind, key) {
    if (!key) return [];
    const auth = { Authorization: key };
    if (kind === 'video') {
        const d = await getJson(`https://api.pexels.com/videos/search?${new URLSearchParams({ query, orientation: 'landscape', per_page: '15', size: 'medium' })}`, auth);
        return (d.videos || []).flatMap((v) => {
            const f = (v.video_files || []).filter((x) => x.width >= W && x.height >= H && x.width >= x.height && /mp4/.test(x.file_type || ''))
                .sort((a, b) => a.width * a.height - b.width * b.height)[0];
            if (!f) return [];
            return [{
                id: `pexels-v-${v.id}`, source: 'Pexels', kind: 'video', url: f.link, thumb: v.image,
                width: f.width, height: f.height, duration: v.duration, author: v.user?.name || '', page: v.url || '', license: 'Pexels License',
            }];
        });
    }
    const d = await getJson(`https://api.pexels.com/v1/search?${new URLSearchParams({ query, orientation: 'landscape', per_page: '15' })}`, auth);
    return (d.photos || []).filter((p) => p.width >= W).map((p) => ({
        id: `pexels-p-${p.id}`, source: 'Pexels', kind: 'photo', url: p.src?.original, thumb: p.src?.medium,
        width: p.width, height: p.height, author: p.photographer || '', page: p.url || '', license: 'Pexels License',
    }));
}

// ---- Wikimedia Commons (no key): only free licences, landscape, large enough ----
const FREE = /^(CC0|Public domain|PD|CC BY(-SA)? [\d.]+|CC BY(-SA)?$)/i;
export async function wikimedia(query) {
    const params = new URLSearchParams({
        action: 'query', format: 'json', origin: '*', generator: 'search', gsrsearch: `${query} filetype:bitmap`,
        gsrnamespace: '6', gsrlimit: '15', prop: 'imageinfo', iiprop: 'url|size|extmetadata', iiurlwidth: '640',
    });
    const d = await commonsJson(`https://commons.wikimedia.org/w/api.php?${params}`);
    return Object.values(d.query?.pages || {}).flatMap((p) => {
        const ii = p.imageinfo?.[0];
        const m = ii?.extmetadata || {};
        const lic = strip(m.LicenseShortName?.value);
        if (!ii || ii.width < W * 0.8 || ii.width < ii.height || !FREE.test(lic)) return [];
        return [{
            id: `commons-${p.pageid}`, source: 'Wikimedia Commons', kind: 'photo', url: ii.url, thumb: ii.thumburl,
            width: ii.width, height: ii.height, author: strip(m.Artist?.value).slice(0, 80), page: ii.descriptionurl, license: lic,
        }];
    });
}

// ---- Wikimedia Commons video (no key): public-domain films, newsreels, science footage ----
// The original can be a huge WebM; a transcoded rendition (≤1080p) is used when there is one.
export async function wikimediaVideo(query) {
    const params = new URLSearchParams({
        action: 'query', format: 'json', origin: '*', generator: 'search', gsrsearch: `${query} filetype:video`,
        gsrnamespace: '6', gsrlimit: '15', prop: 'videoinfo', viprop: 'url|size|derivatives|extmetadata', viurlwidth: '640',
    });
    const d = await commonsJson(`https://commons.wikimedia.org/w/api.php?${params}`);
    return Object.values(d.query?.pages || {}).flatMap((p) => {
        const v = p.videoinfo?.[0];
        const m = v?.extmetadata || {};
        const lic = strip(m.LicenseShortName?.value);
        // archival film is often 480p — still better than a still; tiny lab clips are not
        if (!v || v.height < 360 || v.width < v.height * 1.2 || !(v.duration >= 3) || !FREE.test(lic) || !v.thumburl) return [];
        const der = (v.derivatives || []).filter((x) => x.src && /webm|mp4/.test(x.type || '') && (x.height || 0) <= 1080)
            .sort((a, b) => (b.height || 0) - (a.height || 0))[0];
        const url = der?.src || (v.size < 300e6 ? v.url : '');
        if (!url) return [];
        return [{
            id: `commons-v-${p.pageid}`, source: 'Wikimedia Commons', kind: 'video', url, thumb: v.thumburl,
            width: der?.width || v.width, height: der?.height || v.height, duration: Math.round(v.duration),
            author: strip(m.Artist?.value).slice(0, 80), page: v.descriptionurl, license: lic,
        }];
    });
}

// ---- NASA video (no key): space, Earth, physics, biology on the ISS ----
// The file list is one more request (collection.json), made only for the shot that is chosen.
export async function nasaVideo(query) {
    const d = await getJson(`https://images-api.nasa.gov/search?${new URLSearchParams({ q: query, media_type: 'video', page_size: '15' })}`);
    return (d.collection?.items || []).flatMap((it) => {
        const meta = it.data?.[0] || {};
        const thumb = (it.links || []).find((l) => l.rel === 'preview')?.href;
        if (!thumb || !meta.nasa_id || !it.href) return [];
        return [{
            id: `nasa-v-${meta.nasa_id}`, source: 'NASA', kind: 'video', url: '', thumb: thumb.replace(/^http:/, 'https:'),
            width: 0, height: 0, author: meta.center || 'NASA',
            page: `https://images.nasa.gov/details/${encodeURIComponent(meta.nasa_id)}`, license: 'NASA (public domain unless noted)',
            resolve: async () => {
                const files = (await getJson(it.href.replace(/^http:/, 'https:'))).map((f) => String(f).replace(/^http:/, 'https:'));
                // medium is ~720–1080p and a sensible size; orig can be several GB
                return ['~medium.mp4', '~large.mp4', '~orig.mp4', '~mobile.mp4'].map((k) => files.find((f) => f.endsWith(k))).find(Boolean) || '';
            },
        }];
    });
}

// ---- NASA Image and Video Library (no key): space, Earth, science ----
export async function nasa(query) {
    const d = await getJson(`https://images-api.nasa.gov/search?${new URLSearchParams({ q: query, media_type: 'image', page_size: '15' })}`);
    return (d.collection?.items || []).flatMap((it) => {
        const meta = it.data?.[0] || {};
        const thumb = (it.links || []).find((l) => l.rel === 'preview')?.href;
        if (!thumb || !meta.nasa_id) return [];
        return [{
            id: `nasa-${meta.nasa_id}`, source: 'NASA', kind: 'photo',
            url: `https://images-assets.nasa.gov/image/${encodeURIComponent(meta.nasa_id)}/${encodeURIComponent(meta.nasa_id)}~orig.jpg`,
            thumb, width: 0, height: 0, author: meta.photographer || meta.center || 'NASA',
            page: `https://images.nasa.gov/details/${encodeURIComponent(meta.nasa_id)}`, license: 'NASA (public domain unless noted)',
        }];
    });
}

// ---- Openverse (no key): free-licensed images from many collections ----
export async function openverse(query) {
    const d = await getJson(`https://api.openverse.org/v1/images/?${new URLSearchParams({ q: query, license_type: 'commercial', aspect_ratio: 'wide', size: 'large', page_size: '15' })}`);
    return (d.results || []).filter((r) => !r.width || r.width >= W * 0.8).map((r) => ({
        id: `openverse-${r.id}`, source: `Openverse/${r.source || r.provider || ''}`, kind: 'photo', url: r.url, thumb: r.thumbnail || r.url,
        width: r.width || 0, height: r.height || 0, author: r.creator || '', page: r.foreign_landing_url || '', license: `${(r.license || '').toUpperCase()} ${r.license_version || ''}`.trim(),
    }));
}

// Every source that can answer, for one query; a failing source is skipped (logged)
export async function searchAll(query, kind, keys, log = () => {}) {
    const jobs = kind === 'video'
        ? [['Pixabay', () => pixabay(query, 'video', keys.pixabay)], ['Pexels', () => pexels(query, 'video', keys.pexels)],
            ['Wikimedia video', () => wikimediaVideo(query)], ['NASA video', () => nasaVideo(query)]]
        : [['Pixabay', () => pixabay(query, 'photo', keys.pixabay)], ['Pexels', () => pexels(query, 'photo', keys.pexels)],
            ['Wikimedia', () => wikimedia(query)], ['NASA', () => nasa(query)], ['Openverse', () => openverse(query)]];
    const out = await Promise.all(jobs.map(async ([name, fn]) => {
        try { return await fn(); } catch (e) { log(`  ${name}: ${e.message}`); return []; }
    }));
    return out.flat();
}
