const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');

function validateUrl(url) {
  try {
    const u = new URL(url);
    if (!['git:', 'http:', 'https:'].includes(u.protocol)) return false;
    return true;
  } catch { return false; }
}

const LOOM_DIR = path.join(os.homedir(), '.loom');
const GLOBAL_SKILLS_DIR = path.join(LOOM_DIR, 'skills');

function projectSkillsDir() {
  return path.join(process.cwd(), '.loom', 'skills');
}

function skillDirs() {
  const dirs = [GLOBAL_SKILLS_DIR, projectSkillsDir()];
  return dirs.filter((d) => fs.existsSync(d));
}

function parseFrontmatter(text) {
  const nameMatch = text.match(/^name:\s*(.+)$/m);
  const descMatch = text.match(/^description:\s*(.+)$/m);
  return {
    name: nameMatch ? nameMatch[1].trim() : null,
    description: descMatch ? descMatch[1].trim() : '',
  };
}

function listSkills() {
  const found = [];
  for (const dir of skillDirs()) {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const skillMd = path.join(dir, e.name, 'SKILL.md');
      if (!fs.existsSync(skillMd)) continue;
      const raw = fs.readFileSync(skillMd, 'utf8').slice(0, 4000);
      const meta = parseFrontmatter(raw);
      found.push({
        name: meta.name || e.name,
        dir: path.join(dir, e.name),
        description: meta.description || '(no description)',
        source: dir === GLOBAL_SKILLS_DIR ? 'global' : 'project',
      });
    }
  }
  return found;
}

function isInstalled(name) {
  return listSkills().some((s) => s.name === name || path.basename(s.dir) === name);
}

function installFrom(srcDir, targetName) {
  const src = path.resolve(srcDir);
  if (!fs.existsSync(path.join(src, 'SKILL.md'))) {
    return { error: `No SKILL.md in ${src}` };
  }
  const name = targetName || path.basename(src);
  const dest = path.join(GLOBAL_SKILLS_DIR, name);
  if (fs.existsSync(dest)) {
    fs.rmSync(dest, { recursive: true, force: true });
  }
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.cpSync(src, dest, { recursive: true });
  return { installed: true, name: name, dir: dest };
}

function findSkillIn(root) {
  const candidates = [path.join(root, 'SKILL.md')];
  const subs = ['skill', 'skills', '.loom/skills', 'packages'];
  for (const sub of subs) candidates.push(path.join(root, sub, 'SKILL.md'));
  const existing = candidates.find((c) => fs.existsSync(c));
  if (existing) return path.dirname(existing);
  for (const name of fs.readdirSync(root, { withFileTypes: true })) {
    if (!name.isDirectory()) continue;
    const p = path.join(root, name.name, 'SKILL.md');
    if (fs.existsSync(p)) return path.dirname(p);
  }
  return root;
}

function cloneFromGit(url, targetName) {
  if (!validateUrl(url)) throw new Error(`Invalid git URL: ${url}`);
  const base = url.split('/').pop().replace(/\.git$/, '');
  const name = targetName || base;
  const tmp = path.join(os.tmpdir(), 'loom-skill-' + Date.now());
  try {
    execSync('git clone --depth 1 ' + url + ' ' + tmp, { stdio: 'ignore' });
    const found = findSkillIn(tmp);
    return installFrom(found, name);
  } finally {
    if (fs.existsSync(tmp)) fs.rmSync(tmp, { recursive: true, force: true });
  }
}

function installSkill(name, targetName) {
  if (!fs.existsSync(GLOBAL_SKILLS_DIR)) fs.mkdirSync(GLOBAL_SKILLS_DIR, { recursive: true });
  let src = name;
  if (src.startsWith('file:')) src = src.slice(5);
  if (src.startsWith('git') || src.startsWith('http')) {
    return cloneFromGit(src, targetName);
  }
  return installFrom(src, targetName);
}

function removeSkill(name) {
  for (const dir of skillDirs()) {
    const p = path.join(dir, name);
    if (fs.existsSync(p)) {
      fs.rmSync(p, { recursive: true, force: true });
      return { removed: p };
    }
  }
  return { error: 'Skill not installed: ' + name };
}

module.exports = {
  listSkills,
  isInstalled,
  installSkill,
  installFrom,
  removeSkill,
  GLOBAL_SKILLS_DIR,
  projectSkillsDir,
};