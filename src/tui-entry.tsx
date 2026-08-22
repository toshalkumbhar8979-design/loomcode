// Compile entry for the standalone executable (bun build --compile).
// Compiled binaries skip bunfig.toml entirely, so the preload-side effects
// (Windows VT/console-mode fix, UTF-8 codepage, crash black-box, optional
// LOOM_START_CWD restore) are imported here explicitly. The dynamic import
// keeps tui-open.tsx's module graph evaluating AFTER those effects run.
import "./tui-preload.js";
// Compiled binaries skip bunfig.toml, so the Solid JSX runtime loader must be
// registered explicitly before the app graph evaluates.
import "@opentui/solid/preload";
await import("./tui-open.tsx");
