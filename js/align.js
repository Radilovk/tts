// Where each sentence starts in a narrated passage, found in the audio itself.
//
// Neither Chirp 3 HD nor Gemini says when each sentence is spoken. Spreading the time
// in proportion to the characters drifts by many seconds over a long passage (a short
// sentence with a long pause, a long sentence read fast), so the highlighted sentence ran
// ahead of the voice. Here the passage is decoded, the pauses are found (a voice always
// pauses after a full stop), and every sentence boundary is matched to one pause so that
// the time between boundaries fits the characters spoken, preferring longer pauses (a
// comma pause is shorter than a sentence pause).

const RATE = 8000;          // decoding rate: plenty to find pauses, little memory
const FRAME = 0.01;         // 10 ms frames
const MIN_GAP = 0.12;       // shortest pause that can end a sentence

function frameEnergy(data) {
    const n = Math.floor(RATE * FRAME);
    const frames = Math.floor(data.length / n);
    const e = new Float32Array(frames);
    for (let f = 0; f < frames; f++) {
        let s = 0;
        for (let i = f * n, end = i + n; i < end; i++) s += data[i] * data[i];
        e[f] = s / n;
    }
    return e;
}

// Pauses: [{ start, end }] in seconds, plus where speech begins and ends.
export function findPauses(data) {
    const e = frameEnergy(data);
    if (!e.length) return { pauses: [], speechStart: 0, speechEnd: 0 };
    const sorted = Float32Array.from(e).sort();
    const loud = sorted[Math.floor(sorted.length * 0.9)] || 0;
    const silent = Math.max(loud * 0.03, 1e-7);   // ~ -15 dB below speech
    let first = 0, last = e.length - 1;
    while (first < e.length && e[first] < silent) first++;
    while (last > first && e[last] < silent) last--;
    const pauses = [];
    let runStart = -1;
    for (let f = first; f <= last + 1; f++) {
        const quiet = f <= last && e[f] < silent;
        if (quiet && runStart < 0) runStart = f;
        if (!quiet && runStart >= 0) {
            const len = (f - runStart) * FRAME;
            if (len >= MIN_GAP) pauses.push({ start: runStart * FRAME, end: f * FRAME });
            runStart = -1;
        }
    }
    return { pauses, speechStart: first * FRAME, speechEnd: (last + 1) * FRAME };
}

// weights: characters of each sentence. Returns the start time of each sentence (s).
//
// The matching looks at durations, not at absolute positions: the time between two
// chosen pauses must fit the characters spoken in between at the passage's speaking
// rate (within the natural variation of a voice). Errors do not add up along the
// passage, which they do when every boundary is compared with an estimated position.
export function alignSentences(weights, { pauses, speechStart, speechEnd }) {
    const n = weights.length;
    if (n <= 1) return [0];
    const B = n - 1;                       // boundary b = start of sentence b + 1
    const W = [0];
    for (const w of weights) W.push(W[W.length - 1] + Math.max(1, w));
    const span = Math.max(0.1, speechEnd - speechStart);
    const rate = span / W[n];              // seconds per character
    const tp = pauses.map((p) => p.end);   // the next sentence starts where the pause ends
    const bonus = pauses.map((p) => 4 * Math.log((p.end - p.start) / MIN_GAP + 1));
    const g = pauses.length;
    const SKIP = 6, MAX_SKIP = 3, SPREAD = 0.5;
    const interval = (ta, tb, chars) => {
        if (tb <= ta) return Infinity;
        const d = Math.log((tb - ta) / (chars * rate)) / SPREAD;
        return d * d;
    };
    // dp[b][p]: best cost with boundary b at pause p; prev = [b', p'] (b' = -1: start)
    const dp = Array.from({ length: B }, () => new Float64Array(g).fill(Infinity));
    const prev = Array.from({ length: B }, () => new Int32Array(g * 2).fill(-2));
    for (let b = 0; b < B; b++) {
        for (let p = 0; p < g; p++) {
            let best = Infinity, pb = -2, pp = -2;
            for (let b2 = Math.max(-1, b - 1 - MAX_SKIP); b2 < b; b2++) {
                const skip = SKIP * (b - b2 - 1);
                const chars = W[b + 1] - W[b2 + 1];
                if (b2 === -1) {
                    const c = skip + interval(speechStart, tp[p], chars);
                    if (c < best) { best = c; pb = -1; pp = -1; }
                    continue;
                }
                const row = dp[b2];
                for (let p2 = 0; p2 < p; p2++) {
                    if (row[p2] === Infinity) continue;
                    const c = row[p2] + skip + interval(tp[p2], tp[p], chars);
                    if (c < best) { best = c; pb = b2; pp = p2; }
                }
            }
            if (best < Infinity) {
                dp[b][p] = best - bonus[p];
                prev[b][p * 2] = pb;
                prev[b][p * 2 + 1] = pp;
            }
        }
    }
    // Close at the end of speech
    let endCost = SKIP * B + interval(speechStart, speechEnd + 1e-6, W[n]), eb = -1, ep = -1;
    for (let b = Math.max(0, B - 1 - MAX_SKIP); b < B; b++) {
        for (let p = 0; p < g; p++) {
            if (dp[b][p] === Infinity) continue;
            const c = dp[b][p] + SKIP * (B - 1 - b) + interval(tp[p], speechEnd + 1e-6, W[n] - W[b + 1]);
            if (c < endCost) { endCost = c; eb = b; ep = p; }
        }
    }
    const at = new Array(B).fill(null);
    while (eb >= 0) {
        at[eb] = Math.max(0, tp[ep] - 0.06);
        const nb = prev[eb][ep * 2], np = prev[eb][ep * 2 + 1];
        eb = nb; ep = np;
    }
    // Boundaries without a pause: between their matched neighbours, by characters
    const marks = [0];
    for (let b = 0; b < B; b++) {
        if (at[b] != null) { marks.push(at[b]); continue; }
        let l = b - 1; while (l >= 0 && at[l] == null) l--;
        let r = b + 1; while (r < B && at[r] == null) r++;
        const tl = l >= 0 ? at[l] : speechStart, tr = r < B ? at[r] : speechEnd;
        const wl = W[l + 1], wr = r < B ? W[r + 1] : W[n];
        marks.push(tl + (W[b + 1] - wl) / Math.max(1, wr - wl) * (tr - tl));
    }
    for (let i = 1; i < marks.length; i++) if (marks[i] < marks[i - 1]) marks[i] = marks[i - 1];
    return marks;
}

// Start time (s) of every sentence in a passage, or null if the audio cannot be decoded.
export async function sentenceMarks(blob, weights) {
    try {
        const Ctx = window.OfflineAudioContext || window.webkitOfflineAudioContext;
        if (!Ctx) return null;
        const ctx = new Ctx(1, RATE, RATE);
        const buf = await ctx.decodeAudioData(await blob.arrayBuffer());
        return alignSentences(weights, findPauses(buf.getChannelData(0)));
    } catch {
        return null;
    }
}
