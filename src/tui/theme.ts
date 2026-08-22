// Loom Code TUI — color themes + palette access.
// palette() returns a live Proxy: each property is read from the currently
// selected theme at render time, so switching themes re-renders instantly.
import { createSignal } from "solid-js";
import { loadTuiJson, saveTuiJson } from "./tui-config.ts";

export type Palette = {
  bg: string; bgMsg: string; bgPanel: string; bgPanelAlt: string; bgInput: string; bgHover: string;
  border: string; borderFocus: string;
  fg: string; fgDim: string; fgMuted: string;
  primary: string;   // brand accent
  primarySoft: string;
  secondary: string; // user accent
  accent: string;    // tool activity
  success: string; warning: string; error: string;
  thinking: string;
  // Syntax colors for markdown code blocks — each theme ships real VS Code
  // TextMate colors (keyword/string/comment/number/call/base) via fetch-themes.
  syntax: { kw: string; str: string; com: string; num: string; call: string; plain: string };
};

export type Theme = { id: string; label: string; desc: string; palette: Palette };

const LOOM_DARK: Palette = {
  // Deep warm charcoal — terracotta accents
  bg: "#191817",
  bgMsg: "#131211",
  bgPanel: "#211f1e",
  bgPanelAlt: "#2a2725",
  bgInput: "#25221f",
  bgHover: "#322e2a",
  border: "#4a4440",
  borderFocus: "#e07856",
  fg: "#f0ebe4",
  fgDim: "#a89e93",
  fgMuted: "#6e655c",
  primary: "#e07856",
  primarySoft: "#f4a27f",
  secondary: "#b8d0a8",
  accent: "#e8b06f",
  success: "#a3c084",
  warning: "#e0b356",
  error: "#e06c5a",
  thinking: "#d9a35f",
  syntax: {
    kw: "#e07856",
    str: "#a3c084",
    com: "#6e655c",
    num: "#e0b356",
    call: "#e8b06f",
    plain: "#f0ebe4",
  },
};

const LIGHT: Palette = {
  // Paper light — warm parchment with terracotta
  bg: "#faf7f2",
  bgMsg: "#efe9df",
  bgPanel: "#f3eee6",
  bgPanelAlt: "#eae3d8",
  bgInput: "#ffffff",
  bgHover: "#e0d6c8",
  border: "#c9bfae",
  borderFocus: "#c2593a",
  fg: "#2b2620",
  fgDim: "#6f675c",
  fgMuted: "#9a9082",
  primary: "#c2593a",
  primarySoft: "#a34a2f",
  secondary: "#5c7a4a",
  accent: "#b0742f",
  success: "#5f8a3d",
  warning: "#a97a1a",
  error: "#b33c2e",
  thinking: "#a5682a",
  syntax: {
    kw: "#c2593a",
    str: "#5f8a3d",
    com: "#9a9082",
    num: "#a97a1a",
    call: "#b0742f",
    plain: "#2b2620",
  },
};

const OCEAN: Palette = {
  // Deep navy — cyan accents
  bg: "#0e1a26",
  bgMsg: "#0a141d",
  bgPanel: "#132433",
  bgPanelAlt: "#182c3d",
  bgInput: "#16293a",
  bgHover: "#1e3346",
  border: "#2f4a61",
  borderFocus: "#4fc3f7",
  fg: "#e3eef6",
  fgDim: "#9db4c6",
  fgMuted: "#6d8599",
  primary: "#4fc3f7",
  primarySoft: "#81d4fa",
  secondary: "#80cbc4",
  accent: "#ffb74d",
  success: "#81c784",
  warning: "#ffd54f",
  error: "#e57373",
  thinking: "#ffb74d",
  syntax: {
    kw: "#4fc3f7",
    str: "#81c784",
    com: "#6d8599",
    num: "#ffd54f",
    call: "#ffb74d",
    plain: "#e3eef6",
  },
};

