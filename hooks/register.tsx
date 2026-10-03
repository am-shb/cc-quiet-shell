// A second shell prefix: `$` typed into an empty prompt runs the command the
// way `!` does, and stores the same rows, but no model turn follows it.
//
// The mod API has no way into the prompt's own shell mode (see README.md), so
// the `$` stays in the draft, painted in shell mode's color, and the submitted
// draft is turned into the rows a `!` command stores under
// `respondToBashCommands: false`; the turn that prompt would start is ended
// before its first request.

import { atom, read, update } from 'claude-code'
import type { EngineInterface, PromptEditResult, Register } from 'claude-code'

import {
  CAVEAT,
  DOLLAR_PAINT,
  MAX_SAVED_BYTES,
  NO_OUTPUT,
  armedAfter,
  errorRow,
  escapeXml,
  failureRow,
  headBytes,
  inputRow,
  isExplained,
  isQuiet,
  isShellModeHint,
  keep,
  outputLimit,
  persistedMessage,
  remember,
  shellConfig,
  shellScript,
  snapshotScript,
  stdoutRow,
  trimOutput,
} from './quiet'

/** How many `$` commands are remembered, so one recalled from history runs quietly again. */
const KNOWN_LIMIT = 200

/** The `$.store` key of those commands. */
const KNOWN_KEY = 'known'

/** How long a shell may take to write a snapshot, as the engine allows its own. */
const SNAPSHOT_TIMEOUT_MS = 10000

/** How long a submission waits for edits the composer relayed just before Enter. */
const EDIT_LAG_MS = 200

/** The prefix of a response row under a transcript row, as the engine draws it. */
const RESPONSE_PREFIX = '  ⎿  '

/** The `$` prompt whose command is running, as it was sent; null while none runs. */
const running = atom({ plugin: 'quiet-shell', key: 'running' } as const, null)

/** Snapshots this mod wrote this session, by shell, for when the engine has none yet. */
const ownSnapshots = new Map<string, string>()

