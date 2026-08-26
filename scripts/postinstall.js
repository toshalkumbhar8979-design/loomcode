// Postinstall: rewrite the npm-generated bin shims so `loom` starts ONE bun
// process directly IN THE USER'S PROJECT DIRECTORY. The Solid JSX preloader
// is registered with absolute --preload paths (the package-root cwd trick is
// gone — starting at the package root forced a later process.chdir back to
// the project inside tui-open.tsx, which froze the TUI after the first frame:
// splash painted once, then no repaints and no keyboard input).
const fs = require("fs");
const path = require("path");

const pkgRoot = path.resolve(__dirname, "..");

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
        'IF EXIST "%~dp0bun.exe" (SET "_prog=%~dp0bun.exe") ELSE (SET "_prog=bun")',
        '"%_prog%" --preload "%~dp0' + pkgEscaped + '\\src\\tui-preload.js" "%~dp0' + pkgEscaped + '\\bin\\' + script + '" %*',
        "EXIT /b %ERRORLEVEL%",
        ""
    ].join("\r\n");
}

function psShim(pkg, script) {
    return [
        "#!/usr/bin/env pwsh",
        "# rewritten by loom-agent postinstall (no-cwd-change TUI launch)",
        "$env:LOOM_START_CWD = (Get-Location).Path",
        "$pkg = Join-Path $PSScriptRoot '" + pkg + "'",
        "& bun --preload (Join-Path $pkg 'src/tui-preload.js') (Join-Path $pkg 'bin/" + script + "') @args",
        "exit $LASTEXITCODE",
        ""
    ].join("\n");
}

function shShim(pkg, script) {
    return [
        "#!/bin/sh",
        "# rewritten by loom-agent postinstall (no-cwd-change TUI launch)",
        'LOOM_START_CWD="$(pwd)"',
        "export LOOM_START_CWD",
        'PKG="$(dirname "$0")/' + pkg + '"',
        'exec bun --preload "$PKG/src/tui-preload.js" "$PKG/bin/' + script + '" "$@"',
        ""
    ].join("\n");
}

try {
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