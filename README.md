# quiet-shell

A Claude Code mod (a plugin of function hooks) that adds `$` as a second shell
prefix. `$ cmd` runs the command the way `! cmd` does and leaves the same rows
in the transcript, but Claude never responds to it: no model call, no tokens,
no waiting for a reply. `!` is untouched and still gets its response.

Built and tested against Claude Code **2.1.287**. The function-hooks API is
early access and changes between releases, and this mod mirrors some engine
behavior (see below), so recheck it after upgrading.

## The parts the mod API can't deliver

Read this first. The spec asked for `$` to feel identical to `!`. Some of that
can't be done with the 2.1.287 mod API, and the mod doesn't hide that:

**1. Typing `$` does not put the prompt into shell mode, so it doesn't look
like shell mode.** The `$` stays in the draft as an ordinary character. The mod
paints it in shell mode's pink, and that is the only part of the look it can
reproduce:

| | `!` (shell mode) | `$` (this mod) |
|---|---|---|
| glyph left of the input | pink `!` replaces `❯` | `❯` stays; the `$` after it is pink |
| prompt border | pink | stays gray |
| footer | `! for shell mode` | the usual footer (permission mode, hints) |
| ↑ history | filtered to shell commands | all prompts |
| cursor | can't move before the `!` | can move before the `$` |

Why: no API reaches the prompt's input mode.
- `$.prompt` offers `submit`, `read`, `fill`, `suggest` and `compose`, and
  none of them sets a mode. `prompt.fill` in `replace` mode resets the box to
  prompt mode.
- A `prompt.edit` hook can rewrite the draft and paint over it. The composer
  applies the answer through its change handler, but only after the editor has
  already put the typed `$` in and moved the cursor past it, and shell mode is
  entered only for a `!` typed with the cursor at the start. So answering `!`
  for a typed `$` gives a literal `!`, not shell mode. (Read from the 2.1.287
  source and confirmed by trying it.)
- No keybinding action switches modes.
- The prompt box and the footer's permission-mode line are not `ui.render`
  sites, so a mod can't draw them.

**2. Backspacing out deletes a character, not a mode.** Backspace removes the
`$` and leaves an empty normal prompt. It takes the same keys and ends in the
same state as leaving shell mode, but what happens on screen is a character
being deleted.

**3. Visible differences around submitting.** By the time a hook sees a
submitted prompt, it has already been sent. The only ways to stop it are to drop
it or to answer it without passing it on, and both make the engine add a
notice row that no render hook can hide:
- `$` with nothing after it, then Enter: you get `● Prompt dropped by a hook: a
  $ with no command after it runs nothing`, and the `$` goes back in the box.
  An empty `!` + Enter does nothing.
- Esc while a `$` command runs: like `!`, the command is killed and put back in
  the box. You also get `● Prompt dropped by a hook: interrupted`.

**4. Small transient differences while a command runs.** The running row looks
like `!`'s (`! cmd` / `⎿  Running…`, no spinner), with three exceptions:
- The line above the prompt is blank where `!` shows the effort hint
  (`◐ medium · /effort`).
- After a couple of seconds, `!` starts showing a live tail of the output, a
  timer, and a ctrl+b hint for moving the command to the background. `$`
  keeps showing `Running…` and can't be backgrounded.
- A `$` typed while Claude is working waits for the turn to end, as `!` does,
  but once it starts running, Esc can't stop it.

**5. Side effects of going through the prompt path.** A `$` command has to enter
as a prompt, so:
- `UserPromptSubmit` hooks in your settings run for it, and see
  `<bash-input>cmd</bash-input>`. `!` commands skip those hooks.
- The engine starts a turn for it, which the mod aborts in `turn.start`, before
  the first model request. No request is sent: zero were logged across every
  test (see *Verification*). Other plugins watching turns will see a turn that
  was aborted. `Stop` hooks do not run.

**6. Shell differences.**
- `$cd somewhere` doesn't carry over to later commands. With `!`, a `cd`
  inside the project does. No mod API changes the session's working directory.
- Output past `bashOutputMaxChars` is saved under
  `$TMPDIR/claude-quiet-shell/<session>/` rather than the session's
  tool-results folder. The row reads the same apart from that path.
- The engine takes its shell snapshot (your config's aliases, functions and
  options) only on a session's first Bash use. If a `$` command comes first, the
  mod takes one the same way. It holds the same options, functions and aliases,
  but not the engine's private shims for its own `rg`/`find`/`grep`/`pkill`.