const FOREST: Palette = {
  // Dark evergreen — sage accents
  bg: "#0f1a12",
  bgMsg: "#0b130d",
  bgPanel: "#152319",
  bgPanelAlt: "#1b2d20",
  bgInput: "#182a1e",
  bgHover: "#223726",
  border: "#33503a",
  borderFocus: "#7bd88f",
  fg: "#e8f2e9",
  fgDim: "#9db3a0",
  fgMuted: "#6b8270",
  primary: "#7bd88f",
  primarySoft: "#a3e5b2",
  secondary: "#c6d8a8",
  accent: "#e0c568",
  success: "#9ccc65",
  warning: "#d4c34f",
  error: "#e08070",
  thinking: "#c9a95c",
  syntax: {
    kw: "#7bd88f",
    str: "#9ccc65",
    com: "#6b8270",
    num: "#d4c34f",
    call: "#e0c568",
    plain: "#e8f2e9",
  },
};

const MIDNIGHT: Palette = {
  // Near-black violet — lavender accents
  bg: "#131019",
  bgMsg: "#0f0c15",
  bgPanel: "#1a1625",
  bgPanelAlt: "#211c30",
  bgInput: "#1d1830",
  bgHover: "#2a2340",
  border: "#3d3356",
  borderFocus: "#a78bfa",
  fg: "#ede9f5",
  fgDim: "#a59bbd",
  fgMuted: "#6f6690",
  primary: "#a78bfa",
  primarySoft: "#c4b5fd",
  secondary: "#94d2bd",
  accent: "#f6ad55",
  success: "#9ae6b4",
  warning: "#fde68a",
  error: "#f87171",
  thinking: "#f0abfc",
  syntax: {
    kw: "#a78bfa",
    str: "#9ae6b4",
    com: "#6f6690",
    num: "#fde68a",
    call: "#f6ad55",
    plain: "#ede9f5",
  },
};

const MONO: Palette = {
  // Pure monochrome — greys only
  bg: "#111111",
  bgMsg: "#0d0d0d",
  bgPanel: "#1a1a1a",
  bgPanelAlt: "#242424",
  bgInput: "#1c1c1c",
  bgHover: "#2b2b2b",
  border: "#3c3c3c",
  borderFocus: "#e8e8e8",
  fg: "#e8e8e8",
  fgDim: "#9c9c9c",
  fgMuted: "#666666",
  primary: "#e8e8e8",
  primarySoft: "#c4c4c4",
  secondary: "#b8b8b8",
  accent: "#cccccc",
  success: "#9f9f9f",
  warning: "#bdbdbd",
  error: "#e0e0e0",
  thinking: "#b0b0b0",
  syntax: {
    kw: "#e8e8e8",
    str: "#b8b8b8",
    com: "#666666",
    num: "#bdbdbd",
    call: "#cccccc",
    plain: "#e8e8e8",
  },
};

import { GENERATED_THEMES } from "./themes.generated.ts";

export const THEMES: Record<string, Theme> = {
  loom: { id: "loom", label: "Loom Dark", desc: "Warm charcoal + terracotta (default)", palette: LOOM_DARK },
  light: { id: "light", label: "Light", desc: "Parchment light + terracotta", palette: LIGHT },
  ocean: { id: "ocean", label: "Ocean", desc: "Deep navy + cyan", palette: OCEAN },
  forest: { id: "forest", label: "Forest", desc: "Dark evergreen + sage", palette: FOREST },
  midnight: { id: "midnight", label: "Midnight", desc: "Violet-black + lavender", palette: MIDNIGHT },
  mono: { id: "mono", label: "Mono", desc: "Pure greyscale", palette: MONO },
};

