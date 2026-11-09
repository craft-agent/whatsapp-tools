import { sep } from "node:path"

/**
 * Where keys and settings live, and what files that hold secrets are called.
 * A name is a weak sign, so these lists only refuse; the bytes are read as
 * well (`content-scan.ts`). They are matched case-insensitively, on a name in
 * NFC with trailing dots and spaces dropped, which is how a Windows file
 * system reads it (`.env.` is `.env`).
 */

const NAME_STRIP = /[. ]+$/

/**
 * Folders that hold keys, credentials or settings, in lower case. A file is
 * never sent from inside one, at any depth of its real path:
 *
 * - keys and key stores: `.ssh`, `.gnupg`, `.gpg`, `.pki`, `.password-store`,
 *   `keyrings`, `keychains`, `.vault-token`;
 * - cloud and container tools, which keep tokens beside their settings:
 *   `.aws`, `.azure`, `.gcloud`, `.oci`, `.kube`, `.docker`, `.terraform.d`;
 * - build tools whose settings hold repository passwords: `.m2`, `.gradle`;
 * - the settings folder every program shares, `.config`;
 * - version control metadata, whose config holds remote URLs with tokens and
 *   whose objects hold every earlier version of a file: `.git`, `.hg`, `.svn`;
 * - profiles of programs that keep logins, cookies and mail: `.mozilla`,
 *   `.thunderbird`;
 * - the shell's per-session histories, which hold every command typed,
 *   passwords on command lines included: `.zsh_sessions`, `.bash_sessions`;
 * - backups, which copy whatever the other rules refuse: `.backups`.
 *
 * `.cargo` and `.gem` are not here: what they hold that is secret is a file
 * called `credentials`, which the name rules already refuse.
 */
const DENIED_FOLDERS: ReadonlySet<string> = new Set(
  [
    ...[".ssh", ".gnupg", ".gpg", ".pki", ".password-store", "keyrings", "keychains", ".vault-token"],
    ...[".aws", ".azure", ".gcloud", ".oci", ".kube", ".docker", ".terraform.d"],
    ...[".m2", ".gradle", ".config", ".git", ".hg", ".svn", ".mozilla", ".thunderbird", ".backups"],
    ...[".zsh_sessions", ".bash_sessions"],
  ].map((folder) => folder.toLowerCase()),
)

/** Application data of macOS programs, below `Library/Application Support`. */
const APPLICATION_SUPPORT = ["Library", "Application Support"]

/**
 * Places below the home directory, as lists of folder names, that hold logins,
 * cookies, messages or backups. Nothing below one is sent. On macOS these sit
 * under `Library` and not in a dot folder, so the folder rule cannot see them.
 *
 * - browser profiles, with their saved logins and cookies: Google (Chrome),
 *   Chromium, BraveSoftware, Firefox, Microsoft Edge, Arc, Vivaldi,
 *   com.operasoftware.Opera, and `Library/Safari`, `Library/Cookies`,
 *   `Library/HTTPStorages` (the cookies and sessions the system keeps for
 *   every program);
 * - password managers: 1Password, Bitwarden;
 * - chat clients, whose database and login are the account: Signal, Slack,
 *   discord, Telegram Desktop, `Library/Messages`, `Library/Mail`;
 * - iOS device backups, which hold a phone's data and keychain: MobileSync;
 * - the sandbox folders of macOS programs, which hold each program's own
 *   private data: `Library/Containers`, `Library/Group Containers`;
 * - signal-cli's default data folder, `.local/share/signal-cli`, which holds
 *   the account's keys, wacli's default store, `.wacli`, which holds the
 *   account's session and messages, and the sandboxes of Flatpak (`.var/app`) and Snap
 *   (`snap`) programs on Linux.
 *
 * (`Library/Keychains` is also refused by the `keychains` folder rule.)
 */
