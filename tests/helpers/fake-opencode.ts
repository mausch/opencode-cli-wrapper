import { EventEmitter } from "node:events"
import { PassThrough } from "node:stream"

export const FIXTURE_MODELS_STDOUT: string = `opencode/claude-opus-5
opencode/mimo-v2.6-flash-free
opencode/space-bunny-free
opencode-go/glm-5.1
opencode-go/space-bunny-free
openai/gpt-4.1
malformed-model-line

`

export const FREE_FIXTURE_IDS: string[] = [
  "opencode/mimo-v2.6-flash-free",
  "opencode/space-bunny-free",
  "opencode-go/space-bunny-free",
]

interface SpawnStubOptions {
  readonly exitCode?: number
  readonly error?: Error
}

class SpawnStubProcess extends EventEmitter {
  readonly stdout: PassThrough
  readonly stderr: PassThrough

  constructor() {
    super()
    this.stdout = new PassThrough()
    this.stderr = new PassThrough()
  }

  kill(): boolean {
    return true
  }
}

/*
 * Vitest usage (keep this mock factory limited to the helper call):
 * vi.mock("node:child_process", () => ({ spawn: stubSpawn(FIXTURE_MODELS_STDOUT) }))
 *
 * The returned spawn function emits stdout and completion asynchronously, like
 * the real child process, and can instead emit an error with the optional opts.
 */
export function stubSpawn(
  stdout: string,
  opts: SpawnStubOptions = {},
): (command: string, args?: readonly string[], options?: object) => SpawnStubProcess {
  return (_command, _args, _options) => {
    const child = new SpawnStubProcess()

    queueMicrotask(() => {
      if (opts.error) {
        child.emit("error", opts.error)
        return
      }

      child.stdout.end(stdout)
      child.stderr.end()
      child.emit("close", opts.exitCode ?? 0, null)
    })

    return child
  }
}
