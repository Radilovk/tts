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

// ---------- narration audio (Android MediaPlayer) ----------
//
// Stands in for the <audio> element in the Android app: the same properties and
// events the player uses, but the sound comes from Android's MediaPlayer. The WebView
// element could lose its audio output (audio focus, Bluetooth/speaker switch, screen
// off) and keep "playing" into silence — the text moved on while nothing was heard.

function blobToBase64(blob) {
    return new Promise((resolve, reject) => {
        const r = new FileReader();
        r.onload = () => resolve(String(r.result).slice(String(r.result).indexOf(',') + 1));
        r.onerror = () => reject(r.error);
        r.readAsDataURL(blob);
    });
}

export class NativeAudio extends EventTarget {
    constructor() {
        super();
        this.isNative = true;
        this.src = '';
        this.currentSrc = '';
        this.paused = true;
        this.ended = false;
        this.duration = NaN;
        this.error = null;
        this.preload = 'auto';
        this._t = 0;
        this._rate = 1;
        this._volume = 1;
        this._loadId = 0;
        Native.addListener('audio', (e) => this._onNative(e));
    }

    _onNative({ type, time, duration, detail }) {
        if (duration > 0) this.duration = duration;
        if (type === 'time') {
            this._t = time;
            this.dispatchEvent(new Event('timeupdate'));
        } else if (type === 'play') {
            this._t = time;
            this.paused = false;
            this.dispatchEvent(new Event('play'));
        } else if (type.startsWith('pause:')) {
            // Paused by Android: a call / another app took the sound, headphones unplugged
            this._t = time;
            this.paused = true;
            this.pausedBy = type.slice(6);
            this.dispatchEvent(new Event('pause'));
        } else if (type === 'ended') {
            this._t = this.duration || time;
            this.paused = true;
            this.ended = true;
            this.dispatchEvent(new Event('ended'));
        } else if (type === 'error') {
            this.paused = true;
            this.error = { code: 3, message: detail };
            this.dispatchEvent(new Event('error'));
        }
    }

    // Load a passage; resolves when Android has it ready to play.
    async loadBlob(blob) {
        const id = ++this._loadId;
        this.paused = true;
        this.ended = false;
        this.error = null;
        this._t = 0;
        this.duration = NaN;
        this.src = 'native:' + id;
        this.currentSrc = this.src;
        const data = await blobToBase64(blob);
        if (id !== this._loadId) throw new DOMException('Replaced', 'AbortError');
        try {
            const { duration } = await Native.audioLoad({ data });
            if (id !== this._loadId) throw new DOMException('Replaced', 'AbortError');
            this.duration = duration;
        } catch (e) {
            if (e?.name === 'AbortError') throw e;
            throw new DOMException(e?.message || 'Аудиото не може да се възпроизведе.', 'NotSupportedError');
        }
        this.dispatchEvent(new Event('loadedmetadata'));
    }

    async play() {
        try {
            await Native.audioPlay();
        } catch (e) {
            throw new DOMException(e?.message || 'Звукът не тръгна.', 'NotAllowedError');
        }
        this.paused = false;
        this.ended = false;
    }

    pause() {
        const was = !this.paused;
        this.paused = true;
        this.pausedBy = 'app';
        Native.audioPause().catch(() => {});
        if (was) this.dispatchEvent(new Event('pause'));
    }

    stopAll() {
        ++this._loadId;
        this.paused = true;
        this.src = '';
        Native.audioStop().catch(() => {});
    }

    get currentTime() { return this._t; }
    set currentTime(t) {
        this._t = Math.max(0, t);
        this.ended = false;
        Native.audioSeek({ time: this._t }).catch(() => {});
    }

    get playbackRate() { return this._rate; }
    set playbackRate(r) {
        this._rate = r;
        Native.audioRate({ rate: r }).catch(() => {});
    }

    get volume() { return this._volume; }
    set volume(v) {
        this._volume = v;
        Native.audioVolume({ volume: v }).catch(() => {});
    }
}
