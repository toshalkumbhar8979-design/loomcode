// ChatArea — message list with proper role styling + tool log + think time.
import { palette } from "../theme.ts";
import { showThinking } from "../store.ts";
import { formatDiffCount } from "../../core/file-diffs.js";
import os from "os";

const ui = palette("loom");
function uname() { return os.userInfo().username || "you"; }
function fmtMs(ms) { if (!ms) return ""; return ms < 1000 ? ms + "ms" : (ms / 1000).toFixed(1) + "s"; }

// Right-side file-change panel used only for the vertical split view:
// shows which files were edited, + counts, and the colored +/- hunks.
function DiffPanel(props) {
  const diffs = props.diffs || [];
  if (!diffs.length) return null;
  return (
    <box flexDirection="column" width={50} marginLeft={1}>
      <box flexDirection="column" borderStyle="single" borderColor={ui.border}
        backgroundColor={ui.bgPanel} paddingX={1} paddingY={1} width={50}>
        {diffs.map((d, i) => (
          <box key={"d-" + i} flexDirection="column" marginBottom={i < diffs.length - 1 ? 1 : 0}>
            <box flexDirection="row" justifyContent="space-between">
              <text fg={ui.accent} bold wrap>{"✎ " + d.path}</text>
              <text fg={d.added ? ui.success : ui.fgMuted} dim>{"  " + formatDiffCount(d)}</text>
            </box>
            {d.lines.map((ln, j) => {
              if (ln.text === "…") return <text key={j} fg={ui.fgMuted} dim>{"  …"}</text>;
              const lines = String(ln.text).replace(/\n$/, "").split("\n");
              return lines.map((t, k) => (
                <text key={j + "-" + k} fg={ln.kind === "add" ? ui.success : ln.kind === "del" ? ui.error : ui.fgMuted} dim={ln.kind === "ctx"}>
                  {ln.kind === "add" ? "+ " : ln.kind === "del" ? "- " : "  "}{t.slice(0, 58)}
                </text>
              ));
            })}
          </box>
        ))}
      </box>
    </box>
  );
}

function MsgBubble(props) {
  const m = props.m;

  if (m.role === "system") {
    return (
      <box marginBottom={1} paddingX={2}>
        <text fg={ui.fgMuted} dim wrap>{m.content}</text>
      </box>
    );
  }

  if (m.role === "user") {
    return (
      <box flexDirection="column" marginBottom={1} paddingRight={1}>
        <box flexDirection="row" justifyContent="space-between" paddingX={1}>
          <text fg={ui.secondary} bold>{"◤ " + uname()}</text>
          <text fg={ui.fgMuted} dim>{m.time || ""}</text>
        </box>
        <box paddingX={2}>
          <text fg={ui.fg} wrap>{String(m.content || "").slice(0, 2000)}</text>
        </box>
      </box>
    );
  }

  if (m.role === "tool") {
    const first = String(m.content || "").split("\n")[0].slice(0, 140);
    return (
      <box marginBottom={1} paddingLeft={4}>
        <text fg={ui.accent} dim wrap>{"→  " + first}</text>
      </box>
    );
  }

  // Assistant
  const isErr = m.isError;
  const isThink = m.thinking;
  const isStop = m.interrupted;
  const acc = isErr ? ui.error : (isThink ? ui.thinking : isStop ? ui.warning : ui.secondary);
  const label = isErr ? "✕ Error" : isThink ? "◇ Thinking…" : isStop ? "‖ Interrupted" : "◇ Loom";
  const diffs = m.fileDiffs || [];
  const splitDiff = diffs.length >= 2;
  const singleDiff = diffs.length === 1;
  return (
    <box flexDirection="row" marginBottom={1}>
      <box flexDirection="column" marginRight={1}>
        <text fg={acc}>{"│"}</text>
        <text fg={acc}>{"│"}</text>
        <text fg={acc}>{"│"}</text>
      </box>
      <box flexDirection={splitDiff ? "row" : "column"} flexGrow={1} paddingRight={1}>
        <box flexDirection="column" flexGrow={1} paddingRight={splitDiff ? 0 : 1}>
          <box flexDirection="row" justifyContent="space-between" paddingX={1}>
            <text fg={acc} bold>{label}</text>
            {showThinking() && m.thinkTime ? (
              <text fg={ui.thinking} dim>{"⚡ " + fmtMs(m.thinkTime)}</text>
            ) : null}
          </box>
          {m.toolCalls?.length ? (
            <text fg={ui.accent}>{"⚡ " + m.toolCalls.map((tc) => tc.name).join(", ")}</text>
          ) : null}
          <box paddingX={1}>
            <text fg={isErr ? ui.error : ui.fg} wrap>
              {(m.content || (isThink ? "…" : "")).slice(0, 8000)}
            </text>
          </box>
          {m.toolLog ? (
            <box paddingX={1} marginTop={0}>
              <text fg={ui.accent} dim wrap>{String(m.toolLog).split("\n").slice(-5).join("\n")}</text>
            </box>
          ) : null}
          {singleDiff ? (
            <box paddingX={1} marginTop={1}>
              <text fg={ui.accent} dim wrap>
                {"✎ " + diffs[0].path + "  " + formatDiffCount(diffs[0])}
              </text>
            </box>
          ) : null}
        </box>
        {splitDiff ? <DiffPanel diffs={diffs} /> : null}
      </box>
    </box>
  );
}

export function ChatArea(props: { messages?: () => any[]; thinking?: boolean }) {
  const visible = () => (props.messages?.() || []).slice(-40);
  return (
    <box flexDirection="column" flexGrow={1} overflow="hidden" paddingX={0}>
      <scrollbox
        flexGrow={1}
        stickyScroll
        stickyStart="bottom"
        scrollbarOptions={{ trackOptions: { style: { fg: ui.border } } }}
        viewportOptions={{ flexGrow: 1 }}
      >
        {visible().map((m, i) => (
          <MsgBubble key={"m-" + i} m={m} />
        ))}
        {props.thinking && (
          <box paddingX={3} paddingY={1}>
            <text fg={ui.thinking} dim>{"◆ Loom is thinking…  (esc to interrupt)"}</text>
          </box>
        )}
      </scrollbox>
    </box>
  );
}
