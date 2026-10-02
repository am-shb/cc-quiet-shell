// The pure half of the quiet shell prefix: when a typed `$` arms, which
// submissions run without Claude, and the rows a `!` command would store.
// Every format here copies what Claude Code 2.1.287 stores for a `!` command
// under `respondToBashCommands: false`, so a `$` row draws the same way.

/** The fields of a `prompt.edit` input read here: the draft before, and the splice. */
export type Edit = {
  text: string
  start: number
  end: number
  inputText: string
}

/** How a finished command came back from the shell. */
export type Ran = {
  /** Standard output and standard error, merged in the order they were written. */
  output: string
  /** The exit status; null when a signal ended the shell. */
  code: number | null
}

/** The note the engine puts before a `!` command it does not answer. */
export const CAVEAT =
  "<local-command-caveat>The command below was run directly in Claude Code, not sent to you as a request, and its output goes straight to the user. It's recorded here as context for later messages.</local-command-caveat>"

/** What a successful command with no output reads as. */
export const NO_OUTPUT = '(Bash completed with no output)'

/** The paint the armed `$` gets: shell mode's accent color. */
export const DOLLAR_PAINT = { start: 0, end: 1, color: 'bashBorder' } as const

/** Successful output past this many characters is saved to a file instead. */
export const DEFAULT_OUTPUT_LIMIT = 30000

/** How much of saved output the row previews. */
export const PREVIEW_CHARS = 2000

/** The most output saved to a file: what one `$.fs.write` takes. */
export const MAX_SAVED_BYTES = 4194304

/** The most output characters held while a command runs. */
export const MAX_KEPT_CHARS = 4194304

/** The footer's hint while the prompt is in `!` shell mode. */
const SHELL_MODE_HINT = /(?:^|\s)! for shell mode(?:\s|$)/

