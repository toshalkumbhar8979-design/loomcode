// Layer — the one modal frame. Opaque, centered, titled, with a footer
// hairline. Every overlay in the app sits inside it.
import { palette, topRule, botRule } from "../design.ts";

const ui = palette();

export function ModalFrame(props: {
  title: string;
  subtitle?: string;
  children: any;
  footer?: string;
  width?: number;
}) {
  const W = props.width || 72;
  return (
    <box position="absolute" top={0} left={0} right={0} bottom={0}
      alignItems="center" justifyContent="center" flexDirection="column">
      <box backgroundColor={ui.bg} flexDirection="column" width={W}>
        <text fg={ui.primary} height={1} flexShrink={0}>{topRule(W, undefined, { left: props.title })}</text>
        <box flexDirection="column" paddingX={3} paddingY={1}>
          {props.subtitle ? <text fg={ui.fgMuted}>{props.subtitle}</text> : null}
          <box flexDirection="column" marginTop={props.subtitle ? 1 : 0}>{props.children}</box>
        </box>
        <text fg={ui.fgMuted} height={1} flexShrink={0}>{botRule(W, undefined, props.footer ? { right: props.footer } : undefined)}</text>
      </box>
    </box>
  );
}

export function wheelStep(e: any, delta: number): number {
  const dir = e?.scroll?.direction;
  return dir === "up" ? -delta : delta;
}

export function kbNav() {
  const kbs = require("../keybinds.ts");
  return {
    prev: kbs.label("dialog_select_prev").toUpperCase(),
    next: kbs.label("dialog_select_next").toUpperCase(),
    submit: kbs.label("dialog_select_submit").toUpperCase(),
    cancel: kbs.label("modal_cancel").toUpperCase(),
  };
}
