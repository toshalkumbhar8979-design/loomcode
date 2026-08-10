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

function globalSkillsDir() {
  return path.join(process.env.LOOM_CONFIG_DIR || LOOM_DIR, 'skills');
}

// Third-party agent skills installed elsewhere on the machine (read-only):
// skills the user already has in ~/.agents/skills show up in the browser and
// can be toggled, but install/remove always target ~/.loom/skills.
function agentsSkillsDir() {
  return path.join(process.env.LOOM_AGENTS_DIR || os.homedir(), '.agents', 'skills');
}

function trustFile() {
  return path.join(process.env.LOOM_CONFIG_DIR || LOOM_DIR, 'skills-trust.json');
}

function loadTrust() {
  try {
    return JSON.parse(fs.readFileSync(trustFile(), 'utf8')) || {};
  } catch {
    return {};
  }
}

function saveTrust(trust) {
  fs.mkdirSync(path.dirname(trustFile()), { recursive: true });
  fs.writeFileSync(trustFile(), JSON.stringify(trust, null, 2));
}

// Remote skills are injected into the system prompt and their instructions run
// with full tool access, so the first install from a source must be explicitly
// approved and the approval is pinned to the exact commit that was reviewed.
// Re-installing the same URL with different content requires re-approval.
const defaultGit = {
  clone(url, tmp) {
    execSync('git clone --depth 1 ' + url + ' ' + tmp, { stdio: 'ignore' });
  },
  revParse(tmp) {
    return execSync('git -C ' + tmp + ' rev-parse HEAD', { encoding: 'utf8' }).trim();
  },
};

function projectSkillsDir() {
  return path.join(process.cwd(), '.loom', 'skills');
}

function skillDirs() {
  const dirs = [globalSkillsDir(), agentsSkillsDir(), projectSkillsDir()];
  const seen = new Set();
  const out = [];
  for (const d of dirs) {
    if (seen.has(d)) continue;
    seen.add(d);
    if (fs.existsSync(d)) out.push(d);
  }
  return out;
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
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const skillMd = path.join(dir, e.name, 'SKILL.md');
      if (!fs.existsSync(skillMd)) continue;
      let raw = '';
      try { raw = fs.readFileSync(skillMd, 'utf8').slice(0, 4000); } catch { continue; }
      const meta = parseFrontmatter(raw);
      found.push({
        name: meta.name || e.name,
        dir: path.join(dir, e.name),
        description: meta.description || '(no description)',
        source: dir === globalSkillsDir() ? 'global' : (dir === agentsSkillsDir() ? 'agents' : 'project'),
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
  const dest = path.join(globalSkillsDir(), name);
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

function cloneFromGit(url, targetName, opts, git) {
  if (!validateUrl(url)) throw new Error(`Invalid git URL: ${url}`);
  const base = url.split('/').pop().replace(/\.git$/, '');
  const name = targetName || base;
  const tmp = path.join(os.tmpdir(), 'loom-skill-' + Date.now());
  const impl = git || defaultGit;
  try {
    impl.clone(url, tmp);
    const commit = impl.revParse(tmp);
    const trust = loadTrust();
    const record = trust[url];
    // A string trust value is an approval bound to one specific commit (the
    // one the user was shown). If HEAD moved since, refuse — re-review needed.
    if (typeof opts.trust === 'string' && opts.trust !== commit) {
      return {
        error: 'Remote content changed since it was presented for approval',
        trustRequired: { url, commit, previous: opts.trust },
      };
    }
    if (!opts || !opts.trust) {
      if (!record) {
        return {
          error: 'Untrusted remote skill: ' + url,
          trustRequired: { url, commit },
        };
      }
      if (record.commit !== commit) {
        return {
          error: 'Skill content changed since it was approved',
          trustRequired: { url, commit, previous: record.commit, approvedAt: record.approvedAt },
        };
      }
    }
    const found = findSkillIn(tmp);
    const res = installFrom(found, name);
    if (res.error) return res;
    trust[url] = { commit, approvedAt: new Date().toISOString() };
    saveTrust(trust);
    return res;
  } finally {
    if (fs.existsSync(tmp)) fs.rmSync(tmp, { recursive: true, force: true });
  }
}

function installSkill(name, targetName, opts, git) {
  if (!fs.existsSync(globalSkillsDir())) fs.mkdirSync(globalSkillsDir(), { recursive: true });
  let src = name;
  if (src.startsWith('file:')) src = src.slice(5);
  if (src.startsWith('git') || src.startsWith('http')) {
    return cloneFromGit(src, targetName, opts, git);
  }
  const found = findSkillIn(path.resolve(src));
  return installFrom(found, targetName || path.basename(path.resolve(src)));
}

function removeSkill(name) {
  // Only ~/.loom/skills is writable; agents-dir and project-dir skills are
  // read-only and must never be deleted from here.
  const p = path.join(globalSkillsDir(), name);
  if (fs.existsSync(p)) {
    fs.rmSync(p, { recursive: true, force: true });
    return { removed: p };
  }
  return { error: 'Skill not installed: ' + name };
}

module.exports = {
  listSkills,
  isInstalled,
  installSkill,
  installFrom,
  removeSkill,
  globalSkillsDir,
  agentsSkillsDir,
  projectSkillsDir,
};