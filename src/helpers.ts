import { spawn } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const IGNORED_DIRECTORIES = new Set([".git", "node_modules", "dist", "build", "coverage"])
const MAX_TREE_ITEMS = 80
export const MAX_RECENT_ROOTS = 8
const PACKAGE_MANAGERS = new Set(["npm", "pnpm", "yarn", "bun"])

export type ScriptLauncher = {
  executable: string
  args: string[]
}

export type ScriptTerminal = "native" | "wezterm-tab" | "wezterm-window" | "wezterm-horizontal" | "wezterm-vertical"
export type WezTermSplitSize = { Percent: number } | { Cells: number }

export type WezTermSettings = {
  horizontal: WezTermSplitSize
  vertical: WezTermSplitSize
}

export type ScriptLanguage = {
  id: string
  title: string
  enabled: boolean
  launcher: ScriptLauncher
  extensions: string[]
}

export type ScriptSettings = {
  shell: ScriptLauncher
  terminal: ScriptTerminal
  wezterm: WezTermSettings
  languages: ScriptLanguage[]
}

export type SidebarSettings = {
  projectDirectory?: string
  visibility: {
    showMcp: boolean
    showLsp: boolean
  }
  scripts: ScriptSettings
  scriptPins: string[]
  favoriteFileRoots: string[]
  recentFileRoots: string[]
  fileRoots: Record<string, { customRoots: string[]; activeRoot?: string }>
}

const DEFAULT_SCRIPT_SETTINGS: ScriptSettings = {
  shell: { executable: "pwsh", args: ["-NoLogo", "-NoExit", "-Command"] },
  terminal: "native",
  wezterm: {
    horizontal: { Percent: 50 },
    vertical: { Percent: 50 },
  },
  languages: [
    { id: "powershell", title: "PowerShell 7", enabled: true, launcher: { executable: "pwsh", args: ["-NoLogo", "-NoExit", "-File"] }, extensions: [".ps1", ".psm1"] },
    { id: "sh", title: "POSIX sh", enabled: true, launcher: { executable: "sh", args: [] }, extensions: [".sh"] },
    { id: "bash", title: "Bash", enabled: true, launcher: { executable: "bash", args: [] }, extensions: [".bash"] },
    { id: "zsh", title: "Zsh", enabled: true, launcher: { executable: "zsh", args: [] }, extensions: [".zsh"] },
    { id: "python", title: "Python", enabled: true, launcher: { executable: "python", args: [] }, extensions: [".py"] },
    { id: "node", title: "Node.js", enabled: true, launcher: { executable: "node", args: [] }, extensions: [".js", ".mjs", ".cjs"] },
    { id: "typescript", title: "TypeScript", enabled: true, launcher: { executable: "npx", args: ["tsx"] }, extensions: [".ts", ".mts", ".cts"] },
    { id: "cmd", title: "Windows cmd", enabled: true, launcher: { executable: "cmd.exe", args: ["/d", "/c"] }, extensions: [".bat", ".cmd"] },
    { id: "ruby", title: "Ruby", enabled: true, launcher: { executable: "ruby", args: [] }, extensions: [".rb"] },
    { id: "php", title: "PHP", enabled: true, launcher: { executable: "php", args: [] }, extensions: [".php"] },
  ],
}

export const BUILTIN_SHELLS = [
  { id: "powershell", title: "PowerShell 7", launcher: { executable: "pwsh", args: ["-NoLogo", "-NoExit", "-Command"] } },
  { id: "sh", title: "POSIX sh", launcher: { executable: "sh", args: ["-c"] } },
  { id: "bash", title: "Bash", launcher: { executable: "bash", args: ["-c"] } },
  { id: "zsh", title: "Zsh", launcher: { executable: "zsh", args: ["-c"] } },
  { id: "cmd", title: "Windows cmd", launcher: { executable: "cmd.exe", args: ["/d", "/k"] } },
] as const

export const WEZTERM_TERMINALS = [
  { id: "wezterm-tab", title: "New tab" },
  { id: "wezterm-window", title: "New window" },
  { id: "wezterm-horizontal", title: "Horizontal split (side-by-side)" },
  { id: "wezterm-vertical", title: "Vertical split (stacked)" },
] as const

