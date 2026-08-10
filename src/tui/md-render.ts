// md-render — the TUI's markdown renderer for assistant chat output.
//
// Block-level markdown needs a real parser to get right; line-level + inline
// markdown is predictable, cheap, and covers 99% of what the model prints in
// chat (bold, inline code, headers, bullets, quotes, rule lines). This keeps
// output styling predictable without dragging in the full MarkdownRenderable
// (which needs a syntax-style theme and handles streaming differently).
//
// Each logical line is rendered as a separate <text> element with styled
// <span>/<b>/<em>/<a> children so wrapping composes cleanly.

export type MdSpan =
  | { text: string; bold?: false; italic?: false; code?: false; link?: undefined }
  | { text: string; bold: true; italic?: boolean; code?: undefined; link?: undefined }
  | { text: string; italic: true; bold?: boolean; code?: undefined; link?: undefined }
  | { text: string; code: true; bold?: undefined; italic?: undefined; link?: undefined };

// Parse one line of markdown into styled spans. Order: code spans first
// (inside them everything is literal), then strong/em emphasis, then links.
function parseInline(line: string): { text: string; bold?: boolean; italic?: boolean; code?: boolean; link?: string }[] {
  const tokens: { text: string; bold?: boolean; italic?: boolean; code?: boolean; link?: string }[] = [];
  let i = 0;
  let buf = "";
  const flush = () => { if (buf) { tokens.push({ text: buf }); buf = ""; } };
  while (i < line.length) {
    // escaping: \* renders a literal *
    if (line[i] === "\\" && i + 1 < line.length && /[\\*_`\[\]()#~-]/.test(line[i + 1])) {
      buf += line[i + 1];
      i += 2;
      continue;
    }
    // inline code `code`
    if (line[i] === "`") {
      const close = line.indexOf("`", i + 1);
      if (close > i) {
        flush();
        tokens.push({ text: line.slice(i + 1, close), code: true });
        i = close + 1;
        continue;
      }
      // unmatched ` — literal
      buf += line[i];
      i++;
      continue;
    }
    // strong emphasis **bold** (greedy to the LAST closing ** permite nesting-ish)
    if (line.startsWith("**", i)) {
      const close = line.indexOf("**", i + 2);
      if (close > i + 2) {
        flush();
        tokens.push({ text: line.slice(i + 2, close), bold: true });
        i = close + 2;
        continue;
      }
    }
    // italic emphasis *italic* (next char must be non-space; closing * picked
    // by skipping over "**" sequences so **bold** inside a paragraph is safe).
    // Never treat a "**" opening as italic — the strong branch above owns those.
    if (line[i] === "*" && line[i + 1] !== "*" && i + 1 < line.length && /\S/.test(line[i + 1])) {
      let close = -1;
      for (let j = i + 1; ; j = close + 1) {
        close = line.indexOf("*", j);
        if (close < 0) break;
        if (line[close + 1] === "*") continue;
        if (close > i + 1) break;
        close = -1;
        break;
      }
      if (close > i + 1) {
        flush();
        tokens.push({ text: line.slice(i + 1, close), italic: true });
        i = close + 1;
        continue;
      }
      // unmatched * — literal
      buf += "*";
      i++;
      continue;
    }
    // links [label](href)
    if (line[i] === "[") {
      const closeL = line.indexOf("](", i);
      const closeP = closeL > i ? line.indexOf(")", closeL + 2) : -1;
      if (closeL > i && closeP > closeL) {
        flush();
        const label = line.slice(i + 1, closeL);
        const href = line.slice(closeL + 2, closeP);
        tokens.push({ text: label + " (" + href + ")", link: href });
        i = closeP + 1;
        continue;
      }
      // not a link — literal
      buf += line[i];
      i++;
      continue;
    }
    buf += line[i];
    i++;
  }
  flush();
  return tokens;
}

export type MdLine =
  | { kind: "heading"; level: 1 | 2 | 3; spans: ReturnType<typeof parseInline> }
  | { kind: "bullet"; indent: number; spans: ReturnType<typeof parseInline> }
  | { kind: "quote"; spans: ReturnType<typeof parseInline> }
  | { kind: "rule" }
  | { kind: "text"; spans: ReturnType<typeof parseInline> }
  | { kind: "code"; code: string; lang: string };

// Split markdown text into per-line blocks. Fenced ``` blocks keep verbatim
// (their contents are already "rendered" code; the ChatArea palette boxes them).
export function parseMarkdown(md: string): MdLine[] {
  const out: MdLine[] = [];
  const lines = String(md).split("\n");
  let fence = false;
  let fenceLang = "";
  let codeBuf: string[] = [];
  for (const raw of lines) {
    const fenceM = raw.match(/^\s*```\s*([a-zA-Z0-9+-]*)?\s*$/);
    if (fenceM) {
      if (fence) {
        out.push({ kind: "code", code: codeBuf.join("\n"), lang: fenceLang });
        codeBuf = [];
        fenceLang = "";
        fence = false;
      } else {
        fence = true;
        fenceLang = (fenceM[1] || "").toLowerCase();
      }
      continue;
    }
    if (fence) { codeBuf.push(raw); continue; }

    if (/^\s*$/.test(raw)) { out.push({ kind: "text", spans: [] }); continue; }

    // horizontal rule
    if (/^\s*(-{3,}|_{3,}|\*{3,})\s*$/.test(raw)) { out.push({ kind: "rule" }); continue; }

    // heading: # text / ## text / ### text
    const hm = raw.match(/^(#{1,3})\s+(.*)$/);
    if (hm) {
      out.push({ kind: "heading", level: Math.min(3, hm[1].length) as 1 | 2 | 3, spans: parseInline(hm[2]) });
      continue;
    }

    // blockquote
    const qm = raw.match(/^\s*>\s?(.*)$/);
    if (qm) { out.push({ kind: "quote", spans: parseInline(qm[1]) }); continue; }

    // list bullet: leading spaces + -/*/+ or 1. marker
    const bm = raw.match(/^(\s*)([-*+]|\d+\.)\s+(.*)$/);
    if (bm) {
      out.push({ kind: "bullet", indent: Math.min(12, bm[1].length), spans: parseInline(bm[3]) });
      continue;
    }

    // plain paragraph line — merge inline styles
    out.push({ kind: "text", spans: parseInline(raw) });
  }
  if (fence && codeBuf.length) out.push({ kind: "code", code: codeBuf.join("\n"), lang: fenceLang });
  return out;
}

// ─── Lightweight code highlighting ───
// opencode-style palette mapping: keywords / strings / comments / numbers /
// calls get distinct colors instead of one flat white block. Regex-per-line
// tokenising is plenty for chat output (we never need parse trees).
export type CodeTok = { text: string; style: "kw" | "str" | "com" | "num" | "call" | "plain" };

const KW: Record<string, string[]> = {
  js: ["const", "let", "var", "function", "return", "if", "else", "for", "while", "do", "switch", "case", "default", "break", "continue", "import", "export", "from", "class", "extends", "super", "new", "typeof", "instanceof", "try", "catch", "finally", "throw", "await", "async", "yield", "in", "of", "delete", "void", "null", "undefined", "true", "false", "this", "type", "interface", "enum", "implements", "public", "private", "protected", "static", "readonly", "namespace", "declare", "as", "satisfies"],
  py: ["def", "return", "if", "elif", "else", "for", "while", "import", "from", "class", "try", "except", "finally", "with", "as", "lambda", "None", "True", "False", "and", "or", "not", "in", "is", "global", "nonlocal", "assert", "yield", "raise", "break", "continue", "pass", "del", "print", "range", "len"],
  bash: ["echo", "if", "then", "else", "elif", "fi", "for", "while", "do", "done", "case", "esac", "function", "return", "exit", "export", "local", "source", "cd", "mkdir", "rm", "cp", "mv", "ls", "cat", "grep", "sed", "awk", "printf", "set"],
};
const KW_ALL = Array.from(new Set(KW.js.concat(KW.py, KW.bash)));

function langFamily(lang: string): string {
  const l = (lang || "").toLowerCase();
  if (/(^js$|jsx|ts|tsx|javascript|typescript|mjs|cjs)/.test(l)) return "js";
  if (/(^py$|python|pyw)/.test(l)) return "py";
  if (/(^sh$|bash|zsh|shell)/.test(l)) return "bash";
  return "";
}

function kwSetFor(lang: string): string[] {
  const fam = langFamily(lang);
  return fam && KW[fam] ? KW[fam] : KW_ALL;
}

// One regex line-scanner: comments → strings → numbers → keywords → calls.
// Anything else stays "plain". Cheap and predictable for chat-sized blocks.
function highlightLine(line: string, kws: string[]): CodeTok[] {
  const out: CodeTok[] = [];
  const isPyBash = kws.includes("lambda") || kws.includes("elif");
  // Keep a strict group layout: 1=comment 2=string 3=number 4=keyword 5=call.
  // The keyword alternation must NOT add inner captures or the later groups shift.
  const kwAlt = "\\b(?:" + kws.join("|") + ")\\b";
  const re = new RegExp(
    "(" + (isPyBash ? "#.*$" : "\\/\\/.*$|\\/\\*.*") + ")" +            // 1 comment
      "|(" + "\"(?:[^\"\\\\\\n]|\\\\.)*\"|'(?:[^'\\\\\\n]|\\\\.)*'|`(?:[^`\\\\\\n]|\\\\.)*`" + ")" + // 2 string
      "|(\\b\\d[\\d._xa-fA-F]*\\b)" +                                    // 3 number
      "|(" + kwAlt + ")" +                                               // 4 keyword
      "|([A-Za-z_$][\\w$]*(?=\\())",                                     // 5 call
    "g"
  );
  let last = 0;
  let m: RegExpExecArray | null;
  const pushPlain = (t: string) => { if (t) out.push({ text: t, style: "plain" }); };
  while ((m = re.exec(line))) {
    if (m.index > last) pushPlain(line.slice(last, m.index));
    if (m[1]) out.push({ text: m[1], style: "com" });
    else if (m[2]) out.push({ text: m[2], style: "str" });
    else if (m[3]) out.push({ text: m[3], style: "num" });
    else if (m[4]) out.push({ text: m[4], style: "kw" });
    else if (m[5]) out.push({ text: m[5], style: "call" });
    last = m.index + m[0].length;
    if (m[0].length === 0) re.lastIndex++;
  }
  if (last < line.length) pushPlain(line.slice(last));
  return out;
}

export function highlightCode(code: string, lang: string): CodeTok[][] {
  const kws = kwSetFor(lang);
  return String(code).split("\n").map(l => highlightLine(l, kws));
}
