// The pure half: arming, the submit decision, and rows shaped as the engine
// shapes a `!` command's.

import { describe, expect, test } from 'claude-code/testing'

import {
  CAVEAT,
  armedAfter,
  errorRow,
  escapeXml,
  failureRow,
  formatSize,
  hasHeredoc,
  headBytes,
  inputRow,
  isQuiet,
  isSameDraft,
  isShellModeHint,
  outputLimit,
  persistedMessage,
  preview,
  quote,
  remember,
  shellScript,
  snapshotScript,
  stdoutRow,
  trimOutput,
} from '../hooks/quiet'

const typed = (text: string, start: number, end: number, inputText: string) => ({
  text,
  start,
  end,
  inputText,
})

describe('arming', () => {
  test('a $ typed into an empty prompt arms', () => {
    expect(armedAfter(false, typed('', 0, 0, '$'), '$', false)).toBe(true)
  })

  test('a pasted $command into an empty prompt arms', () => {
    expect(armedAfter(false, typed('', 0, 0, '$git status'), '$git status', false)).toBe(true)
  })

  test('typing after the $ keeps it armed', () => {
    expect(armedAfter(true, typed('$', 1, 1, 'ls'), '$ls', false)).toBe(true)
  })

  test('a cursor move to the front changes nothing', () => {
    expect(armedAfter(true, typed('$ls', 0, 0, ''), '$ls', false)).toBe(true)
  })

  test('backspacing the $ disarms', () => {
    expect(armedAfter(true, typed('$', 0, 1, ''), '', false)).toBe(false)
  })

  test('text put in front of the $ disarms', () => {
    expect(armedAfter(true, typed('$ls', 0, 0, 'x'), 'x$ls', false)).toBe(false)
  })

  test('a $ typed in front of other text is ordinary', () => {
    expect(armedAfter(false, typed('ls', 0, 0, '$'), '$ls', false)).toBe(false)
  })

  test('a $ typed anywhere but the start is ordinary', () => {
    expect(armedAfter(false, typed('echo ', 5, 5, '$'), 'echo $', false)).toBe(false)
  })

  test('nothing arms in ! shell mode', () => {
    expect(armedAfter(false, typed('', 0, 0, '$'), '$', true)).toBe(false)
  })

  test('shell mode is read off the footer hint', () => {
    expect(isShellModeHint('! for shell mode')).toBe(true)
    expect(isShellModeHint('(shift+tab to cycle) · ← for agents')).toBe(false)
  })
})

describe('the submit decision', () => {
  test('the draft the edits built decides', () => {
    expect(isQuiet('$ls', '$ls', true, [])).toBe(true)
    expect(isQuiet('$ls', '$ls', false, ['$ls'])).toBe(false)
  })

  test('a draft something else put in the box runs quietly only when it did before', () => {
    expect(isQuiet('$ls', '', false, ['$ls'])).toBe(true)
    expect(isQuiet('$PATH is wrong, why?', '', false, ['$ls'])).toBe(false)
  })

  test('an armed draft runs quietly with more typed than had been relayed by Enter', () => {
    expect(isQuiet('$echo first', '$', true, [])).toBe(true)
    expect(isQuiet('$x more', '$x', false, [])).toBe(false)
  })

  test('a prompt without a leading $ is never quiet', () => {
    expect(isQuiet('ls', 'ls', true, ['ls'])).toBe(false)
  })

  test('pasted text expanded at submit still matches its draft', () => {
    const draft = '$cat <<EOF\n[Pasted text #1 +3 lines]\nEOF'
    expect(isSameDraft('$cat <<EOF\na\nb\nc\nd\nEOF', draft)).toBe(true)
    expect(isSameDraft('$rm -rf x', draft)).toBe(false)
  })

  test('remembering keeps the newest last, once, within the limit', () => {
    expect(remember(['$a', '$b'], '$a', 10)).toEqual(['$b', '$a'])
    expect(remember(['$a', '$b', '$c'], '$d', 2)).toEqual(['$c', '$d'])
  })
})

