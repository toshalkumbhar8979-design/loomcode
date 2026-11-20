// Loom Code — visual language.
//
// A terminal-native surface: near-black canvas, one blue signal, green for
// success, amber for attention, rose for failure. Chrome is a hairline, not a
// frame. Content is the interface.
import { createSignal } from "solid-js";
import fs from "fs";
import path from "path";
import { ROBOT_FRAMES } from "./robot-frames.generated.ts";
import { loadTuiJson, saveTuiJson } from "./tui-config.ts";

export type Palette = {
  bg: string; bgMsg: string; bgPanel: string; bgPanelAlt: string; bgInput: string; bgHover: string;
  bgDiffAdd: string; bgDiffDel: string;
  border: string; borderFocus: string;
  fg: string; fgDim: string; fgMuted: string;
  primary: string; primarySoft: string;
  secondary: string; accent: string;
  success: string; warning: string; error: string; thinking: string;
  syntax: { kw: string; str: string; com: string; num: string; call: string; plain: string };
};

export type Theme = { id: string; label: string; desc: string; palette: Palette };

const LOOM: Palette = {
  bg: "#0d0d0d",
  bgMsg: "#1b1b1b",
  bgPanel: "#141414",
  bgPanelAlt: "#242424",
  bgInput: "#101010",
  bgHover: "#2a2a2a",
  bgDiffAdd: "#13251a",
  bgDiffDel: "#2a151a",
  border: "#2e2e2e",
  borderFocus: "#7aa2f7",
  fg: "#e6e6e6",
  fgDim: "#a4a4a4",
  fgMuted: "#6e6e6e",
  primary: "#7aa2f7",
  primarySoft: "#a9c1ff",
  secondary: "#9ece6a",
  accent: "#e0af68",
  success: "#9ece6a",
  warning: "#e0af68",
  error: "#f7768e",
  thinking: "#8f8f8f",
  syntax: { kw: "#bb9af7", str: "#9ece6a", com: "#6e6e6e", num: "#ff9e64", call: "#7aa2f7", plain: "#e6e6e6" },
};

const PAPER: Palette = {
  bg: "#f7f4ec",
  bgMsg: "#ece5d8",
  bgPanel: "#f1ece1",
  bgPanelAlt: "#e5ddcd",
  bgInput: "#fffdf8",
  bgHover: "#d9cfbc",
  bgDiffAdd: "#e1ecd9",
  bgDiffDel: "#f2dcd7",
  border: "#c6b9a2",
  borderFocus: "#2f5d8a",
  fg: "#262420",
  fgDim: "#5f5a50",
  fgMuted: "#8b8272",
  primary: "#2f5d8a",
  primarySoft: "#4a7cad",
  secondary: "#3f7d4e",
  accent: "#a56b1c",
  success: "#3f7d4e",
  warning: "#a56b1c",
  error: "#a63a34",
  thinking: "#7a7468",
  syntax: { kw: "#7a4f7e", str: "#3f7d4e", com: "#8b8272", num: "#8a5a1c", call: "#2f5d8a", plain: "#262420" },
};

const GLACIER: Palette = {
  bg: "#0b1220",
  bgMsg: "#121d30",
  bgPanel: "#101b2d",
  bgPanelAlt: "#17253c",
  bgInput: "#0d1726",
  bgHover: "#1d2f4a",
  bgDiffAdd: "#122a22",
  bgDiffDel: "#2a171c",
  border: "#2b405c",
  borderFocus: "#6cb8e8",
  fg: "#dbe7f2",
  fgDim: "#94a9bd",
  fgMuted: "#647c93",
  primary: "#6cb8e8",
  primarySoft: "#a3d4f2",
  secondary: "#8fd0c5",
  accent: "#e8c46c",
  success: "#8fd0a5",
  warning: "#e8c46c",
  error: "#e07a7a",
  thinking: "#8fa3b8",
  syntax: { kw: "#6cb8e8", str: "#8fd0a5", com: "#647c93", num: "#e8c46c", call: "#8fd0c5", plain: "#dbe7f2" },
};

