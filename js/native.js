// Bridge to the Android app (Capacitor). In the browser everything here is inert.

const C = window.Capacitor;

export const isNative = !!(C && typeof C.isNativePlatform === 'function' && C.isNativePlatform());

export const Native = isNative ? (C.registerPlugin ? C.registerPlugin('Razkazvach') : C.Plugins.Razkazvach) : null;

// URL the WebView can fetch for a file in the app's storage (shared books)
export function nativeFileUrl(path) {
    return C.convertFileSrc(path.startsWith('file://') ? path : 'file://' + path);
}

// ---------- Android voices ----------

let voices = [];
let engines = [];
let currentEngine = '';
const listeners = new Set();

export function nativeVoices() { return voices; }
export function nativeEngines() { return { engines, current: currentEngine }; }
export function onNativeVoices(cb) { listeners.add(cb); }

export async function loadNativeVoices(engine) {
    if (!Native) return [];
    try {
        if (engine !== undefined) await Native.setEngine({ engine });
        const e = await Native.getEngines();
        engines = e.engines || [];
        currentEngine = e.current || '';
        const r = await Native.getVoices();
        voices = (r.voices || []).filter((v) => v.installed !== false || v.network);
    } catch (err) {
        voices = [];
    }
    listeners.forEach((cb) => cb());
    return voices;
}

// Readable label for Android voice names such as "bg-bg-x-bgk-network"
export function nativeVoiceLabel(v, index) {
    const variant = (v.name.match(/-x-([a-z0-9]+)/i) || [])[1];
    const parts = [variant ? `Глас ${variant.toUpperCase()}` : `Глас ${index + 1}`];
    if (v.quality >= 400) parts.push('HD');
    parts.push(v.network ? 'онлайн' : 'офлайн');
    return parts.join(' · ');
}
