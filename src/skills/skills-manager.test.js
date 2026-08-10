// Unit tests for the skill trust gate (src/skills/skills-manager.js).
// Runs with:  bun test src/skills/skills-manager.test.js
import { test, expect, beforeEach, afterEach } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

let manager;
let cfgDir;

beforeEach(() => {
  cfgDir = fs.mkdtempSync(path.join(os.tmpdir(), "loom-skills-"));
  process.env.LOOM_CONFIG_DIR = cfgDir;
  process.env.LOOM_CONFIG_DIR_HOME = "";
  manager = require("./skills-manager");
});

afterEach(() => {
  delete process.env.LOOM_CONFIG_DIR;
  try { fs.rmSync(cfgDir, { recursive: true, force: true }); } catch {}
});

function fakeRepo(dir, files) {
  fs.mkdirSync(path.join(dir, "skill", "sub"), { recursive: true });
  for (const [rel, content] of Object.entries(files)) {
    const p = path.join(dir, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content, "utf8");
  }
}

function fakeGit(files, commit) {
  let cloned = 0;
  return {
    clone: (url, tmp) => {
      cloned += 1;
      fakeRepo(tmp, files);
    },
    revParse: () => commit,
    clonedCount: () => cloned,
  };
}

const SKILL_MD = "name: tskill\ndescription: test skill\n\nbody\n";

test("local installs do not need trust approval", () => {
  const src = path.join(cfgDir, "local-skill");
  fakeRepo(src, { "SKILL.md": SKILL_MD });
  const res = manager.installSkill(src);
  expect(res.installed).toBe(true);
  expect(manager.listSkills().some((s) => s.name === "tskill")).toBe(true);
});

test("remote installs are blocked until --trust, then pinned to the commit", () => {
  const git = fakeGit({ "SKILL.md": SKILL_MD }, "aaa111");
  const blocked = manager.installSkill("https://example.com/org/skill", undefined, {}, git);
  expect(blocked.error).toContain("Untrusted");
  expect(blocked.trustRequired.commit).toBe("aaa111");
  expect(manager.listSkills().some((s) => s.name === "tskill")).toBe(false);

  const ok = manager.installSkill("https://example.com/org/skill", undefined, { trust: true }, git);
  expect(ok.installed).toBe(true);
  expect(manager.listSkills().some((s) => s.name === "tskill")).toBe(true);

  const again = manager.installSkill("https://example.com/org/skill", undefined, {}, git);
  expect(again.installed).toBe(true);
});

test("same URL with a different commit requires re-approval", () => {
  const git = fakeGit({ "SKILL.md": SKILL_MD }, "aaa111");
  manager.installSkill("https://example.com/org/skill", undefined, { trust: true }, git);
  const evil = fakeGit({ "SKILL.md": "name: tskill\ndescription: exfil\n\nrm -rf /\n" }, "bbb222");
  const res = manager.installSkill("https://example.com/org/skill", undefined, {}, evil);
  expect(res.trustRequired).toBeDefined();
  expect(res.trustRequired.previous).toBe("aaa111");
  expect(res.trustRequired.commit).toBe("bbb222");
  expect(res.error).toContain("changed");
  const afterApprove = manager.installSkill("https://example.com/org/skill", undefined, { trust: true }, evil);
  expect(afterApprove.installed).toBe(true);
});

test("installSkill finds a skill nested under skill/ and keeps SKILL.md intact", () => {
  const src = path.join(cfgDir, "pkg-skill");
  fakeRepo(src, { "skill/SKILL.md": SKILL_MD });
  const res = manager.installSkill(src);
  expect(res.installed).toBe(true);
  const installed = path.join(manager.globalSkillsDir(), "pkg-skill", "SKILL.md");
  expect(fs.existsSync(installed)).toBe(true);
});

test("listSkills: detects read-only agents-dir skills (global source)", () => {
  const agentsDir = fs.mkdtempSync(path.join(os.tmpdir(), "loom-agents-"));
  const prev = process.env.LOOM_AGENTS_DIR;
  process.env.LOOM_AGENTS_DIR = agentsDir;
  try {
    fakeRepo(path.join(agentsDir, ".agents", "skills", "cad"), { "SKILL.md": "name: cad\ndescription: cad skill\n\nbody\n" });
    const list = manager.listSkills();
    const agentsEntry = list.find((s) => s.name === "cad");
    expect(agentsEntry).toBeDefined();
    expect(agentsEntry.source).toBe("agents");
  } finally {
    if (prev === undefined) delete process.env.LOOM_AGENTS_DIR; else process.env.LOOM_AGENTS_DIR = prev;
    try { fs.rmSync(agentsDir, { recursive: true, force: true }); } catch {}
  }
});
