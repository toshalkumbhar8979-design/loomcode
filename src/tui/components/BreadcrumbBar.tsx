// Top breadcrumb bar — project path, session info, model.
import { palette } from "../theme.ts";
import { providerName, modelName, sessionId, cwdShort, username, inputMode } from "../store.ts";

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
      <box flexDirection="row">
        <text fg={ui.primary}>{"loom"}</text>
        <text fg={ui.fgMuted}>{" / "}</text>
        <text fg={ui.fg}>{cwdShort() || "~"}</text>
        <text fg={ui.fgMuted}>{"  ·  "}</text>
        <text fg={ui.fgDim}>{sessionId().slice(0, 8)}</text>
        <text fg={ui.fgMuted}>{"  ·  "}</text>
        <text fg={modeColors[inputMode()] || ui.primary}>{"[" + (MODE_LABELS[inputMode()] || "B") + "]"}</text>
      </box>
      <box flexDirection="row">
        <text fg={ui.secondary}>{providerName()}</text>
        <text fg={ui.fgMuted}>{" / "}</text>
        <text fg={ui.fg}>{modelName()}</text>
      </box>
    </box>
  );
}
