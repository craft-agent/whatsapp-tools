import { describe, expect, test } from "bun:test"
import { isDeniedFolder, isDeniedName } from "./deny-lists"

describe("isDeniedFolder", () => {
  test.each([
    ".ssh",
    ".SSH",
    ".Gnupg",
    ".gpg",
    ".aws",
    ".azure",
    ".gcloud",
    ".kube",
    ".docker",
    ".config",
    ".git",
    ".hg",
    ".svn",
  ])("denies %s", (folder) => {
    expect(isDeniedFolder(folder)).toBe(true)
  })

  test.each([
    ".password-store",
    ".backups",
    ".mozilla",
    ".Thunderbird",
    ".zsh_sessions",
    ".pki",
    ".m2",
    ".gradle",
    ".oci",
    "keyrings",
    "keychains",
    "Keychains",
    "KEYCHAINS",
    ".terraform.d",
    ".vault-token",
  ])("denies %s", (folder) => {
    expect(isDeniedFolder(folder)).toBe(true)
  })

  test("reads a name as a Windows file system does: trailing dots and spaces dropped", () => {
    expect(isDeniedFolder(".ssh.")).toBe(true)
    expect(isDeniedFolder(".ssh. . ")).toBe(true)
  })

  test("reads a name in NFC", () => {
    expect(isDeniedFolder("keychains".normalize("NFD"))).toBe(true)
  })

  test.each([
    "ssh",
    "git",
    "config",
    "configs",
    ".gitignore",
    "my.config",
    "keychain",
    "src",
    "",
    ".registry",
    ".cargo",
    ".gem",
  ])("allows %p", (folder) => {
    expect(isDeniedFolder(folder)).toBe(false)
  })
})

describe("isDeniedName", () => {
  test("is case-insensitive and drops trailing dots and spaces", () => {
    expect(isDeniedName(".ENV")).toBe(true)
    expect(isDeniedName(".env. ")).toBe(true)
    expect(isDeniedName("Server.PEM.")).toBe(true)
  })

  test("matches a whole name, not part of a longer word", () => {
    expect(isDeniedName(".envrc")).toBe(true)
    expect(isDeniedName("id_rsa_old")).toBe(true)
    expect(isDeniedName("my.netrc.txt")).toBe(false)
    expect(isDeniedName("pem.txt")).toBe(false)
    expect(isDeniedName("turkey.txt")).toBe(false)
  })

  test("leaves public data alone: known_hosts and authorized_keys are not secrets", () => {
    expect(isDeniedName("known_hosts")).toBe(false)
    expect(isDeniedName("authorized_keys")).toBe(false)
  })

  test("matches a name with a line break", () => {
    expect(isDeniedName("a\nsecret\n.txt")).toBe(true)
  })
})
