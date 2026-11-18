// Forecast a game's launch-day Twitch viewers hour by hour.
//
// make.fun bounty: gta6-twitch-ccu-forecast-01
// Node 22, standard library only. No network, no dependencies.
//
// Usage (as run by the harness):
//   MAKEFUN_INPUT_DIR=/input MAKEFUN_OUTPUT_DIR=/output node /bot/main.ts
// Reads every *.in case file in the input directory and writes one
// <id>.out per case: {"hours": [23 rows, hours 2-24]} where each row is
// {"hour": h, "q": [q05, q25, q50, q75, q95]}.
//
// Model
// -----
// Each case ships the launch-day hourly curves of dozens of past big
// launches ("comparables"). Two anchors describe the case's scale:
//
//   * hour-1 print - the viewers in the first hour of the release day.
//     Noisy: hour 1 (00:00-01:00Z) only covers the regions that already
//     unlocked, so for a rolling-midnight launch it is a dip.
//   * pre-launch peak - the highest hourly viewers in the 24 hours before
//     the release day, from the case's own history. A much steadier anchor
//     for launch demand, but only when pre-launch viewership is real
//     (no early access / no pre-release streams => it can be tiny).
//
// For each comparable we build both log-ratio curves:
//   ln(viewers_h / pre-launch-peak) and ln(viewers_h / hour-1 print).
// Comparables whose launch-day peak is more than 20x either anchor are
// dropped: those are fixed-time global unlocks whose hour-1 print is
// meaningless, and their shapes do not transfer to a rolling-midnight
// launch. (If every comparable fails that filter, the filter is relaxed
// rather than discarding all shape information.) Per hour, the forecast quantiles are kernel-weighted empirical
// quantiles across the remaining comparables, weighting comparables whose
// anchor level is close to the case's (Gaussian kernel, bandwidth 1 in log
// space), with the spread shrunk 15% toward the median (the raw
// cross-comparable spread is wider than the conditional spread).
//
// The two anchor forecasts are blended in log space. When the pre-launch
// peak is at least the hour-1 print, the pre-launch anchor gets 60% weight;
// when the pre-launch peak is far below the hour-1 print (pre-launch
// viewership was uninformative), its weight fades toward zero so the
// forecast tracks the hour-1 anchor instead.
//
// The program never crashes: every case is handled independently, every
// parse is guarded, and any failure falls back to a flat forecast anchored
// on the best level available, so a valid output file is always written.

import { readdirSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const LEVELS = [0.05, 0.25, 0.5, 0.75, 0.95];
// Normal quantiles for the flat fallback forecast.
const Z = [-1.645, -0.674, 0, 0.674, 1.645];
const HOURS = Array.from({ length: 23 }, (_, i) => i + 2);
const MAX_VIEWERS = 1e9;
const PEAK_RATIO_LIMIT = 20;
const KERNEL_BANDWIDTH = 1.0;
const SPREAD_SHRINK = 0.85;
const PRELAUNCH_WEIGHT = 0.6;
const MIN_PRELAUNCH_WEIGHT = 0.05;
const HOUR_MS = 3600000;

function isNum(v) {
  return typeof v === "number" && Number.isFinite(v);
}

function round2(x) {
  return Math.round(x * 100) / 100;
}

// Clamp to the contract range and force non-decreasing quantiles.
function cleanQuantiles(q) {
  const out = [];
  let prev = 1;
  for (const v of q) {
    let x = isNum(v) ? v : prev;
    if (x < 1) x = 1;
    if (x > MAX_VIEWERS) x = MAX_VIEWERS;
    if (x < prev) x = prev;
    out.push(round2(x));
    prev = x;
  }
  return out;
}

// Weighted empirical quantile. pairs: [[value, weight], ...].
function weightedQuantile(pairs, q) {
  const sorted = pairs.slice().sort((a, b) => a[0] - b[0]);
  let total = 0;
  for (const [, w] of sorted) total += w;
  if (!(total > 0)) return 0;
  let acc = 0;
  for (const [v, w] of sorted) {
    acc += w;
    if (acc >= q * total) return v;
  }
  return sorted[sorted.length - 1][0];
}

// Parse one comparable into its two log-ratio curves, or null if unusable.
// A comparable is usable only if it has a full 24-hour launch day, a
// positive hour-1 print, and a positive pre-launch 24h peak. With strict
// filtering, comparables whose launch-day peak is within PEAK_RATIO_LIMIT
// of both anchors are also dropped: those are fixed-time global unlocks,
// whose hour-1 print is not a launch level, and their shapes do not
// transfer to a rolling-midnight launch.
function parseComparable(c, strict) {
  try {
    if (!c || typeof c !== "object") return null;
    const t0 = Date.parse(c.day_start);
    if (!Number.isFinite(t0)) return null;
    if (!Array.isArray(c.hourly)) return null;
    const day = new Map();
    let prePeak24 = 0;
    for (const p of c.hourly) {
      if (!p || typeof p !== "object") continue;
      const t = Date.parse(p.from);
      if (!Number.isFinite(t) || !isNum(p.viewers) || p.viewers <= 0) continue;
      const h = Math.round((t - t0) / HOUR_MS) + 1;
      if (h >= 1 && h <= 24) day.set(h, p.viewers);
      if (t >= t0 - 24 * HOUR_MS && t < t0 && p.viewers > prePeak24) {
        prePeak24 = p.viewers;
      }
    }
    if (day.size < 24 || prePeak24 <= 0) return null;
    const v1 = day.get(1);
    if (!v1 || v1 <= 0) return null;
    let peak = 0;
    for (const v of day.values()) if (v > peak) peak = v;
    if (strict && (peak / v1 > PEAK_RATIO_LIMIT || peak / prePeak24 > PEAK_RATIO_LIMIT)) {
      return null;
    }
    const ratiosPre = {};
    const ratiosV1 = {};
    for (const [h, v] of day) {
      ratiosPre[h] = Math.log(v / prePeak24);
      ratiosV1[h] = Math.log(v / v1);
    }
    return { v1, prePeak24, ratiosPre, ratiosV1 };
  } catch {
    return null;
  }
}

// The case's own anchors: hour-1 print and pre-launch 24h peak.
function caseAnchors(cse) {
  let v1 = 0;
  try {
    const k = Array.isArray(cse.known) ? cse.known[0] : null;
    if (k && isNum(k.viewers) && k.viewers > 0) v1 = k.viewers;
  } catch {
    // fall through
  }
  let prePeak24 = 0;
  try {
    const t0 = Date.parse(cse.day_start);
    if (Number.isFinite(t0) && Array.isArray(cse.history)) {
      for (const p of cse.history) {
        if (!p || typeof p !== "object") continue;
        const t = Date.parse(p.at);
        if (!Number.isFinite(t) || !isNum(p.viewers)) continue;
        if (t >= t0 - 24 * HOUR_MS && t < t0 && p.viewers > prePeak24) {
          prePeak24 = p.viewers;
        }
      }
    }
  } catch {
    // fall through
  }
  return { v1, prePeak24 };
}

// One anchor's forecast: kernel-weighted quantiles of the comparables'
// log-ratio curves, anchored on the case's level, spread shrunk toward
// the weighted median. Returns {hour: [q05..q95]} (raw, not yet cleaned).
function anchorForecast(anchor, comparables, caseLevel, ratioKey, levelKey, levels) {
  const rows = {};
  for (const h of HOURS) {
    const pairs = [];
    for (const c of comparables) {
      const r = c[ratioKey][h];
      if (!isNum(r)) continue;
      const d = Math.log(c[levelKey] / caseLevel) / KERNEL_BANDWIDTH;
      pairs.push([r, Math.exp(-0.5 * d * d)]);
    }
    if (!pairs.length) {
      rows[h] = levels.map(() => anchor);
      continue;
    }
    const med = weightedQuantile(pairs, 0.5);
    rows[h] = levels.map((tau) => {
      const q = weightedQuantile(pairs, tau);
      return anchor * Math.exp(med + SPREAD_SHRINK * (q - med));
    });
  }
  return rows;
}

// Flat fallback: q50 pinned at the level, quantiles widening with horizon.
function flatForecast(level, levels) {
  const rows = {};
  for (const h of HOURS) {
    const s = 0.15 * Math.sqrt(h - 1);
    rows[h] = levels.map((_, j) => level * Math.exp(Z[j] * s));
  }
  return rows;
}

function blendRows(rowsA, rowsB, wA, levels) {
  const rows = {};
  for (const h of HOURS) {
    rows[h] = cleanQuantiles(
      levels.map((_, j) => Math.exp(wA * Math.log(rowsA[h][j]) + (1 - wA) * Math.log(rowsB[h][j]))),
    );
  }
  return rows;
}

function forecastCase(cse) {
  const levels = Array.isArray(cse.levels) &&
    cse.levels.length === 5 &&
    cse.levels.every((v) => isNum(v) && v > 0 && v < 1)
    ? cse.levels
    : LEVELS;
  const { v1, prePeak24 } = caseAnchors(cse);
  const level = v1 > 0 ? v1 : prePeak24 > 0 ? prePeak24 : 1;

  let comparables = [];
  try {
    const raw = Array.isArray(cse.comparables) ? cse.comparables : [];
    comparables = raw.map((c) => parseComparable(c, true)).filter(Boolean);
    if (!comparables.length) {
      // Every comparable failed the strict filter: relax it and use all
      // complete curves rather than discarding the shape information.
      comparables = raw.map((c) => parseComparable(c, false)).filter(Boolean);
    }
  } catch {
    comparables = [];
  }
  if (!comparables.length) {
    // No usable comparable at all: flat forecast on the best level.
    const rows = {};
    const flat = flatForecast(level, levels);
    for (const h of HOURS) rows[h] = cleanQuantiles(flat[h]);
    return rows;
  }

  const rowsB = anchorForecast(level, comparables, level, "ratiosV1", "v1", levels);
  if (!(prePeak24 > 0)) {
    const rows = {};
    for (const h of HOURS) rows[h] = cleanQuantiles(rowsB[h]);
    return rows;
  }

  const rowsA = anchorForecast(prePeak24, comparables, prePeak24, "ratiosPre", "prePeak24", levels);
  // Blend weight for the pre-launch anchor: full weight when the pre-launch
  // peak is at least the hour-1 print, fading out in log space as the
  // pre-launch peak falls below it (uninformative pre-launch level).
  const r = prePeak24 / level;
  let wA = PRELAUNCH_WEIGHT;
  if (r < 1) {
    wA = PRELAUNCH_WEIGHT * Math.max(0, 1 + Math.log10(r));
    if (wA < MIN_PRELAUNCH_WEIGHT) wA = MIN_PRELAUNCH_WEIGHT;
  }
  return blendRows(rowsA, rowsB, wA, levels);
}

// A valid output for a case we could not read at all.
function fallbackOutput() {
  const rows = {};
  const flat = flatForecast(1, LEVELS);
  for (const h of HOURS) rows[h] = cleanQuantiles(flat[h]);
  return { hours: HOURS.map((h) => ({ hour: h, q: rows[h] })) };
}

function main() {
  const inputDir = process.env.MAKEFUN_INPUT_DIR || "/input";
  const outputDir = process.env.MAKEFUN_OUTPUT_DIR || "/output";
  let files = [];
  try {
    files = readdirSync(inputDir).filter((f) => f.endsWith(".in")).sort();
  } catch {
    return; // No readable input directory: nothing to do.
  }
  try {
    mkdirSync(outputDir, { recursive: true });
  } catch {
    return; // Nowhere to write: nothing we can do.
  }
  for (const file of files) {
    const id = file.slice(0, -3);
    let out;
    try {
      const cse = JSON.parse(readFileSync(join(inputDir, file), "utf8"));
      const rows = forecastCase(cse);
      out = { hours: HOURS.map((h) => ({ hour: h, q: rows[h] })) };
    } catch {
      out = fallbackOutput();
    }
    try {
      writeFileSync(join(outputDir, `${id}.out`), JSON.stringify(out));
    } catch {
      // One failed write must not stop the other cases.
    }
  }
}

main();
