// MdText — render a markdown string into chat-friendly terminal JSX.
// Line-level parsing comes from md-render.ts; this file is the JSX mapping.
import { palette } from "../theme.ts";
import { parseMarkdown, highlightCode, CodeTok } from "../md-render.ts";

const ui = palette("loom");

// Code colors come straight from the active theme's TextMate syntax scopes
// (keyword/string/comment/number/call) — same source VS Code uses, so fenced
// blocks look right for whichever theme is picked.
const CODE_COLORS: Record<CodeTok["style"], () => string> = {
  kw: () => ui.syntax.kw,
  str: () => ui.syntax.str,
  com: () => ui.syntax.com,
  num: () => ui.syntax.num,
  call: () => ui.syntax.call,
  plain: () => ui.syntax.plain,
};

function CodeLine(props: { toks: CodeTok[]; k: string }) {
  return (
    <text>
      {props.toks.map((t, j) => (
        // @ts-ignore OpenTUI text nodes take fg via the style prop (TextNodeOptions), not as a direct prop
        <span style={{ fg: CODE_COLORS[t.style]() }}>
          {t.text}
        </span>
      ))}
    </text>
  );
}

function spansToNodes(spans: any[], keyPrefix: string) {
  if (!spans.length) return " ";
  return spans.map((s, i) => {
    const key = keyPrefix + "-" + i;
    if (s.code) {
      // Inline code: accent color + panel background to read as a chip.
      // @ts-ignore OpenTUI text nodes take fg/bg via the style prop (TextNodeOptions), not as direct props
      return <span style={{ fg: ui.accent, bg: ui.bgPanel }}>{s.text}</span>;
    }
    if (s.link) {
      // @ts-ignore OpenTUI text nodes take fg/underline via the style prop; href is a direct prop
      return <a href={s.link} style={{ fg: ui.accent, underline: true }}>{s.text}</a>;
    }
    if (s.bold && s.italic) {
      // @ts-ignore OpenTUI text nodes take fg via the style prop (TextNodeOptions)
      return <span style={{ fg: ui.fg }}><b><i>{s.text}</i></b></span>;
    }
    // @ts-ignore OpenTUI text nodes take fg via the style prop (TextNodeOptions)
    if (s.bold) return <b><span style={{ fg: ui.fg }}>{s.text}</span></b>;
    // @ts-ignore OpenTUI text nodes take fg via the style prop (TextNodeOptions)
    if (s.italic) return <i><span style={{ fg: ui.fg }}>{s.text}</span></i>;
    return <span>{s.text}</span>;
  });
}

function HeadingText(props: { level: 1 | 2 | 3; spans: any[]; keyPrefix: string }) {
  const marker = props.level === 1 ? "# " : props.level === 2 ? "## " : "### ";
  return <text fg={ui.primary}>{marker}{spansToNodes(props.spans, props.keyPrefix)}</text>;
}

export function MdText(props: { md: string; wrap?: boolean }) {
  const lines = parseMarkdown(props.md);
  return (
    <box flexDirection="column">
      {lines.map((ln, i) => {
        const kp = "mdl-" + i;
        switch (ln.kind) {
          case "heading": return <HeadingText level={ln.level} spans={ln.spans} keyPrefix={kp} />;
          case "bullet":
            return (
              <text paddingLeft={ln.indent}>
                {// @ts-ignore OpenTUI text nodes take fg via the style prop (TextNodeOptions)
                <span style={{ fg: ui.secondary }}>{"• "}</span>}
                {spansToNodes(ln.spans, kp)}
              </text>
            );
          case "quote":
            return (
              <text>
                {// @ts-ignore OpenTUI text nodes take fg via the style prop (TextNodeOptions)
                <span style={{ fg: ui.accent }}>{"│ "}</span>}
                {spansToNodes(ln.spans, kp)}
              </text>
            );
          case "rule":
            return <text fg={ui.fgMuted}>{"────────"}</text>;
          case "code": {
            const lines = highlightCode(ln.code, ln.lang);
            return (
              <box backgroundColor={ui.bgPanel} paddingX={1} flexDirection="column">
                {lines.map((toks, j) => (
                  <CodeLine toks={toks} k={kp + "-c" + j} />
                ))}
              </box>
            );
          }
          default:
            return <text>{spansToNodes(ln.spans, kp)}</text>;
        }
      })}
    </box>
  );
}