const DENIED_HOME_PLACES: readonly (readonly string[])[] = [
  ...[
    ...["Google", "Chromium", "BraveSoftware", "Firefox", "Microsoft Edge", "Arc", "Vivaldi"],
    ...["com.operasoftware.Opera", "1Password", "Bitwarden", "Signal", "Slack", "discord"],
    ...["Telegram Desktop", "MobileSync"],
  ].map((app) => [...APPLICATION_SUPPORT, app]),
  ...["Safari", "Mail", "Messages", "Cookies", "HTTPStorages", "Containers", "Group Containers"].map((folder) => [
    "Library",
    folder,
  ]),
  [".local", "share", "signal-cli"],
  [".wacli"],
  [".var", "app"],
  ["snap"],
]

/** The name patterns that say a file holds a key or a secret, each group with why. */
const NAME_PATTERNS: readonly string[] = [
  // Dotfiles that hold credentials: environment files, package and registry logins, database and cloud passwords
  String.raw`\.env.*|[._]netrc|\.npmrc|\.yarnrc(?:\.yml)?|\.pypirc|\.pgpass|\.my\.cnf|\.mylogin\.cnf|\.git-credentials|\.dockercfg|\.dockerconfigjson|\.boto|\.s3cfg|\.htpasswd`,
  // Private key files, and keystores and keytabs that hold them (not `.der`, which is as often a certificate)
  String.raw`id_(?:rsa|dsa|ecdsa|ed25519).*|.*\.(?:pem|key|ppk|p8|pk8|pkcs8|p12|pfx|jks|jceks|bks|keystore|keytab|keychain|keychain-db)`,
  // Password stores and wallets
  String.raw`.*\.(?:kdbx|kdb|psafe3|opvault|1pux|1pif|agilekeychain|gpg|asc|wallet)|wallet\.dat`,
  // VPN profiles and iOS signing profiles, which carry keys
  String.raw`.*\.(?:ovpn|mobileprovision)`,
  // Shell, editor and client histories, which keep every command and query typed, passwords on command lines included
  String.raw`\.(?:bash|zsh|sh|python|psql|mysql|sqlite|node_repl|rediscli|irb)_history|\.lesshst|\.viminfo`,
  // Infrastructure state and settings: Terraform state and variables hold secrets in clear, kubeconfig holds cluster tokens
  String.raw`.*\.tfstate(?:\..*)?|.*\.tfvars(?:\.json)?|\.terraformrc|terraform\.rc|kubeconfig.*`,
  // Cloud service account keys and token files
  String.raw`service[-_]?account.*\.json|.*\.token`,
  // Anything that says what it is
  String.raw`.*credential.*|.*secret.*|.*password.*`,
]

/**
 * Compiled from `NAME_PATTERNS`. `known_hosts` and `authorized_keys` are not
 * matched: they hold public keys and host names, not secrets, and the real
 * ones sit in `.ssh`, which is refused. `auth.json` is not either: the name is
 * too common to say anything.
 */
const DENIED_NAMES = new RegExp(`^(?:${NAME_PATTERNS.join("|")})$`, "is")

/** A name as the lists judge it: in NFC, without trailing dots and spaces. */
function judged(name: string): string {
  return name.normalize("NFC").replace(NAME_STRIP, "")
}

/** Whether a path component is a folder that holds keys or settings. */
export function isDeniedFolder(component: string): boolean {
  return DENIED_FOLDERS.has(judged(component).toLowerCase())
}

/** Whether a file name looks like a key or a secret. */
export function isDeniedName(name: string): boolean {
  return DENIED_NAMES.test(judged(name))
}

function components(path: string): string[] {
  return path.split(sep).filter((component) => component !== "")
}

/**
 * The place below the home directory (`Library/Cookies`, …) that a real path
 * is in, written with `/`, or `undefined`. Both paths are real paths; names
 * are compared case-insensitively, as the file system that has `Library`
 * reads them.
 */
export function deniedHomePlace(realPath: string, home: string): string | undefined {
  const homeParts = components(home)
  const parts = components(realPath)
  if (parts.length < homeParts.length || homeParts.some((part, i) => part.toLowerCase() !== parts[i]!.toLowerCase())) {
    return undefined
  }
  const below = parts.slice(homeParts.length).map((part) => judged(part).toLowerCase())
  const place = DENIED_HOME_PLACES.find((names) => names.every((name, i) => below[i] === name.toLowerCase()))
  return place?.join("/")
}
