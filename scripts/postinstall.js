// Postinstall: rewrite the npm-generated bin shims so `loom` starts ONE bun
// process directly IN THE USER'S PROJECT DIRECTORY. The Solid JSX preloader
// is registered with absolute --preload paths (the package-root cwd trick is
// gone — starting at the package root forced a later process.chdir back to
// the project inside tui-open.tsx, which froze the TUI after the first frame:
// splash painted once, then no repaints and no keyboard input).
const fs = require("fs");
const path = require("path");

const pkgRoot = path.resolve(__dirname, "..");

// Bun, bundled: loom-agent lists the @oven/bun-<platform> binaries as
// optionalDependencies, so `npm i -g loom-agent` brings the REAL bun binary
// (pinned, matching the repo's bun) along even when the user has no bun
// installed. npm skips non-matching platforms via each package's os/cpu
// fields, and this resolution never needs install scripts (npm
// allow-scripts policies can't break it). Resolved here once at install
// time and baked into the shims as the preferred runtime; the shims still
// fall back to whatever `bun` is on PATH, and — if NO bun exists at all —
// to `node bin/loom.js` (line-mode REPL) instead of dying with
// "'bun' is not recognized".
function ovenBunPath() {
    const PKGS = {
        "win32-x64": "bun-windows-x64",
        "win32-arm64": "bun-windows-aarch64",
        "darwin-x64": "bun-darwin-x64",
        "darwin-arm64": "bun-darwin-aarch64",
        "linux-x64": "bun-linux-x64",
        "linux-arm64": "bun-linux-aarch64",
    };
    const short = PKGS[process.platform + "-" + process.arch];
    if (!short) return "";
    const exe = process.platform === "win32" ? "bun.exe" : "bun";
    const candidates = [
        path.join(pkgRoot, "node_modules", "@oven", short, "bin", exe), // nested (npm default)
        path.join(pkgRoot, "..", "@oven", short, "bin", exe),           // hoisted
    ];
    for (var i = 0; i < candidates.length; i++) {
        try { if (fs.existsSync(candidates[i])) return candidates[i]; } catch {}
    }
    return "";
}

var ovenPath = "";

function shimDirs() {
    const dirs = new Set();
    if (path.basename(path.resolve(pkgRoot, "..")) !== "node_modules") return [];
    dirs.add(path.resolve(pkgRoot, "..", ".."));
    dirs.add(path.join(path.resolve(pkgRoot, ".."), ".bin"));
    return [...dirs].filter(function(d) {
        try {
            return fs.existsSync(path.join(d, "loom.cmd")) || fs.existsSync(path.join(d, "loom"));
        } catch {
            return false;
        }
    });
}

function cmdShim(pkg, script) {
    var pkgEscaped = pkg.replace(/\//g, "\\");
    return [
        "@ECHO off",
        "SETLOCAL",
        'SET "LOOM_START_CWD=%CD%"',
        'IF EXIST "' + ovenPath + '" (SET "_prog=' + ovenPath + '") ELSE (SET "_prog=bun")',
        '"%_prog%" --preload "%~dp0' + pkgEscaped + '\\src\\tui-preload.js" "%~dp0' + pkgEscaped + '\\bin\\' + script + '" %*',
        "IF %ERRORLEVEL% NEQ 9009 EXIT /b %ERRORLEVEL%",
        "REM bun not found (errorlevel 9009): fall back to the Node REPL",
        "node \"%~dp0" + pkgEscaped + "\\bin\\loom.js\" %*",
        "EXIT /b %ERRORLEVEL%",
        ""
    ].join("\r\n");
}

function psShim(pkg, script) {
    return [
        "#!/usr/bin/env pwsh",
        "# rewritten by loom-agent postinstall (bundled bun + node fallback)",
        "$env:LOOM_START_CWD = (Get-Location).Path",
        "$pkg = Join-Path $PSScriptRoot '" + pkg + "'",
        "$bun = '" + ovenPath + "'",
        "if (-not ($bun -and (Test-Path $bun))) { $bun = 'bun' }",
        "& $bun --preload (Join-Path $pkg 'src/tui-preload.js') (Join-Path $pkg 'bin/" + script + "') @args",
        "if ($LASTEXITCODE -eq 9009) { node (Join-Path $pkg 'bin/loom.js') @args; exit $LASTEXITCODE }",
        "exit $LASTEXITCODE",
        ""
    ].join("\n");
}

function shShim(pkg, script) {
    return [
        "#!/bin/sh",
        "# rewritten by loom-agent postinstall (bundled bun + node fallback)",
        'LOOM_START_CWD="$(pwd)"',
        "export LOOM_START_CWD",
        'PKG="$(dirname "$0")/' + pkg + '"',
        'BUN="' + ovenPath + '"',
        '[ -x "$BUN" ] || BUN="$(command -v bun || true)"',
        'if [ -n "$BUN" ]; then',
        '  exec "$BUN" --preload "$PKG/src/tui-preload.js" "$PKG/bin/' + script + '" "$@"',
        "fi",
        'echo "[loom] full TUI needs bun - install with: npm i -g bun (https://bun.sh)" >&2',
        'exec node "$PKG/bin/loom.js" "$@"',
        ""
    ].join("\n");
}

try {
    ovenPath = ovenBunPath();
    if (ovenPath) {
        console.log("[loom-agent] bundled bun found: " + ovenPath);
    } else {
        console.log("[loom-agent] bundled bun not present for " + process.platform + "-" + process.arch + " (optional dep skipped?) - shims will use bun from PATH, or fall back to the Node REPL");
    }
    for (var i = 0; i < shimDirs().length; i++) {
        var dir = shimDirs()[i];
        var relPkg = path.relative(dir, pkgRoot).split(path.sep).join("/");
        if (!relPkg || relPkg.startsWith("..")) continue;
        for (var j = 0; j < 2; j++) {
            var name = j === 0 ? "loom" : "loom-tui";
            var script = name === "loom" ? "loom-bun.js" : "loom-tui.js";
            var targets = [
                [name + ".cmd", cmdShim(relPkg, script)],
                [name + ".ps1", psShim(relPkg, script)],
                [name, shShim(relPkg, script)]
            ];
            for (var k = 0; k < targets.length; k++) {
                var file = targets[k][0];
                var content = targets[k][1];
                var p = path.join(dir, file);
                if (!fs.existsSync(p)) continue;
                fs.writeFileSync(p, content, { mode: 0o755 });
                console.log("[loom-agent] rewrote shim " + p);
            }
        }
    }
} catch (err) {
    console.warn("[loom-agent] shim rewrite skipped: " + (err && err.message));
}