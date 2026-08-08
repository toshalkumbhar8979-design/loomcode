// Loom Code TUI — color themes + palette access.
// palette() returns a live Proxy: each property is read from the currently
// selected theme at render time, so switching themes re-renders instantly.
import { createSignal } from "solid-js";
import fs from "fs";
import os from "os";
import path from "path";

export type Palette = {
  bg: string; bgPanel: string; bgPanelAlt: string; bgInput: string; bgHover: string;
  border: string; borderFocus: string;
  fg: string; fgDim: string; fgMuted: string;
  primary: string;   // brand accent
  primarySoft: string;
  secondary: string; // user accent
  accent: string;    // tool activity
  success: string; warning: string; error: string;
  thinking: string;
  pet: string;       // companion tint
};

export type Theme = { id: string; label: string; desc: string; palette: Palette };

const LOOM_DARK: Palette = {
  // Deep warm charcoal — terracotta accents
  bg: "#191817",
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
  pet: "#f4a27f",
};

const LIGHT: Palette = {
  // Paper light — warm parchment with terracotta
  bg: "#faf7f2",
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
  pet: "#c2593a",
};

const OCEAN: Palette = {
  // Deep navy — cyan accents
  bg: "#0e1a26",
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
  pet: "#4fc3f7",
};

const FOREST: Palette = {
  // Dark evergreen — sage accents
  bg: "#0f1a12",
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
  pet: "#a3e5b2",
};

const MIDNIGHT: Palette = {
  // Near-black violet — lavender accents
  bg: "#131019",
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
  pet: "#c4b5fd",
};

const MONO: Palette = {
  // Pure monochrome — greys only
  bg: "#111111",
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
  pet: "#e8e8e8",
};

export const THEMES: Record<string, Theme> = {
  loom: { id: "loom", label: "Loom Dark", desc: "Warm charcoal + terracotta (default)", palette: LOOM_DARK },
  light: { id: "light", label: "Light", desc: "Parchment light + terracotta", palette: LIGHT },
  ocean: { id: "ocean", label: "Ocean", desc: "Deep navy + cyan", palette: OCEAN },
  forest: { id: "forest", label: "Forest", desc: "Dark evergreen + sage", palette: FOREST },
  midnight: { id: "midnight", label: "Midnight", desc: "Violet-black + lavender", palette: MIDNIGHT },
  mono: { id: "mono", label: "Mono", desc: "Pure greyscale", palette: MONO },
};

const TUI_STATE = path.join(os.homedir(), ".loom", "tui.json");

function loadSavedTheme(): string {
  try {
    if (fs.existsSync(TUI_STATE)) {
      const data = JSON.parse(fs.readFileSync(TUI_STATE, "utf8"));
      if (typeof data.theme === "string" && THEMES[data.theme]) return data.theme;
    }
  } catch {}
  return "loom";
}

export function saveThemePref(id: string) {
  try {
    let data: any = {};
    if (fs.existsSync(TUI_STATE)) {
      try { data = JSON.parse(fs.readFileSync(TUI_STATE, "utf8")) || {}; } catch {}
    }
    data.theme = id;
    fs.mkdirSync(path.dirname(TUI_STATE), { recursive: true });
    fs.writeFileSync(TUI_STATE, JSON.stringify(data, null, 2));
  } catch {}
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
