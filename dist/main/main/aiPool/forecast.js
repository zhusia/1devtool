"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.forecastToPercent = forecastToPercent;
const TRAILING_WINDOW_MS = 6 * 3_600_000;
const MIN_SAMPLES = 4;
const MIN_SPAN_MS = 30 * 60_000;
/**
 * A drop this large between consecutive samples is a window reset. Kept high
 * so a single bad probe (spike up, then back down) never registers as a
 * reset — real resets fall to near zero, an outlier recovery rarely exceeds
 * 30 points. A small-percentage reset the cut misses still yields a sane
 * (merely conservative) slope, which Theil–Sen absorbs.
 */
const RESET_DROP_PCT = 30;
function noForecast(sampleCount, spanMs) {
    return { etaMs: null, slopePctPerHour: null, confidence: 'none', sampleCount, spanMs };
}
/** Median of pairwise slopes (Theil–Sen) — robust to single bad probes. */
function theilSenSlopePerMs(points) {
    const slopes = [];
    for (let i = 0; i < points.length; i += 1) {
        for (let j = i + 1; j < points.length; j += 1) {
            const dt = points[j].ts - points[i].ts;
            if (dt <= 0)
                continue;
            slopes.push((points[j].pct - points[i].pct) / dt);
        }
    }
    if (slopes.length === 0)
        return 0;
    slopes.sort((a, b) => a - b);
    const mid = Math.floor(slopes.length / 2);
    return slopes.length % 2 === 1 ? slopes[mid] : (slopes[mid - 1] + slopes[mid]) / 2;
}
function forecastToPercent(points, targetPct, nowMs) {
    const windowed = points
        .filter((point) => Number.isFinite(point.pct) && point.ts >= nowMs - TRAILING_WINDOW_MS && point.ts <= nowMs)
        .sort((a, b) => a.ts - b.ts);
    // Cut at the most recent reset boundary — mixing pre- and post-reset
    // samples produces a nonsense (often negative) slope.
    let startIndex = 0;
    for (let i = 1; i < windowed.length; i += 1) {
        if (windowed[i - 1].pct - windowed[i].pct >= RESET_DROP_PCT)
            startIndex = i;
    }
    const series = windowed.slice(startIndex);
    const spanMs = series.length >= 2 ? series[series.length - 1].ts - series[0].ts : 0;
    if (series.length < MIN_SAMPLES || spanMs < MIN_SPAN_MS) {
        return noForecast(series.length, spanMs);
    }
    const slopePerMs = theilSenSlopePerMs(series);
    const slopePctPerHour = slopePerMs * 3_600_000;
    const confidence = spanMs >= 2 * 3_600_000 && series.length >= 8
        ? 'high'
        : spanMs >= 3_600_000 && series.length >= 6
            ? 'medium'
            : 'low';
    if (slopePerMs <= 0) {
        return { etaMs: null, slopePctPerHour, confidence, sampleCount: series.length, spanMs };
    }
    const last = series[series.length - 1];
    const remainingPct = targetPct - last.pct;
    if (remainingPct <= 0) {
        return { etaMs: 0, slopePctPerHour, confidence, sampleCount: series.length, spanMs };
    }
    const etaFromLast = remainingPct / slopePerMs;
    const etaMs = Math.max(0, etaFromLast - (nowMs - last.ts));
    return { etaMs, slopePctPerHour, confidence, sampleCount: series.length, spanMs };
}
