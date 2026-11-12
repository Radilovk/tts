// Monthly usage counter and cost estimate (stored locally).

import { PRICES, geminiPrice, AZURE_FREE_CHARS } from './engines.js';
import { libraryApi } from './shared.js';

const KEY = 'rz_usage';

// Google bills by calendar month in Pacific time; counting by the same month means
// the free characters never "renew" here hours before they renew at Google.
export function monthKey(d = new Date()) {
    try {
        const p = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit' }).formatToParts(d);
        return `${p.find((x) => x.type === 'year').value}-${p.find((x) => x.type === 'month').value}`;
    } catch {
        const t = new Date(d.getTime() - 8 * 3600_000);
        return `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, '0')}`;
    }
}

function load() {
    try {
        const u = JSON.parse(localStorage.getItem(KEY) || '{}');
        if (u.month !== monthKey()) return { month: monthKey(), cloud: {}, gemini: { inTokens: 0, outTokens: 0 }, cacheHits: 0 };
        return u;
    } catch {
        return { month: monthKey(), cloud: {}, gemini: { inTokens: 0, outTokens: 0 }, cacheHits: 0 };
    }
}

// usd: exact cost of this call (Gemini depends on model, batch and free key)
export function recordUsage({ engine, tier, chars = 0, inTokens = 0, outTokens = 0, usd, mode }) {
    const u = load();
    if (engine === 'cloud') u.cloud[tier] = (u.cloud[tier] || 0) + chars;
    if (engine === 'gemini') {
        u.gemini.inTokens += inTokens;
        u.gemini.outTokens += outTokens;
        u.gemini.usd = (u.gemini.usd || 0) + (usd ?? (inTokens * PRICES.gemini.inPer1M + outTokens * PRICES.gemini.outPer1M) / 1e6);
        if (mode === 'batch') u.gemini.batchTokens = (u.gemini.batchTokens || 0) + outTokens;
        if (mode === 'free') u.gemini.freeTokens = (u.gemini.freeTokens || 0) + outTokens;
    }
    if (engine === 'azure') u.azure = (u.azure || 0) + chars;
    if (engine === 'translate') {
        u.translate = u.translate || { inTokens: 0, outTokens: 0 };
        u.translate.inTokens += inTokens;
        u.translate.outTokens += outTokens;
    }
    localStorage.setItem(KEY, JSON.stringify(u));
}

export function usageSummary() {
    const u = load();
    const rows = [];
    let total = 0;
    // Google HD: the larger of this device's count and the worker's total for the key
    const tiers = new Set([...Object.keys(u.cloud), ...Object.keys(serverCount())]);
    for (const tier of tiers) {
        const chars = cloudUsedChars(tier);
        const p = PRICES.cloud[tier] || PRICES.cloud.Other;
        const billable = Math.max(0, chars - p.free);
        const cost = billable / 1e6 * p.per1M;
        total += cost;
        rows.push({ label: `Google ${p.label}`, used: chars, free: p.free, cost, unit: 'знака' });
    }
    if (u.azure) {
        rows.push({ label: 'Microsoft гласове', used: u.azure, free: AZURE_FREE_CHARS, cost: 0, unit: 'знака' });
    }
    if (u.gemini.outTokens) {
        const cost = monthlyGeminiUsd();
        total += cost;
        const mins = (t) => Math.round((t || 0) / PRICES.gemini.tokensPerSecond / 60);
        const extra = [u.gemini.batchTokens ? `${mins(u.gemini.batchTokens)} мин на ½ цена` : '', u.gemini.freeTokens ? `${mins(u.gemini.freeTokens)} мин безплатно` : ''].filter(Boolean).join(', ');
        rows.push({
            label: 'Gemini разказвач', used: u.gemini.outTokens, cost, unit: 'аудио токена',
            minutes: u.gemini.outTokens / PRICES.gemini.tokensPerSecond / 60, note: extra,
        });
    }
    if (u.translate?.inTokens) {
        const cost = u.translate.inTokens / 1e6 * 0.1 + u.translate.outTokens / 1e6 * 0.4;
        total += cost;
        rows.push({ label: 'Превод (Gemini Flash-Lite)', used: u.translate.outTokens, cost, unit: 'токена', translated: true });
    }
    return { rows, total, month: u.month };
}

// Characters used this month on a Google voice tier.
export function monthlyCloudChars(tier) {
    return load().cloud[tier] || 0;
}

