// MdText — render a markdown string into chat-friendly terminal JSX.
// Line-level parsing comes from md-render.ts; this file is the JSX mapping.
import { palette } from "../theme.ts";
import { parseMarkdown, highlightCode, CodeTok } from "../md-render.ts";

const ui = palette("loom");

// opencode-ish code palette: keywords pop, strings warm, comments muted,
// numbers bright, calls accented. Keeps chat code blocks readable at a glance.
const CODE_COLORS: Record<CodeTok["style"], () => string> = {
  kw: () => ui.secondary,
  str: () => ui.success,
  com: () => ui.fgMuted,
  num: () => ui.warning,
  call: () => ui.accent,
  plain: () => ui.fg,
};

function CodeLine(props: { toks: CodeTok[]; k: string }) {
  return (
    <text>
      {props.toks.map((t, j) => (
        <span key={props.k + "-" + j} fg={CODE_COLORS[t.style]()}>
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
      return <span key={key} fg={ui.accent} bg={ui.bgPanel}>{s.text}</span>;
    }
    if (s.link) {
      return <a key={key} href={s.link} fg={ui.accent} underline>{s.text}</a>;
    }
    if (s.bold && s.italic) {
      return <span key={key} fg={ui.fg}><b><i>{s.text}</i></b></span>;
    }
    if (s.bold) return <b key={key}><span fg={ui.fg}>{s.text}</span></b>;
    if (s.italic) return <i key={key}><span fg={ui.fg}>{s.text}</span></i>;
    return <span key={key}>{s.text}</span>;
  });
}

function HeadingText(props: { level: 1 | 2 | 3; spans: any[]; keyPrefix: string }) {
  const marker = props.level === 1 ? "# " : props.level === 2 ? "## " : "### ";
  return <text fg={ui.primary} bold>{marker}{spansToNodes(props.spans, props.keyPrefix)}</text>;
}

export function MdText(props: { md: string; wrap?: boolean }) {
  const lines = parseMarkdown(props.md);
  return (
    <box flexDirection="column">
      {lines.map((ln, i) => {
        const kp = "mdl-" + i;
        switch (ln.kind) {
          case "heading": return <HeadingText key={kp} level={ln.level} spans={ln.spans} keyPrefix={kp} />;
          case "bullet":
            return (
              <text key={kp} paddingLeft={ln.indent}>
                <span fg={ui.secondary}>{"• "}</span>
                {spansToNodes(ln.spans, kp)}
              </text>
            );
          case "quote":
            return (
              <text key={kp}>
                <span fg={ui.accent}>{"│ "}</span>
                {spansToNodes(ln.spans, kp)}
              </text>
            );
          case "rule":
            return <text key={kp} fg={ui.fgMuted} dim>{"────────"}</text>;
          case "code": {
            const lines = highlightCode(ln.code, ln.lang);
            return (
              <box key={kp} backgroundColor={ui.bgPanel} paddingX={1} flexDirection="column">
                {lines.map((toks, j) => (
                  <CodeLine key={kp + "-c" + j} toks={toks} k={kp + "-c" + j} />
                ))}
              </box>
            );
          }
          default:
            return <text key={kp} wrap>{spansToNodes(ln.spans, kp)}</text>;
        }
      })}
    </box>
  );
}