function cloneSettings(settings: ScriptSettings): ScriptSettings {
  return {
    shell: { executable: settings.shell.executable, args: [...settings.shell.args] },
    terminal: settings.terminal,
    wezterm: {
      horizontal: { ...settings.wezterm.horizontal },
      vertical: { ...settings.wezterm.vertical },
    },
    languages: settings.languages.map((language) => ({
      id: language.id,
      title: language.title,
      enabled: language.enabled,
      launcher: { executable: language.launcher.executable, args: [...language.launcher.args] },
      extensions: [...language.extensions],
    })),
  }
}

function launcher(value: unknown, fallback: ScriptLauncher): ScriptLauncher {
  if (!value || typeof value !== "object") return { executable: fallback.executable, args: [...fallback.args] }
  const input = value as { executable?: unknown; args?: unknown }
  if (typeof input.executable !== "string" || !input.executable.trim()) {
    return { executable: fallback.executable, args: [...fallback.args] }
  }
  return {
    executable: input.executable.trim(),
    args: Array.isArray(input.args) ? input.args.filter((arg): arg is string => typeof arg === "string") : [...fallback.args],
  }
}

export function normalizeExtension(value: string): string | undefined {
  const extension = value.trim().toLowerCase()
  if (!extension) return undefined
  const normalized = extension.startsWith(".") ? extension : `.${extension}`
  return /^\.[a-z0-9][a-z0-9._-]*$/.test(normalized) ? normalized : undefined
}

function language(value: unknown, fallback: ScriptLanguage | undefined): ScriptLanguage | undefined {
  if (!value || typeof value !== "object") return fallback
  const input = value as { id?: unknown; title?: unknown; enabled?: unknown; launcher?: unknown; extensions?: unknown }
  if (typeof input.id !== "string" || !input.id.trim() || typeof input.title !== "string" || !input.title.trim()) return fallback
  const fallbackLauncher = fallback?.launcher ?? { executable: "pwsh", args: [] }
  const extensions = Array.isArray(input.extensions)
    ? [...new Set(input.extensions.filter((item): item is string => typeof item === "string").map(normalizeExtension).filter((item): item is string => Boolean(item)))]
    : fallback?.extensions ?? []
  return {
    id: input.id.trim(),
    title: input.title.trim(),
    enabled: typeof input.enabled === "boolean" ? input.enabled : fallback?.enabled ?? true,
    launcher: launcher(input.launcher, fallbackLauncher),
    extensions,
  }
}

function splitSize(value: unknown, fallback: WezTermSplitSize): WezTermSplitSize {
  if (!value || typeof value !== "object") return { ...fallback }
  const input = value as { Percent?: unknown; Cells?: unknown }
  if (typeof input.Percent === "number" && Number.isInteger(input.Percent) && input.Percent > 0 && input.Percent < 100) {
    return { Percent: input.Percent }
  }
  if (typeof input.Cells === "number" && Number.isInteger(input.Cells) && input.Cells > 0) {
    return { Cells: input.Cells }
  }
  return { ...fallback }
}

export function defaultScriptSettings(): ScriptSettings {
  return cloneSettings(DEFAULT_SCRIPT_SETTINGS)
}

export function defaultSidebarSettings(): SidebarSettings {
  return {
    visibility: { showMcp: true, showLsp: true },
    scripts: defaultScriptSettings(),
    scriptPins: [],
    favoriteFileRoots: [],
    recentFileRoots: [],
    fileRoots: {},
  }
}

