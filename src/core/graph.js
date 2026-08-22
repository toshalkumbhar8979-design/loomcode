// Graph builder — parses Loom memory files (LOOM.md, .loom/graph/nodes/*.md)
// into a nodes/edges JSON structure for the /graph command.
//
// Per the Loom Graph View Design doc:
//   * Memory files use structured Markdown with frontmatter (type, confidence)
//   * ## headings -> nodes
//   * #tags -> node tags
//   * [[wikilinks]] -> edges between nodes
//
// The parser is deliberately regex-only (no full Markdown AST) — memory files
// are constrained in format, and a regex pass keeps dependencies at zero.
const fs = require('fs');
const path = require('path');
const os = require('os');

/**
 * @typedef {Object} GraphNode
 * @property {string} id
 * @property {string} title
 * @property {string} type
 * @property {number} confidence
 * @property {string[]} tags
 * @property {string} source
 * @property {string} body
 */

/**
 * @typedef {Object} GraphEdge
 * @property {string} source
 * @property {string} target
 * @property {string} type
 */

/**
 * @typedef {Object} GraphData
 * @property {GraphNode[]} nodes
 * @property {GraphEdge[]} edges
 */

/**
 * @typedef {Object} FileDefaults
 * @property {string} [type]
 * @property {number} [confidence]
 */

/**
 * @typedef {Object} Heading
 * @property {number} index
 * @property {string} text
 */

