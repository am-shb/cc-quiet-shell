// The hooks through the engine: what reaches the model, what the session
// stores, and which turns end before their first request. The test's own
// hooks stand for the engine beneath the plugin.

import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On, PromptEditInput, PromptEditResult } from 'claude-code'

import { CAVEAT, DOLLAR_PAINT } from '../hooks/quiet'

type World = {
  /** The argv of every child spawned. */
  spawned: string[][]
  /** What each spawned child prints and how it exits. */
  child: { output: string; code: number }
  /** The prompts that reached the bottom of `prompt.submit`. */
  entered: string[]
  /** The turns aborted. */
  aborted: string[]
  /** The texts put in the prompt box. */
  filled: string[]
  /** The rows as the plugin passed them down to be stored. */
  stored: unknown[][]
}

/** Stands the engine beneath the plugin: a box, a session, a shell, a clock. */
function engine(on: On, known: string[] = [], hasClock = true): World {
  const world: World = {
    spawned: [],
    child: { output: 'a.txt\nb.txt\n', code: 0 },
    entered: [],
    aborted: [],
    filled: [],
    stored: [],
  }
  mock.env(on, { HOME: '/home/me', SHELL: '/bin/bash', PATH: '/usr/bin:/bin', TMPDIR: '/tmp' })
  mock.store(on, { known })
  on('prompt.edit', (_$, e) => ({
    text: e.text.slice(0, e.start) + e.inputText + e.text.slice(e.end),
    cursor: e.start + e.inputText.length,
  }))
  on('prompt.submit', (_$, e) => {
    world.entered.push(e.text)
    return { text: e.text }
  })
  on('prompt.fill', (_$, e) => {
    world.filled.push(e.text)
    return { isFilled: true }
  })
  // The store itself is the engine's; the test keeps what reached it.
  on('session.append', (_$, e, next) => {
    world.stored.push(e.message.content)
    return next(e)
  })
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  on('turn.abort', (_$, e) => {
    world.aborted.push(e.turnId)
    return { value: undefined }
  })
  on('ui.render', () => ({ type: 'engine', ref: 0 }))
  if (hasClock) {
    on('clock.sleep', () => ({ value: undefined }))
  }
  on('session.cwd', () => ({ value: '/work' }))
  on('session.id', () => ({ value: 'session-1' }))
  on('settings.read', () => ({ value: {} }))
  on('fs.list', () => ({ value: [] }))
  on('fs.exists', () => ({ value: false }))
  on('fs.write', () => ({ value: undefined }))
  on('process.run', () => ({
    value: { exitCode: 1, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
  }))
  on('process.spawn', async function* (_$, e) {
    world.spawned.push([...e.argv])
    if (world.child.output !== '') {
      yield { stream: 'stdout' as const, text: world.child.output }
    }
    return { value: { code: world.child.code, signal: null } }
  })

  return world
}

const composer = { kind: 'composer' } as const

/**
 * The person's edit, raised as the composer raises it. The test engine has
 * `$.prompt.edit`; this build's typings leave it off the test engine's noun.
 */
function typeInto($: unknown, e: PromptEditInput): Promise<PromptEditResult> {
  return ($ as { prompt: { edit: (e: PromptEditInput) => Promise<PromptEditResult> } }).prompt.edit(e)
}

/** The person typing `text` at `at` in a box holding `before`. */
function edit(before: string, at: number, text: string) {
  return { origin: composer, text: before, cursor: at, start: at, end: at, inputText: text }
}

function submitted(text: string, turnId?: string) {
  return { text, wait: false, origin: composer, ...(turnId === undefined ? {} : { turnId }) }
}

/** What `session.start` carries in a terminal session. */
const START = { cwd: '/work', surface: 'terminal', isInteractive: true } as const

/**
 * Appends `e` as the engine's transcript does. The store at the bottom is the
 * engine's own, which a test has none of, so only the chain above it runs.
 */
async function store($: Engine, e: ReturnType<typeof row>): Promise<void> {
  await $.session.append(e).catch(() => undefined)
}

function row(text: string) {
  return {
    message: { type: 'user' as const, role: 'user' as const, content: [{ type: 'text', text }] },
    door: 'command' as const,
    origin: composer,
    uuid: `row-${text.length}`,
  }
}

describe('the prompt box', () => {
  test('a $ typed into an empty prompt is painted in shell mode color', async ($, on) => {
    engine(on)
    const box = await typeInto($, { ...edit('', 0, '$'), key: { key: '$' } })
    expect(box.decorations).toContainEqual(DOLLAR_PAINT)
  })

  test('a $ typed in ! shell mode is left alone', async ($, on) => {
    engine(on)
    await $.ui.render({
      surface: 'terminal',
      component: 'PromptHint',
      requestId: 'hint',
      props: { isDraft: false, isWorking: false, hint: '! for shell mode' },
    })
    const box = await typeInto($, edit('', 0, '$'))
    expect(box.decorations ?? []).not.toContainEqual(DOLLAR_PAINT)
  })

  test('a $ put in front of typed text is left alone', async ($, on) => {
    engine(on)
    await typeInto($, edit('', 0, 'ls'))
    const box = await typeInto($, edit('ls', 0, '$'))
    expect(box.decorations ?? []).not.toContainEqual(DOLLAR_PAINT)
  })
})

describe('a $ command', () => {
  test('runs, is stored as a ! command is, and its turn ends before any request', async ($, on) => {
    const world = engine(on)
    await typeInto($, edit('', 0, '$'))
    await typeInto($, edit('$', 1, 'ls'))

    await $.prompt.submit(submitted('$ls'))
    expect(world.entered).toEqual(['<bash-input>ls</bash-input>'])
    expect(world.spawned).toHaveLength(1)
    expect(world.spawned[0]?.[0]).toBe('/bin/bash')
    expect(world.spawned[0]?.[2]).toEndWith("eval 'ls' < /dev/null 2>&1")

    await store($, row('<bash-input>ls</bash-input>'))
    expect(world.stored.at(-1)).toEqual([
      { type: 'text', text: CAVEAT },
      { type: 'text', text: '<bash-input>ls</bash-input>' },
      { type: 'text', text: '<bash-stdout>a.txt\nb.txt</bash-stdout><bash-stderr></bash-stderr>' },
    ])

    await $.turn.start({ text: '<bash-input>ls</bash-input>', turnId: 'quiet' })
    await $.turn.start({ text: 'hello', turnId: 'ordinary' })
    expect(world.aborted).toEqual(['quiet'])
  })

  test('that fails is stored with its output as stderr, as the engine stores it', async ($, on) => {
    const world = engine(on)
    world.child = { output: 'ls: cannot access nope\n', code: 2 }
    await typeInto($, edit('', 0, '$ls nope'))
    await $.prompt.submit(submitted('$ls nope'))

    await store($, row('<bash-input>ls nope</bash-input>'))
    expect(world.stored.at(-1)?.at(-1)).toEqual({
      type: 'text',
      text: '<bash-stdout></bash-stdout><bash-stderr>ls: cannot access nope\n</bash-stderr>',
    })
  })

  test('with no output says so, as the engine does', async ($, on) => {
    const world = engine(on)
    world.child = { output: '', code: 0 }
    await typeInto($, edit('', 0, '$true'))
    await $.prompt.submit(submitted('$true'))

    await store($, row('<bash-input>true</bash-input>'))
    expect(world.stored.at(-1)?.at(-1)).toEqual({
      type: 'text',
      text: '<bash-stdout>(Bash completed with no output)</bash-stdout><bash-stderr></bash-stderr>',
    })
  })

  test('typed while a turn runs waits for its row, and runs then', async ($, on) => {
    const world = engine(on)
    await typeInto($, edit('', 0, '$date'))
    await $.prompt.submit(submitted('$date', 'busy'))
    expect(world.entered).toEqual(['<bash-input>date</bash-input>'])
    expect(world.spawned).toHaveLength(0)

    await store($, row('<bash-input>date</bash-input>'))
    expect(world.spawned).toHaveLength(1)
    expect(world.stored.at(-1)).toHaveLength(3)
  })

  test('recalled from history runs quietly again', async ($, on) => {
    const world = engine(on, ['$pwd'])
    await $.session.start(START)
    await $.prompt.submit(submitted('$pwd'))
    expect(world.entered).toEqual(['<bash-input>pwd</bash-input>'])
  })

  test('with nothing after the $ is dropped, and the $ goes back in the box', async ($, on) => {
    const world = engine(on)
    await typeInto($, edit('', 0, '$'))
    const result = await $.prompt.submit(submitted('$'))
    expect(result.drop).toBeDefined()
    expect(world.entered).toEqual([])
    expect(world.filled).toEqual(['$'])
    expect(world.spawned).toHaveLength(0)
  })
})

describe('everything else', () => {
  test('an ordinary prompt reaches the model untouched', async ($, on) => {
    const world = engine(on)
    await typeInto($, edit('', 0, 'hello'))
    await $.prompt.submit(submitted('hello'))
    expect(world.entered).toEqual(['hello'])
    expect(world.spawned).toHaveLength(0)
  })

  test('a $ that was not typed into an empty prompt is ordinary text', async ($, on) => {
    const world = engine(on)
    await typeInto($, edit('', 0, 'ls'))
    await typeInto($, edit('ls', 0, '$'))
    await $.prompt.submit(submitted('$ls'))
    expect(world.entered).toEqual(['$ls'])
    expect(world.spawned).toHaveLength(0)
  })

  test('a $ backspaced away leaves an ordinary prompt', async ($, on) => {
    const world = engine(on)
    await typeInto($, edit('', 0, '$'))
    await typeInto($, { origin: composer, text: '$', cursor: 1, start: 0, end: 1, inputText: '' })
    await typeInto($, edit('', 0, 'ls'))
    await $.prompt.submit(submitted('ls'))
    expect(world.entered).toEqual(['ls'])
  })

  test('a $ prompt is dropped, never sent on, when the hook fails before handing it on', async ($, on) => {
    // No clock: the wait for late edits throws, and the hook fails there.
    const world = engine(on, ['$pwd'], false)
    await $.session.start(START)
    const result = await $.prompt.submit(submitted('$pwd'))
    expect(result.drop).toBeDefined()
    expect(world.entered).toEqual([])
  })

  test('a prompt from elsewhere than the person is never run', async ($, on) => {
    const world = engine(on, ['$ls'])
    await $.session.start(START)
    await $.prompt.submit({ text: '$ls', wait: false, origin: { kind: 'plugin', name: 'other' } })
    expect(world.entered).toEqual(['$ls'])
    expect(world.spawned).toHaveLength(0)
  })

  test('rows and turns of ordinary prompts pass untouched', async ($, on) => {
    const world = engine(on)
    await store($, row('hello'))
    expect(world.stored).toEqual([[{ type: 'text', text: 'hello' }]])
    await $.turn.start({ text: 'hello', turnId: 't' })
    expect(world.aborted).toEqual([])
  })
})