export function normalizeScriptSettings(value: unknown, base = defaultScriptSettings()): ScriptSettings {
  if (!value || typeof value !== "object") return cloneSettings(base)
  const input = value as { shell?: unknown; terminal?: unknown; wezterm?: unknown; languages?: unknown }
  const wezterm = input.wezterm && typeof input.wezterm === "object"
    ? input.wezterm as { horizontal?: unknown; vertical?: unknown }
    : {}
  const languages = cloneSettings(base).languages
  if (Array.isArray(input.languages)) {
    for (const item of input.languages) {
      const normalized = language(item, languages.find((entry) => entry.id === (item as { id?: unknown })?.id))
      if (!normalized) continue
      const index = languages.findIndex((entry) => entry.id === normalized.id)
      if (index === -1) languages.push(normalized)
      else languages[index] = normalized
    }
  }
  return {
    shell: launcher(input.shell, base.shell),
    terminal: input.terminal === "native"
      ? "native"
      : WEZTERM_TERMINALS.some((item) => item.id === input.terminal)
        ? input.terminal as ScriptTerminal
        : base.terminal,
    wezterm: {
      horizontal: splitSize(wezterm.horizontal, base.wezterm.horizontal),
      vertical: splitSize(wezterm.vertical, base.wezterm.vertical),
    },
    languages,
  }
}

export function normalizeSidebarSettings(value: unknown, base = defaultSidebarSettings()): SidebarSettings {
  if (!value || typeof value !== "object") return {
    projectDirectory: base.projectDirectory,
    visibility: { ...base.visibility },
    scripts: cloneSettings(base.scripts),
    scriptPins: [...base.scriptPins],
    favoriteFileRoots: [...base.favoriteFileRoots],
    recentFileRoots: [...base.recentFileRoots],
    fileRoots: structuredClone(base.fileRoots),
  }
  const input = value as {
    projectDirectory?: unknown
    showMcp?: unknown
    showLsp?: unknown
    scripts?: unknown
    scriptPins?: unknown
    favoriteFileRoots?: unknown
    fileRootPins?: unknown
    recentFileRoots?: unknown
    fileRoots?: unknown
  }
  const fileRoots: SidebarSettings["fileRoots"] = { ...base.fileRoots }
  const migratedRecentRoots: string[] = []
  if (input.fileRoots && typeof input.fileRoots === "object") {
    for (const [sessionID, rawState] of Object.entries(input.fileRoots)) {
      if (!rawState || typeof rawState !== "object") continue
      const state = rawState as { customRoots?: unknown; activeRoot?: unknown }
      const customRoots = dedupeRootPaths(
        Array.isArray(state.customRoots)
          ? state.customRoots.filter((item): item is string => typeof item === "string")
          : [],
      )
      migratedRecentRoots.push(...customRoots)
      const activeRoot = typeof state.activeRoot === "string"
        ? normalizeRootPath(state.activeRoot)
        : undefined
      fileRoots[sessionID] = {
        customRoots,
        activeRoot: activeRoot && isDirectory(activeRoot) ? activeRoot : undefined,
      }
    }
  }
  let recentFileRoots = Array.isArray(input.recentFileRoots)
    ? dedupeRootPaths(input.recentFileRoots.filter((item): item is string => typeof item === "string"))
    : [...base.recentFileRoots]
  if (recentFileRoots.length === 0 && migratedRecentRoots.length > 0) {
    recentFileRoots = dedupeRootPaths(migratedRecentRoots)
  }
  const rawFavorites = Array.isArray(input.favoriteFileRoots)
    ? input.favoriteFileRoots
    : input.fileRootPins
  const normalizedFavorites = Array.isArray(rawFavorites)
    ? dedupeRootPaths(rawFavorites.filter((item): item is string => typeof item === "string"))
    : dedupeRootPaths(base.favoriteFileRoots)
  return {
    projectDirectory: typeof input.projectDirectory === "string" && isDirectory(input.projectDirectory)
      ? input.projectDirectory
      : base.projectDirectory,
    visibility: {
      showMcp: typeof input.showMcp === "boolean" ? input.showMcp : base.visibility.showMcp,
      showLsp: typeof input.showLsp === "boolean" ? input.showLsp : base.visibility.showLsp,
    },
    scripts: normalizeScriptSettings(input.scripts, base.scripts),
    scriptPins: Array.isArray(input.scriptPins)
      ? [...new Set(input.scriptPins.filter((item): item is string => typeof item === "string"))]
      : [...base.scriptPins],
    favoriteFileRoots: normalizedFavorites,
    recentFileRoots,
    fileRoots,
  }
}

export function sidebarConfigPaths(projectRoot: string, homeDirectory = os.homedir()): { user: string; project: string } {
  return {
    user: path.join(homeDirectory, ".config", "openSidebar", "config.json"),
    project: path.join(projectRoot, ".config", "openSidebar.json"),
  }
}