export const register: Register = on => {
  /** The draft's leading `$` was typed or pasted into an empty prompt, outside `!` mode. */
  let isArmed = false
  /** The prompt box as of the last edit the composer relayed. */
  let draft = ''
  /** The prompt is in `!` shell mode, as the footer's hint says. */
  let isShellMode = false
  /** `$` commands run before, oldest first. */
  let known: string[] = []
  /** Output rows of `$` commands already run, by the text of the row they belong in. */
  const ran = new Map<string, string>()
  /** `$` commands queued behind a running turn, oldest first: each runs when its row is stored. */
  const queued: { row: string; command: string }[] = []
  /** The texts of turns to end before their first request. */
  const toEnd = new Set<string>()

  on('session.start', async ($, e, next) => {
    known = await readKnown($)
    await update($, running, () => null)

    return next(e)
  })

  on('ui.render', { component: 'PromptHint' }, ($, e, next) => {
    isShellMode = isShellModeHint(e.props.hint)

    return next(e)
  })

  // While a `$` command runs, the prompt waiting on it is drawn as a `!`
  // command is while it runs: its input row and `Running…`, no spinner.
  on('ui.render', { component: 'UserMessage', requestId: 'placeholder' }, async ($, e, next) => {
    const now = await read($, running)
    const isRunning = now === e.props.text || isQuiet(e.props.text, draft, isArmed, known)
    if (e.surface !== 'terminal' || !isRunning) {
      return next(e)
    }

    const { Box, Text } = $.ui.resolve(e)
    return (
      <Box flexDirection="column" marginTop={1}>
        <Box flexDirection="row" backgroundColor="bashMessageBackgroundColor" paddingRight={1}>
          <Text color="bashBorder">! </Text>
          <Text color="text">{e.props.text.slice(1)}</Text>
        </Box>
        <Box flexDirection="row" height={1}>
          <Text dimColor>{RESPONSE_PREFIX}</Text>
          <Text dimColor>Running…</Text>
        </Box>
      </Box>
    )
  })

  on('ui.render', { component: 'Spinner' }, async ($, e, next) => {
    if (e.surface !== 'terminal' || (await read($, running)) === null) {
      return next(e)
    }

    const { Box } = $.ui.resolve(e)
    return <Box />
  })

  on('prompt.edit', async ($, e, next) => {
    const box = await next(e)
    const wasArmed = e.text === draft ? isArmed : known.includes(e.text)
    isArmed = armedAfter(wasArmed, e, box.text, isShellMode)
    draft = box.text

    return isArmed ? painted(box) : box
  })

  on('prompt.submit', async ($, e, next) => {
    if (e.origin.kind !== 'composer') {
      return next(e)
    }

    // Edits typed just before Enter may still be on their way to `prompt.edit`.
    for (let waited = 0; e.text.startsWith('$') && !isExplained(e.text, draft, isArmed); waited += 10) {
      if (waited >= EDIT_LAG_MS) {
        break
      }
      await $.clock.sleep(10)
    }

    const isQuietCommand = isQuiet(e.text, draft, isArmed, known)
    isArmed = false
    draft = ''
    if (!isQuietCommand) {
      return next(e)
    }

    const command = e.text.slice(1)
    if (command.trim() === '') {
      // `!` ignores Enter on an empty shell prompt; a sent prompt cannot be
      // taken back, so the `$` goes back in the box and the prompt is dropped.
      if (await refill($, e.text)) {
        isArmed = true
        draft = e.text
      }

      return { drop: 'a $ with no command after it runs nothing' }
    }

    known = remember(known, e.text, KNOWN_LIMIT)
    void writeKnown($, known)
    const row = inputRow(command)
    if (e.turnId !== undefined) {
      // Typed while a turn runs: queued, it runs once its row is stored,
      // after that turn, as a queued `!` command does.
      queued.push({ row, command })

      return next({ ...e, text: row })
    }

    // Run here, inside the submission, so Esc stops it as it stops a `!`
    // command: the engine abandons this dispatch, and the child with it. Like
    // an interrupted `!` command, it goes back in the box.
    const output = await runShown($, command, e.text)
    if (next.signal.aborted) {
      if (await refill($, e.text)) {
        isArmed = true
        draft = e.text
      }

      return { drop: 'interrupted' }
    }

    ran.set(row, output)
    return next({ ...e, text: row })
  }).catch(($, e, next) => {
    // The engine sends the prompt on unchanged for a hook that failed; for a
    // `$` prompt not yet handed on, that would put a command in front of the
    // model, so it is dropped instead.
    if (next.called || e.origin.kind !== 'composer' || !e.text.startsWith('$')) {
      return next(e)
    }

    return { drop: 'quiet-shell failed before it could run this command' }
  })

  on('session.append', async ($, e, next) => {
    const block = e.message.content.length === 1 ? e.message.content[0] : undefined
    const text = block?.type === 'text' ? block.text : undefined
    const row =
      e.message.type === 'user' && e.origin.kind === 'composer' && typeof text === 'string'
        ? text
        : undefined
    const done = row === undefined ? undefined : ran.get(row)
    const waiting = done === undefined ? queued.findIndex(one => one.row === row) : -1
    if (row === undefined || (done === undefined && waiting === -1)) {
      return next(e)
    }

    ran.delete(row)
    const command = waiting === -1 ? undefined : queued.splice(waiting, 1)[0]?.command
    // Marked before anything that can fail: the turn this row starts is
    // ended whatever the run comes to.
    toEnd.add(row)
    const output = done ?? (await runShown($, command ?? '', `$${command}`))
    const content = [
      { type: 'text' as const, text: CAVEAT },
      ...e.message.content,
      { type: 'text' as const, text: output },
    ]

    return next({ ...e, message: { ...e.message, content } })
  })

  on('turn.start', async ($, e, next) => {
    if (!toEnd.delete(e.text)) {
      if ((await read($, running)) !== null) {
        await update($, running, () => null)
      }

      return next(e)
    }

    const started = next(e)
    try {
      await $.turn.abort({ turnId: e.turnId })
    } catch {
      await started
      await $.turn.abort({ turnId: e.turnId })
    }

    return started
  })
}

function painted(box: PromptEditResult): PromptEditResult {
  return { ...box, decorations: [...(box.decorations ?? []), DOLLAR_PAINT] }
}

async function readKnown($: EngineInterface): Promise<string[]> {
  const stored = await $.store.get(KNOWN_KEY)

  return Array.isArray(stored) ? stored.filter(one => typeof one === 'string') : []
}

async function writeKnown($: EngineInterface, list: string[]): Promise<void> {
  try {
    await $.store.set(KNOWN_KEY, list)
  } catch {
    // Remembering is a convenience for history recall; the command still runs.
  }
}

/** Puts `text` back in the emptied prompt box with its `$` painted; whether it took. */
async function refill($: EngineInterface, text: string): Promise<boolean> {
  try {
    const { isFilled } = await $.prompt.fill({ text, decorations: [DOLLAR_PAINT] })

    return isFilled
  } catch {
    return false
  }
}

/** `run`, with the prompt `sent` drawn as running meanwhile. */
async function runShown($: EngineInterface, command: string, sent: string): Promise<string> {
  await update($, running, () => sent)
  try {
    return await run($, command)
  } finally {
    await update($, running, () => null)
  }
}

