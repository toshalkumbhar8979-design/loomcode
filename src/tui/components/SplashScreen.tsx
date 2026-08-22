// Splash screen -- logo + embedded InputBar when no messages yet. Signal reads in JSX.
import { palette, LOOM_LOGO } from "../theme.ts";
import { providerName, modelName, providerKeyOk } from "../store.ts";
import { InputBar } from "./InputBar.tsx";

export function SplashScreen() {
  const ui = palette("loom");

  return (
    // Centered like opencode: the whole block (logo + status + chatbox)
    // floats mid-screen and grows symmetrically around its center as the
    // chatbox lines up.
    <box flexDirection="column" flexGrow={1} alignItems="center" justifyContent="center" backgroundColor={ui.bg}>
      <box flexGrow={1} />

      <box flexDirection="column" alignItems="center" marginBottom={1}>
        {LOOM_LOGO.map((line, i) => (
          <text fg={ui.primary}>{line}</text>
        ))}
      </box>

      <box marginTop={2} flexDirection="row">
        <text fg={ui.primary}>{"Build"}</text>
        <text fg={ui.fgDim}>{"  "}</text>
        <text fg={ui.fg}>{providerName()}</text>
        <text fg={ui.fgDim}>{"  "}</text>
        <text fg={ui.fg}>{modelName()}</text>
        <text fg={ui.fgDim}>{"  "}</text>
        <text fg={providerKeyOk() ? "green" : "yellow"}>{providerKeyOk() ? "connected" : "no key"}</text>
      </box>

      <box marginTop={0}>
        <text fg={ui.fgMuted}>{"v1.1.0"}</text>
      </box>

      <box marginY={1} width={74}>
        <InputBar />
      </box>

      <box flexDirection="column" alignItems="center">
        <box flexDirection="row">
          <text fg={ui.warning}>{"Tip: "}</text>
          <text fg={ui.fgDim}>{"Type /help  @ for files  ! for shell  tab to cycle mode"}</text>
        </box>
        <text fg={ui.fgMuted}>{"ctrl+p palette  ctrl+b sidebar  esc interrupt"}</text>
      </box>

      <box flexGrow={1} />
    </box>
  );
}