// 3D SDF ASCII bot. The frame box is anchored; the bot turns toward the
// pointer or the composer caret using the supplied nine gaze frames.
import { For, createSignal, onCleanup, onMount } from "solid-js";
import { ROBOT_FRAMES, type RobotDirection } from "../robot-frames.generated.ts";

const GAZE: Array<{ id: RobotDirection; x: number; y: number }> = [
  { id: "up-left", x: -28 / 36, y: -18 / 24 },
  { id: "up", x: 0, y: -22 / 24 },
  { id: "up-right", x: 28 / 36, y: -18 / 24 },
  { id: "left", x: -34 / 36, y: 0 },
  { id: "center", x: 0, y: 0 },
  { id: "right", x: 34 / 36, y: 0 },
  { id: "down-left", x: -28 / 36, y: 18 / 24 },
  { id: "down", x: 0, y: 22 / 24 },
  { id: "down-right", x: 28 / 36, y: 18 / 24 },
];

const clamp = (value: number) => Math.max(-1, Math.min(1, value));

function targetDirection(cursorX: number, cursorY: number, width: number, height: number): RobotDirection {
  const w = Math.max(1, width || 100);
  const h = Math.max(1, height || 32);
  const artCenterY = Math.max(1, (h - 15) / 2);
  const nx = clamp((cursorX - w / 2) / Math.max(10, w / 2 - 6));
  const ny = clamp((cursorY - artCenterY) / Math.max(5, artCenterY - 1));
  if (Math.hypot(nx, ny) < 0.25) return "center";

  let best: RobotDirection = "center";
  let bestDistance = Infinity;
  for (const gaze of GAZE) {
    const dx = nx - gaze.x;
    const dy = ny - gaze.y;
    const distance = dx * dx + dy * dy;
    if (distance < bestDistance) {
      bestDistance = distance;
      best = gaze.id;
    }
  }
  return best;
}

export function RobotAnimation(props: {
  cursorX: number;
  cursorY: number;
  width: number;
  height: number;
  color?: string;
}) {
  const [blinking, setBlinking] = createSignal(false);

  onMount(() => {
    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    let blinkTimer: ReturnType<typeof setTimeout> | undefined;

    const scheduleBlink = () => {
      idleTimer = setTimeout(() => {
        setBlinking(true);
        blinkTimer = setTimeout(() => setBlinking(false), 140);
        scheduleBlink();
      }, 2800 + Math.random() * 2600);
    };

    scheduleBlink();
    onCleanup(() => {
      if (idleTimer) clearTimeout(idleTimer);
      if (blinkTimer) clearTimeout(blinkTimer);
    });
  });

  const frame = () =>
    blinking()
      ? ROBOT_FRAMES.blink
      : ROBOT_FRAMES[targetDirection(props.cursorX, props.cursorY, props.width, props.height)];

  return (
    <box flexDirection="column" alignItems="center" flexShrink={0}>
      <For each={frame()}>
        {(line: string) => <text fg={props.color || "#ffffff"} height={1}>{line}</text>}
      </For>
    </box>
  );
}
