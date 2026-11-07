import { renderANSI } from "uqr"
import { DEFAULT_LABEL, checkLabel } from "../core/whatsapp/labels"
import { normalizePhone, pairDevice } from "../core/whatsapp/pairing"
import { PROJECT } from "../project"
import { handleCommandError, parseCommandStateDir, parseFlagArgs } from "./command-args"
import { EXIT_OK, type CommandIo } from "./command-io"

const SCAN_INSTRUCTION = "On your phone, open WhatsApp > Linked devices > Link a device, and scan this code:"
const RENEWED_INSTRUCTION = "WhatsApp renewed the code; scan this one instead:"
const PAIR_CODE_INSTRUCTION =
  "On your phone, open WhatsApp > Linked devices > Link a device > Link with phone number instead, and enter this code:"
const WAIT_NOTE =
  "Keep this window open: after the scan, the first sync runs for a short while before this command finishes."

/** Light modules around the code, which a scanner needs; uqr's ANSI renderer paints them white on any theme. */
const QR_BORDER = 2

const VALUE_FLAGS = ["--account", "--phone"] as const

type PairCommand = {
  label: string
  /** The phone's digits, when the person pairs with a code typed on the phone. */
  phone?: string
  stateDir: string
}

/** Reads the command line: the flags of `pair` itself, and the settings flags, of which only the state directory is taken. */
function parsePair(argv: string[], io: CommandIo): PairCommand {
  const { values, rest } = parseFlagArgs(argv, { values: VALUE_FLAGS })
  const phone = values["--phone"]
  return {
    label: checkLabel(values["--account"] ?? DEFAULT_LABEL),
    ...(phone === undefined ? {} : { phone: normalizePhone(phone) }),
    stateDir: parseCommandStateDir(rest, io),
  }
}

function endWithLineBreak(text: string): string {
  return text.endsWith("\n") ? text : `${text}\n`
}

function messageCount(count: number): string {
  return `${count} ${count === 1 ? "message" : "messages"}`
}

/**
 * The `pair` command: pairs this machine as a linked device of the person's
 * phone under a label (`--account`, `default` without it). It draws the QR
 * code to scan in the terminal, or with `--phone` prints the code to type on
 * the phone, and waits for the pairing and the first sync. Resolves to the
 * exit code.
 */
export async function runPair(argv: string[], io: CommandIo): Promise<number> {
  let command: PairCommand
  try {
    command = parsePair(argv, io)
  } catch (error) {
    return handleCommandError(error, io, { mode: "usage" })
  }

  let lastQrCode: string | undefined
  let lastPairCode: string | undefined
  try {
    const result = await pairDevice({
      stateDir: command.stateDir,
      label: command.label,
      env: io.env,
      phone: command.phone,
      signal: io.signal ?? new AbortController().signal,
      onQrCode(code) {
        if (code === lastQrCode) return
        const instruction = lastQrCode === undefined ? SCAN_INSTRUCTION : RENEWED_INSTRUCTION
        io.stdout(`${instruction}\n\n${endWithLineBreak(renderANSI(code, { border: QR_BORDER }))}`)
        if (lastQrCode === undefined) io.stdout(`\n${WAIT_NOTE}\n`)
        lastQrCode = code
      },
      onPairCode(code) {
        if (code === lastPairCode) return
        io.stdout(`${PAIR_CODE_INSTRUCTION}\n\n  ${code}\n\n${WAIT_NOTE}\n`)
        lastPairCode = code
      },
    })
    io.stdout(`\nPaired "${command.label}".\n`)
    if (result.messagesStored !== null) io.stdout(`${messageCount(result.messagesStored)} arrived while pairing.\n`)
    io.stdout(`Start receiving with: ${PROJECT.cli} service install --account ${command.label}\n`)
    return EXIT_OK
  } catch (error) {
    return handleCommandError(error, io, { abortMessage: "Pairing was cancelled." })
  }
}
