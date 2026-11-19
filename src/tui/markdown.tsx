// Markdown — parse once, render as OpenTUI text. Block-level lines,
// inline emphasis, fenced code with lightweight syntax tinting. Links keep
// their URL visible (terminals have no hover).
import { palette } from "./design.ts";

const ui = palette();

type Inline = { text: string; bold?: boolean; italic?: boolean; code?: boolean; link?: string };

function parseInline(line: string): Inline[] {
  const tokens: Inline[] = [];
  let i = 0;
  let buf = "";
  const flush = () => { if (buf) { tokens.push({ text: buf }); buf = ""; } };
  while (i < line.length) {
    if (line[i] === "\\" && i + 1 < line.length && /[\\*_`\[\]()#~-]/.test(line[i + 1])) {
      buf += line[i + 1];
      i += 2;
      continue;
    }
    if (line[i] === "`") {
      const close = line.indexOf("`", i + 1);
      if (close > i) {
        flush();
        tokens.push({ text: line.slice(i + 1, close), code: true });
        i = close + 1;
        continue;
      }
      buf += line[i];
      i++;
      continue;
    }
    if (line.startsWith("**", i)) {
      const close = line.indexOf("**", i + 2);
      if (close > i + 2) {
        flush();
        tokens.push({ text: line.slice(i + 2, close), bold: true });
        i = close + 2;
        continue;
      }
    }
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
      buf += "*";
      i++;
      continue;
    }
    if (line[i] === "[") {
      const closeL = line.indexOf("](", i);
      const closeP = closeL > i ? line.indexOf(")", closeL + 2) : -1;
      if (closeL > i && closeP > closeL) {
        flush();
        tokens.push({ text: line.slice(i + 1, closeL), link: line.slice(closeL + 2, closeP) });
        i = closeP + 1;
        continue;
      }
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
  | { kind: "heading"; level: 1 | 2 | 3; spans: Inline[] }
  | { kind: "bullet"; indent: number; spans: Inline[] }
  | { kind: "quote"; spans: Inline[] }
  | { kind: "rule" }
  | { kind: "text"; spans: Inline[] }
  | { kind: "code"; code: string; lang: string };

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
    if (/^\s*(-{3,}|_{3,}|\*{3,})\s*$/.test(raw)) { out.push({ kind: "rule" }); continue; }
    const hm = raw.match(/^(#{1,3})\s+(.*)$/);
    if (hm) {
      out.push({ kind: "heading", level: Math.min(3, hm[1].length) as 1 | 2 | 3, spans: parseInline(hm[2]) });
      continue;
    }
    const qm = raw.match(/^\s*>\s?(.*)$/);
    if (qm) { out.push({ kind: "quote", spans: parseInline(qm[1]) }); continue; }
    const bm = raw.match(/^(\s*)([-*+]|\d+\.)\s+(.*)$/);
    if (bm) {
      out.push({ kind: "bullet", indent: Math.min(12, bm[1].length), spans: parseInline(bm[3]) });
      continue;
    }
    out.push({ kind: "text", spans: parseInline(raw) });
  }
  if (fence && codeBuf.length) out.push({ kind: "code", code: codeBuf.join("\n"), lang: fenceLang });
  return out;
}

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

function highlightLine(line: string, kws: string[]): CodeTok[] {
  const out: CodeTok[] = [];
  const isPyBash = kws.includes("lambda") || kws.includes("elif");
  const kwAlt = "\\b(?:" + kws.join("|") + ")\\b";
  const re = new RegExp(
    "(" + (isPyBash ? "#.*$" : "\\/\\/.*$|\\/\\*.*") + ")" +
      "|(" + "\"(?:[^\"\\\\\\n]|\\\\.)*\"|'(?:[^'\\\\\\n]|\\\\.)*'|`(?:[^`\\\\\\n]|\\\\.)*`" + ")" +
      "|(\\b\\d[\\d._xa-fA-F]*\\b)" +
      "|(" + kwAlt + ")" +
      "|([A-Za-z_$][\\w$]*(?=\\())",
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

const CODE_COLORS: Record<CodeTok["style"], () => string> = {
  kw: () => ui.syntax.kw,
  str: () => ui.syntax.str,
  com: () => ui.syntax.com,
  num: () => ui.syntax.num,
  call: () => ui.syntax.call,
  plain: () => ui.syntax.plain,
};

function renderSpans(spans: Inline[]): any[] {
  const out: any[] = [];
  spans.forEach((s) => {
    if (s.code) {
      out.push(<span style={{ fg: ui.accent }}>{s.text}</span>);
      return;
    }
    if (s.link) {
      out.push(<span style={{ fg: ui.secondary }}>{s.text}</span>);
      out.push(<span style={{ fg: ui.fgMuted }}>{" (" + s.link + ")"}</span>);
      return;
    }
    if (s.bold && s.italic) {
      out.push(<span style={{ fg: ui.fg }}><b><i>{s.text}</i></b></span>);
      return;
    }
    if (s.bold) out.push(<b><span style={{ fg: ui.fg }}>{s.text}</span></b>);
    else if (s.italic) out.push(<i><span style={{ fg: ui.fgDim }}>{s.text}</span></i>);
    else out.push(<span>{s.text}</span>);
  });
  return out;
}

export function Md(props: { md: string }) {
  const lines = parseMarkdown(props.md);
  return (
    <box flexDirection="column">
      {lines.map((ln: any) => {
        switch (ln.kind) {
          case "heading": {
            const color = ln.level === 1 ? ui.primary : ln.level === 2 ? ui.fg : ui.fgDim;
            return <text fg={color}><b>{renderSpans(ln.spans)}</b></text>;
          }
          case "bullet":
            return (
              <text paddingLeft={(ln.indent || 0) + 1}>
                <span style={{ fg: ui.primarySoft }}>{"• "}</span>
                {renderSpans(ln.spans)}
              </text>
            );
          case "quote":
            return <text fg={ui.fgDim} paddingLeft={1}>{"│ "}{renderSpans(ln.spans)}</text>;
          case "rule":
            return <text fg={ui.border}>{"─".repeat(40)}</text>;
          case "code": {
            const rows = highlightCode(ln.code, ln.lang);
            return (
              <box marginTop={1} marginBottom={1} flexDirection="column">
                <text fg={ui.fgMuted}>{"┌─ " + (ln.lang || "code")}</text>
                {rows.map((toks: any) => (
                  <text>
                    <span style={{ fg: ui.border }}>{"│ "}</span>
                    {toks.map((t: any) => (
                      <span style={{ fg: CODE_COLORS[t.style]() }}>{t.text}</span>
                    ))}
                  </text>
                ))}
                <text fg={ui.fgMuted}>{"└─"}</text>
              </box>
            );
          }
          default:
            return <text>{renderSpans(ln.spans)}</text>;
        }
      })}
    </box>
  );
}
