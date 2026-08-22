// Bootstrap shim for globally-installed launches.
//
// Bun only discovers bunfig.toml / tsconfig.json by walking UP from its
// working directory. When installed via npm the package lives outside the
// user's project tree, so launchers start bun from the PACKAGE root (where
// those files ship) and hand the real project directory through
// LOOM_START_CWD. This file must stay import-free so the chdir happens
// before any Loom module (which may read cwd at import time) executes.
if (process.env.LOOM_START_CWD) {
  try { process.chdir(process.env.LOOM_START_CWD); } catch {}
}
await import("./tui-open.tsx");
