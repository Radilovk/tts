// Monthly usage counter and cost estimate (stored locally).

import { PRICES, geminiPrice } from './engines.js';

const KEY = 'rz_usage';

function monthKey() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
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
    for (const [tier, chars] of Object.entries(u.cloud)) {
        const p = PRICES.cloud[tier] || PRICES.cloud.Other;
        const billable = Math.max(0, chars - p.free);
        const cost = billable / 1e6 * p.per1M;
        total += cost;
        rows.push({ label: `Google ${p.label}`, used: chars, free: p.free, cost, unit: 'знака' });
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

// Estimated Gemini spend this month in USD.
export function monthlyGeminiUsd() {
    const g = load().gemini;
    if (g.usd != null) return g.usd;
    return g.inTokens / 1e6 * PRICES.gemini.inPer1M + g.outTokens / 1e6 * PRICES.gemini.outPer1M;
}

export function resetUsage() {
    localStorage.removeItem(KEY);
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