describe('the shell script', () => {
  test('bash: snapshot, extglob off, unsetenv dropped, eval from /dev/null, stderr merged', () => {
    expect(shellScript('/bin/bash', '/snap/s.sh', 'ls -la')).toBe(
      "source '/snap/s.sh' 2>/dev/null || true && shopt -u extglob 2>/dev/null || true && " +
        "{ \\builtin unalias -- 'unsetenv'; \\builtin unset -f -- 'unsetenv'; } >/dev/null 2>&1 || true && " +
        "eval 'ls -la' < /dev/null 2>&1",
    )
  })

  test('zsh turns its own globbing options off', () => {
    expect(shellScript('/bin/zsh', undefined, 'ls')).toStartWith(
      'setopt NO_EXTENDED_GLOB NO_BARE_GLOB_QUAL 2>/dev/null || true && ',
    )
  })

  test('a here-document keeps standard input', () => {
    expect(hasHeredoc('cat <<EOF\nhi\nEOF')).toBe(true)
    expect(hasHeredoc("cat <<-'END'")).toBe(true)
    expect(hasHeredoc('echo $((1 << 2))')).toBe(false)
    expect(shellScript('/bin/bash', undefined, 'cat <<EOF\nhi\nEOF')).toEndWith("eval 'cat <<EOF\nhi\nEOF' 2>&1")
  })

  test('single quotes survive quoting', () => {
    expect(quote("it's")).toBe("'it'\\''s'")
  })

  test('the snapshot script sources the config, dumps, and pins PATH', () => {
    const script = snapshotScript('/bin/bash', '/tmp/s.sh', '/home/me/.bashrc', '/usr/bin:/bin')
    expect(script).toContain("SNAPSHOT_FILE='/tmp/s.sh'")
    expect(script).toContain("source '/home/me/.bashrc' < /dev/null")
    expect(script).toContain('declare -F')
    expect(script).toContain('shopt -s expand_aliases')
    expect(script).toContain("export PATH='\\''/usr/bin:/bin'\\''")
    expect(snapshotScript('/bin/zsh', '/tmp/s.sh', undefined, '/bin')).not.toContain('source ')
  })
})

describe('rows as the engine stores them', () => {
  test('the input row', () => {
    expect(inputRow('ls -la')).toBe('<bash-input>ls -la</bash-input>')
  })

  test('the caveat is the engine sentence', () => {
    expect(CAVEAT).toStartWith('<local-command-caveat>The command below was run directly in Claude Code')
  })

  test('successful output loses leading blank lines and trailing space only', () => {
    expect(trimOutput('\n\n  lead  \n\n')).toBe('  lead')
    expect(trimOutput('x\ty\r\nz')).toBe('x\ty\r\nz')
  })

  test('rows escape what they carry', () => {
    expect(escapeXml('<b>&</b>')).toBe('&lt;b&gt;&amp;&lt;/b&gt;')
    expect(stdoutRow('hi')).toBe('<bash-stdout>hi</bash-stdout><bash-stderr></bash-stderr>')
    expect(failureRow('out\nerr\n')).toBe('<bash-stdout></bash-stdout><bash-stderr>out\nerr\n</bash-stderr>')
    expect(errorRow('no shell')).toBe('<bash-stderr>Command failed: no shell</bash-stderr>')
  })

  test('bashOutputMaxChars applies as the engine clamps it', () => {
    expect(outputLimit(undefined)).toBe(30000)
    expect(outputLimit(100)).toBe(4000)
    expect(outputLimit(50000)).toBe(50000)
    expect(outputLimit(999999)).toBe(128000)
  })

  test('sizes print as the engine prints them', () => {
    expect(formatSize(812)).toBe('812 bytes')
    expect(formatSize(2000)).toBe('2KB')
    expect(formatSize(43892)).toBe('42.9KB')
    expect(formatSize(4194304)).toBe('4MB')
  })

  test('a preview ends at a line break in its second half', () => {
    expect(preview('aaaaa\nbbbbbb', 8)).toEqual({ head: 'aaaaa', hasMore: true })
    expect(preview('aaaa\nbbbbbb', 8)).toEqual({ head: 'aaaa\nbbb', hasMore: true })
    expect(preview('a\nbbbbbbbbbb', 8)).toEqual({ head: 'a\nbbbbbb', hasMore: true })
    expect(preview('short', 8)).toEqual({ head: 'short', hasMore: false })
  })

  test('saving cuts on a character, by UTF-8 bytes', () => {
    expect(headBytes('éééé', 5)).toEqual({ head: 'éé', isCut: true })
    expect(headBytes('abc', 9)).toEqual({ head: 'abc', isCut: false })
  })

  test('saved output stands as the engine words it', () => {
    const shown = 'line\n'.repeat(1000).trimEnd()
    const message = persistedMessage('/tmp/x.txt', shown, shown)
    expect(message).toStartWith(
      '<persisted-output>\nOutput too large (4.9KB). Full output saved to: /tmp/x.txt\n\nPreview (first 2KB):\nline\n',
    )
    expect(message).toEndWith('\n...\n</persisted-output>')
    expect(persistedMessage('/tmp/x.txt', shown, shown.slice(0, 10))).toContain(
      'Output exceeded the 4MB persist limit; only the first 4MB were saved to: /tmp/x.txt',
    )
  })
})