export function promptProjectDirectory(prompt: unknown, homeDirectory = os.homedir()): string | undefined {
  if (typeof prompt !== "string") return undefined
  const match = prompt.trim().replace(/^(["']).*\1$/, (value) => value.slice(1, -1)).match(/^cd\s+(.+?)\s*$/i)
  if (!match) return undefined
  const candidate = match[1].trim().replace(/^['"]|['"]$/g, "")
  return path.isAbsolute(candidate) && candidate !== homeDirectory && isDirectory(candidate) ? path.normalize(candidate) : undefined
}

export function sessionProjectDirectory(
  messages: readonly unknown[],
  partsForMessage: (messageID: string) => readonly unknown[],
  homeDirectory = os.homedir(),
): string | undefined {
  for (const message of messages) {
    if (!message || typeof message !== "object") continue
    const value = message as { id?: unknown; role?: unknown }
    if (value.role !== "user" || typeof value.id !== "string") continue
    for (const part of partsForMessage(value.id)) {
      if (!part || typeof part !== "object") continue
      const text = (part as { type?: unknown; text?: unknown })
      if (text.type === "text") {
        const directory = promptProjectDirectory(text.text, homeDirectory)
        if (directory) return directory
      }
    }
  }
  return undefined
}

function readJsonFile(filePath: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"))
  } catch {
    return undefined
  }
}

export function loadSidebarSettings(
  projectRoot: string,
  homeDirectory = os.homedir(),
  userPath = sidebarConfigPaths(projectRoot, homeDirectory).user,
  projectPath = sidebarConfigPaths(projectRoot, homeDirectory).project,
  base = defaultSidebarSettings(),
): SidebarSettings {
  const user = readJsonFile(userPath)
  const project = readJsonFile(projectPath)
  const userSettings = normalizeSidebarSettings(user, base)
  return normalizeSidebarSettings(project, userSettings)
}

export function saveSidebarSettings(filePath: string, settings: SidebarSettings): void {
  const directory = path.dirname(filePath)
  fs.mkdirSync(directory, { recursive: true })
  const temporary = `${filePath}.tmp-${process.pid}`
  fs.writeFileSync(temporary, `${JSON.stringify(settings, null, 2)}\n`, "utf8")
  fs.renameSync(temporary, filePath)
}

function cursorSettingsPath(homeDirectory: string): string {
  return path.join(homeDirectory, ".config", "openSidebar", "config.json")
}

export function cursorSessionSecretPath(homeDirectory = os.homedir()): string {
  return path.join(homeDirectory, ".config", "openSidebar", "cursor-session")
}

function configCursorSessionToken(homeDirectory: string): string | undefined {
  const value = readJsonFile(cursorSettingsPath(homeDirectory))
  if (!value || typeof value !== "object") return undefined
  const token = (value as { cursorSessionToken?: unknown }).cursorSessionToken
  return typeof token === "string" && token.trim() !== "" ? token.trim() : undefined
}

function writeJsonObject(filePath: string, value: Record<string, unknown>): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  const temporary = `${filePath}.tmp-${process.pid}`
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8")
  fs.renameSync(temporary, filePath)
}

function stripCursorSessionTokenFromConfig(homeDirectory: string): void {
  const filePath = cursorSettingsPath(homeDirectory)
  const existing = readJsonFile(filePath)
  if (!existing || typeof existing !== "object" || !("cursorSessionToken" in existing)) return
  const settings = { ...(existing as Record<string, unknown>) }
  delete settings.cursorSessionToken
  writeJsonObject(filePath, settings)
}

function readCursorSessionSecret(homeDirectory: string): string | undefined {
  try {
    const token = fs.readFileSync(cursorSessionSecretPath(homeDirectory), "utf8").trim()
    return token !== "" ? token : undefined
  } catch {
    return undefined
  }
}

function writeCursorSessionSecret(homeDirectory: string, token: string): void {
  const filePath = cursorSessionSecretPath(homeDirectory)
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  const temporary = `${filePath}.tmp-${process.pid}`
  fs.writeFileSync(temporary, `${token}\n`, "utf8")
  fs.renameSync(temporary, filePath)
  try {
    fs.chmodSync(filePath, 0o600)
  } catch {
    // Owner-only mode is best-effort on Windows.
  }
}

function migrateCursorSessionToken(homeDirectory: string): void {
  const fromConfig = configCursorSessionToken(homeDirectory)
  if (fromConfig && !readCursorSessionSecret(homeDirectory)) writeCursorSessionSecret(homeDirectory, fromConfig)
  stripCursorSessionTokenFromConfig(homeDirectory)
}

export function readCursorSessionToken(homeDirectory = os.homedir()): string | undefined {
  migrateCursorSessionToken(homeDirectory)
  return readCursorSessionSecret(homeDirectory) ?? configCursorSessionToken(homeDirectory)
}

export function writeCursorSessionToken(homeDirectory: string, token: string): void {
  writeCursorSessionSecret(homeDirectory, token.trim())
  stripCursorSessionTokenFromConfig(homeDirectory)
}

export function clearCursorSessionToken(homeDirectory = os.homedir()): void {
  try {
    fs.unlinkSync(cursorSessionSecretPath(homeDirectory))
  } catch {
    // Missing secrets file is already clear.
  }
  stripCursorSessionTokenFromConfig(homeDirectory)
}

export function parseLauncher(value: string): string[] | undefined {
  const tokens: string[] = []
  let token = ""
  let quote = ""
  for (const character of value.trim()) {
    if (quote) {
      if (character === quote) quote = ""
      else token += character
    } else if (character === '"' || character === "'") {
      quote = character
    } else if (/\s/.test(character)) {
      if (token) {
        tokens.push(token)
        token = ""
      }
    } else {
      token += character
    }
  }
  if (quote) return undefined
  if (token) tokens.push(token)
  return tokens.length > 0 ? tokens : undefined
}

export function updateLanguage(
  settings: ScriptSettings,
  languageID: string,
  update: (language: ScriptLanguage) => ScriptLanguage | undefined,
): ScriptSettings {
  return {
    ...cloneSettings(settings),
    languages: settings.languages.map((item) => item.id === languageID ? update(item) : item).filter((item): item is ScriptLanguage => Boolean(item)),
  }
}

export type Script = { name: string; command: string; filePath?: string; launcher: ScriptLauncher; terminal: ScriptTerminal; weztermSize: WezTermSplitSize }
export type TreeEntry = { name: string; relativePath: string; fullPath: string; directory: boolean; depth: number }
export type RootSections = { recentRoots: string[]; favoriteRoots: string[] }

export function isDirectory(value: string): boolean {
  try {
    return fs.statSync(value).isDirectory()
  } catch {
    return false
  }
}

export function normalizeRootPath(value: string): string {
  const normalized = path.normalize(value)
  if (process.platform === "win32" && /^[a-zA-Z]:/.test(normalized)) {
    return normalized.slice(0, 1).toUpperCase() + normalized.slice(1)
  }
  return normalized
}

export function rootPathKey(value: string): string {
  const normalized = normalizeRootPath(value)
  return process.platform === "win32" ? normalized.toLowerCase() : normalized
}

export function sameRootPath(first: string, second: string): boolean {
  return rootPathKey(first) === rootPathKey(second)
}

export function dedupeRootPaths(paths: readonly string[], isValid: (root: string) => boolean = isDirectory): string[] {
  const seen = new Set<string>()
  const result: string[] = []
  for (const item of paths) {
    if (typeof item !== "string" || !item.trim()) continue
    const canonical = normalizeRootPath(item)
    if (!isValid(canonical)) continue
    const key = rootPathKey(canonical)
    if (seen.has(key)) continue
    seen.add(key)
    result.push(canonical)
  }
  return result
}

export type EverythingSearchEntry = { path: string; directory: boolean }
export type EverythingSearchResult =
  | { ok: true; entries: EverythingSearchEntry[] }
  | { ok: false; error: "missing-es" | "ipc-unavailable" | "failed" | "aborted" }

export type EverythingSpawnResult = { stdout: string; code: number | null; error?: Error }

export function everythingSearchQuery(roots: readonly string[], query: string): string {
  const scoped = dedupeRootPaths(roots).map((root) => {
    const folder = normalizeRootPath(root)
    const withSep = folder.endsWith(path.sep) ? folder : `${folder}${path.sep}`
    return /[\s<>|"]/.test(withSep) ? `"${withSep.replaceAll('"', "")}"` : withSep
  })
  const scope = scoped.length === 0 ? "" : scoped.length === 1 ? scoped[0] : `<${scoped.join("|")}>`
  const trimmed = query.trim()
  if (scope && trimmed) return `${scope} ${trimmed}`
  return trimmed || scope
}

export function everythingSearchArgs(search: string, maxResults = 80): string[] {
  // es.exe matches only when the query is a separate -search argv; wrapping the query in quotes yields zero hits.
  return ["-n", String(maxResults), "-timeout", "2000", "-hide-empty-search-results", "-search", search]
}

function defaultEverythingSpawn(executable: string, args: string[], signal?: AbortSignal): Promise<EverythingSpawnResult> {
  return new Promise((resolve) => {
    const child = spawn(executable, args, { windowsHide: true })
    let stdout = ""
    const onAbort = () => {
      child.kill()
    }
    signal?.addEventListener("abort", onAbort, { once: true })
    child.stdout?.on("data", (chunk) => {
      stdout += String(chunk)
    })
    child.on("error", (error) => {
      signal?.removeEventListener("abort", onAbort)
      resolve({ stdout, code: null, error })
    })
    child.on("close", (code) => {
      signal?.removeEventListener("abort", onAbort)
      resolve({ stdout, code })
    })
  })
}

export async function runEverythingSearch(options: {
  query: string
  roots: readonly string[]
  maxResults?: number
  signal?: AbortSignal
  executable?: string
  spawnImpl?: (executable: string, args: string[], signal?: AbortSignal) => Promise<EverythingSpawnResult>
}): Promise<EverythingSearchResult> {
  const executable = options.executable ?? (process.platform === "win32" ? "es.exe" : "es")
  const spawnImpl = options.spawnImpl ?? defaultEverythingSpawn
  const search = everythingSearchQuery(options.roots, options.query)
  const args = everythingSearchArgs(search, options.maxResults)
  if (options.signal?.aborted) return { ok: false, error: "aborted" }
  const spawned = await spawnImpl(executable, args, options.signal)
  if (options.signal?.aborted) return { ok: false, error: "aborted" }
  if (spawned.error) {
    const code = (spawned.error as NodeJS.ErrnoException).code
    if (code === "ENOENT") return { ok: false, error: "missing-es" }
    return { ok: false, error: "failed" }
  }
  if (spawned.code === 8) return { ok: false, error: "ipc-unavailable" }
  if (spawned.code !== 0 && spawned.code !== 9) return { ok: false, error: "failed" }
  const entries: EverythingSearchEntry[] = []
  for (const line of spawned.stdout.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed) continue
    const canonical = normalizeRootPath(trimmed)
    let directory = false
    try {
      directory = fs.statSync(canonical).isDirectory()
    } catch {
      continue
    }
    entries.push({ path: canonical, directory })
    if (entries.length >= (options.maxResults ?? 80)) break
  }
  return { ok: true, entries }
}

export function displayPath(value: string, homeDirectory: string): string {
  const normalized = value.replaceAll("\\", "/")
  const home = homeDirectory.replaceAll("\\", "/").replace(/\/$/, "")
  return normalized === home ? "/~" : normalized.startsWith(`${home}/`) ? `/~${normalized.slice(home.length + 1)}` : normalized
}

export function rootSections(
  customRoots: readonly string[],
  favoriteRoots: readonly string[],
  isValid: (root: string) => boolean = isDirectory,
): RootSections {
  const favorites = dedupeRootPaths(favoriteRoots, isValid)
  const favoriteKeys = new Set(favorites.map(rootPathKey))
  const recentRoots = dedupeRootPaths(customRoots, isValid)
    .filter((root) => !favoriteKeys.has(rootPathKey(root)))
    .slice(0, MAX_RECENT_ROOTS)
  return { recentRoots, favoriteRoots: favorites }
}

function packageManager(directory: string): string {
  try {
    const packageJson = JSON.parse(fs.readFileSync(path.join(directory, "package.json"), "utf8"))
    if (typeof packageJson.packageManager === "string") {
      const manager = packageJson.packageManager.split("@")[0]
      if (PACKAGE_MANAGERS.has(manager)) return manager
    }
  } catch {
    // Lockfiles are the fallback when package.json is absent or invalid.
  }

  for (const [file, manager] of [
    ["pnpm-lock.yaml", "pnpm"],
    ["yarn.lock", "yarn"],
    ["bun.lock", "bun"],
    ["bun.lockb", "bun"],
    ["package-lock.json", "npm"],
  ] as const) {
    if (fs.existsSync(path.join(directory, file))) return manager
  }
  return "npm"
}

function shellPath(filePath: string): string {
  return `"${filePath.replaceAll('"', '\\"')}"`
}

function fileScript(filePath: string, languages: readonly ScriptLanguage[]): Script | undefined {
  const fileName = path.basename(filePath).toLowerCase()
  const language = languages.find((item) => item.enabled && item.extensions.some((extension) => fileName.endsWith(extension)))
  return language
    ? { name: path.relative(path.dirname(path.dirname(filePath)), filePath), command: shellPath(filePath), filePath, launcher: language.launcher, terminal: "native", weztermSize: { Percent: 50 } }
    : undefined
}

function readPackageScripts(directory: string, shell: ScriptLauncher): Script[] {
  try {
    const packageJson = JSON.parse(fs.readFileSync(path.join(directory, "package.json"), "utf8"))
    if (!packageJson.scripts || typeof packageJson.scripts !== "object") return []
    const manager = packageManager(directory)
    return Object.keys(packageJson.scripts)
      .filter((name) => /^[a-zA-Z0-9_:.\/-]+$/.test(name))
      .sort((a, b) => a.localeCompare(b))
      .map((name) => ({ name, command: `${manager} run ${name}`, launcher: shell, terminal: "native", weztermSize: { Percent: 50 } }))
  } catch {
    return []
  }
}

function readFileScripts(root: string, languages: readonly ScriptLanguage[]): Script[] {
  const scriptsDirectory = path.basename(root) === ".scripts" ? root : path.join(root, ".scripts")
  try {
    return fs.readdirSync(scriptsDirectory, { withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => fileScript(path.join(scriptsDirectory, entry.name), languages))
      .filter((script): script is Script => Boolean(script))
      .sort((a, b) => a.name.localeCompare(b.name))
  } catch {
    return []
  }
}

export function readScripts(projectRoot: string, fileRoot = projectRoot, settings: ScriptSettings = defaultScriptSettings()): Script[] {
  return [...readPackageScripts(projectRoot, settings.shell), ...readFileScripts(fileRoot, settings.languages)].map((script) => ({ ...script, terminal: settings.terminal, weztermSize: settings.terminal === "wezterm-horizontal" ? settings.wezterm.horizontal : settings.terminal === "wezterm-vertical" ? settings.wezterm.vertical : settings.wezterm.horizontal }))
}

export function readTree(root: string, expanded: ReadonlySet<string>): TreeEntry[] {
  const entries: TreeEntry[] = []

  function visit(directory: string, depth: number): void {
    if (entries.length >= MAX_TREE_ITEMS) return
    let children: fs.Dirent[]
    try {
      children = fs.readdirSync(directory, { withFileTypes: true })
    } catch {
      return
    }

    children
      .filter((entry) => !entry.isDirectory() || !IGNORED_DIRECTORIES.has(entry.name))
      .sort((a, b) => {
        if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1
        return a.name.localeCompare(b.name)
      })
      .forEach((entry) => {
        if (entries.length >= MAX_TREE_ITEMS) return
        const relativePath = path.relative(root, path.join(directory, entry.name)) || entry.name
        const directoryEntry = entry.isDirectory()
        entries.push({
          name: entry.name,
          relativePath,
          fullPath: path.join(directory, entry.name),
          directory: directoryEntry,
          depth,
        })
        if (directoryEntry && expanded.has(relativePath)) visit(path.join(directory, entry.name), depth + 1)
      })
  }

  visit(root, 0)
  return entries
}