const FRONTMATTER_RE = /^---\s*\n([\s\S]*?)\n---\s*\n/;
const HEADING_RE = /^(#{1,3})\s+(.+?)\s*$/gm;
const WIKILINK_RE = /\[\[([^\]]+)\]\]/g;
const TAG_RE = /(?:^|\s)#([a-z0-9][a-z0-9-]*)/gi;
const TYPE_RE = /type:\s*["']?([a-z_]+)["']?/i;
const CONFIDENCE_RE = /confidence:\s*([0-9.]+)/i;

// Slugify a heading into a stable id. Wikilinks use this same slug so a
// "## Use SQLite" heading can be referenced as [[use-sqlite]] elsewhere.
function slugify(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^\w\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

// Parse one .md file into nodes. "##" sections become top-level nodes;
// "###" subsections become child nodes with a 'child' edge to their parent
// "##" — so LOOM.md renders as a real hierarchy, not a flat list.
/**
 * @param {string} filePath
 * @returns {{ nodes: GraphNode[], edges: GraphEdge[], defaults: FileDefaults }}
 */
function parseFile(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8');
  /** @type {FileDefaults} */
  const fileDefaults = {};
  const fmMatch = FRONTMATTER_RE.exec(raw);
  if (fmMatch) {
    const fm = fmMatch[1];
    const tm = TYPE_RE.exec(fm);
    if (tm) fileDefaults.type = tm[1];
    const cm = CONFIDENCE_RE.exec(fm);
    if (cm) fileDefaults.confidence = Math.max(0, Math.min(1, parseFloat(cm[1])));
  }

  /** @type {GraphNode[]} */
  const nodes = [];
  /** @type {GraphEdge[]} */
  const edges = [];

  // Collect headings with their level (## or ###; # is the file title).
  /** @type {{ level: number, index: number, text: string }[]} */
  const headings = [];
  HEADING_RE.lastIndex = 0;
  let m;
  while ((m = HEADING_RE.exec(raw)) !== null) {
    headings.push({ level: m[1].length, index: m.index, text: m[2] });
  }

  /** @type {{ level: number, id: string }[]} */
  const stack = [];
  for (let i = 0; i < headings.length; i++) {
    const h = headings[i];
    if (h.level < 2) continue; // skip "# Title"
    // Body runs until the next heading of the same or higher level.
    let next = i + 1;
    while (next < headings.length && headings[next].level > h.level) next++;
    const nl = raw.indexOf('\n', h.index);
    const start = nl === -1 ? raw.length : nl + 1;
    const end = next < headings.length ? headings[next].index : raw.length;
    let body = raw.slice(start, end).trim();

    // Strip leading frontmatter-like artefacts and horizontal rules.
    body = body.replace(/^---[\s\S]*?---\s*/m, '').replace(/^---\s*$/gm, '');

    const id = slugify(h.text);
    /** @type {string[]} */
    const tags = [];
    TAG_RE.lastIndex = 0;
    let tm;
    while ((tm = TAG_RE.exec(body)) !== null) {
      const tag = tm[1].toLowerCase();
      if (!tags.includes(tag)) tags.push(tag);
    }
    /** @type {GraphNode} */
    const node = {
      id,
      title: h.text,
      type: fileDefaults.type || 'note',
      confidence: fileDefaults.confidence ?? 0.5,
      tags,
      source: filePath,
      body: body.slice(0, 2000),
    };
    nodes.push(node);

    // The immediate ancestor (last heading of a strictly lower level)
    // becomes this node's parent — ## -> ###.
    let parent = null;
    for (let j = stack.length - 1; j >= 0; j--) {
      if (stack[j].level < h.level) { parent = stack[j]; break; }
    }
    if (parent) edges.push({ source: parent.id, target: id, type: 'child' });
    while (stack.length && stack[stack.length - 1].level >= h.level) stack.pop();
    stack.push({ level: h.level, id });

    // Wikilinks in the body become edges from this node to the slugified
    // target. Targets that don't exist as nodes still get a stub so the
    // graph doesn't silently drop the link.
    WIKILINK_RE.lastIndex = 0;
    let wm;
    while ((wm = WIKILINK_RE.exec(body)) !== null) {
      const target = slugify(wm[1]);
      edges.push({ source: id, target, type: 'references' });
    }
  }

  return { nodes, edges, defaults: fileDefaults };
}

/**
 * Build the full graph for a project directory.
 * Scans: ./LOOM.md, ./.loom/LOOM.md, ~/.loom/LOOM.md, ./.loom/graph/nodes/*.md
 * @param {string} cwd
 * @returns {GraphData}
 */
function buildGraph(cwd) {
  const roots = [
    path.join(cwd, 'LOOM.md'),
    path.join(cwd, '.loom', 'LOOM.md'),
    path.join(cwd, '.loom', 'graph', 'nodes'),
    path.join(os.homedir(), '.loom', 'LOOM.md'),
  ];

  /** @type {Map<string, GraphNode>} */
  const nodeMap = new Map();
  /** @type {GraphEdge[]} */
  const edges = [];

  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    const stat = fs.statSync(root);
    if (stat.isDirectory()) {
      // .loom/graph/nodes/*.md — one file per node (each is already a node).
      const files = fs.readdirSync(root).filter(f => f.endsWith('.md'));
      for (const f of files) {
        const full = path.join(root, f);
        const parsed = parseFile(full);
        for (const n of parsed.nodes) nodeMap.set(n.id, n);
        edges.push(...parsed.edges);
      }
    } else {
      const parsed = parseFile(root);
      for (const n of parsed.nodes) {
        // Prefer an existing file-scoped node (from .loom/graph/nodes/) over
        // a same-id section in a merged LOOM.md — files are more curated.
        if (!nodeMap.has(n.id)) nodeMap.set(n.id, n);
      }
      edges.push(...parsed.edges);
    }
  }

  // Stub nodes for wikilink targets that have no backing node — keeps the
  // graph honest about what's referenced but not yet captured.
  /** @type {Set<string>} */
  const stubIds = new Set();
  for (const e of edges) stubIds.add(e.target);
  for (const id of stubIds) {
    if (!nodeMap.has(id)) {
      nodeMap.set(id, {
        id,
        title: id.replace(/-/g, ' '),
        type: 'note',
        confidence: 0.1,
        tags: [],
        source: '(not yet captured)',
        body: '',
      });
    }
  }

  return {
    nodes: Array.from(nodeMap.values()).sort((a, b) => a.title.localeCompare(b.title)),
    edges,
  };
}

/**
 * Render the graph as a simple text representation for CLI/debugging.
 * @param {{ nodes: GraphNode[], edges: GraphEdge[] }} graph
 * @returns {string}
 */
function renderGraphText(graph) {
  /** @type {string[]} */
  const lines = [];
  lines.push('Loom Graph — ' + graph.nodes.length + ' nodes, ' + graph.edges.length + ' edges');
  lines.push('');
  for (const n of graph.nodes) {
    const conf = (n.confidence * 100).toFixed(0);
    lines.push('  ' + n.id + ' [' + n.type + '] (' + conf + '%) ' + (n.tags.length ? '#' + n.tags.join(' #') : ''));
    lines.push('    ' + n.title);
  }
  if (graph.edges.length) {
    lines.push('');
    lines.push('Edges:');
    for (const e of graph.edges) {
      lines.push('  ' + e.source + ' --(' + e.type + ')--> ' + e.target);
    }
  }
  return lines.join('\n');
}

module.exports = { buildGraph, parseFile, slugify, renderGraphText };