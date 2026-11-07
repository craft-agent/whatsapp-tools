import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { rm } from "node:fs/promises"
import { join } from "node:path"
import { acquireServiceLock, isServiceRunning, readServicePid } from "./service-lock"
import { shortTempDir, startIdleProcess } from "./sync.testing"
import { pathsIn } from "./wacli.testing"

let dir: string
let path: string
const paths = () => ({ ...pathsIn(dir), serviceLock: path })

beforeEach(async () => {
  dir = await shortTempDir()
  path = join(dir, "service.lock")
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

/** A process id that belonged to a process which is gone. */
async function deadPid(): Promise<number> {
  const child = await startIdleProcess()
  const gone = new Promise((resolve) => child.once("exit", resolve))
  child.kill("SIGKILL")
  await gone
  return child.pid
}

describe("acquireServiceLock", () => {
  test("creates the lock with this process's id, readable by the owner only", () => {
    const release = acquireServiceLock(path)
    expect(release).toBeDefined()
    expect(readFileSync(path, "utf8").trim()).toBe(String(process.pid))
    expect(statSync(path).mode & 0o777).toBe(0o600)
    release!()
  })

  test("release removes the lock", () => {
    acquireServiceLock(path)!()
    expect(existsSync(path)).toBe(false)
  })

  test("is refused while another live process holds the lock, and leaves it alone", async () => {
    const holder = await startIdleProcess()
    try {
      writeFileSync(path, `${holder.pid}\n`)
      expect(acquireServiceLock(path)).toBeUndefined()
      expect(readFileSync(path, "utf8").trim()).toBe(String(holder.pid))
    } finally {
      holder.kill("SIGKILL")
    }
  })

  test("takes over a lock whose process is gone", async () => {
    writeFileSync(path, `${await deadPid()}\n`)
    const release = acquireServiceLock(path)
    expect(release).toBeDefined()
    expect(readFileSync(path, "utf8").trim()).toBe(String(process.pid))
    release!()
  })

  test("takes over a lock that holds no process id", () => {
    writeFileSync(path, "not a pid")
    const release = acquireServiceLock(path)
    expect(release).toBeDefined()
    release!()
    writeFileSync(path, "")
    acquireServiceLock(path)!()
    expect(existsSync(path)).toBe(false)
  })

  test("a release never removes a lock another process took", async () => {
    const release = acquireServiceLock(path)!
    const other = await startIdleProcess()
    try {
      writeFileSync(path, `${other.pid}\n`)
      release()
      expect(readFileSync(path, "utf8").trim()).toBe(String(other.pid))
    } finally {
      other.kill("SIGKILL")
    }
  })

  test("fails when the lock cannot be created", () => {
    expect(() => acquireServiceLock(join(dir, "missing", "service.lock"))).toThrow()
  })
})

describe("readServicePid and isServiceRunning", () => {
  test("report no service without a lock", () => {
    expect(readServicePid(paths())).toBeUndefined()
    expect(isServiceRunning(paths())).toBe(false)
  })

  test("report the live process that holds the lock", async () => {
    const holder = await startIdleProcess()
    try {
      writeFileSync(path, `${holder.pid}\n`)
      expect(readServicePid(paths())).toBe(holder.pid)
      expect(isServiceRunning(paths())).toBe(true)
    } finally {
      holder.kill("SIGKILL")
    }
  })

  test("report no service for a stale or unreadable lock, and leave the file", async () => {
    writeFileSync(path, `${await deadPid()}\n`)
    expect(isServiceRunning(paths())).toBe(false)
    writeFileSync(path, "garbage")
    expect(readServicePid(paths())).toBeUndefined()
    expect(existsSync(path)).toBe(true)
  })
})
