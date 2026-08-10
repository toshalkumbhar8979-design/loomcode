// Usage & billing tracker -- persists cumulative token/cost stats to ~/.loom/usage.json.
// Overridable via LOOM_USAGE_FILE env var (used by tests). The env var is read
// lazily on each load/save so tests can redirect the ledger at any time.
const fs = require('fs');
const path = require('path');
const os = require('os');

const USAGE_FILE = process.env.LOOM_USAGE_FILE || path.join(os.homedir(), '.loom', 'usage.json');
function usageFile() { return process.env.LOOM_USAGE_FILE || USAGE_FILE; }

function monthKey(d) {
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
}

function dayKey(d) {
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

function load() {
  try { return JSON.parse(fs.readFileSync(usageFile(), 'utf8')); } catch { return {}; }
}

function save(data) {
  try {
    fs.mkdirSync(path.dirname(usageFile()), { recursive: true });
    fs.writeFileSync(usageFile(), JSON.stringify(data, null, 2));
  } catch {}
}

function normalize(data) {
  const totals = data.totals || { inputTokens: 0, outputTokens: 0, costUsd: 0 };
  const months = data.months || {};
  const days = data.days || {};
  const key = monthKey(new Date());
  const dkey = dayKey(new Date());
  const month = months[key] || { inputTokens: 0, outputTokens: 0, costUsd: 0 };
  const day = days[dkey] || { costUsd: 0 };
  return {
    totals,
    months,
    days,
    month,
    day,
    key,
    dkey,
    budgetUsd: typeof data.budgetUsd === 'number' ? data.budgetUsd : 25,
    dailyAlertUsd: typeof data.dailyAlertUsd === 'number' ? data.dailyAlertUsd : 0,
    override: data.override || null,
  };
}

// Add a usage record (tokens + cost in USD) to the lifetime totals, current
// month, and current day.
function recordUsage({ inputTokens = 0, outputTokens = 0, costUsd = 0 } = {}) {
  const data = normalize(load());
  data.totals.inputTokens += inputTokens;
  data.totals.outputTokens += outputTokens;
  data.totals.costUsd += costUsd;
  data.months[data.key] = data.month;
  data.months[data.key].inputTokens += inputTokens;
  data.months[data.key].outputTokens += outputTokens;
  data.months[data.key].costUsd += costUsd;
  data.days[data.dkey] = data.day;
  data.days[data.dkey].costUsd += costUsd;
  save({ totals: data.totals, months: data.months, days: data.days, budgetUsd: data.budgetUsd, dailyAlertUsd: data.dailyAlertUsd, override: data.override });
}

function getUsage() {
  const data = normalize(load());
  return {
    totals: data.totals,
    month: data.month,
    monthKey: data.key,
    budgetUsd: data.budgetUsd,
    totalTokens: data.totals.inputTokens + data.totals.outputTokens,
    monthTokens: data.month.inputTokens + data.month.outputTokens,
    day: {
      key: data.dkey,
      costUsd: data.day.costUsd,
      alertUsd: data.dailyAlertUsd,
      alert: data.dailyAlertUsd > 0 && data.day.costUsd >= data.dailyAlertUsd,
    },
  };
}

function setMonthlyBudget(usd) {
  const data = normalize(load());
  // 0 is a valid value — it disables enforcement. Only fall back to 25 when
  // the input isn't a finite non-negative number (NaN, Infinity, negative).
  const n = Number(usd);
  data.budgetUsd = Number.isFinite(n) && n >= 0 ? n : 25;
  save({ totals: data.totals, months: data.months, days: data.days, budgetUsd: data.budgetUsd, dailyAlertUsd: data.dailyAlertUsd, override: data.override });
}

// Set the daily spend alert threshold in USD. 0 disables alerts. The alert is
// advisory (footer/status warning) — it never blocks a turn.
function setDailyAlert(usd) {
  const data = normalize(load());
  const n = Number(usd);
  data.dailyAlertUsd = Number.isFinite(n) && n >= 0 ? n : 0;
  save({ totals: data.totals, months: data.months, days: data.days, budgetUsd: data.budgetUsd, dailyAlertUsd: data.dailyAlertUsd, override: data.override });
}

function dayStatus() {
  const data = normalize(load());
  return {
    dayKey: data.dkey,
    dayCostUsd: data.day.costUsd || 0,
    alertUsd: data.dailyAlertUsd,
    alert: data.dailyAlertUsd > 0 && (data.day.costUsd || 0) >= data.dailyAlertUsd,
  };
}

// Where we stand against the monthly spend cap. `over` is true once the
// month's cost has reached the cap — sessions use this to hard-block paid
// turns. A cap of 0 disables enforcement (treated as unlimited).
// `overrideUsed` is true when the user explicitly confirmed a one-shot
// override for the current month (/budget override) that has not been
// consumed yet.
function budgetStatus() {
  const data = normalize(load());
  const usd = data.month.costUsd || 0;
  const cap = data.budgetUsd;
  const overrideUsed = !!(data.override && data.override.month === data.key && !data.override.consumed);
  return {
    monthCostUsd: usd,
    budgetUsd: cap,
    pct: cap > 0 ? (usd / cap) * 100 : 0,
    over: cap > 0 && usd >= cap,
    overrideUsed,
  };
}

// One-shot confirmation: lets exactly one paid turn through after the cap is
// reached. Consumed the first time a paid turn actually proceeds.
function requestOverride() {
  const data = normalize(load());
  data.override = { month: data.key, consumed: false };
  save({ totals: data.totals, months: data.months, days: data.days, budgetUsd: data.budgetUsd, dailyAlertUsd: data.dailyAlertUsd, override: data.override });
  return true;
}

function consumeOverride() {
  const data = normalize(load());
  if (!(data.override && data.override.month === data.key && !data.override.consumed)) return false;
  data.override.consumed = true;
  save({ totals: data.totals, months: data.months, days: data.days, budgetUsd: data.budgetUsd, dailyAlertUsd: data.dailyAlertUsd, override: data.override });
  return true;
}

// 37283 -> "37.3K", 1500000 -> "1.5M", 512 -> "512"
function formatTokens(n) {
  const v = Number(n) || 0;
  if (v >= 1e9) return (v / 1e9).toFixed(2).replace(/\.?0+$/, '') + 'B';
  if (v >= 1e6) return (v / 1e6).toFixed(1).replace(/\.0$/, '') + 'M';
  if (v >= 1e3) return (v / 1e3).toFixed(1).replace(/\.0$/, '') + 'K';
  return String(v);
}

// 4.843 -> "$4.84", 0.14 -> "$0.14", 120 -> "$120"
function formatUsd(n) {
  const v = Number(n) || 0;
  return '$' + (v >= 100 ? v.toFixed(0) : v.toFixed(2));
}

module.exports = { recordUsage, getUsage, setMonthlyBudget, setDailyAlert, dayStatus, budgetStatus, requestOverride, consumeOverride, formatTokens, formatUsd, usageFile, USAGE_FILE };
