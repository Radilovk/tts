// PCM → Ogg/Opus in the browser (WebCodecs AudioEncoder + a small Ogg muxer).
// Speech at 32 kb/s Opus is ~12× smaller than the 24 kHz WAV Gemini returns,
// with no audible loss for narration. Returns null when the browser can't encode.

const BITRATE = 32000;
const FRAME_US = 20000; // 20 ms Opus frames
const PRE_SKIP = 312;   // libopus encoder delay at 48 kHz

let support = null;

async function supported(rate) {
    if (support !== null) return support;
    try {
        support = typeof AudioEncoder !== 'undefined'
            && !!(await AudioEncoder.isConfigSupported({ codec: 'opus', sampleRate: rate, numberOfChannels: 1, bitrate: BITRATE })).supported;
    } catch {
        support = false;
    }
    return support;
}

// ---------- Ogg container ----------

const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
        let r = i << 24;
        for (let j = 0; j < 8; j++) r = r & 0x80000000 ? (r << 1) ^ 0x04c11db7 : r << 1;
        t[i] = r >>> 0;
    }
    return t;
})();

function crc32(bytes) {
    let crc = 0;
    for (let i = 0; i < bytes.length; i++) crc = ((crc << 8) ^ CRC_TABLE[((crc >>> 24) ^ bytes[i]) & 0xff]) >>> 0;
    return crc;
}

function oggPage(packets, { granule, serial, seq, bos = false, eos = false }) {
    const lacing = [];
    for (const p of packets) {
        let n = p.length;
        while (n >= 255) { lacing.push(255); n -= 255; }
        lacing.push(n);
    }
    const bodyLen = packets.reduce((s, p) => s + p.length, 0);
    const page = new Uint8Array(27 + lacing.length + bodyLen);
    const v = new DataView(page.buffer);
    page.set([0x4f, 0x67, 0x67, 0x53], 0); // "OggS"
    page[4] = 0;
    page[5] = (bos ? 0x02 : 0) | (eos ? 0x04 : 0);
    v.setBigUint64(6, BigInt(granule), true);
    v.setUint32(14, serial, true);
    v.setUint32(18, seq, true);
    page[26] = lacing.length;
    page.set(lacing, 27);
    let off = 27 + lacing.length;
    for (const p of packets) { page.set(p, off); off += p.length; }
    v.setUint32(22, crc32(page), true);
    return page;
}

function opusHead(rate) {
    const h = new Uint8Array(19);
    const v = new DataView(h.buffer);
    h.set(new TextEncoder().encode('OpusHead'), 0);
    h[8] = 1;                       // version
    h[9] = 1;                       // channels
    v.setUint16(10, PRE_SKIP, true);
    v.setUint32(12, rate, true);    // original input rate (informational)
    v.setInt16(16, 0, true);        // output gain
    h[18] = 0;                      // channel mapping family
    return h;
}

// Vorbis-style comments: TITLE, ARTIST, ALBUM… (also used for the AI-narration label)
function opusTags(tags = {}) {
    const enc = new TextEncoder();
    const vendor = enc.encode('razkazvach');
    const comments = Object.entries(tags).filter(([, v]) => v).map(([k, v]) => enc.encode(`${k}=${v}`));
    const size = 8 + 4 + vendor.length + 4 + comments.reduce((n, c) => n + 4 + c.length, 0);
    const t = new Uint8Array(size);
    const v = new DataView(t.buffer);
    t.set(enc.encode('OpusTags'), 0);
    v.setUint32(8, vendor.length, true);
    t.set(vendor, 12);
    let off = 12 + vendor.length;
    v.setUint32(off, comments.length, true);
    off += 4;
    for (const c of comments) {
        v.setUint32(off, c.length, true);
        t.set(c, off + 4);
        off += 4 + c.length;
    }
    return t;
}

function mux(packets, rate, tags) {
    const serial = (Math.random() * 0xffffffff) >>> 0;
    const pages = [
        oggPage([opusHead(rate)], { granule: 0, serial, seq: 0, bos: true }),
        oggPage([opusTags(tags)], { granule: 0, serial, seq: 1 }),
    ];
    let seq = 2;
    let granule = PRE_SKIP;
    for (let i = 0; i < packets.length; i += 50) {
        const group = packets.slice(i, i + 50);
        for (const p of group) granule += Math.round(p.duration * 48000 / 1e6);
        pages.push(oggPage(group.map((p) => p.data), { granule, serial, seq: seq++, eos: i + 50 >= packets.length }));
    }
    return new Blob(pages, { type: 'audio/ogg' });
}

// ---------- public ----------

// Streaming encoder: add() PCM pieces one after another, finish() → Ogg/Opus Blob.
// Keeps only compressed packets in memory, so whole chapters stay small.
export class OpusWriter {
    constructor(rate, tags = {}) {
        this.rate = rate;
        this.tags = tags;
        this.packets = [];
        this.error = null;
        this.samples = 0;
        this.encoder = null;
    }

    static async supported(rate) {
        return supported(rate);
    }

    _ensure() {
        if (this.encoder) return;
        this.encoder = new AudioEncoder({
            output: (chunk) => {
                const data = new Uint8Array(chunk.byteLength);
                chunk.copyTo(data);
                this.packets.push({ data, duration: chunk.duration || FRAME_US });
            },
            error: (e) => { this.error = e; },
        });
        this.encoder.configure({ codec: 'opus', sampleRate: this.rate, numberOfChannels: 1, bitrate: BITRATE });
    }

    add(int16) {
        if (this.error) throw this.error;
        this._ensure();
        for (let off = 0; off < int16.length; off += this.rate) {
            const piece = int16.subarray(off, Math.min(int16.length, off + this.rate));
            const data = new AudioData({
                format: 's16', sampleRate: this.rate, numberOfFrames: piece.length, numberOfChannels: 1,
                timestamp: Math.round(this.samples / this.rate * 1e6), data: piece.slice(),
            });
            this.encoder.encode(data);
            data.close();
            this.samples += piece.length;
        }
    }

    async finish() {
        if (!this.encoder) return null;
        try { await this.encoder.flush(); } catch (e) { this.error = e; }
        try { this.encoder.close(); } catch {}
        if (this.error || !this.packets.length) return null;
        return mux(this.packets, this.rate, this.tags);
    }
}

// int16: mono Int16Array PCM. Resolves to an Ogg/Opus Blob, or null if unsupported.
export async function encodeOpus(int16, rate, tags) {
    if (!int16.length || !(await supported(rate))) return null;
    const w = new OpusWriter(rate, tags);
    try {
        w.add(int16);
        return await w.finish();
    } catch {
        return null;
    }
}
