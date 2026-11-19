// Boot — the splash. A 30x13 3D SDF ASCII bot, one question, one hint line.
// The bot box is anchored; RobotAnimation turns it toward the pointer, or
// toward the composer caret once the user has typed.
import { useTerminalDimensions } from "@opentui/solid";
import { palette } from "../design.ts";
import { cursor, input, pointer } from "../store.ts";
import { RobotAnimation } from "./RobotAnimation.tsx";

const ui = palette();

export function Boot() {
  const dims = useTerminalDimensions();

  const target = () => {
    const w = Math.max(1, dims().width || 100);
    const h = Math.max(1, dims().height || 32);
    if (input().trim()) {
      const contentW = Math.max(52, Math.min(88, w - 8));
      const startX = Math.floor((w - contentW) / 2) + 2;
      return { x: startX + Math.min(cursor(), Math.max(0, contentW - 4)), y: h - 2 };
    }
    const p = pointer();
    return p.seen ? { x: p.x, y: p.y } : { x: Math.floor(w / 2), y: Math.max(0, Math.floor((h - 15) / 2)) };
  };

  return (
    <box flexDirection="column" alignItems="center" flexShrink={0}>
      <RobotAnimation
        cursorX={target().x}
        cursorY={target().y}
        width={dims().width || 100}
        height={dims().height || 32}
        color={ui.primary}
      />
      <text fg={ui.fg} height={1} marginTop={1}>{"What can I do for you?"}</text>
      <text fg={ui.fgMuted} height={1} marginTop={1}>
        {"Use / for slash commands, @ for file mentions, Ctrl+P for menu"}
      </text>
    </box>
  );
}