// ---------- Google HD: never past the free characters ----------
//
// Google has no monthly limit of its own (only per-minute quotas), so the app stops
// Google HD itself. Three things keep the count on the safe side:
//   • a margin: it stops at 90% of the free characters;
//   • passages being synthesized right now are reserved before the request goes out,
//     so prefetching several passages at once cannot slip past the limit together;
//   • the worker keeps a per-key total for the month, so the phone app, the browser and
//     other devices with the same key add up (the larger of the two counts is used).
export const CLOUD_SAFE_SHARE = 0.9;
const SERVER_KEY = 'rz_cloud_server';
const reserved = {};

function serverCount() {
    try {
        const s = JSON.parse(localStorage.getItem(SERVER_KEY) || '{}');
        return s.month === monthKey() ? s.cloud || {} : {};
    } catch { return {}; }
}

function saveServer(data) {
    if (!data || data.month !== monthKey() || typeof data.cloud !== 'object') return;
    try { localStorage.setItem(SERVER_KEY, JSON.stringify({ month: data.month, cloud: data.cloud })); } catch {}
}

export function cloudUsedChars(tier) {
    return Math.max(monthlyCloudChars(tier), serverCount()[tier] || 0);
}

export function cloudLimitChars(tier) {
    return Math.floor((PRICES.cloud[tier] || PRICES.cloud.Other).free * CLOUD_SAFE_SHARE);
}

// Reserve the characters of a request; returns false (and reserves nothing) if they
// do not fit in what is left of the free characters.
export function cloudReserve(tier, chars) {
    if (cloudUsedChars(tier) + (reserved[tier] || 0) + chars > cloudLimitChars(tier)) return false;
    reserved[tier] = (reserved[tier] || 0) + chars;
    return true;
}

export function cloudRelease(tier, chars) {
    reserved[tier] = Math.max(0, (reserved[tier] || 0) - chars);
}

async function usageCall(apiKey, body) {
    const base = libraryApi();
    if (!base || !apiKey) return;
    try {
        const r = await fetch(`${base}/usage`, {
            method: body ? 'POST' : 'GET',
            headers: { 'X-Rz-Key': apiKey, ...(body ? { 'Content-Type': 'application/json' } : {}) },
            body: body ? JSON.stringify(body) : undefined,
            cache: 'no-store',
        });
        if (r.ok) saveServer(await r.json());
    } catch {}
}

// The month's total for this key from the worker (other devices included).
export function syncCloudUsage(apiKey) { return usageCall(apiKey, null); }

// Add characters to the worker's total for this key (fire-and-forget).
export function reportCloudUsage(apiKey, tier, chars) {
    return usageCall(apiKey, { month: monthKey(), tier, chars });
}

// Estimated Gemini spend this month in USD.
export function monthlyGeminiUsd() {
    const g = load().gemini;
    if (g.usd != null) return g.usd;
    return g.inTokens / 1e6 * PRICES.gemini.inPer1M + g.outTokens / 1e6 * PRICES.gemini.outPer1M;
}

// Clears the local statistics. The Google HD count is kept: it is what stops
// Google HD before the free characters run out.
export function resetUsage() {
    const u = load();
    localStorage.setItem(KEY, JSON.stringify({ month: u.month, cloud: u.cloud, gemini: { inTokens: 0, outTokens: 0 }, cacheHits: 0 }));
}

// Price of one hour of listening, for the engine cards.
export function hourlyCost(engine, tier = 'Chirp3-HD', batch = false) {
    const charsPerHour = 14 * 3600;
    if (engine === 'cloud') return charsPerHour / 1e6 * (PRICES.cloud[tier] || PRICES.cloud.Other).per1M;
    if (engine === 'gemini') {
        // tier = model id here
        const p = geminiPrice(tier && tier !== 'Chirp3-HD' ? tier : '');
        const cost = (3600 * PRICES.gemini.tokensPerSecond * p.out + charsPerHour / 3 * p.in) / 1e6;
        return batch ? cost / 2 : cost;
    }
    return 0;
}

export function freeHoursPerMonth(tier = 'Chirp3-HD') {
    const p = PRICES.cloud[tier] || PRICES.cloud.Other;
    return p.free / (14 * 3600);
}

// ---------- Microsoft voices: inside the free characters ----------
// A free (F0) Azure resource is never billed (Azure just refuses past 0.5M a month);
// the app also stops itself at 95%, so a paid (S0) resource stays free too.
export const AZURE_SAFE_SHARE = 0.95;

export function monthlyAzureChars() {
    return load().azure || 0;
}

export function azureFreeLeft() {
    return Math.max(0, Math.floor(AZURE_FREE_CHARS * AZURE_SAFE_SHARE) - monthlyAzureChars());
}
