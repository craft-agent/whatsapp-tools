#!/usr/bin/env node
/**
 * A stand-in for wacli in tests. `wacli.testing.ts` copies it into a temp directory as
 * `wacli`, next to a `fake.json` that says how to behave:
 * `{ "version": "0.26.0", "responses": [ { "args": ["doctor"], "stdout"?, "stderr"?, "exit"?, "sleepMs"?, "hang"? } ], "default"?: { ... } }`
 *
 * A response matches when its `args` appear in order, as one run, among the arguments left after the
 * global flags are removed. The first match answers; then `default`; else a failure envelope.
 * Every call is recorded in `calls.jsonl`: `{ argv, env: { WACLI_* }, cwd }`.
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
fs.appendFileSync(path.join(dir, "calls.jsonl"), `${JSON.stringify({ argv, env, cwd: process.cwd() })}\n`)

function containsRun(haystack, needle) {
  for (let start = 0; start + needle.length <= haystack.length; start++) {
    if (needle.every((item, offset) => haystack[start + offset] === item)) return true
  }
  return false
}

function respond(response) {
  if (response.hang) process.on("SIGTERM", () => process.exit(0))
  const run = () => {
    if (response.stdout) process.stdout.write(response.stdout)
    if (response.stderr) process.stderr.write(response.stderr)
    process.exitCode = response.exit ?? 0
    if (response.hang) setInterval(() => {}, 1000)
  }
  if (response.sleepMs) setTimeout(run, response.sleepMs)
  else run()
}

if (args.length === 1 && args[0] === "version") {
  process.stdout.write(`${config.version}\n`)
} else {
  const found = (config.responses || []).find((response) => containsRun(args, response.args))
  respond(
    found ||
      config.default || {
        stderr: `${JSON.stringify({ success: false, data: null, error: "unknown command" })}\n`,
        exit: 1,
      },
  )
}