const NOCTURNE: Palette = {
  bg: "#100e16",
  bgMsg: "#1a1626",
  bgPanel: "#17131f",
  bgPanelAlt: "#211a2d",
  bgInput: "#130f1b",
  bgHover: "#2b2239",
  bgDiffAdd: "#1b2a22",
  bgDiffDel: "#2a1824",
  border: "#3a2f4c",
  borderFocus: "#b59ce8",
  fg: "#e6e0f2",
  fgDim: "#a89ec0",
  fgMuted: "#736a8c",
  primary: "#b59ce8",
  primarySoft: "#d0c1f4",
  secondary: "#8fd0c5",
  accent: "#e8b56c",
  success: "#96d0a8",
  warning: "#e8b56c",
  error: "#e07a8a",
  thinking: "#9a90b0",
  syntax: { kw: "#b59ce8", str: "#96d0a8", com: "#736a8c", num: "#e8b56c", call: "#8fd0c5", plain: "#e6e0f2" },
};

const MONO: Palette = {
  bg: "#0f0f0f",
  bgMsg: "#1b1b1b",
  bgPanel: "#181818",
  bgPanelAlt: "#232323",
  bgInput: "#121212",
  bgHover: "#2c2c2c",
  bgDiffAdd: "#202020",
  bgDiffDel: "#2a2a2a",
  border: "#383838",
  borderFocus: "#e6e6e6",
  fg: "#e6e6e6",
  fgDim: "#a3a3a3",
  fgMuted: "#6b6b6b",
  primary: "#e6e6e6",
  primarySoft: "#c9c9c9",
  secondary: "#bdbdbd",
  accent: "#cfcfcf",
  success: "#b0b0b0",
  warning: "#cfcfcf",
  error: "#efefef",
  thinking: "#8f8f8f",
  syntax: { kw: "#e6e6e6", str: "#bdbdbd", com: "#6b6b6b", num: "#cfcfcf", call: "#c9c9c9", plain: "#e6e6e6" },
};

export const THEMES: Record<string, Theme> = {
  loom: { id: "loom", label: "Loom", desc: "Near-black canvas + blue signal (default)", palette: LOOM },
  paper: { id: "paper", label: "Paper", desc: "Warm parchment + ink blue", palette: PAPER },
  glacier: { id: "glacier", label: "Glacier", desc: "Deep blue + ice cyan", palette: GLACIER },
  nocturne: { id: "nocturne", label: "Nocturne", desc: "Violet-black + orchid", palette: NOCTURNE },
  mono: { id: "mono", label: "Mono", desc: "Pure greyscale", palette: MONO },
};

function savedTheme(): string {
  const data = loadTuiJson();
  return typeof data.theme === "string" && THEMES[data.theme] ? data.theme : "loom";
}

const [themeId, setThemeId] = createSignal(savedTheme());

export function setTheme(id: string): boolean {
  if (!THEMES[id]) return false;
  setThemeId(id);
  saveTuiJson({ theme: id });
  return true;
}

export function themeName(): string {
  return themeId();
}

export function themeOptions(): { id: string; label: string; desc: string }[] {
  return Object.values(THEMES).map(t => ({ id: t.id, label: t.label, desc: t.desc }));
}

// Live proxy: every read resolves against the selected theme, so switching
// themes repaints without remounting components.
export function palette(_name?: string): Palette {
  return new Proxy(LOOM, {
    get(_t, prop) {
      const cur = THEMES[themeId()];
      return ((cur && cur.palette) || LOOM)[prop as keyof Palette];
    },
  }) as Palette;
}

export const ui = palette();

export const GLYPH = {
  mark: "◆",
  markOpen: "◇",
  pointer: "▸",
  caret: "█",
  dot: "·",
  dotFilled: "•",
  bar: "│",
  barHeavy: "┃",
  dash: "─",
  cross: "✗",
  check: "✓",
  bullet: "▪",
  arrow: "→",
  user: "▌",
  prompt: "›",
  star: "✦",
  diamond: "◈",
  ring: "◎",
  circle: "○",
  circleFilled: "●",
  bolt: "⚡",
  ellipsis: "…",
  up: "↑",
  down: "↓",
  weave: "╱",
  weaveAlt: "╲",
};

export const SPIN = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
export const TICK_MS = 120;

export function spinner(tick: number): string {
  return SPIN[Math.abs(tick) % SPIN.length];
}

export function fmtMs(ms: number): string {
  if (!ms || ms < 0) return "";
  return ms < 1000 ? Math.round(ms) + "ms" : (ms / 1000).toFixed(1) + "s";
}

export function fit(s: string, n: number): string {
  const t = String(s == null ? "" : s);
  return t.length <= n ? t : t.slice(0, Math.max(1, n - 1)) + GLYPH.ellipsis;
}

