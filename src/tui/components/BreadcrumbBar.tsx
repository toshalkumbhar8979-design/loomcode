// Top breadcrumb bar — project path, session info, model. bgPanel surface
// plus a dim right-hand cluster; no frame (the TUI stays grid-line-free).
import { palette } from "../theme.ts";
import { providerName, modelName, sessionId, cwdShort, inputMode } from "../store.ts";

const MODE_LABELS: Record<string, string> = { build: "B", plan: "P", chat: "C" };

export function BreadcrumbBar() {
  const ui = palette("loom");
  const modeColors: Record<string, string> = { build: ui.primary, plan: ui.primarySoft, chat: ui.warning };
  return (
    <box
      flexDirection="row"
      justifyContent="space-between"
      alignItems="center"
      paddingX={1}
      backgroundColor={ui.bgPanel}
    >
      <box flexDirection="row" alignItems="center">
        <text fg={ui.primary}>{"loom"}</text>
        <text fg={ui.fgMuted}>{" · "}</text>
        <text fg={ui.fg}>{cwdShort() || "~"}</text>
        <text fg={ui.fgMuted}>{" · "}</text>
        <text fg={ui.fgMuted}>{sessionId().slice(0, 8)}</text>
        <text fg={ui.fgMuted}>{"  "}</text>
        <text fg={modeColors[inputMode()] || ui.primary}>{"[" + (MODE_LABELS[inputMode()] || "B") + "]"}</text>
      </box>
      <box flexDirection="row" alignItems="center">
        <text fg={ui.secondary}>{providerName()}</text>
        <text fg={ui.fgMuted}>{" / "}</text>
        <text fg={ui.fgDim}>{modelName()}</text>
      </box>
    </box>
  );
}