// Safety net: shiki-sourced themes sometimes carry transparent or
// background-identical border colors, which makes every UI grid line vanish.
// Accept a border only when it clears a real contrast bar against `bg`;
// otherwise derive one (lighten dark themes, darken light themes).
function visibleBorder(bg: string, border: string): string {
  const hex = (h: string) => /^#?([0-9a-f]{6})/i.exec(String(h).trim())?.[1];
  const lum = (h: string) => {
    const m = hex(h);
    if (!m) return 0;
    const n = parseInt(m, 16);
    return 0.299 * (n >> 16 & 255) + 0.587 * (n >> 8 & 255) + 0.114 * (n & 255);
  };
  const base = hex(bg) || "1e1e1e";
  const raw = hex(border);
  if (raw && Math.abs(lum("#" + raw) - lum("#" + base)) >= 28) return border;
  const L = lum("#" + base);
  // Channel shifts run red-green-blue order; a negative factor SUBTRACTS the
  // requested proportion of each channel, and every channel clamps to 0-255
  // so the derived border hex never overflows/underflows.
  const mix = (f: number) => {
    const hex2 = (v: number) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0");
    const ch = (s: number) => {
      const c = parseInt(base, 16) >> s & 255;
      return f > 0 ? hex2(c + (255 - c) * f) : hex2(c - c * Math.abs(f));
    };
    return "#" + ch(16) + ch(8) + ch(0);
  };
  return L < 128 ? mix(0.38) : mix(-0.35);
}

// Stitch in the generated (shiki-sourced) themes after the local defaults.
// Ids from the registry win on collision — the six above always take priority.
// Each generated palette is validated on a COPY: missing fields (including
// syntax) are filled from LOOM_DARK and the border is derived on the copy, so
// the imported generated object is never mutated.
for (const t of GENERATED_THEMES) {
  if (!THEMES[t.id]) {
    const src: any = (t as Theme).palette || {};
    const p: any = Object.assign({}, LOOM_DARK, src);
    if (!p.syntax || typeof p.syntax !== "object") p.syntax = {};
    p.syntax = Object.assign({}, LOOM_DARK.syntax, p.syntax);
    p.border = visibleBorder(p.bg, p.border);
    THEMES[t.id] = { id: t.id, label: t.label, desc: t.desc, palette: p };
  }
}

function loadSavedTheme(): string {
  const data = loadTuiJson();
  if (typeof data.theme === "string" && THEMES[data.theme]) return data.theme;
  return "loom";
}

export function saveThemePref(id: string) {
  saveTuiJson({ theme: id });
}

const [themeId, setThemeId] = createSignal(loadSavedTheme());

export function setTheme(id: string) {
  if (!THEMES[id]) return false;
  setThemeId(id);
  saveThemePref(id);
  return true;
}

export function themeName() {
  return themeId();
}

export function themeOptions(): { id: string; label: string; desc: string }[] {
  return Object.values(THEMES).map(t => ({ id: t.id, label: t.label, desc: t.desc }));
}

export function palette(_name?: string): Palette {
  return new Proxy(LOOM_DARK, {
    get(_target, prop) {
      const cur = THEMES[themeId()];
      const p = (cur && cur.palette) || LOOM_DARK;
      return (p as any)[prop as string];
    },
  }) as Palette;
}

export const VERSION = "1.2.0";

export const LOOM_LOGO = [
  " ██╗      ██████╗  ██████╗ ███╗   ███╗      ██████╗ ██████╗ ██████╗ ███████╗",
  " ██║     ██╔═══██╗██╔═══██╗████╗ ████║     ██╔════╝██╔═══██╗██╔══██╗██╔════╝",
  " ██║     ██║   ██║██║   ██║██╔████╔██║     ██║     ██║   ██║██║  ██║█████╗  ",
  " ██║     ██║   ██║██║   ██║██║╚██╔╝██║     ██║     ██║   ██║██║  ██║██╔══╝  ",
  " ███████╗╚██████╔╝╚██████╔╝██║ ╚═╝ ██║     ╚██████╗██████╔╝██████╔╝███████╗",
  " ╚══════╝ ╚═════╝  ╚═════╝ ╚═╝     ╚═╝      ╚═════╝╚═════╝ ╚═════╝ ╚══════╝",
];