export function hairline(width: number): string {
  return GLYPH.dash.repeat(Math.max(1, width | 0));
}

// A compact context gauge: ██████░░░░
export function contextBar(pct: number, width = 10): string {
  const w = Math.max(1, width | 0);
  const filled = Math.max(0, Math.min(w, Math.round((Math.max(0, Math.min(100, pct)) / 100) * w)));
  return "█".repeat(filled) + "░".repeat(w - filled);
}

// A horizontal rule with an optional inline title: "┌─ TITLE ────────┐"
export function topRule(width: number, title?: string, opts?: { left?: string; right?: string }): string {
  const w = Math.max(8, width | 0);
  const left = opts?.left || title || "";
  const right = opts?.right || "";
  let body = GLYPH.dash.repeat(Math.max(0, w - 2));
  if (left) {
    const tag = " " + left + " ";
    body = tag + GLYPH.dash.repeat(Math.max(0, w - 2 - tag.length));
  }
  if (right && right.length + 2 < w - 2) {
    const tag = " " + right + " ";
    body = body.slice(0, Math.max(0, w - 2 - tag.length)) + tag;
  }
  return "┌" + body + "┐";
}

export function midRule(width: number, title?: string, opts?: { left?: string; right?: string }): string {
  const w = Math.max(8, width | 0);
  const left = opts?.left || title || "";
  const right = opts?.right || "";
  let body = GLYPH.dash.repeat(Math.max(0, w - 2));
  if (left) {
    const tag = " " + left + " ";
    body = tag + GLYPH.dash.repeat(Math.max(0, w - 2 - tag.length));
  }
  if (right && right.length + 2 < w - 2) {
    const tag = " " + right + " ";
    body = body.slice(0, Math.max(0, w - 2 - tag.length)) + tag;
  }
  return "├" + body + "┤";
}

export function botRule(width: number, title?: string, opts?: { left?: string; right?: string }): string {
  const w = Math.max(8, width | 0);
  const left = opts?.left || title || "";
  const right = opts?.right || "";
  let body = GLYPH.dash.repeat(Math.max(0, w - 2));
  if (left) {
    const tag = " " + left + " ";
    body = tag + GLYPH.dash.repeat(Math.max(0, w - 2 - tag.length));
  }
  if (right && right.length + 2 < w - 2) {
    const tag = " " + right + " ";
    body = body.slice(0, Math.max(0, w - 2 - tag.length)) + tag;
  }
  return "└" + body + "┘";
}

export const VERSION = (() => {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(import.meta.dir, "..", "..", "package.json"), "utf8"));
    return String(pkg.version || "0.0.0");
  } catch {
    return "0.0.0";
  }
})();

// Block wordmark for the splash and the quit banner.
export const WORDMARK = [
  "█    █████ █████ █   █",
  "█    █   █ █   █ ██ ██",
  "█    █   █ █   █ █ █ █",
  "█    █   █ █   █ █   █",
  "█████ █████ █████ █   █",
];

export const WORDMARK_PLAIN = WORDMARK.join("\n");

// Medium "LOOM CODE" logo printed after the renderer is destroyed. Five rows,
// 53 columns — readable in a normal terminal without dominating the scrollback.
const BLOCK5: Record<string, string[]> = {
  L: ["█    ", "█    ", "█    ", "█    ", "█████"],
  O: ["█████", "█   █", "█   █", "█   █", "█████"],
  M: ["█   █", "██ ██", "█ █ █", "█   █", "█   █"],
  " ": ["     ", "     ", "     ", "     ", "     "],
  C: ["█████", "█    ", "█    ", "█    ", "█████"],
  D: ["████ ", "█   █", "█   █", "█   █", "████ "],
  E: ["█████", "█    ", "████ ", "█    ", "█████"],
};
export const WORDMARK_CODE = [0, 1, 2, 3, 4].map(row =>
  Array.from("LOOM CODE").map(ch => BLOCK5[ch][row]).join(" ")
);
export const WORDMARK_CODE_PLAIN = WORDMARK_CODE.join("\n");

// Splash robot. Supplied 30x13 3D SDF ASCII bot frames: nine gaze directions
// plus blink, kept verbatim. RobotAnimation turns the anchored bot toward the
// pointer or composer.
export { ROBOT_FRAMES };
export const SPLASH_ART = ROBOT_FRAMES.center;
