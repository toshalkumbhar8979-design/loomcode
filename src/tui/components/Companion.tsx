// Companion — Animated ASCII pet. All signal reads inside JSX/Show for reactivity.
import { onMount, onCleanup, createSignal, Show } from "solid-js";
import { palette } from "../theme.ts";
import {
  petBark, petEnabled, companion,
  notifyPet, companionMoodPose, companionBlinkFrame, companionRandomPhrase,
} from "../store.ts";
import { openPetsBroadcast } from "../companion/openpets.ts";

const ui = palette("loom");

export function Companion() {
  const [frame, setFrame] = createSignal(0);
  const [bubbleText, setBubbleText] = createSignal("");
  const [hearts, setHearts] = createSignal(0);

  let timer: any;
  let bubbleTimer: any;

  onMount(() => {
    timer = setInterval(() => setFrame(f => (f + 1) % 16), 700);
    setTimeout(() => {
      const p = companionRandomPhrase();
      if (p) { setBubbleText(p); if (bubbleTimer) clearTimeout(bubbleTimer); bubbleTimer = setTimeout(() => setBubbleText(""), 2500); }
    }, 2000);
  });

  onCleanup(() => {
    if (timer) clearInterval(timer);
    if (bubbleTimer) clearTimeout(bubbleTimer);
  });

  function showPhrase(phrase: string, duration = 3500) {
    if (!phrase) return;
    setBubbleText(phrase);
    if (bubbleTimer) clearTimeout(bubbleTimer);
    bubbleTimer = setTimeout(() => setBubbleText(""), duration);
  }

  function handleClick() {
    setHearts(c => c + 1);
    const phrase = companionRandomPhrase() || "<3";
    showPhrase(phrase, 2000);
    notifyPet({ mood: "celebrating", until: 1200 });
    openPetsBroadcast({ mood: "celebrating", phrase });
  }

  // Current art: prefer mood pose if a transient mood is active, else blink animation.
  function currentArt(): string[] {
    const mood = petBark()?.mood;
    if (mood && mood !== "idle" && mood !== "sleep") return companionMoodPose();
    return companionBlinkFrame(frame());
  }

  return (
    <Show when={petEnabled()}>
      <box flexDirection="column" alignItems="center" marginBottom={1}>
        <Show when={bubbleText().length > 0}>
          <box border borderStyle="rounded" paddingX={1} marginBottom={0} backgroundColor={ui.bgPanelAlt} borderColor={ui.border}>
            <text fg={ui.fgDim} dim>{bubbleText()}</text>
          </box>
        </Show>

        <box onMouseDown={handleClick} paddingX={1} paddingY={0} flexDirection="column">
          {currentArt().map((line, i) => (
            <text key={i} fg={i === 1 ? ui.pet : ui.fgDim}>{line}</text>
          ))}
        </box>

        <text fg={ui.fgMuted} dim>
          {"~ " + companion() + (hearts() > 0 ? " <3x" + hearts() : "")}
        </text>
      </box>
    </Show>
  );
}
