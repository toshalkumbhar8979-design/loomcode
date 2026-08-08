// Skill matcher — Phase 2.2. Finds installed skills whose keywords overlap with
// the user's current message. Cheap: zero model calls, pure heuristics on
// frontmatter + skill dir names + file-type keywords.
//
// The idea: a skill is "triggered" when its name, filename, or description
// mentions a token in the message (normalized to lowercase, word-boundary).
// The list is deterministic and sorted by match count (strongest first).
const fs = require('fs');
const path = require('path');
const { listSkills } = require('./skills-manager');

// Keyword aliases: user-typed word -> keyword that matches in the skill name/description.
const KEYWORD_ALIASES = {
  gcode: ['gcode', 'slice', 'slicer', 'print', 'fdm', '3d print'],
  cad: ['cad', '3d', 'step', 'stp', 'dxf', 'stl', 'glb', 'parametric', 'model'],
  bambulab: ['bambu', 'print', 'prusa', 'lan', '3d print'],
  sring: ['srdf', 'urdf', 'robot', 'ros', 'gazebo', 'joint', 'link', 'moveit'],
  gcodeviewer: ['gcode', 'slice', 'viewer'],
  stepviewer: ['step', 'stp', 'cad', 'viewer'],
  stlviewer: ['stl', '3d', 'viewer'],
  payment: ['payment', 'pay', 'checkout', 'stripe', 'sepay', 'license', 'billing'],
  theme: ['theme', 'color scheme', 'palette', 'dark', 'light'],
};

function normalizeWord(w) {
  return w.toLowerCase().replace(/[^a-z0-9._-]/g, '');
}

function buildAliasMap() {
  const aliases = {};
  for (const [skillName, keywords] of Object.entries(KEYWORD_ALIASES)) {
    for (const kw of keywords) {
      if (!aliases[kw]) aliases[kw] = new Set();
      aliases[kw].add(skillName);
    }
  }
  // also map aliases for dir names
  for (const [skillName, keywords] of Object.entries(KEYWORD_ALIASES)) {
    const dir = skillName;
    for (const kw of keywords) {
      if (!aliases[kw]) aliases[kw] = new Set();
      aliases[kw].add(dir);
    }
  }
  return aliases;
}

const ALIASES = buildAliasMap();

// Split the user message into normalized "words" (strip punctuation, lowercase,
// split on whitespace). Common stop words are dropped so "a" or "this" can't trigger.
const STOP_WORDS = new Set(['a', 'an', 'the', 'this', 'that', 'these', 'those', 'i', 'you', 'he', 'she', 'we', 'they', 'it', 'to', 'in', 'on', 'at', 'for', 'with', 'and', 'or', 'of', 'is', 'are', 'be', 'my', 'me', 'your', 'that\'s', 'i\'m', 'how', 'what', 'why', 'when', 'where', 'show', 'tell', 'please', 'can', 'do', 'does', 'will', 'need', 'want', 'make', 'use', 'get']);

function tokenize(text) {
  if (!text) return [];
  return String(text)
    .split(/\s+/)
    .map(normalizeWord)
    .filter((w) => w.length >= 3 && !STOP_WORDS.has(w));
}

// Score a single skill against a word list. Higher = stronger match.
function scoreSkill(skill, wordSet) {
  const name = String(skill.name || '').toLowerCase();
  const desc = String(skill.description || '').toLowerCase();
  const dirName = path.basename(String(skill.dir || '')).toLowerCase();
  const haystack = name + ' ' + desc + ' ' + dirName;
  let score = 0;
  let matched = [];
  for (const w of wordSet) {
    // direct containment check (substring covers plurals: "slicing" contains "slice")
    if (haystack.includes(w)) {
      score += 1;
      matched.push(w);
      continue;
    }
    // alias-word -> skill matches via alias expansion
    if (ALIASES[w]) {
      for (const alias of ALIASES[w]) {
        if (haystack.includes(alias)) {
          score += 1.5; // alias match > generic word
          matched.push(`${w}→${alias}`);
          break;
        }
      }
    }
  }
  if (score === 0) return null;
  return { skill, score, matched };
}

// Cache SKILL.md instructions keyed by dir path (with mtime invalidation) so we
// only re-read when the file changes.
const _instrCache = new Map();
function loadInstructions(dir) {
  try {
    const key = String(dir);
    const p = path.join(dir, 'SKILL.md');
    const stat = fs.statSync(p);
    const mtime = stat.mtimeMs;
    const cached = _instrCache.get(key);
    if (cached && cached.mtime === mtime) return cached.instructions;
    const instructions = fs.readFileSync(p, 'utf8').slice(0, 8000);
    _instrCache.set(key, { mtime, instructions });
    return instructions;
  } catch { return ''; }
}

// Return the top-N triggered skills for a user message.
// `skillsList` can inject a fake set for testing.
function match(message, skillsList) {
  const words = tokenize(message);
  const wordSet = new Set(words);
  const skills = skillsList || listSkills();
  const out = [];
  for (const s of skills) {
    const hit = scoreSkill(s, wordSet);
    if (!hit) continue;
    // Require at least 2 matching words to avoid spurious one-word triggers like "print"
    if (hit.score < 2) continue;
    out.push(hit);
  }
  out.sort((a, b) => b.score - a.score);
  // Attach the full SKILL.md instructions to each winner so the session can
  // inject them into the system prompt. Lazy-load + mtime-cache per dir.
  const top = out.slice(0, 3);
  for (const hit of top) {
    if (hit.skill.instructions === undefined) hit.skill.instructions = loadInstructions(hit.skill.dir);
  }
  return top.map((h) => h.skill);
}

module.exports = { match, tokenize, scoreSkill };