/** The placeholders a draft shows for pastes, which a submission carries expanded. */
const PASTE_PLACEHOLDER =
  /\[(?:Pasted text #\d+(?: \+\d+ lines)?|\.\.\.Truncated text #\d+ \+\d+ lines\.\.\.)\]/g

export function isShellModeHint(hint: string): boolean {
  return SHELL_MODE_HINT.test(hint)
}

/**
 * Whether the draft after `edit` holds an armed `$`: one typed or pasted into an
 * empty prompt outside `!` shell mode, with no edit since deleting it or putting
 * text in front of it. A `$` anywhere else is ordinary text.
 */
export function armedAfter(
  wasArmed: boolean,
  edit: Edit,
  after: string,
  isShellMode: boolean,
): boolean {
  if (isShellMode || !after.startsWith('$')) {
    return false
  }

  const touchesFront = edit.start === 0 && (edit.end > 0 || edit.inputText !== '')
  if (!touchesFront) {
    return wasArmed
  }

  return edit.text === '' && edit.inputText.startsWith('$')
}

/** Whether `submitted` is `draft` as typed, its paste placeholders expanded. */
export function isSameDraft(submitted: string, draft: string): boolean {
  if (submitted === draft) {
    return true
  }

  const parts = draft.split(PASTE_PLACEHOLDER)
  if (parts.length === 1) {
    return false
  }

  const pattern = parts.map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[\\s\\S]*')
  return new RegExp(`^${pattern}$`).test(submitted)
}

/**
 * Whether the edits relayed so far account for `text`: it is the draft they
 * built, or an armed draft with more typed after it than had been relayed by
 * the time Enter was pressed.
 */
export function isExplained(text: string, draft: string, isArmed: boolean): boolean {
  return isSameDraft(text, draft) || (isArmed && text.startsWith(draft))
}

/**
 * Whether a prompt the person sent runs quietly. When the edits account for
 * it, they decide; when something else put it in the box (history, a restored
 * draft), it runs quietly only if it ran quietly before.
 */
export function isQuiet(
  text: string,
  draft: string,
  isArmed: boolean,
  known: readonly string[],
): boolean {
  if (!text.startsWith('$')) {
    return false
  }

  return isExplained(text, draft, isArmed) ? isArmed : known.includes(text)
}

/** `known` with `text` as its newest entry, at most `limit` long. */
export function remember(known: readonly string[], text: string, limit: number): string[] {
  return [...known.filter(one => one !== text), text].slice(-limit)
}

/** The row a `!` command's input is stored as. */
export function inputRow(command: string): string {
  return `<bash-input>${command}</bash-input>`
}

export function escapeXml(text: string): string {
  return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
}

/** A word for a POSIX shell, single-quoted. */
export function quote(word: string): string {
  return `'${word.replaceAll("'", "'\\''")}'`
}

/** Whether `command` feeds itself a here-document, which the engine leaves standard input to. */
export function hasHeredoc(command: string): boolean {
  if (/\d\s*<<\s*\d/.test(command) || /\[\[\s*\d+\s*<<\s*\d+\s*\]\]/.test(command) || /\$\(\(.*<<.*\)\)/.test(command)) {
    return false
  }

  return /<<-?\s*(?:(['"]?)(\w+)\1|\\(\w+))/.test(command)
}

/**
 * The script the shell runs: the same steps the engine's Bash tool takes for a
 * `!` command (the shell snapshot, extglob off, no `unsetenv` alias, standard
 * input from /dev/null), with standard error merged into standard output.
 */
export function shellScript(shell: string, snapshot: string | undefined, command: string): string {
  const steps = snapshot === undefined ? [] : [`source ${quote(snapshot)} 2>/dev/null || true`]
  steps.push(
    /zsh/.test(shell)
      ? 'setopt NO_EXTENDED_GLOB NO_BARE_GLOB_QUAL 2>/dev/null || true'
      : 'shopt -u extglob 2>/dev/null || true',
    "{ \\builtin unalias -- 'unsetenv'; \\builtin unset -f -- 'unsetenv'; } >/dev/null 2>&1 || true",
    `eval ${quote(command)}${hasHeredoc(command) ? '' : ' < /dev/null'} 2>&1`,
  )

  return steps.join(' && ')
}

/** The shell config file the engine's snapshot sources: `~/.zshrc` or `~/.bashrc`. */
export function shellConfig(shell: string, home: string): string {
  return `${home.replace(/\/+$/, '')}/${/zsh/.test(shell) ? '.zshrc' : '.bashrc'}`
}

/**
 * The script that writes a shell snapshot to `file`, as the engine writes its
 * own on the first Bash use of a session: the person's shell config sourced,
 * then its shell options, functions and aliases dumped, then the session's
 * PATH. The engine's shims for its own tools (rg, find, grep, pkill) are left
 * out: they serve the model's commands, not a person's.
 */
export function snapshotScript(shell: string, file: string, config: string | undefined, path: string): string {
  const isZsh = /zsh/.test(shell)
  const dump = isZsh
    ? `
      echo "# Functions" >> "$SNAPSHOT_FILE"
      typeset -f > /dev/null 2>&1
      typeset +f | grep -vE '^_[^_]' | while read func; do
        typeset -f "$func" >> "$SNAPSHOT_FILE"
      done
      echo "# Shell Options" >> "$SNAPSHOT_FILE"
      setopt | sed 's/^/setopt /' | head -n 1000 >> "$SNAPSHOT_FILE"`
    : `
      echo "# Shopt" >> "$SNAPSHOT_FILE"
      shopt -p | head -n 1000 >> "$SNAPSHOT_FILE"
      echo "# Functions" >> "$SNAPSHOT_FILE"
      declare -f > /dev/null 2>&1
      declare -F | cut -d' ' -f3 | grep -vE '^_[^_]' | while read func; do
        printf 'eval %q > /dev/null 2>&1\\n' "$(declare -f "$func")" >> "$SNAPSHOT_FILE"
      done
      echo "# Shell Options" >> "$SNAPSHOT_FILE"
      set -o | grep "on" | awk '{print "set -o " $1}' | head -n 1000 >> "$SNAPSHOT_FILE"
      echo "shopt -s expand_aliases" >> "$SNAPSHOT_FILE"`
  const options = config !== undefined ? dump : isZsh ? '' : `echo "shopt -s expand_aliases" >> "$SNAPSHOT_FILE"`
  const aliases =
    config === undefined
      ? ''
      : `
      echo "# Aliases" >> "$SNAPSHOT_FILE"
      alias | sed 's/^alias //g' | sed 's/^/alias -- /' | head -n 1000 >> "$SNAPSHOT_FILE"`

  return `SNAPSHOT_FILE=${quote(file)}
      ${config === undefined ? '# No user config file to source' : `source ${quote(config)} < /dev/null`}
      echo "# Snapshot file" >| "$SNAPSHOT_FILE"
      echo "unalias -a 2>/dev/null || true" >> "$SNAPSHOT_FILE"
      ${options}
      ${aliases}
      printf '%s\\n' ${quote(`export PATH=${quote(path)}`)} >> "$SNAPSHOT_FILE"
      if [ ! -f "$SNAPSHOT_FILE" ]; then
        echo "Error: Snapshot file was not created at $SNAPSHOT_FILE" >&2
        exit 1
      fi
    `
}

/** Successful output as the Bash tool hands it on: no leading blank lines, no trailing space. */
export function trimOutput(output: string): string {
  return output.replace(/^(\s*\n)+/, '').trimEnd()
}

/** The `bashOutputMaxChars` setting as the engine applies it. */
export function outputLimit(setting: unknown): number {
  if (typeof setting !== 'number' || !Number.isInteger(setting) || setting <= 0) {
    return DEFAULT_OUTPUT_LIMIT
  }

  return Math.min(Math.max(setting, 4000), 128000)
}

/** A size as the engine prints one: `812 bytes`, `45.2KB`, `3MB`. */
export function formatSize(bytes: number): string {
  const kb = bytes / 1024
  if (kb < 1) {
    return `${bytes} bytes`
  }
  if (kb < 1024) {
    return `${kb.toFixed(1).replace(/\.0$/, '')}KB`
  }

  const mb = kb / 1024
  if (mb < 1024) {
    return `${mb.toFixed(1).replace(/\.0$/, '')}MB`
  }

  return `${(mb / 1024).toFixed(1).replace(/\.0$/, '')}GB`
}

/** The head of `text`, cut at a line break when one falls in its second half. */
export function preview(text: string, limit: number): { head: string; hasMore: boolean } {
  if (text.length <= limit) {
    return { head: text, hasMore: false }
  }

  const lastBreak = text.slice(0, limit).lastIndexOf('\n')
  return { head: text.slice(0, lastBreak > limit * 0.5 ? lastBreak : limit), hasMore: true }
}

/** The longest head of `text` that fits in `maxBytes` of UTF-8, and whether that is all of it. */
export function headBytes(text: string, maxBytes: number): { head: string; isCut: boolean } {
  if (text.length * 3 <= maxBytes) {
    return { head: text, isCut: false }
  }

  let bytes = 0
  let end = 0
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0
    bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4
    if (bytes > maxBytes) {
      return { head: text.slice(0, end), isCut: true }
    }
    end += char.length
  }

  return { head: text, isCut: false }
}

/**
 * The message that stands for output saved to `path`, as the engine words it:
 * `saved` is what the file holds, `shown` the whole output.
 */
export function persistedMessage(path: string, shown: string, saved: string): string {
  const { head, hasMore } = preview(saved, PREVIEW_CHARS)
  const what =
    saved.length < shown.length
      ? `Output exceeded the ${formatSize(MAX_SAVED_BYTES)} persist limit; only the first ${formatSize(MAX_SAVED_BYTES)} were saved to: ${path}\n\n`
      : `Output too large (${formatSize(shown.length)}). Full output saved to: ${path}\n\n`

  return `<persisted-output>\n${what}Preview (first ${formatSize(PREVIEW_CHARS)}):\n${head}${hasMore ? '\n...\n' : '\n'}</persisted-output>`
}

/** The output row of a command that exited 0, its stdout already shaped. */
export function stdoutRow(stdout: string): string {
  return `<bash-stdout>${stdout}</bash-stdout><bash-stderr></bash-stderr>`
}

/** The output row of a command that failed: the engine keeps its raw output as stderr. */
export function failureRow(output: string): string {
  return `<bash-stdout></bash-stdout><bash-stderr>${escapeXml(output)}</bash-stderr>`
}

/** The output row of a command the shell could not be started for. */
export function errorRow(message: string): string {
  return `<bash-stderr>Command failed: ${escapeXml(message)}</bash-stderr>`
}

/** `kept` with `piece` added, never past `MAX_KEPT_CHARS`. */
export function keep(kept: string, piece: string): string {
  if (kept.length >= MAX_KEPT_CHARS) {
    return kept
  }

  return (kept + piece).slice(0, MAX_KEPT_CHARS)
}
