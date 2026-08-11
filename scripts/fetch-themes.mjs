// Build-time: convert shiki TextMate themes (in @shikijs/themes) into Loom
// Palettes, written to src/tui/themes.generated.ts. Run with:
//   node scripts/fetch-themes.mjs
// "loom" stays the default and sits on top of the picker; every entry below is
// generated from the upstream shiki theme on disk — never hand-tuned.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const SHIKI = path.join(ROOT, "node_modules", "@shikijs", "themes", "dist");
const OUT = path.join(ROOT, "src", "tui", "themes.generated.ts");

// [id, shiki module, label, tagline] — ORDER of this list == picker order.
const MAPPINGS = [
  ["ayu", "ayu-dark", "Ayu", "Dark + warm accents, VS Code classic"],
  ["catppuccin", "catppuccin-mocha", "Catppuccin Mocha", "Pastel, coffee-toned dark"],
  ["catppuccin-frappe", "catppuccin-frappe", "Catppuccin Frappé", "Pastel, medium-dark"],
  ["catppuccin-macchiato", "catppuccin-macchiato", "Catppuccin Macchiato", "Pastel, deep dark"],
  ["catppuccin-latte", "catppuccin-latte", "Catppuccin Latte", "Pastel, light"],
  ["dracula", "dracula", "Dracula", "Vampiric pink/purple classic"],
  ["dracula-soft", "dracula-soft", "Dracula Soft", "Mellower dracula"],
  ["everforest", "everforest-dark", "Everforest", "Muted greens, soft contrast"],
  ["github", "github-dark", "GitHub", "GitHub dark theme"],
  ["gruvbox", "gruvbox-dark-medium", "Gruvbox", "Retro groove, warm dark tones"],
  ["kanagawa", "kanagawa-wave", "Kanagawa", "Japanese ink-painting inspired"],
  ["material", "material-theme", "Material", "Google material dark theme"],
  ["material-darker", "material-theme-darker", "Material Darker", "Darker material variant"],
  ["monokai", "monokai", "Monokai", "Classic green/yellow"],
  ["nightowl", "night-owl", "Night Owl", "Dark blue, gentle contrast"],
  ["nord", "nord", "Nord", "Arctic, north-bluish color palette"],
  ["one-dark", "one-dark-pro", "One Dark Pro", "Atom's One Dark, pro variant"],
  ["palenight", "material-theme-palenight", "Palenight", "Material palenight — deep blue"],
  ["rosepine", "rose-pine", "Rosé Pine", "All natural pine, muted pastels"],
  ["rosepine-dawn", "rose-pine-dawn", "Rosé Pine Dawn", "Warm, light variant"],
  ["solarized", "solarized-dark", "Solarized Dark", "Precision colors, low contrast"],
  ["solarized-light", "solarized-light", "Solarized Light", "Solarized light variant"],
  ["synthwave", "synthwave-84", "Synthwave '84", "Retro neon"],
  ["tokyonight", "tokyo-night", "Tokyo Night", "Tokyo city lights"],
  ["vesper", "vesper", "Vesper", "Evening calm, dark theme"],
  ["vitesse", "vitesse-dark", "Vitesse", "Elegant dark theme"],
];

function hexToRgb(hex) {
  const m = /^#?([0-9a-fA-F]{6})([0-9a-fA-F]{2})?$/.exec(String(hex || "").trim());
  if (!m) return null;
  return [parseInt(m[1].slice(0, 2), 16), parseInt(m[1].slice(2, 4), 16), parseInt(m[1].slice(4, 6), 16)];
}

function toHex(rgb) {
  return "#" + rgb.map(v => Math.max(0, Math.min(255, v)).toString(16).padStart(2, "0")).join("");
}

// Scale a hex color toward dark (f < 1 darkens, f > 1 lightens).
function scale(hex, f) {
  const rgb = hexToRgb(hex);
  if (!rgb) return hex;
  return toHex(rgb.map(v => Math.round(v * f)));
}

// Mix hex color toward a target hex by factor f ∈ [0..1].
function mix(hex, target, f) {
  const a = hexToRgb(hex), b = hexToRgb(target);
  if (!a || !b) return hex;
  return toHex(a.map((v, i) => Math.round(v + (b[i] - v) * f)));
}

// Normalize to a solid #rrggbb (strips any alpha channel; rejects garbage).
function norm(hex) {
  const m = /^#?([0-9a-fA-F]{6})([0-9a-fA-F]{2})?$/.exec(String(hex || "").trim());
  if (!m) return null;
  return "#" + m[1].toLowerCase();
}

// Perceived luminance 0..255.
function lum(hex) {
  const rgb = hexToRgb(hex);
  if (!rgb) return 0;
  return 0.299 * rgb[0] + 0.587 * rgb[1] + 0.114 * rgb[2];
}

// A border that is always visible against the background. Shiki themes often
// ship panel.border as transparent ("#0000"), 8-digit alpha, or the exact
// background color — any of those makes UI grid lines vanish. Accept the
// theme's border only when it clears a real contrast bar; otherwise derive
// one: lighten dark themes, darken light themes.
function borderFor(bg, themeBorder) {
  const base = norm(bg) || "#1e1e1e";
  const raw = norm(themeBorder);
  if (raw && Math.abs(lum(raw) - lum(base)) >= 28) return raw;
  return lum(base) < 128 ? mix(base, "#ffffff", 0.38) : mix(base, "#000000", 0.35);
}

