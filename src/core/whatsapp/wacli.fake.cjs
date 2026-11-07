#!/usr/bin/env node
/**
 * A stand-in for wacli in tests. `wacli.testing.ts` copies it into a temp directory as
 * `wacli`, next to a `fake.json` that says how to behave:
 * `{ "version": "0.26.0", "responses": [ { "args": ["doctor"], "stdout"?, "stderr"?, "exit"?, "sleepMs"?, "hang"?, "stderrLines"?, "exitAfterMs"?, "onTerm"?, "ignoreTerm"? } ], "default"?: { ... }, "mirror"?: { ... } }`
 *
 * A response matches when its `args` appear in order, as one run, among the arguments left after the
 * global flags are removed. The first match answers; then the optional `mirror` (`wacli.mirror.cjs` says how it
 * answers the reads of chats, messages, polls and calls, given in wacli's own JSON shapes); then `default`; else a
 * failure envelope.
 * `fake.json` is read on every call, so a test may change the answers between calls.
 * Every call is recorded in `calls.jsonl`: `{ argv, env: { WACLI_* }, cwd, pid }`.
 *
 * What a response does, from the moment it starts (after `sleepMs`):
 * - writes `stdout`, then `stderr`;
 * - writes each of `stderrLines` (`{ line, afterMs? }`) to stderr, as a line, `afterMs` after the start;
 * - with `exitAfterMs`, exits with `exit` (default 0) that long after the start, hanging or not;
 *   with `hang` and no `exitAfterMs`, waits until it is stopped; otherwise exits when its output is done.
 * On SIGTERM a response with `hang`, `onTerm` or `ignoreTerm` does as `onTerm` says: writes its `stderr`
 * and exits with its `exit` (0 by default). `ignoreTerm` ignores the signal instead.
 */
"use strict"

const fs = require("node:fs")
const path = require("node:path")

const dir = path.dirname(fs.realpathSync(__filename))
const config = JSON.parse(fs.readFileSync(path.join(dir, "fake.json"), "utf8"))

const argv = process.argv.slice(2)

/** Global flags that take a value. */
const VALUE_FLAGS = ["--store", "--timeout"]
/** Global flags that do not take a value. */
const BARE_FLAGS = ["--json", "--read-only", "--events"]

const args = []
for (let i = 0; i < argv.length; i++) {
  const arg = argv[i]
  if (VALUE_FLAGS.includes(arg)) i++
  else if (VALUE_FLAGS.some((flag) => arg.startsWith(`${flag}=`)) || BARE_FLAGS.includes(arg)) continue
  else args.push(arg)
}

const env = {}
for (const [name, value] of Object.entries(process.env)) if (name.startsWith("WACLI_")) env[name] = value
fs.appendFileSync(
  path.join(dir, "calls.jsonl"),
  `${JSON.stringify({ argv, env, cwd: process.cwd(), pid: process.pid })}\n`,
)

function containsRun(haystack, needle) {
  for (let start = 0; start + needle.length <= haystack.length; start++) {
    if (needle.every((item, offset) => haystack[start + offset] === item)) return true
  }
  return false
}

/** Exits once what was written has been flushed. */
function exitAfterFlush(code) {
  process.stderr.write("", () => process.stdout.write("", () => process.exit(code)))
}

function respond(response) {
  const onTerm = response.onTerm
  if (response.hang || onTerm || response.ignoreTerm) {
    process.on("SIGTERM", () => {
      if (response.ignoreTerm) return
      if (onTerm && onTerm.stderr) process.stderr.write(onTerm.stderr)
      exitAfterFlush(onTerm ? onTerm.exit : 0)
    })
  }
  const run = () => {
    if (response.stdout) process.stdout.write(response.stdout)
    if (response.stderr) process.stderr.write(response.stderr)
    for (const { line, afterMs } of response.stderrLines || []) {
      setTimeout(() => process.stderr.write(`${line}\n`), afterMs || 0)
    }
    process.exitCode = response.exit ?? 0
    if (response.exitAfterMs !== undefined) setTimeout(() => exitAfterFlush(process.exitCode), response.exitAfterMs)
    else if (response.hang) setInterval(() => {}, 1000)
  }
  if (response.sleepMs) setTimeout(run, response.sleepMs)
  else run()
}

if (args.length === 1 && args[0] === "version") {
  process.stdout.write(`${config.version}\n`)
} else {
  const found = (config.responses || []).find((response) => containsRun(args, response.args))
  const fromMirror = !found && config.mirror && require(path.join(dir, "wacli.mirror.cjs")).answer(args, config.mirror)
  respond(
    found ||
      fromMirror ||
      config.default || {
        stderr: `${JSON.stringify({ success: false, data: null, error: "unknown command" })}\n`,
        exit: 1,
      },
  )
}
