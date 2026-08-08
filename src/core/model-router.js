// Model router — picks the right model for the current budget level.
// Levels: free (only $0 models) · cheap (free + low-cost) · best (anything) ·
// auto (explicit provider/model picks, no routing). Only providers with a
// configured key are considered, so the router never bricks on a missing key.
const { PROVIDERS, PROVIDER_ORDER, getModelMeta } = require('../providers/index.js');
const { getRecentModels, hasApiKey } = require('../config/settings');

const LEVELS = ['free', 'cheap', 'best', 'auto'];

// A model is "cheap" when a 1M-token input+output turn stays under this cap.
const CHEAP_TURN_USD = 2.5;
const CHEAP_IN = 0.5;
const CHEAP_OUT = 2;

function levelOf(meta) {
  if (!meta) return 'best';
  if ((meta.priceIn || 0) === 0 && (meta.priceOut || 0) === 0) return 'free';
  if ((meta.priceIn || 0) <= CHEAP_IN && (meta.priceOut || 0) <= CHEAP_OUT) return 'cheap';
  return 'best';
}

function matchesLevel(meta, level) {
  if (!level || level === 'auto') return true;
  if (level === 'free') return levelOf(meta) === 'free';
  if (level === 'cheap') return levelOf(meta) === 'free' || levelOf(meta) === 'cheap';
  return true; // best = everything
}

// Every model reachable with the keys currently configured. Local backends are
// excluded — the router must never auto-route to a server that may not be
// running; local is used only via explicit /model picks.
function usableModels() {
  const out = [];
  for (const p of PROVIDER_ORDER) {
    if (p === 'local') continue;
    if (!hasApiKey(p)) continue;
    for (const m of (PROVIDERS[p] && PROVIDERS[p].models) || []) {
      out.push({ provider: p, model: m.id, meta: m });
    }
  }
  return out;
}

// Pick the best model for a level. Preference: recently-used models (newest
// first), then lowest per-token price. `tried` skips models that already failed
// this session. Returns { provider, model } or null when nothing qualifies.
function pickModel(level, opts = {}) {
  if (!level || level === 'auto') return null;
  const tried = opts.tried || [];
  const all = usableModels().filter((c) => matchesLevel(c.meta, level));
  if (!all.length) return null;

  const fresh = all.filter((c) => !tried.includes(c.provider + '/' + c.model));
  const pool = fresh.length ? fresh : all;

  for (const r of getRecentModels()) {
    const hit = pool.find((c) => c.provider === r.provider && c.model === r.model);
    if (hit) return { provider: hit.provider, model: hit.model };
  }

  pool.sort((a, b) =>
    (a.meta.priceIn + a.meta.priceOut) - (b.meta.priceIn + b.meta.priceOut));
  return { provider: pool[0].provider, model: pool[0].model };
}

// Estimated USD cost of a turn on a given model.
function estimateTurnCost(providerName, modelId, inputTokens, outputTokens) {
  const meta = getModelMeta(providerName, modelId);
  if (!meta) return null;
  return ((inputTokens || 0) / 1e6) * (meta.priceIn || 0) +
         ((outputTokens || 0) / 1e6) * (meta.priceOut || 0);
}

// Human-readable summary of what a level means right now.
function describeLevel(level) {
  const picked = pickModel(level);
  const free = usableModels().some((c) => matchesLevel(c.meta, 'free'));
  const cheap = usableModels().some((c) => matchesLevel(c.meta, 'cheap'));
  return {
    level,
    picked,
    freeAvailable: free,
    cheapAvailable: cheap,
  };
}

module.exports = { LEVELS, levelOf, matchesLevel, usableModels, pickModel, estimateTurnCost, describeLevel, CHEAP_TURN_USD };