/**
 * Runs `command` as a `!` command runs, and answers the row its output is
 * stored as. Standard input is a pipe, as the engine's is: bash reads
 * `~/.bashrc` on its own when standard input is a socket.
 */
async function run($: EngineInterface, command: string): Promise<string> {
  try {
    const shell = await shellPath($)
    const snapshot = (await engineSnapshot($, shell)) ?? (await ownSnapshot($, shell))
    const child = $.process.spawn({
      argv: [shell, '-c', shellScript(shell, snapshot, command)],
      cwd: await $.session.cwd(),
      input: '',
    })
    let output = ''
    for await (const piece of child) {
      output = keep(output, piece.text)
    }

    const { code } = await child.result
    return code === 0 ? await successRow($, output) : failureRow(output)
  } catch (error) {
    return errorRow(error instanceof Error ? error.message : String(error))
  }
}

/** The output row of a command that exited 0, its output saved to a file when it is long. */
async function successRow($: EngineInterface, output: string): Promise<string> {
  const shown = trimOutput(output) || NO_OUTPUT
  const settings = await $.settings.read()
  if (shown.length <= outputLimit(settings.bashOutputMaxChars)) {
    return stdoutRow(escapeXml(shown))
  }

  const { head } = headBytes(shown, MAX_SAVED_BYTES)
  const path = `${await sessionFolder($)}/${crypto.randomUUID()}.txt`
  await $.fs.write(path, head)

  return stdoutRow(persistedMessage(path, shown, head))
}

/** This session's folder for files the mod writes, under the system's temporary directory. */
async function sessionFolder($: EngineInterface): Promise<string> {
  const tmp = ((await $.env.get('TMPDIR')) ?? '/tmp').replace(/\/+$/, '')

  return `${tmp}/claude-quiet-shell/${await $.session.id()}`
}

/** The shell `!` commands run in: `CLAUDE_CODE_SHELL`, else `SHELL`, when bash or zsh. */
async function shellPath($: EngineInterface): Promise<string> {
  const override = await $.env.get('CLAUDE_CODE_SHELL')
  if (override !== undefined && /bash|zsh/.test(override)) {
    return override
  }

  const login = await $.env.get('SHELL')
  if (login !== undefined && /bash|zsh/.test(login)) {
    return login
  }

  return '/bin/bash'
}

/**
 * The newest shell snapshot Claude Code took for `shell`: the options, functions
 * and aliases of the person's shell config, which `!` commands run under. The
 * engine takes one on a session's first Bash use and deletes it at exit.
 */
async function engineSnapshot($: EngineInterface, shell: string): Promise<string | undefined> {
  const home = (await $.env.get('HOME')) ?? ''
  const config = (await $.env.get('CLAUDE_CONFIG_DIR')) ?? `${home}/.claude`
  const folder = `${config.replace(/\/+$/, '')}/shell-snapshots`
  const prefix = `snapshot-${/zsh/.test(shell) ? 'zsh' : 'bash'}-`
  try {
    const newest = (await $.fs.list(folder))
      .filter(entry => entry.kind === 'file' && entry.name.startsWith(prefix) && entry.name.endsWith('.sh'))
      .sort((a, b) => b.mtimeMs - a.mtimeMs)[0]

    return newest === undefined ? undefined : `${folder}/${newest.name}`
  } catch {
    return undefined
  }
}

/**
 * A snapshot of the same kind, written by this mod when a `$` command comes
 * before the session's first Bash use; taken once per session and shell.
 */
async function ownSnapshot($: EngineInterface, shell: string): Promise<string | undefined> {
  const made = ownSnapshots.get(shell)
  if (made !== undefined && (await $.fs.exists(made))) {
    return made
  }

  try {
    const home = (await $.env.get('HOME')) ?? ''
    const config = shellConfig(shell, home)
    const file = `${await sessionFolder($)}/snapshot-${/zsh/.test(shell) ? 'zsh' : 'bash'}.sh`
    await $.fs.write(file, '')
    const script = snapshotScript(
      shell,
      file,
      (await $.fs.exists(config)) ? config : undefined,
      (await $.env.get('PATH')) ?? '',
    )
    const { exitCode } = await $.process.run([shell, '-c', '-l', script], {
      env: { SHELL: shell, GIT_EDITOR: 'true', CLAUDECODE: '1' },
      timeoutMs: SNAPSHOT_TIMEOUT_MS,
    })
    if (exitCode !== 0) {
      return undefined
    }

    ownSnapshots.set(shell, file)
    return file
  } catch {
    return undefined
  }
}