**7. Scope.** Only prompts typed in the terminal are handled. Prompts from
Remote Control (phone, web), the SDK, or other plugins pass through untouched.
The desktop app's composer is untested. So is zsh: every end-to-end check
below ran under bash. For zsh, the mod follows the engine's own zsh steps, and
the unit tests cover the script it builds.

## What does match `!`

These were checked against the real engine (see *Verification*):

- **No model call.** Zero API requests for any `$` command, including twenty
  sent back to back, ones typed while Claude was working, and ones sent the
  instant they were typed or pasted.
- **The transcript.** For a 20-command matrix (empty output, stderr, non-zero
  exits, escaping, CRLF and tabs, aliases, functions, `.bashrc` exports, nested
  quotes, relative paths, large output) plus a here-document, the stored rows
  are byte-for-byte the
  rows a `!` command stores under `respondToBashCommands: false`: the
  `local-command-caveat` note, `<bash-input>`, and `<bash-stdout>` /
  `<bash-stderr>`. The one exception is the saved-output path. The drawn
  screens are identical too, colors included.
- **What Claude sees later.** On your next prompt, the `$` commands are in
  context with the same caveat as a no-respond `!` command ("run directly in
  Claude Code, not sent to you as a request").
- **How the command runs.** The same shell (`CLAUDE_CODE_SHELL`, else `$SHELL`
  if it's bash or zsh), the same snapshot of your aliases, functions and
  options, the same `~/.bashrc` read (bash reads it on its own when stdin is a
  socket, as the engine's is), and the session's working directory. Like the
  engine, it turns extglob off, takes stdin from `/dev/null` (except for
  here-documents), merges stderr into stdout, and leaves the positional
  parameters empty.
- **Interaction.** `!` is unchanged, and so is a `$` typed inside `!` mode,
  which isn't painted. A `$` that isn't the first thing typed into an empty
  prompt is ordinary text and goes to Claude. Pasting `$cmd` into an empty
  prompt counts the same as typing it. Recalling a `$` command with ↑ runs it
  quietly again. A `$` typed while Claude works is queued and runs after the
  turn.

## Install

Any one of these:

```sh
# loaded by every new interactive session
git clone https://github.com/am-shb/cc-quiet-shell ~/.claude/skills/quiet-shell

# or, for one session
claude --plugin-dir /path/to/cc-quiet-shell
```

Or add it to the `env` block of `~/.claude/settings.json`:
`"CLAUDE_CODE_PLUGIN_DIRS": "/path/to/cc-quiet-shell"`.

Requires a bash or zsh shell, so macOS, Linux or WSL.

## How it works

| Hook | What it does |
|---|---|
| `prompt.edit` | Arms when `$` is typed or pasted into an empty prompt outside `!` mode, and paints it. Disarms if the `$` is deleted or text is put in front of it. |
| `prompt.submit` | Decides whether the prompt is a quiet command, and waits briefly for edits typed just before Enter. Runs the command with the same script the engine uses for `!` (see `shellScript` in `hooks/quiet.ts`), then sends `<bash-input>cmd</bash-input>` on in place of the prompt. A `.catch` drops a `$` prompt rather than letting a failure send it to Claude. |
| `session.append` | Adds the caveat and the output to that row, so it is stored and drawn as a `!` command's rows are. |
| `turn.start` | Aborts the turn the row starts, before its first request. |
| `ui.render` | Draws the waiting prompt as `!`'s running row and hides the spinner while a `$` command runs. Reads the footer hint to tell when `!` mode is on. |

The mod remembers up to 200 `$` commands in its plugin store, so a recalled
one runs quietly again. A recalled prompt that merely starts with `$` and was
never run quietly goes to Claude.

## Verification

- `claude plugin validate .`
- `claude plugin test .`: 45 tests, covering the arming rules, the submit
  decision, the row formats, and the hooks run through the engine's test kit.
- `tsc -p .`: type-checks the hooks and tests once Claude Code has loaded the
  mod, since loading writes `.claude-plugin/types/`.
- End to end, outside this repo: a real interactive Claude Code in tmux, with
  `ANTHROPIC_BASE_URL` pointed at a local stub that logs every request. Each
  command was run through `!` and through `$`, and the transcript files and
  colored screen captures were diffed.