// Pick the foreground color for a TextMate scope: exact match first, then
// prefix fallback (so "keyword.control" hits "keyword").
function pickScope(tokenColors, wanted) {
  for (const rule of tokenColors || []) {
    const scopes = rule.scope ? (Array.isArray(rule.scope) ? rule.scope : [rule.scope]) : [];
    for (const s of scopes) {
      if (!s) continue;
      for (const part of String(s).split(",")) {
        if (part.trim() === wanted && rule.settings?.foreground) return rule.settings.foreground;
      }
    }
  }
  for (const rule of tokenColors || []) {
    const scopes = rule.scope ? (Array.isArray(rule.scope) ? rule.scope : [rule.scope]) : [];
    for (const s of scopes) {
      if (!s) continue;
      for (const part of String(s).split(",")) {
        const head = part.trim().split(".")[0];
        if (head === wanted && rule.settings?.foreground) return rule.settings.foreground;
      }
    }
  }
  return null;
}

async function loadTheme(name) {
  const mod = await import("file://" + path.join(SHIKI, name + ".mjs").replace(/\\/g, "/"));
  return mod.default;
}

async function main() {
  const built = [];
  for (const [id, shikiName, label, desc] of MAPPINGS) {
    let th;
    try {
      th = await loadTheme(shikiName);
    } catch (e) {
      console.error("MISS shiki theme module:", shikiName, e.message || e);
      process.exitCode = 1;
      continue;
    }
    const colors = th.colors || {};
    const tokenColors = Array.isArray(th.tokenColors) ? th.tokenColors : [];

    const bg = norm(colors["editor.background"]) || "#1e1e1e";
    const fg = norm(colors["editor.foreground"]) || "#d4d4d4";
    const sideBarBg = norm(colors["sideBar.background"]) || bg;
    const panelBg = norm(colors["panel.background"]) || bg;
    const inputBg = norm(colors["editorWidget.background"] || colors["input.background"]) || bg;
    const statusBarBg = norm(colors["statusBar.background"]) || bg;
    const border = borderFor(bg, colors["panel.border"] || colors["sideBar.border"] || colors["editorGroup.border"] || scale(bg, 1.4));
    const selBgRaw = colors["editor.selectionBackground"] || colors["editor.lineHighlightBackground"] || "#264f78";
    // Strip alpha from selection for a solid hover color.
    const selHex = selBgRaw.length === 9 ? selBgRaw.slice(0, 7) : selBgRaw;
    const selection = mix(selHex, fg, 0.08);

    // Syntax colors straight from the theme's TextMate rules — this is what
    // makes code look like it does in VS Code under the same theme.
    const kw = pickScope(tokenColors, "keyword") || pickScope(tokenColors, "storage") || fg;
    const str = pickScope(tokenColors, "string") || fg;
    const com = pickScope(tokenColors, "comment") || scale(fg, 0.55);
    const num = pickScope(tokenColors, "constant") || pickScope(tokenColors, "constant.numeric") || fg;
    const ent = pickScope(tokenColors, "entity") || pickScope(tokenColors, "entity.name.function") || fg;
    const support = pickScope(tokenColors, "support") || ent;
    const vrb = pickScope(tokenColors, "variable") || fg;
    const storage = pickScope(tokenColors, "storage") || kw;

    const link = colors["textLink.foreground"] || kw;
    const warning = colors["editorWarning.foreground"] || "#cca700";
    const error = colors["editorError.foreground"] || "#f44747";
    const success = colors["editorGutter.addedBackground"] || "#487e35";

    built.push({
      id, label, desc,
      palette: {
        bg,
        bgMsg: scale(bg, 0.82),
        bgPanel: sideBarBg,
        bgPanelAlt: panelBg,
        bgInput: inputBg,
        bgHover: selection,
        border,
        borderFocus: kw,
        fg,
        fgDim: mix(fg, bg, 0.35),
        fgMuted: mix(fg, bg, 0.6),
        primary: kw,
        primarySoft: mix(kw, bg, 0.2),
        secondary: ent,
        accent: link,
        success: success.startsWith("#") ? success.slice(0, 7) : success,
        warning: warning.startsWith("#") ? warning.slice(0, 7) : warning,
        error: error.startsWith("#") ? error.slice(0, 7) : error,
        thinking: mix(link, fg, 0.25),
        pet: ent,
        syntax: {
          kw, str, com, num,
          call: ent,
          plain: fg,
          storage, support, variable: vrb,
        },
      },
    });
  }

  const stub = "// Generated by scripts/fetch-themes.mjs — do not edit by hand.\n" +
    "// Source of truth: @shikijs/themes registry. Re-run the script after\n" +
    "// adding a row to MAPPINGS or bumping the package.\n\n" +
    "export const GENERATED_THEMES = " + JSON.stringify(built, null, 2) + ";\n";
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, stub);
  console.log("wrote", path.relative(ROOT, OUT), "with", built.length, "themes");
}

main().catch(e => { console.error(e); process.exit(1); });
