import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { join } from "node:path"
import { createSandbox, toolFailure, type Sandbox } from "./outgoing.testing"
import { resolveOutgoing } from "./resolve"

let box: Sandbox
let work: string
beforeEach(() => {
  box = createSandbox()
  work = box.mkdir("work")
})
afterEach(() => box.remove())

const resolveIn = (path: string, roots: string[] = [work]) =>
  resolveOutgoing(path, { cwd: work, roots, forbidden: [], home: join(box.root, "home") })

describe("resolveOutgoing and key or settings folders", () => {
  test.each([
    ".ssh/config",
    "project/.ssh/id_work",
    "a/b/.AWS/credentials.txt",
    ".Config/tool/settings.json",
    "a/.git/HEAD",
    "a/.GnuPG/pubring.txt",
    "Library/Keychains/readme.txt",
    "KEYCHAINS/readme.txt",
    ".mozilla/firefox/places.txt",
    "a/.Thunderbird/mail.txt",
    ".zsh_sessions/ABC.history",
    ".bash_sessions/ABC.history",
    ".backups/old.txt",
  ])("refuses %s, without saying which folder", async (path) => {
    box.write(`work/${path}`)
    const error = await toolFailure(() => resolveIn(path))
    expect(error.code).toBe("forbidden")
    expect(error.message).toBe(`${JSON.stringify(path)} is inside a key or settings folder.`)
  })

  test("refuses a folder name with trailing dots or spaces, as a Windows file system reads it", async () => {
    box.write("work/.ssh./config.txt")
    box.write("work/.ssh /config.txt")
    expect((await toolFailure(() => resolveIn(".ssh./config.txt"))).code).toBe("forbidden")
    expect((await toolFailure(() => resolveIn(".ssh /config.txt"))).code).toBe("forbidden")
  })

  test("refuses a file that is itself called after such a folder", async () => {
    box.write("work/.git")
    expect((await toolFailure(() => resolveIn(".git"))).code).toBe("forbidden")
  })

  test("looks above the root too: a root inside a settings folder sends nothing", async () => {
    const inside = box.mkdir(".config/project")
    const file = box.write(".config/project/today.txt")
    const error = await toolFailure(() => resolveIn(file, [inside]))
    expect(error.code).toBe("forbidden")
    expect(error.message).toBe(`${JSON.stringify(file)} is inside a key or settings folder.`)
  })

  test("looks at the real path: a link out of a settings folder is judged by where it leads", async () => {
    box.write(".ssh/config")
    box.link("work/innocent.txt", `${box.root}/.ssh/config`)
    const error = await toolFailure(() => resolveIn("innocent.txt", [work, box.root]))
    expect(error.code).toBe("forbidden")
    expect(error.message).toBe('"innocent.txt" is inside a key or settings folder.')
    expect(error.message).not.toContain(".ssh")
  })

  test("names the key folder, not send_dirs, for a file outside every root", async () => {
    const file = box.write("elsewhere/.ssh/config")
    const error = await toolFailure(() => resolveIn(file))
    expect(error.code).toBe("forbidden")
    expect(error.message).toBe(`${JSON.stringify(file)} is inside a key or settings folder.`)
    expect(error.message).not.toContain("send_dirs")
  })

  test("allows folders that only look similar, and the .registry folder that is no general rule", async () => {
    box.write("work/.registry/state.txt")
    expect((await resolveIn(".registry/state.txt")).name).toBe("state.txt")
    box.write("work/ssh/config.txt")
    box.write("work/gitignore/notes.txt")
    box.write("work/configs/notes.txt")
    expect((await resolveIn("ssh/config.txt")).name).toBe("config.txt")
    expect((await resolveIn("gitignore/notes.txt")).name).toBe("notes.txt")
    expect((await resolveIn("configs/notes.txt")).name).toBe("notes.txt")
  })
})

describe("resolveOutgoing and names that look like keys or secrets", () => {
  test.each([
    ".env",
    ".ENV.local",
    ".env.production",
    ".env.",
    ".netrc",
    ".npmrc",
    ".pypirc",
    ".pgpass",
    ".git-credentials",
    ".htpasswd",
    "id_rsa",
    "id_ed25519.pub",
    "ID_ECDSA_backup",
    "server.pem",
    "SERVER.PEM",
    "tls.key",
    "client.p12",
    "client.pfx",
    "store.jks",
    "release.keystore",
    "login.keychain-db",
    "vault.kdbx",
    "mail.gpg",
    "public.asc",
    "office.ovpn",
    "app.mobileprovision",
    "putty.ppk",
    "aws-credentials.txt",
    "my_Secret_notes.md",
    "passwords.csv",
    "Password.txt",
    ".bash_history",
    ".zsh_history",
    ".sh_history",
    ".python_history",
    ".psql_history",
    ".mysql_history",
    ".sqlite_history",
    ".node_repl_history",
    ".rediscli_history",
    ".lesshst",
    ".viminfo",
    ".irb_history",
    "key.pk8",
    "key.pkcs8",
    "store.jceks",
    "store.bks",
    "service.keytab",
    "terraform.tfstate",
    "terraform.tfstate.backup",
    "prod.tfvars",
    "prod.auto.tfvars.json",
    ".terraformrc",
    "terraform.rc",
    "kubeconfig",
    "kubeconfig-prod.yaml",
    ".dockerconfigjson",
    "wallet.dat",
    "coins.wallet",
    "vault.kdb",
    "vault.psafe3",
    "vault.opvault",
    "export.1pux",
    "export.1pif",
    "vault.agilekeychain",
    "service-account-prod.json",
    "serviceaccount.json",
    "deploy.token",
  ])("refuses a file named %s", async (name) => {
    box.write(`work/${name}`)
    const error = await toolFailure(() => resolveIn(name))
    expect(error.code).toBe("forbidden")
    expect(error.message).toContain("named like a key or a secret")
  })

  test.each([
    "notes.txt",
    "known_hosts",
    "authorized_keys",
    "keyboard.txt",
    "monkey.pdf",
    "environment.md",
    "env.txt",
    "idea.rsa.txt",
    "auth.json",
    "history.txt",
    "main.tf",
    "tokens.md",
    ".registry",
    "certificate.der",
    "history.irb.txt",
  ])("allows a file named %s", async (name) => {
    box.write(`work/${name}`)
    expect((await resolveIn(name)).name).toBe(name)
  })

  test("judges the real name: a harmless link to a key file is refused, a key-like link to a harmless file is not", async () => {
    const key = box.write("work/store/id_rsa")
    box.link("work/harmless.txt", key)
    expect((await toolFailure(() => resolveIn("harmless.txt"))).code).toBe("forbidden")
    const plain = box.write("work/store/plain.txt")
    box.link("work/server.pem", plain)
    expect((await resolveIn("server.pem")).name).toBe("plain.txt")
  })
})
