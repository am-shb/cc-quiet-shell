// The values quiet-shell keeps in `$.state` for the session.

/** The `$` prompt whose command is running, as it was sent; null while none runs. */
export type QuietShellRunning = string | null

declare module 'claude-code' {
  interface PluginState {
    'quiet-shell': {
      running: QuietShellRunning
    }
  }
}
