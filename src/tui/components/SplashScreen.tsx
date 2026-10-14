// Splash screen -- logo + embedded InputBar when no messages yet. Signal reads in JSX.
import { palette, LOOM_LOGO, VERSION } from "../theme.ts";
import { providerName, modelName, providerKeyOk } from "../store.ts";
import { InputBar } from "./InputBar.tsx";

export function SplashScreen() {
  const ui = palette("loom");

  return (
    <box flexDirection="column" flexGrow={1} alignItems="center" justifyContent="center" backgroundColor={ui.bg}>
      <box flexGrow={1} />

      <box flexDirection="column" alignItems="center" marginBottom={1}>
        {LOOM_LOGO.map((line) => (
          <text fg={ui.primary}>{line}</text>
        ))}
      </box>

      <text fg={ui.border}>{"─".repeat(60)}</text>

      <box marginTop={1} flexDirection="row" alignItems="center">
        {/* OpenTUI text nodes take fg/bg via the style prop — a direct
            backgroundColor prop is silently ignored (the pill vanished). */}
        {/* @ts-ignore styled span for the build chip */}
        <text><span style={{ fg: ui.bgPanel, bg: ui.primary }}>{" build "}</span></text>
        <text fg={ui.fgMuted}>{"  " + providerName()}</text>
        <text fg={ui.fgMuted}>{" / "}</text>
        <text fg={ui.fg}>{modelName()}</text>
        <text fg={ui.fgMuted}>{"  "}</text>
        <text fg={providerKeyOk() ? ui.success : ui.warning}>
          {"● " + (providerKeyOk() ? "connected" : "no key")}
        </text>
      </box>

      <box marginTop={0}>
        <text fg={ui.fgMuted}>{"v" + VERSION}</text>
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
