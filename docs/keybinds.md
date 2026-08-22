# Keybinds

Every key in the Loom TUI is configurable. Bindings live in the `keybinds`
object of `~/.loom/tui.json` (the same file the TUI uses for its theme and
sidebar state). Restart Loom after editing, or run `/keybinds` inside the TUI
to see every action with its current key.

## Quick example

```json
{
  "keybinds": {
    "command_list": "ctrl+j",
    "sidebar_toggle": ["ctrl+b", "ctrl+s"],
    "session_interrupt": "ctrl+z",
    "app_exit": "none"
  },
  "leader": "ctrl+x",
  "leader_timeout": 2000
}
```

- `keybinds` — a map of action name → binding. A configured value fully
  replaces the default for that action.
- `leader` — the key that arms "leader mode": the next key press runs the
  action bound to `<leader>X`. Set to `"none"` or `false` to disable leader
  mode. Default `ctrl+x`.
- `leader_timeout` — milliseconds the leader stays armed. Default `2000`.

## Binding values

A binding can be:

- a string with comma-separated alternatives: `"ctrl+r,ctrl+o"`,
- an array of alternatives: `["ctrl+r", "ctrl+o"]`,
- an object with a `key` field: `{ "key": "ctrl+r" }`,
- `"none"` or `false` to disable the action entirely.

## Key syntax

| Key | Accepted forms |
| --- | --- |
| Modifiers | `ctrl`, `shift`, `alt`, `meta`, `option`, `super`, `cmd`, `win`, `mod`, `hyper`, `control` |
| Enter | `return`, `enter` |
| Escape | `escape`, `esc` |
| Delete / Insert | `delete`, `del` / `insert`, `ins` |
| Page keys | `pageup`, `pgup`, `page-up` / `pagedown`, `pgdn`, `page-down` |
| Function keys | `f1` … `f12` |
| Leader scope | `<leader>n` — runs after the leader key |

Order of modifiers doesn't matter; the canonical display form is
`ctrl+shift+alt+super+hyper+name` (meta/option are shown as `alt`).

## Actions

### App / session

| Action | Default | OpenCode alias | Slash |
| --- | --- | --- | --- |
| `app_exit` | `ctrl+c`, `<leader>q` | `app_exit` | |
| `command_list` | `ctrl+p` | `command_list` | |
| `sidebar_toggle` | `ctrl+b` | `sidebar_toggle` | |
| `sidebar_cycle_tab` | `ctrl+i` | | |
| `session_interrupt` | `escape` | `session_interrupt` | |
| `modal_cancel` | mirrors `session_interrupt` | | |
| `user_expand` | `ctrl+e` | `user_expand` | |
| `session_new` | `<leader>n` | `session_new` | `/new` |
| `session_list` | `<leader>l` | `session_list` | `/sessions` |
| `session_export` | `<leader>x` | `session_export` | `/export` |
| `session_compact` | `<leader>c` | `session_compact` | `/compact` |
| `model_list` | `<leader>m` | `model_list`, `model_provider_list` | `/models` |
| `agent_list` | `<leader>a` | `agent_list` | `/agents` |
| `help_show` | `<leader>h` | `help_show` | `/help` |
| `editor_open` | `<leader>e` | `editor_open` | `/editor` |
| `display_thinking` | `<leader>t` | `display_thinking` | `/thinking` |
| `tool_details` | `<leader>d` | `tool_details` | `/details` |
| `app_settings` | `<leader>s` | | `/settings` |
| `app_undo` | `<leader>u` | | `/undo` |
| `app_redo` | `<leader>r` | | `/redo` |
| `mode_build` | `<leader>b` | | `/build` |
| `mode_plan` | `<leader>p` | | `/plan` |
| `theme_list` | (disabled) | `theme_list` | `/theme` |

### Prompt input (readline-style editing)

| Action | Default | OpenCode alias |
| --- | --- | --- |
| `input_submit` | `return` | `input_submit`, `prompt_submit` |
| `input_newline` | `shift+return` | `input_newline` |
| `input_paste` | `ctrl+v` | `input_paste` |
| `input_select_all` | `ctrl+a` | `input_select_all` |
| `input_move_left` | `left` | `input_move_left` |
| `input_move_right` | `right` | `input_move_right` |
| `line_home` | `home` | `input_line_home`, `input_buffer_home` |
| `line_end` | `end` | `input_line_end`, `input_buffer_end` |
| `input_backspace` | `backspace` | `input_backspace` |
| `input_delete` | `ctrl+d`, `delete` | `input_delete` |
| `prompt_autocomplete_next` | `tab` | `prompt.autocomplete.next`, `prompt.autocomplete.complete` |
| `up_context` | `up` | `input_move_up`, `history_previous`, `prompt.autocomplete.prev` |
| `down_context` | `down` | `input_move_down`, `history_next` |

### Dialog keys (modal lists & prompts)

`dialog_select_prev` / `dialog_select_next` (`up` / `down`),
`dialog_select_submit` (`return`), `dialog_select_page_up` (`pageup`),
`dialog_select_page_down` (`pagedown`), `dialog_select_home` (`home`),
`dialog_select_end` (`end`). OpenCode aliases: `dialog.select.prev`,
`dialog.select.next`, `dialog.select.submit`, `dialog.prompt.submit`,
`dialog.select.page_up`, `dialog.select.page_down`, `dialog.select.home`,
`dialog.select.end`.

## Notes

- `modal_cancel` is bound to the same key as `session_interrupt` by default,
  so Escape both clears the input and closes an open dialog. Give it its own
  key to split the two.
- Unknown action names are ignored with a warning (visible in `/keybinds`).
- Actions with a slash command (`/models`, `/help`, …) run that command when
  triggered from the keyboard, exactly as if you typed it.
