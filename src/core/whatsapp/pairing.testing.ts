import { rm } from "node:fs/promises"
import { labelPaths, type LabelPaths } from "./labels"
import { pairDevice, type PairOptions, type PairResult } from "./pairing"
import { LABEL, doctor, shortTempDir } from "./sync.testing"
import {
  envelope,
  eventLine,
  failure,
  installFakeWacli,
  type FakeCall,
  type FakeResponse,
  type FakeWacli,
} from "./wacli.testing"

/** A made-up number, as the person types it and as it reaches wacli. */
export const PHONE = "+1 555-000-0000"
export const PHONE_DIGITS = "15550000000"

/** Made-up codes whose digit runs masking would destroy: they must reach the callbacks as they are. */
export const QR_PAYLOAD = "2@9876543210,Zm9vYmFy,YmF6cXV4,1"
export const PAIR_CODE = "12345678"

/** What `wacli doctor` answers for a label with no device paired. */
export const NOT_PAIRED = doctor({ authenticated: false, session_revoked: false })

/** What `wacli doctor` answers for a label whose session WhatsApp revoked. */
export const REVOKED = doctor({ authenticated: false, session_revoked: true })

/** The events of an `auth` that offers a QR code and a pairing code. */
export const CODE_EVENTS: NonNullable<FakeResponse["stderrLines"]> = [
  { line: eventLine("qr_code", { code: QR_PAYLOAD }) },
  { line: eventLine("pair_code", { phone: PHONE_DIGITS, code: PAIR_CODE }) },
]

/** An `auth` that offers the codes, pairs and runs its first sync. */
export const AUTH_OK: FakeResponse = {
  args: ["auth"],
  stderrLines: CODE_EVENTS,
  stdout: envelope({ authenticated: true, messages_stored: 12 }),
}

/** An `auth` that offers the codes and then fails with `text`. */
export function authFailing(text: string): FakeResponse {
  return { args: ["auth"], stderrLines: CODE_EVENTS, stderr: failure(text), exit: 1 }
}

/** An `auth` that offers the codes and then waits until it is stopped. */
export const AUTH_WAITING: FakeResponse = { args: ["auth"], stderrLines: CODE_EVENTS, hang: true }

/** A pairing test's surroundings: a state directory, a fake wacli, and what the callbacks received. */
export type PairingFixture = {
  fake: FakeWacli
  stateDir: string
  paths: LabelPaths
  qrCodes: string[]
  pairCodes: string[]
  /** Pairs `LABEL` with the fake, over `overrides`. */
  pair(overrides?: Partial<PairOptions>): Promise<PairResult>
  /** The fake's `auth` calls, in order. */
  authCalls(): Promise<FakeCall[]>
  cleanup(): Promise<void>
}

/** Sets up a pairing test; the fake answers `responses`. Call `cleanup` afterwards. */
export async function pairingFixture(responses: FakeResponse[]): Promise<PairingFixture> {
  const fake = await installFakeWacli()
  fake.setResponses(responses)
  const stateDir = await shortTempDir()
  const qrCodes: string[] = []
  const pairCodes: string[] = []
  return {
    fake,
    stateDir,
    paths: labelPaths(stateDir, LABEL),
    qrCodes,
    pairCodes,
    pair: (overrides = {}) =>
      pairDevice({
        stateDir,
        label: LABEL,
        env: fake.env,
        signal: new AbortController().signal,
        onQrCode: (code) => qrCodes.push(code),
        onPairCode: (code) => pairCodes.push(code),
        ...overrides,
      }),
    async authCalls() {
      return (await fake.calls()).filter((call) => call.argv.includes("auth"))
    },
    async cleanup() {
      await fake.cleanup()
      await rm(stateDir, { recursive: true, force: true })
    },
  }
}
