import { For, Show, createMemo, createSignal } from "solid-js"
import type { TuiDialogSelectProps, TuiPlugin, TuiPluginModule, TuiPromptRef } from "@opencode-ai/plugin/tui"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { BUILTIN_SHELLS, clearCursorSessionToken, defaultScriptSettings, defaultSidebarSettings, dedupeRootPaths, displayPath, isDirectory, loadSidebarSettings, normalizeExtension, normalizeRootPath, normalizeScriptSettings, parseLauncher, readCursorSessionToken, readScripts, readTree, rootSections, runEverythingSearch, sameRootPath, saveSidebarSettings, saveUserScriptSettings, sessionProjectDirectory, sidebarConfigPaths, updateLanguage, WEZTERM_TERMINALS, writeCursorSessionToken, type Script, type ScriptLanguage, type ScriptSettings, type SidebarSettings, type WezTermSplitSize } from "./helpers.js"
import { cursorSessionCookie, probeCursorUsage, probeOpenAIUsage, probeOpenCodeGoUsage, probeOpenRouterUsage, type CursorUsage, type OpenAIUsage, type OpenCodeGoUsage, type OpenRouterUsage } from "./usage.js"
import { copyToClipboard, fileClipboardText, runScript as runNativeScript, scriptClipboardText, scriptCommand } from "./script-runner.js"

const DIRECTORY_COLORS = ["#F7E9B5", "#F4E1A0", "#F1D98B", "#EED076", "#EBC861"]
const DIRECTORY_INDICATOR_COLORS = ["#DCCF99", "#D5C184", "#CEB56F", "#C7A95A", "#C09D45"]
const MAX_TREE_ITEMS = 80
const ADD_ROOT = "__sidebar_add_custom_root__"
const RESET_ROOT = "__sidebar_reset_project_root__"
const FAVORITE_HELP = "__sidebar_favorite_help__"
const FILE_ROOT_PREFIX = "file:"
const ADD_SCRIPT_EXECUTABLE = "__sidebar_add_script_executable__"
const ADD_SCRIPT_EXTENSION = "__sidebar_add_script_extension__"
const RESET_SCRIPT_SETTINGS = "__sidebar_reset_script_settings__"
const SCRIPT_SHELL_SECTION = "__sidebar_script_shell_section__"
const SCRIPT_LANGUAGE_SECTION = "__sidebar_script_language_section__"
const SCRIPT_EXTENSION_SECTION = "__sidebar_script_extension_section__"
const WEZTERM_SIZE_SECTION = "__sidebar_wezterm_size_section__"
const USAGE_REFRESH_INTERVAL_MS = 5 * 60 * 1000
const MODEL_STATE_PATH = path.join(process.env.XDG_STATE_HOME ?? path.join(os.homedir(), ".local", "state"), "opencode", "model.json")

function directoryColor(depth: number, colors: string[]): string {
  return colors[Math.min(depth, colors.length - 1)]
}

function midpointColor(first: { toInts(): [number, number, number, number]; toString(): string }, second: string): string {
  const hex = second.match(/^#([\da-f]{6})$/i)?.[1]
  if (!hex) return first.toString()
  const [red, green, blue] = first.toInts()
  return `#${[red, green, blue].map((value, index) => Math.round((value + parseInt(hex.slice(index * 2, index * 2 + 2), 16)) / 2).toString(16).padStart(2, "0")).join("")}`
}

function palerColor(color: { toInts(): [number, number, number, number] }): string {
  return `#${color.toInts().slice(0, 3).map((value) => Math.round(value + (255 - value) * 0.18).toString(16).padStart(2, "0")).join("")}`
}

function pinKey(worktree: string): string {
  return `opencode-sidebar-tools:pins:${worktree}`
}

function favoriteRootKey(worktree: string): string {
  return `opencode-sidebar-tools:favorite-file-roots:${worktree}`
}

function rootsKey(sessionID: string): string {
  return `opencode-sidebar-tools:file-roots:${sessionID}`
}

function scriptSettingsKey(worktree: string): string {
  return `opencode-sidebar-tools:script-settings:${worktree}`
}

type RootState = { customRoots: string[]; activeRoot?: string }
type SelectedModel = { providerID: string; modelID: string }

function globalScriptSettings(options: unknown): ScriptSettings {
  if (!options || typeof options !== "object") return defaultScriptSettings()
  const value = (options as { scripts?: unknown }).scripts
  return normalizeScriptSettings(value)
}

function globalSidebarSettings(options: unknown): SidebarSettings {
  return { ...defaultSidebarSettings(), scripts: globalScriptSettings(options) }
}

function loadRootState(api: Parameters<TuiPlugin>[0], sessionID: string): RootState {
  const value = api.kv.get<unknown>(rootsKey(sessionID), {})
  if (!value || typeof value !== "object") return { customRoots: [] }
  const state = value as { customRoots?: unknown; activeRoot?: unknown }
  const customRoots = Array.isArray(state.customRoots)
    ? state.customRoots.filter((item): item is string => typeof item === "string" && isDirectory(item))
    : []
  return {
    customRoots: [...new Set(customRoots)],
    activeRoot: typeof state.activeRoot === "string" && customRoots.includes(state.activeRoot) ? state.activeRoot : undefined,
  }
}

function loadPins(api: Parameters<TuiPlugin>[0], worktree: string): Set<string> {
  const value = api.kv.get<unknown>(pinKey(worktree), [])
  return new Set(Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [])
}

function loadRootPins(api: Parameters<TuiPlugin>[0], worktree: string): Set<string> {
  const value = api.kv.get<unknown>(favoriteRootKey(worktree), [])
  return new Set(Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && isDirectory(item)) : [])
}

function commandId(prefix: string, value: string): string {
  const safe = value.replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-|-$/g, "") || "item"
  return `sidebar.${prefix}.${safe}`
}

function isSelectedModel(value: unknown): value is SelectedModel {
  if (!value || typeof value !== "object") return false
  const model = value as { providerID?: unknown; modelID?: unknown }
  return typeof model.providerID === "string" && typeof model.modelID === "string"
}

function configuredModel(agent: unknown, config: unknown): SelectedModel | undefined {
  if (!config || typeof config !== "object") return undefined
  const settings = config as { model?: unknown; agent?: Record<string, { model?: unknown }> }
  const value = typeof agent === "string" ? settings.agent?.[agent]?.model ?? settings.model : settings.model
  if (isSelectedModel(value)) return value
  if (typeof value !== "string") return undefined
  const slash = value.indexOf("/")
  return slash > 0 && slash < value.length - 1
    ? { providerID: value.slice(0, slash), modelID: value.slice(slash + 1) }
    : undefined
}

function savedModelState(agent: unknown, config: unknown): SelectedModel | undefined {
  try {
    const state = JSON.parse(fs.readFileSync(MODEL_STATE_PATH, "utf8")) as {
      model?: Record<string, unknown>
      recent?: unknown[]
    }
    const model = typeof agent === "string" && isSelectedModel(state.model?.[agent])
      ? state.model[agent]
      : configuredModel(agent, config) ?? state.recent?.find(isSelectedModel)
    return model
  } catch {
    return undefined
  }
}

function savedVariant(model: { providerID: string; id: string } | undefined): string | undefined {
  if (!model) return "none"
  try {
    const state = JSON.parse(fs.readFileSync(MODEL_STATE_PATH, "utf8")) as { variant?: Record<string, unknown> }
    const variant = state.variant?.[`${model.providerID}/${model.id}`]
    return typeof variant === "string" && variant !== "default" ? variant : "none"
  } catch {
    return undefined
  }
}

function footerPath(directory: string, homeDirectory: string, branch?: string): string {
  const normalized = directory.replaceAll("\\", "/")
  const home = homeDirectory.replaceAll("\\", "/").replace(/\/$/, "")
  const visible = normalized === home
    ? "~/"
    : normalized.startsWith(`${home}/`)
      ? `~/${normalized.slice(home.length + 1)}`
      : normalized
  return branch ? `${visible}:${branch}` : visible
}

const tui: TuiPlugin = async (api, options) => {
  const currentSessionID = () => {
    const current = api.route.current
    const sessionID = current.name === "session" ? current.params?.sessionID : undefined
    return typeof sessionID === "string" ? sessionID : `project:${api.state.path.worktree || api.state.path.directory}`
  }
  const projectRoot = (forSessionID = currentSessionID()) => {
    return api.state.session.get(forSessionID)?.directory
      || api.state.path.worktree
      || api.state.path.directory
  }
  let sessionID = currentSessionID()
  let sessionDirectory = projectRoot()
  let project = sessionDirectory
  let rootState = loadRootState(api, sessionID)
  let root = rootState.activeRoot || project
  const pluginDefaults = globalSidebarSettings(options)
  const initialPromptDirectory = sessionProjectDirectory(api.state.session.messages(sessionID), (messageID) => api.state.part(messageID), os.homedir())
  let configRoot = sessionDirectory === os.homedir() ? initialPromptDirectory || sessionDirectory : sessionDirectory
  const configPaths = sidebarConfigPaths(configRoot, os.homedir())
  let sidebarSettings = loadSidebarSettings(configRoot, os.homedir(), configPaths.user, configPaths.project, pluginDefaults)
  let projectConfigRoot = configRoot
  project = sidebarSettings.projectDirectory || configRoot
  root = sidebarSettings.fileRoots[sessionID]?.activeRoot || project
  if (!sidebarSettings.fileRoots[sessionID]) sidebarSettings.fileRoots[sessionID] = rootState
  let scriptSettings = sidebarSettings.scripts
  const hoverColor = midpointColor(api.theme.current.primary, DIRECTORY_COLORS[0])
  const headerButtonColor = palerColor(api.theme.current.accent)
  const promptRefs = new Map<string, TuiPromptRef>()
  const [scripts, setScripts] = createSignal(readScripts(project, root, scriptSettings))
  const [scriptsOpen, setScriptsOpen] = createSignal(true)
  const [filesOpen, setFilesOpen] = createSignal(true)
  const [hovered, setHovered] = createSignal<string>()
  const [usage, setUsage] = createSignal<OpenAIUsage>({ ok: false })
  const [goUsage, setGoUsage] = createSignal<OpenCodeGoUsage>({ ok: false })
  const [openRouterUsage, setOpenRouterUsage] = createSignal<OpenRouterUsage>({ ok: false })
  const [cursorUsage, setCursorUsage] = createSignal<CursorUsage>({ ok: false })
  const [showRemaining, setShowRemaining] = createSignal(false)
  const [showGoRemaining, setShowGoRemaining] = createSignal(false)
  const [showOrRemaining, setShowOrRemaining] = createSignal(false)
  const [showCursorRemaining, setShowCursorRemaining] = createSignal(false)
  const [model, setModel] = createSignal<SelectedModel>()
  const [variant, setVariant] = createSignal("none")
  const [expanded, setExpanded] = createSignal<Set<string>>(new Set(["."]))
  const [tree, setTree] = createSignal(readTree(root, expanded()))
  let pins = new Set(sidebarSettings.scriptPins)
  let favorites = new Set(sidebarSettings.favoriteFileRoots)
  let cursorSessionToken = readCursorSessionToken(os.homedir())
  let usageRunning = false
  const usageAbort = new AbortController()
  let modelStateWatcher: fs.FSWatcher | undefined
  let refreshCommands = () => {}
  let visibilityRunning = false

  const saveProjectSettings = () => {
    const paths = sidebarConfigPaths(projectConfigRoot, os.homedir())
    const projectSettings = { ...sidebarSettings }
    delete (projectSettings as { scripts?: ScriptSettings }).scripts
    saveSidebarSettings(paths.project, projectSettings)
  }

  const loadProjectOwnedState = () => {
    const legacyRootState = loadRootState(api, sessionID)
    const legacyPins = loadPins(api, project)
    const legacyRootPins = loadRootPins(api, project)
    if (!sidebarSettings.fileRoots[sessionID] && (legacyRootState.customRoots.length > 0 || legacyRootState.activeRoot)) {
      sidebarSettings.fileRoots[sessionID] = legacyRootState
    }
    if (sidebarSettings.recentFileRoots.length === 0 && legacyRootState.customRoots.length > 0) {
      sidebarSettings.recentFileRoots = dedupeRootPaths(legacyRootState.customRoots)
    }
    if (sidebarSettings.scriptPins.length === 0 && legacyPins.size > 0) sidebarSettings.scriptPins = [...legacyPins]
    if (sidebarSettings.favoriteFileRoots.length === 0 && legacyRootPins.size > 0) sidebarSettings.favoriteFileRoots = [...legacyRootPins]
    const projectPath = sidebarConfigPaths(projectConfigRoot, os.homedir()).project
    let hasProjectScripts = false
    try {
      const projectConfig = JSON.parse(fs.readFileSync(projectPath, "utf8")) as { scripts?: unknown }
      hasProjectScripts = projectConfig.scripts !== undefined
    } catch {
      // Missing or malformed project config is handled by the normalized defaults.
    }
    if (!hasProjectScripts) {
      const legacyScripts = api.kv.get<unknown>(scriptSettingsKey(project), undefined)
      if (legacyScripts !== undefined) sidebarSettings.scripts = normalizeScriptSettings(legacyScripts, sidebarSettings.scripts)
    }
    if (!hasProjectScripts || legacyRootState.customRoots.length > 0 || legacyRootState.activeRoot || legacyPins.size > 0 || legacyRootPins.size > 0) saveProjectSettings()
  }

  const syncSidebarVisibility = async () => {
    if (visibilityRunning) return
    visibilityRunning = true
    try {
      for (const [id, visible] of [
        ["internal:sidebar-mcp", sidebarSettings.visibility.showMcp],
        ["internal:sidebar-lsp", sidebarSettings.visibility.showLsp],
      ] as const) {
        const plugin = api.plugins.list().find((item) => item.id === id)
        if (!plugin || plugin.active === visible) continue
        const changed = visible ? await api.plugins.activate(id) : await api.plugins.deactivate(id)
        if (!changed) api.ui.toast({ variant: "warning", message: `Could not ${visible ? "show" : "hide"} ${id}.` })
      }
    } finally {
      visibilityRunning = false
    }
  }

  const loadProjectSettings = () => {
    sessionDirectory = projectRoot(sessionID)
    const promptDirectory = sessionProjectDirectory(api.state.session.messages(sessionID), (messageID) => api.state.part(messageID), os.homedir())
    configRoot = sessionDirectory === os.homedir() ? promptDirectory || sessionDirectory : sessionDirectory
    projectConfigRoot = configRoot
    const paths = sidebarConfigPaths(projectConfigRoot, os.homedir())
    sidebarSettings = loadSidebarSettings(projectConfigRoot, os.homedir(), paths.user, paths.project, pluginDefaults)
    project = sidebarSettings.projectDirectory || projectConfigRoot
    loadProjectOwnedState()
    scriptSettings = sidebarSettings.scripts
    rootState = sidebarSettings.fileRoots[sessionID] ?? { customRoots: [] }
    favorites = new Set(dedupeRootPaths(sidebarSettings.favoriteFileRoots))
    sidebarSettings.favoriteFileRoots = [...favorites]
    sidebarSettings.recentFileRoots = dedupeRootPaths(sidebarSettings.recentFileRoots)
    const sections = rootSections(sidebarSettings.recentFileRoots, [...favorites])
    rootState = {
      customRoots: [...sections.recentRoots, ...sections.favoriteRoots],
      activeRoot: rootState.activeRoot,
    }
    root = rootState.activeRoot ? normalizeRootPath(rootState.activeRoot) : project
    pins = new Set(sidebarSettings.scriptPins)
    void syncSidebarVisibility()
  }

  loadProjectSettings()

  const refreshSelectedModel = (forSessionID = currentSessionID()) => {
    const next = savedModelState(api.state.session.get(forSessionID)?.agent, api.state.config)
    if (next === undefined) return false
    setModel(next)
    return true
  }
  const refreshVariant = (forSessionID = currentSessionID()) => {
    const next = savedVariant(api.state.session.get(forSessionID)?.model)
    if (next === undefined) return false
    setVariant(next)
    return true
  }
  const modelLabel = () => {
    const selected = model()
    if (!selected) return "unavailable"
    const provider = api.state.provider.find((item) => item.id === selected.providerID)
    return provider?.models[selected.modelID]?.name || selected.modelID
  }

  const refreshUsage = async () => {
    if (usageRunning) return
    usageRunning = true
    try {
      const [next, nextGo, nextOpenRouter, nextCursor] = await Promise.all([
        probeOpenAIUsage({ signal: usageAbort.signal }),
        probeOpenCodeGoUsage({ signal: usageAbort.signal }),
        probeOpenRouterUsage({ signal: usageAbort.signal }),
        probeCursorUsage({ signal: usageAbort.signal, cursorSessionToken }),
      ])
      let cursor = nextCursor
      if (!cursor.ok && cursor.reason === "reauthenticate" && cursorSessionToken) {
        clearCursorSessionToken(os.homedir())
        cursorSessionToken = undefined
        cursor = await probeCursorUsage({ signal: usageAbort.signal })
      }
      if (!usageAbort.signal.aborted) setUsage(next)
      if (!usageAbort.signal.aborted) setGoUsage(nextGo)
      if (!usageAbort.signal.aborted) setOpenRouterUsage(nextOpenRouter)
      if (!usageAbort.signal.aborted) setCursorUsage(cursor)
    } finally {
      usageRunning = false
    }
  }
  const usageTimer = setInterval(() => void refreshUsage(), USAGE_REFRESH_INTERVAL_MS)
  void refreshUsage()

  const syncSession = (nextSessionID: string) => {
    const nextSessionDirectory = projectRoot(nextSessionID)
    const nextPromptDirectory = sessionProjectDirectory(api.state.session.messages(nextSessionID), (messageID) => api.state.part(messageID), os.homedir())
    const nextConfigRoot = nextSessionDirectory === os.homedir() ? nextPromptDirectory || nextSessionDirectory : nextSessionDirectory
    if (nextConfigRoot === configRoot && nextSessionID === sessionID) return
    sessionID = nextSessionID
    project = nextConfigRoot
    loadProjectSettings()
    setScriptsOpen(true)
    setFilesOpen(true)
    setExpanded(new Set(["."]))
    refreshSelectedModel(sessionID)
    refreshVariant(sessionID)
    setScripts(readScripts(project, root, scriptSettings))
    setTree(readTree(root, expanded()))
    refreshCommands()
  }
  const refresh = () => {
    const nextSessionID = currentSessionID()
    syncSession(nextSessionID)
    setScripts(readScripts(project, root, scriptSettings))
    setTree(readTree(root, expanded()))
    refreshCommands()
    void refreshUsage()
    void syncSidebarVisibility()
  }
  const syncStoredRootState = () => {
    const sections = rootSections(sidebarSettings.recentFileRoots, [...favorites])
    rootState = {
      customRoots: [...sections.recentRoots, ...sections.favoriteRoots],
      activeRoot: sameRootPath(root, project) ? undefined : normalizeRootPath(root),
    }
    sidebarSettings.fileRoots[sessionID] = rootState
  }

  const isFavorite = (directory: string) => [...favorites].some((item) => sameRootPath(item, directory))

  const setRoot = (nextRoot: string) => {
    const canonical = normalizeRootPath(nextRoot)
    root = canonical
    if (!sameRootPath(canonical, project)) {
      sidebarSettings.recentFileRoots = rootSections(
        [canonical, ...sidebarSettings.recentFileRoots],
        [...favorites],
      ).recentRoots
    }
    syncStoredRootState()
    saveProjectSettings()
    setExpanded(new Set(["."]))
    setScripts(readScripts(project, root, scriptSettings))
    setTree(readTree(root, expanded()))
    refreshCommands()
  }
  const savePins = () => {
    sidebarSettings.scriptPins = [...pins].sort()
    saveProjectSettings()
  }
  const togglePin = (name: string) => {
    if (pins.has(name)) pins.delete(name)
    else pins.add(name)
    savePins()
    refreshCommands()
    api.ui.toast({ variant: "success", message: `${pins.has(name) ? "Pinned" : "Unpinned"} script: ${name}` })
  }
  const toggleFavorite = (customRoot: string) => {
    const canonical = normalizeRootPath(customRoot)
    const existing = [...favorites].find((item) => sameRootPath(item, canonical))
    if (existing) favorites.delete(existing)
    else favorites.add(canonical)
    favorites = new Set(dedupeRootPaths([...favorites]))
    sidebarSettings.favoriteFileRoots = [...favorites].sort()
    sidebarSettings.recentFileRoots = rootSections(sidebarSettings.recentFileRoots, [...favorites]).recentRoots
    syncStoredRootState()
    saveProjectSettings()
    refreshCommands()
    api.ui.toast({ variant: "success", message: `${isFavorite(canonical) ? "Favorited" : "Unfavorited"} root: ${canonical}` })
  }
  const runScript = async (script: Script) => {
    const current = api.route.current
    const sessionID = current.name === "session" ? current.params?.sessionID : undefined
    const cwd = typeof sessionID === "string" ? api.state.session.get(sessionID)?.directory : project
    const result = await runNativeScript(script, cwd || project)
    if (!result.error) {
      api.ui.toast({ variant: "success", message: `Started ${script.name} in ${result.target}.` })
    } else {
      api.ui.toast({ variant: "error", message: `Could not start ${script.name}: ${result.error}` })
    }
  }
  const weeklyUsage = () => {
    const snapshot = usage()
    if (!snapshot.ok) return { window: undefined, reauthenticate: snapshot.reason === "reauthenticate" }
    const window = snapshot.primary.minutes !== null && snapshot.primary.minutes >= 7 * 24 * 60
      ? snapshot.primary
      : snapshot.secondary.minutes !== null && snapshot.secondary.minutes >= 7 * 24 * 60
        ? snapshot.secondary
        : undefined
    return { window, reauthenticate: false }
  }
  const weeklyUsageText = (weekly = weeklyUsage()) => {
    if (weekly.reauthenticate) return { value: "run /connect", remaining: false }
    if (!weekly.window || weekly.window.usedPercent === null) return { value: "unavailable", remaining: false }
return showRemaining()
      ? { value: `${100 - weekly.window.usedPercent}%`, remaining: true }
      : { value: `${weekly.window.usedPercent}%`, remaining: false }
  }
  const promptCursorToken = () => api.ui.dialog.replace(() => api.ui.DialogPrompt({
    title: "Connect Cursor usage",
    description: () => <text>
      1. Open cursor.com in a browser while logged in (or stay signed into the Cursor app).
      2. If the app is signed in, cancel and wait: the sidebar will retry from the app.
      3. Otherwise: in the browser, open DevTools, Application (or Storage), Cookies, cursor.com, copy the value of WorkosCursorSessionToken.
      4. Paste that value here (a long user::eyJ... string is fine).
    </text>,
    placeholder: "user::eyJ...",
    onConfirm: (value) => {
      const trimmed = value.trim()
      if (!cursorSessionCookie(trimmed)) {
        api.ui.toast({ variant: "error", message: "That does not look like a Cursor session cookie" })
        return
      }
      writeCursorSessionToken(os.homedir(), trimmed)
      cursorSessionToken = trimmed
      api.ui.toast({ variant: "success", message: "Cursor usage connected" })
      api.ui.dialog.clear()
      void refreshUsage()
    },
    onCancel: () => api.ui.dialog.clear(),
  }))
  const usageRows = () => {
    const weekly = weeklyUsage()
    const text = weeklyUsageText(weekly)
    const goSnapshot = goUsage()
    const goWeekly = goSnapshot.ok ? goSnapshot.weekly : undefined
    const goValue = goWeekly?.usedPercent === null || goWeekly?.usedPercent === undefined
      ? "unavailable"
      : `${showGoRemaining() ? 100 - goWeekly.usedPercent : goWeekly.usedPercent}%`
    const orSnapshot = openRouterUsage()
    const orOk = orSnapshot.ok ? orSnapshot : undefined
    const orValue = orOk
      ? `${showOrRemaining() ? orOk.remainingPercent : orOk.usedPercent}%`
      : "unavailable"
    const cursorSnapshot = cursorUsage()
    const cursorOk = cursorSnapshot.ok ? cursorSnapshot.monthly : undefined
    const cursorSide = (used: number | null | undefined) =>
      used === null || used === undefined
        ? "unavailable"
        : `${showCursorRemaining() ? 100 - used : used}%`
    const cursorValue = `${cursorSide(cursorOk?.usedPercent)}, ${cursorSide(cursorOk?.apiUsedPercent)} api`
    const cursorNeedsToken = !cursorSnapshot.ok && (cursorSnapshot.reason === "need-token" || cursorSnapshot.reason === "reauthenticate")
    return <>
      <box flexDirection="row" gap={1}>
        <text fg={api.theme.current.text}>Weekly Usage:</text>
      </box>
      <box
        flexDirection="row"
        gap={1}
        onMouseOver={() => setHovered("usage")}
        onMouseOut={() => setHovered()}
        onMouseUp={(event) => {
          if (event.button === 0) setShowRemaining((value) => !value)
        }}
      >
        <text fg={api.theme.current.text}>
          {text.remaining ? "Codex remaining:" : "Codex:"}
        </text>
        <text fg={api.theme.current.textMuted}>{text.value}</text>
      </box>
      <box flexDirection="row" gap={1}>
        <text fg={api.theme.current.textMuted}>resets on</text>
        <text fg={api.theme.current.textMuted}>
          {weekly.window?.resetAt || (weekly.reauthenticate ? "OpenAI auth required" : "unavailable")}
        </text>
      </box>
      <box
        flexDirection="row"
        gap={1}
        onMouseOver={() => setHovered("cursor-usage")}
        onMouseOut={() => setHovered()}
        onMouseUp={(event) => {
          if (event.button === 2) {
            promptCursorToken()
            return
          }
          if (event.button === 0) {
            if (cursorNeedsToken) promptCursorToken()
            else setShowCursorRemaining((value) => !value)
          }
        }}
      >
        <text fg={api.theme.current.text}>
          {showCursorRemaining() && !cursorNeedsToken ? "Cursor remaining:" : "Cursor:"}
        </text>
        <text fg={api.theme.current.textMuted}>
          {cursorNeedsToken ? "sign in" : cursorValue}
        </text>
      </box>
      <box flexDirection="row" gap={1}>
        <text fg={api.theme.current.textMuted}>resets on</text>
        <text fg={api.theme.current.textMuted}>
          {cursorOk?.resetAt || (cursorNeedsToken ? "Cursor auth required" : "unavailable")}
        </text>
      </box>
      <Show when={!cursorSnapshot.ok && cursorSnapshot.reason === "reauthenticate"}>
        <box flexDirection="row" gap={1}>
          <text fg={api.theme.current.textMuted}>click Cursor: to paste a new cookie</text>
        </box>
      </Show>
      <box
        flexDirection="row"
        gap={1}
        onMouseOver={() => setHovered("go-usage")}
        onMouseOut={() => setHovered()}
        onMouseUp={(event) => {
          if (event.button === 0) setShowGoRemaining((value) => !value)
        }}
      >
        <text fg={api.theme.current.text}>
          {showGoRemaining() ? "OpenCode Go remaining:" : "OpenCode Go:"}
        </text>
        <text fg={api.theme.current.textMuted}>{goValue}</text>
      </box>
      <box flexDirection="row" gap={1}>
        <text fg={api.theme.current.textMuted}>resets on</text>
        <text fg={api.theme.current.textMuted}>{goWeekly?.resetAt || "unavailable"}</text>
      </box>
      <box
        flexDirection="row"
        gap={1}
        onMouseOver={() => setHovered("or-usage")}
        onMouseOut={() => setHovered()}
        onMouseUp={(event) => {
          if (event.button === 0) setShowOrRemaining((value) => !value)
        }}
      >
        <text fg={api.theme.current.text}>
          {orOk && showOrRemaining() ? "OpenRouter remaining:" : "OpenRouter:"}
        </text>
        <text fg={api.theme.current.textMuted}>{orValue}</text>
      </box>
      <Show when={orOk}>
        <box flexDirection="row" gap={1}>
          <text fg={api.theme.current.textMuted}>{`$${orOk?.usedUsd.toFixed(2)} / $${orOk?.limitUsd.toFixed(2)}`}</text>
        </box>
      </Show>
    </>
  }
  const toggleDirectory = (relativePath: string) => {
    const next = new Set<string>(expanded())
    if (next.has(relativePath)) next.delete(relativePath)
    else next.add(relativePath)
    setExpanded(next)
    setTree(readTree(root, next))
  }
  const insertChatText = (sessionID: string, text: string) => {
    const ref = promptRefs.get(sessionID)
    if (!ref) {
      api.ui.toast({ variant: "warning", message: "Chat input is not ready yet." })
      return
    }
    const input = ref.current.input
    ref.set({ ...ref.current, input: input ? `${input} ${text}` : text })
  }
  const insertPath = (sessionID: string, filePath: string, absolute = false) => {
    const sessionRoot = api.state.session.get(sessionID)?.directory
    const relativePath = sessionRoot ? path.relative(sessionRoot, filePath) : filePath
    const mentionPath = !absolute && relativePath && !path.isAbsolute(relativePath) && !relativePath.startsWith(`..${path.sep}`)
      ? relativePath
      : filePath
    insertChatText(sessionID, absolute ? `'${filePath}'` : `@${mentionPath.replaceAll(path.sep, "/")}`)
  }
  const pasteScript = (sessionID: string, script: Script) => {
    insertChatText(sessionID, script.filePath ? `'${script.filePath}'` : scriptCommand(script))
  }
  const copyText = async (text: string) => {
    const result = await copyToClipboard(text)
    api.ui.toast(result.error
      ? { variant: "error", message: `Could not copy to clipboard: ${result.error}` }
      : { variant: "success", message: "Copied to clipboard" })
  }
  const cycleVariant = (sessionID: string) => {
    promptRefs.get(sessionID)?.focus()
    const result = api.keymap.dispatchCommand("variant.cycle")
    if (!result.ok) {
      api.ui.toast({ variant: "error", message: `Could not change weight: ${result.reason}` })
      return
    }
    setTimeout(() => {
      if (!refreshVariant(sessionID)) api.ui.toast({ variant: "error", message: "Could not read the active weight." })
    }, 50)
  }
  const selectModel = () => {
    const result = api.keymap.dispatchCommand("model.list")
    if (!result.ok) api.ui.toast({ variant: "error", message: `Could not switch model: ${result.reason}` })
  }
  const promptForRoot = () => api.ui.dialog.replace(() => api.ui.DialogPrompt({
    title: "Set file root",
    description: () => <text>Enter an absolute or project-relative directory.</text>,
    placeholder: project,
    onConfirm: (value) => {
      const candidate = path.normalize(path.resolve(project, value.trim()))
      if (!value.trim() || !isDirectory(candidate)) {
        api.ui.toast({ variant: "error", message: `Directory not found: ${candidate}` })
        return
      }
      setRoot(candidate)
      api.ui.dialog.clear()
    },
    onCancel: () => api.ui.dialog.clear(),
  }))
  let rootPickerSearchAbort: AbortController | undefined
  let rootPickerDebounce: ReturnType<typeof setTimeout> | undefined
  let rootPickerSearchGeneration = 0
  let pickerInterceptor: (() => void) | undefined
  let selectedRootPickerValue: string | undefined
  const [rootPickerOptions, setRootPickerOptions] = createSignal<Array<{ title: string; value: string; category?: string; footer?: string; disabled?: boolean; onSelect?: () => void }>>([])
  let liveRootPickerOptions: Array<{ title: string; value: string; category?: string; footer?: string; disabled?: boolean; onSelect?: () => void }> = []

  const rootDirectoryOptions = (directories: readonly string[], category: string) => {
    const options: Array<{ title: string; value: string; category: string; onSelect?: () => void }> = []
    for (const directory of directories) {
      options.push({
        title: displayPath(directory, os.homedir()),
        value: directory,
        category,
        onSelect: () => {
          setRoot(directory)
          api.ui.dialog.clear()
        },
      })
    }
    return options
  }

  const buildRootPickerOptions = (groupActions = false) => {
    const actionCategory = groupActions ? "Actions" : undefined
    const sections = rootSections(sidebarSettings.recentFileRoots, [...favorites])
    const projectCanonical = normalizeRootPath(project)
    const options: Array<{ title: string; value: string; category?: string; footer?: string; disabled?: boolean; onSelect?: () => void }> = [
      {
        title: "Add custom dir...",
        value: ADD_ROOT,
        category: actionCategory,
        onSelect: () => promptForRoot(),
      },
    ]
    if (isDirectory(projectCanonical)) {
      options.push({
        title: displayPath(projectCanonical, os.homedir()),
        value: projectCanonical,
        category: "Project",
        onSelect: () => {
          setRoot(projectCanonical)
          api.ui.dialog.clear()
        },
      })
    }
    options.push(...rootDirectoryOptions(sections.favoriteRoots, "Favorite"))
    options.push(...rootDirectoryOptions(sections.recentRoots, "Recent"))
    options.push({
      title: "Reset to project root",
      value: RESET_ROOT,
      category: actionCategory,
      onSelect: () => {
        setRoot(project)
        api.ui.dialog.clear()
      },
    })
    options.push({
      title: "Favorite",
      value: FAVORITE_HELP,
      category: "Help",
      footer: "ctrl+f",
      onSelect: () => {},
    })
    return options
  }

  const handleRootPickerSelect = (value: string) => {
    if (value === ADD_ROOT) {
      promptForRoot()
      return
    }
    if (value === RESET_ROOT) {
      setRoot(project)
      api.ui.dialog.clear()
      return
    }
    if (value.startsWith(FILE_ROOT_PREFIX)) {
      insertPath(sessionID, value.slice(FILE_ROOT_PREFIX.length))
      api.ui.dialog.clear()
      return
    }
    setRoot(value)
    api.ui.dialog.clear()
  }

  const applyRootPickerOptions = (searchOptions: Array<{ title: string; value: string; category?: string; footer?: string; disabled?: boolean; onSelect?: () => void }> = []) => {
    const searching = searchOptions.length > 0
    const next = searching ? [...searchOptions, ...buildRootPickerOptions(true)] : buildRootPickerOptions()
    liveRootPickerOptions.splice(0, liveRootPickerOptions.length, ...next)
    setRootPickerOptions(liveRootPickerOptions.slice())
    return liveRootPickerOptions
  }

  const renderRootPicker = (query = "", searchOptions: Array<{ title: string; value: string; category?: string; footer?: string; disabled?: boolean; onSelect?: () => void }> = []) => {
    const options = applyRootPickerOptions(searchOptions)
    selectedRootPickerValue = options.find((option) => typeof option.value === "string" && isDirectory(option.value))?.value
    pickerInterceptor?.()
    pickerInterceptor = api.keymap.intercept("key", (context) => {
      if (context.event.ctrl && context.event.name.toLowerCase() === "f" && selectedRootPickerValue && isDirectory(selectedRootPickerValue)) {
        context.consume({ preventDefault: true, stopPropagation: true })
        toggleFavorite(selectedRootPickerValue)
        renderRootPicker(query, searchOptions)
      }
    })
    const dialogProps = {
      title: `Project: ${project}`,
      skipFilter: true,
      get options() {
        rootPickerOptions()
        return liveRootPickerOptions
      },
      onFilter: (filterQuery: string) => {
        if (rootPickerDebounce) clearTimeout(rootPickerDebounce)
        rootPickerDebounce = setTimeout(() => {
          void (async () => {
            const generation = ++rootPickerSearchGeneration
            const trimmed = filterQuery.trim()
            if (!trimmed) {
              applyRootPickerOptions([])
              return
            }
            rootPickerSearchAbort?.abort()
            rootPickerSearchAbort = new AbortController()
            const searchRoots = dedupeRootPaths([project, ...sidebarSettings.recentFileRoots, ...favorites])
            const result = await runEverythingSearch({
              query: trimmed,
              roots: searchRoots,
              signal: rootPickerSearchAbort.signal,
            })
            if (generation !== rootPickerSearchGeneration) return
            if (result.ok === false) {
              if (result.error === "aborted") return
              if (result.error === "missing-es") {
                api.ui.toast({ variant: "error", message: "Install es.exe and add it to PATH for file search." })
              } else if (result.error === "ipc-unavailable") {
                api.ui.toast({ variant: "error", message: "Everything search needs es.exe on PATH and the Everything app running." })
              }
              applyRootPickerOptions([])
              return
            }
            applyRootPickerOptions(result.entries.map((entry) => ({
              title: entry.directory ? `${displayPath(entry.path, os.homedir())}/` : displayPath(entry.path, os.homedir()),
              value: entry.directory ? entry.path : `${FILE_ROOT_PREFIX}${entry.path}`,
              onSelect: () => handleRootPickerSelect(entry.directory ? entry.path : `${FILE_ROOT_PREFIX}${entry.path}`),
            })))
          })()
        }, 150)
      },
      onMove: (option: (typeof options)[number]) => {
        if (option.value === FAVORITE_HELP) {
          queueMicrotask(() => renderRootPicker(query, searchOptions))
          return
        }
        selectedRootPickerValue = typeof option.value === "string" && isDirectory(option.value) ? option.value : undefined
      },
      onSelect: (option: (typeof options)[number]) => {
        pickerInterceptor?.()
        pickerInterceptor = undefined
        if (typeof option.onSelect === "function") {
          option.onSelect()
          return
        }
        handleRootPickerSelect(String(option.value))
      },
    } as unknown as TuiDialogSelectProps<string>
    api.ui.dialog.replace(() => api.ui.DialogSelect(dialogProps))
  }

  const selectRoot = () => renderRootPicker()
  const openRootPicker = () => setTimeout(selectRoot, 100)

  const saveScriptSettings = (next: ScriptSettings, message = "Script settings updated") => {
    scriptSettings = normalizeScriptSettings(next, sidebarSettings.scripts)
    sidebarSettings.scripts = scriptSettings
    saveUserScriptSettings(os.homedir(), scriptSettings)
    setScripts(readScripts(project, root, scriptSettings))
    refreshCommands()
    api.ui.toast({ variant: "success", message })
  }
  const resetScriptSettings = () => {
    scriptSettings = normalizeScriptSettings(null, sidebarSettings.scripts)
    sidebarSettings.scripts = scriptSettings
    saveUserScriptSettings(os.homedir(), scriptSettings)
    setScripts(readScripts(project, root, scriptSettings))
    refreshCommands()
    api.ui.toast({ variant: "success", message: "Global script settings reset" })
  }
  const toggleLanguage = (languageID: string) => {
    saveScriptSettings(updateLanguage(scriptSettings, languageID, (language) => ({ ...language, enabled: !language.enabled })))
  }
  const toggleExtension = (languageID: string, extension: string) => {
    saveScriptSettings(updateLanguage(scriptSettings, languageID, (language) => ({
      ...language,
      extensions: language.extensions.includes(extension)
        ? language.extensions.filter((item) => item !== extension)
        : [...language.extensions, extension],
    })))
  }
  const chooseLanguageForExtension = (extension: string) => {
    const options = scriptSettings.languages.map((language) => ({
      title: language.title,
      value: language.id,
      category: language.enabled ? "Enabled languages" : "Disabled languages",
      footer: language.launcher.executable,
      disabled: !language.enabled,
    }))
    api.ui.dialog.replace(() => api.ui.DialogSelect({
      title: `Track ${extension} with`,
      options,
      current: options.find((option) => !option.disabled)?.value,
      onSelect: (option) => {
        saveScriptSettings(updateLanguage(scriptSettings, option.value, (language) => ({
          ...language,
          extensions: language.extensions.includes(extension) ? language.extensions : [...language.extensions, extension],
        })), `Tracking ${extension} with ${option.title}`)
        selectScriptSettings()
      },
    }))
  }
  const promptCustomExtension = (languageID?: string) => api.ui.dialog.replace(() => api.ui.DialogPrompt({
    title: "Add script extension",
    description: () => <text>Enter an extension such as .ps1 or .envrc.</text>,
    placeholder: ".custom",
    onConfirm: (value) => {
      const extension = normalizeExtension(value)
      if (!extension) {
        api.ui.toast({ variant: "error", message: "Enter a valid file extension." })
        return
      }
      if (languageID) {
        saveScriptSettings(updateLanguage(scriptSettings, languageID, (language) => ({
          ...language,
          extensions: language.extensions.includes(extension) ? language.extensions : [...language.extensions, extension],
        })), `Tracking ${extension}`)
        selectScriptSettings()
      } else {
        chooseLanguageForExtension(extension)
      }
    },
    onCancel: selectScriptSettings,
  }))
  const promptCustomExecutable = () => api.ui.dialog.replace(() => api.ui.DialogPrompt({
    title: "Add custom script executable",
    description: () => <text>Enter an executable and optional arguments. The file path is appended.</text>,
    placeholder: "my-runner --flag",
    onConfirm: (value) => {
      const tokens = parseLauncher(value)
      if (!tokens) {
        api.ui.toast({ variant: "error", message: "Enter an executable." })
        return
      }
      const [executable, ...args] = tokens
      const id = `custom-${Date.now()}`
      const language: ScriptLanguage = {
        id,
        title: `Custom: ${executable}`,
        enabled: true,
        launcher: { executable, args },
        extensions: [],
      }
      saveScriptSettings({ ...scriptSettings, languages: [...scriptSettings.languages, language] }, `Added ${executable}`)
      promptCustomExtension(id)
    },
    onCancel: selectScriptSettings,
  }))
  const splitSizeLabel = (size: WezTermSplitSize) => "Percent" in size ? `${size.Percent}%` : `${size.Cells} cells`
  const promptWeztermSizeValue = (direction: "horizontal" | "vertical", mode: "Percent" | "Cells") => api.ui.dialog.replace(() => api.ui.DialogPrompt({
    title: `${direction === "horizontal" ? "Horizontal" : "Vertical"} split ${mode}`,
    description: () => <text>{mode === "Percent" ? "Enter a percentage from 1 to 99." : "Enter a positive cell count."}</text>,
    placeholder: mode === "Percent" ? "30" : "20",
    onConfirm: (value) => {
      const number = Number(value.trim())
      const valid = Number.isInteger(number) && (mode === "Percent" ? number > 0 && number < 100 : number > 0)
      if (!valid) {
        api.ui.toast({ variant: "error", message: mode === "Percent" ? "Enter a whole percentage from 1 to 99." : "Enter a positive whole number of cells." })
        return
      }
      const size: WezTermSplitSize = mode === "Percent" ? { Percent: number } : { Cells: number }
      saveScriptSettings({
        ...scriptSettings,
        wezterm: { ...scriptSettings.wezterm, [direction]: size },
      }, `${direction === "horizontal" ? "Horizontal" : "Vertical"} split size set to ${splitSizeLabel(size)}`)
      selectScriptSettings()
    },
    onCancel: selectScriptSettings,
  }))
  const selectWeztermSizeMode = (direction: "horizontal" | "vertical") => {
    const current = scriptSettings.wezterm[direction]
    api.ui.dialog.replace(() => api.ui.DialogSelect({
      title: `${direction === "horizontal" ? "Horizontal" : "Vertical"} split size`,
      options: [
        { title: "Percent", value: "Percent", footer: "Percent" in current ? `${current.Percent}%` : "" },
        { title: "Cells", value: "Cells", footer: "Cells" in current ? `${current.Cells} cells` : "" },
      ],
      current: "Percent" in current ? "Percent" : "Cells",
      onSelect: (option) => promptWeztermSizeValue(direction, option.value as "Percent" | "Cells"),
    }))
  }
  const selectScriptSettings = () => {
    const defaults = defaultScriptSettings()
    const languageMap = new Map(scriptSettings.languages.map((language) => [language.id, language]))
    const extensionOptions = defaults.languages.flatMap((language) => {
      const current = languageMap.get(language.id)
      const extensions = [...new Set([...language.extensions, ...(current?.extensions ?? [])])]
      return extensions.map((extension) => ({
        title: extension,
        value: `extension:${language.id}:${extension}`,
        category: language.title,
        footer: current?.extensions.includes(extension) ? "tracked" : "not tracked",
      }))
    }).concat(scriptSettings.languages
      .filter((language) => !defaults.languages.some((item) => item.id === language.id))
      .flatMap((language) => language.extensions.map((extension) => ({
        title: extension,
        value: `extension:${language.id}:${extension}`,
        category: language.title,
        footer: "tracked",
      }))))
    const splitDirection = scriptSettings.terminal === "wezterm-horizontal"
      ? "horizontal"
      : scriptSettings.terminal === "wezterm-vertical"
        ? "vertical"
        : undefined
    const splitSizeOptions = splitDirection
      ? [
          { title: "Split size", value: WEZTERM_SIZE_SECTION, disabled: true },
          { title: `${splitDirection === "horizontal" ? "Horizontal" : "Vertical"} split size`, value: `wezterm-size:${splitDirection}`, category: "Split size", footer: splitSizeLabel(scriptSettings.wezterm[splitDirection]) },
        ]
      : []
    const options = [
      { title: "Shell", value: SCRIPT_SHELL_SECTION, disabled: true },
      ...BUILTIN_SHELLS.map((shell) => ({
        title: shell.title,
        value: `shell:${shell.id}`,
        category: "Shell",
        footer: scriptSettings.shell.executable === shell.launcher.executable ? "selected" : shell.launcher.executable,
      })),
      ...(BUILTIN_SHELLS.some((shell) => shell.launcher.executable === scriptSettings.shell.executable)
        ? []
        : [{ title: `Custom: ${scriptSettings.shell.executable}`, value: "shell:custom", category: "Shell", footer: "selected" }]),
      { title: "WezTerm", value: "wezterm-section", disabled: true },
      ...WEZTERM_TERMINALS.map((terminal) => ({
        title: terminal.title,
        value: `terminal:${terminal.id}`,
        category: "WezTerm",
        footer: scriptSettings.terminal === terminal.id ? "selected" : "",
      })),
      { title: "Native detached runner", value: "terminal:native", category: "WezTerm", footer: scriptSettings.terminal === "native" ? "selected" : "" },
      ...splitSizeOptions,
      { title: "Languages", value: SCRIPT_LANGUAGE_SECTION, disabled: true },
      ...scriptSettings.languages.map((language) => ({
        title: `${language.enabled ? "*" : " "} ${language.title}`,
        value: `language:${language.id}`,
        category: "Languages",
        footer: language.extensions.join(", ") || "no extensions",
      })),
      { title: "Tracked extensions", value: SCRIPT_EXTENSION_SECTION, disabled: true },
      ...extensionOptions,
      { title: "Add custom executable...", value: ADD_SCRIPT_EXECUTABLE },
      { title: "Add custom extension...", value: ADD_SCRIPT_EXTENSION },
      { title: "Reset global script settings", value: RESET_SCRIPT_SETTINGS },
    ]
    const selectedTerminal = scriptSettings.terminal === "native" ? "terminal:native" : `terminal:${scriptSettings.terminal}`
    const dialogProps = {
      title: `Global script settings`,
      skipFilter: true,
      options,
      current: selectedTerminal,
      onSelect: (option: (typeof options)[number]) => {
        if (option.value === ADD_SCRIPT_EXECUTABLE) promptCustomExecutable()
        else if (option.value === ADD_SCRIPT_EXTENSION) promptCustomExtension()
        else if (option.value === RESET_SCRIPT_SETTINGS) {
          resetScriptSettings()
          selectScriptSettings()
        }
        else if (option.value.startsWith("terminal:")) {
          const terminal = option.value.slice("terminal:".length) as ScriptSettings["terminal"]
          saveScriptSettings({ ...scriptSettings, terminal }, terminal === "native" ? "Using native detached runner" : `Using WezTerm: ${option.title}`)
          selectScriptSettings()
        } else if (option.value.startsWith("wezterm-size:")) {
          selectWeztermSizeMode(option.value.slice("wezterm-size:".length) as "horizontal" | "vertical")
        } else if (option.value.startsWith("shell:")) {
          const shell = BUILTIN_SHELLS.find((item) => `shell:${item.id}` === option.value)
          if (shell) {
            saveScriptSettings({ ...scriptSettings, shell: { ...shell.launcher, args: [...shell.launcher.args] } }, `Using ${shell.title}`)
            selectScriptSettings()
          }
        } else if (option.value.startsWith("language:")) {
          toggleLanguage(option.value.slice("language:".length))
          selectScriptSettings()
        } else if (option.value.startsWith("extension:")) {
          const [, languageID, extension] = option.value.split(":")
          toggleExtension(languageID, extension)
          selectScriptSettings()
        }
      },
    } as unknown as TuiDialogSelectProps<string>
    api.ui.dialog.replace(() => api.ui.DialogSelect(dialogProps))
  }
  const openScriptSettings = () => setTimeout(selectScriptSettings, 100)

  const disposers: Array<() => void> = []
  const registerCommands = () => {
    const rootCommands = rootSections(sidebarSettings.recentFileRoots, [...favorites])
    const commands = [
      {
        name: "sidebar.refresh",
        title: "Refresh project sidebar",
        category: "Sidebar",
        namespace: "sidebar",
        run: refresh,
      },
      {
        name: "sidebar.script-settings",
        title: "Configure project scripts",
        category: "Project scripts",
        namespace: "sidebar",
        run: selectScriptSettings,
      },
      {
        name: "sidebar.file-root.set",
        title: "Set file root",
        category: "Project files",
        namespace: "sidebar",
        run: promptForRoot,
      },
      {
        name: "sidebar.file-root.switch",
        title: "Switch file root",
        category: "Project files",
        namespace: "sidebar",
        run: selectRoot,
      },
      {
        name: "sidebar.file-root.reset",
        title: "Reset file root to project",
        category: "Project files",
        namespace: "sidebar",
        run: () => setRoot(project),
      },
      ...rootCommands.favoriteRoots.map((customRoot) => ({
        name: commandId("file-root-favorite", customRoot),
        title: `Unfavorite file root: ${customRoot}`,
        category: "Project files",
        namespace: "sidebar",
        run: () => toggleFavorite(customRoot),
      })),
      ...rootCommands.recentRoots.map((customRoot) => ({
        name: commandId("file-root-favorite", customRoot),
        title: `Favorite file root: ${customRoot}`,
        category: "Project files",
        namespace: "sidebar",
        run: () => toggleFavorite(customRoot),
      })),
      ...scripts().flatMap((script) => [
        {
          name: commandId("run", script.name),
          title: `Run script: ${script.name}`,
          category: "Project scripts",
          namespace: "sidebar",
          run: () => runScript(script),
        },
        {
          name: commandId("pin", script.name),
          title: `${pins.has(script.name) ? "Unpin" : "Pin"} script: ${script.name}`,
          category: "Project scripts",
          namespace: "sidebar",
          run: () => togglePin(script.name),
        },
      ]),
      ...tree().filter((entry) => entry.directory).map((entry) => ({
        name: commandId("toggle", entry.relativePath),
        title: `${expanded().has(entry.relativePath) ? "Collapse" : "Expand"}: ${entry.relativePath}`,
        category: "Project files",
        namespace: "sidebar",
        run: () => toggleDirectory(entry.relativePath),
      })),
    ]
    return api.keymap.registerLayer({ commands })
  }
  let commandDisposer = registerCommands()
  refreshCommands = () => {
    if (typeof commandDisposer === "function") commandDisposer()
    commandDisposer = registerCommands()
  }
  disposers.push(() => {
    if (typeof commandDisposer === "function") commandDisposer()
  })
  disposers.push(api.event.on("file.watcher.updated", refresh))
  disposers.push(api.event.on("tui.session.select", () => queueMicrotask(refresh)))
  disposers.push(api.event.on("message.updated", () => queueMicrotask(refresh)))
  try {
    modelStateWatcher = fs.watch(MODEL_STATE_PATH, () => {
      refreshSelectedModel()
      refreshVariant()
    })
  } catch {
    // The sidebar remains usable when OpenCode has not created model state yet.
  }
  refreshSelectedModel()
  refreshVariant()
  void syncSidebarVisibility()
  api.lifecycle.onDispose(() => {
    usageAbort.abort()
    clearInterval(usageTimer)
    modelStateWatcher?.close()
    disposers.forEach((dispose) => dispose())
  })

  api.slots.register({
    order: 150,
    slots: {
      sidebar_content() {
        return (
          <box flexDirection="column" gap={0}>
            {usageRows()}
          </box>
        )
      },
    },
  })

  void api.plugins.deactivate("internal:sidebar-footer")
  api.slots.register({
    order: 100,
    slots: {
      sidebar_footer(_ctx, props) {
        const session = api.state.session.get(props.session_id)
        const directory = session?.directory || api.state.path.directory
        const branch = session?.directory === api.state.path.directory ? api.state.vcs?.branch : undefined
        const displayVersion = "displayVersion" in api.app && typeof api.app.displayVersion === "string" && api.app.displayVersion
          ? api.app.displayVersion
          : api.app.version
        return (
          <box gap={1}>
            <text>{footerPath(directory, os.homedir(), branch)}</text>
            <text fg={api.theme.current.textMuted}>
              <span style={{ fg: api.theme.current.success }}>-</span> OpenCode {displayVersion}
            </text>
          </box>
        )
      },
    },
  })

  api.slots.register({
    order: 400,
    slots: {
      sidebar_title(_ctx, props) {
        return (
          <box flexDirection="column" gap={0}>
            <text>{props.title}</text>
            <text
              fg={hovered() === "header-button-session" ? hoverColor : headerButtonColor}
              paddingLeft={1}
              paddingRight={1}
              onMouseOver={() => setHovered("header-button-session")}
              onMouseOut={() => setHovered()}
              onMouseUp={(event) => {
                if (event.button === 0) api.keymap.dispatchCommand("session.list")
              }}
            >
              {"> Switch Session"}
            </text>
            <text
              fg={hovered() === "header-button-model" ? hoverColor : headerButtonColor}
              paddingLeft={1}
              paddingRight={1}
              onMouseOver={() => setHovered("header-button-model")}
              onMouseOut={() => setHovered()}
              onMouseUp={(event) => {
                if (event.button === 0) selectModel()
              }}
            >
              {`> ${modelLabel()}`}
            </text>
            <text
              fg={hovered() === "header-button-weight" ? hoverColor : headerButtonColor}
              paddingLeft={1}
              paddingRight={1}
              onMouseOver={() => setHovered("header-button-weight")}
              onMouseOut={() => setHovered()}
              onMouseDown={(event) => {
                if (event.button === 0) cycleVariant(currentSessionID())
              }}
            >
              {`> ${variant()}`}
            </text>
          </box>
        )
      },
      session_prompt(_ctx, props) {
        return api.ui.Prompt({
          sessionID: props.session_id,
          visible: props.visible,
          disabled: props.disabled,
          onSubmit: props.on_submit,
          ref: (ref) => {
            props.ref?.(ref)
            if (ref) promptRefs.set(props.session_id, ref)
            else promptRefs.delete(props.session_id)
          },
        })
      },
    },
  })

  api.slots.register({
    order: 450,
    slots: {
      sidebar_content(_ctx, props) {
        syncSession(props.session_id)
        const visibleScripts = createMemo(() => [...scripts()].sort((a, b) => {
          const pinOrder = Number(pins.has(b.name)) - Number(pins.has(a.name))
          return pinOrder || a.name.localeCompare(b.name)
        }))
        const changed = createMemo(() => api.state.session.diff(props.session_id).slice(0, 6))
        return (
          <box flexDirection="column" gap={1} paddingTop={1} paddingBottom={1}>
            <box
              flexDirection="row"
              gap={1}
              paddingLeft={1}
              paddingRight={1}
              onMouseOver={() => setHovered("scripts")}
              onMouseOut={() => setHovered()}
              onMouseDown={(event) => {
                if (event.button === 0) openScriptSettings()
              }}
            >
              <text
                fg={hovered() === "scripts" ? hoverColor : api.theme.current.text}
                onMouseDown={(event) => {
                  event.stopPropagation()
                  if (event.button === 0) setScriptsOpen((open) => !open)
                }}
                onMouseUp={(event) => event.stopPropagation()}
              >{scriptsOpen() ? "-" : "+"}</text>
              <text
                fg={hovered() === "scripts" ? hoverColor : api.theme.current.accent}
                onMouseDown={(event) => {
                  event.stopPropagation()
                  if (event.button === 0) openScriptSettings()
                }}
              ><b>scripts</b></text>
            </box>
            <Show when={scriptsOpen()}>
              <For each={visibleScripts()} fallback={<text fg={api.theme.current.textMuted}>No scripts found</text>}>
                {(script) => <text
                  fg={hovered() === `script:${script.name}` ? hoverColor : pins.has(script.name) ? api.theme.current.primary : api.theme.current.text}
                  paddingLeft={1}
                  paddingRight={1}
                  onMouseOver={() => setHovered(`script:${script.name}`)}
                  onMouseOut={() => setHovered()}
                  onMouseDown={(event) => {
                    if (event.button === 2) {
                      pasteScript(props.session_id, script)
                      void copyText(scriptClipboardText(script))
                    }
                    else if (event.button === 0) runScript(script)
                  }}
                >
                  {pins.has(script.name) ? "* " : "  "}{script.name}
                </text>}
              </For>
            </Show>

            <box
              flexDirection="row"
              gap={1}
              paddingLeft={1}
              paddingRight={1}
              onMouseOver={() => setHovered("files")}
              onMouseOut={() => setHovered()}
              onMouseDown={(event) => {
                if (event.button === 0) {
                  openRootPicker()
                }
              }}
            >
              <text
                fg={hovered() === "files" ? hoverColor : api.theme.current.text}
                onMouseDown={(event) => {
                  event.stopPropagation()
                  setFilesOpen((open) => !open)
                }}
                onMouseUp={(event) => event.stopPropagation()}
              >{filesOpen() ? "-" : "+"}</text>
              <text
                fg={hovered() === "files" ? hoverColor : api.theme.current.accent}
                onMouseDown={(event) => {
                  if (event.button === 0) {
                    event.stopPropagation()
                    openRootPicker()
                  }
                }}
              ><b>files</b></text>
              <text
                fg={hovered() === "files" ? hoverColor : api.theme.current.textMuted}
                onMouseDown={(event) => {
                  if (event.button === 0) {
                    event.stopPropagation()
                    openRootPicker()
                  }
                }}
              >[{path.basename(root)}]</text>
            </box>
            <Show when={filesOpen()}>
              <text fg="#AC98C7">{displayPath(root, os.homedir())}</text>
              <box flexDirection="column" gap={1}>
                <For each={tree()} fallback={<text fg={api.theme.current.textMuted}>No visible files</text>}>
                  {(entry) => <box
                    flexDirection="row"
                    paddingLeft={1}
                    paddingRight={1}
                    onMouseOver={() => setHovered(`tree:${entry.relativePath}`)}
                    onMouseOut={() => setHovered()}
                    onMouseDown={(event) => {
                      if (event.button === 2) {
                        insertPath(props.session_id, entry.fullPath, true)
                        void copyText(fileClipboardText(entry.fullPath))
                        return
                      }
                      if (entry.directory) toggleDirectory(entry.relativePath)
                      else insertPath(props.session_id, entry.fullPath, true)
                    }}
                  >
                    <text fg={hovered() === `tree:${entry.relativePath}` ? hoverColor : entry.directory ? directoryColor(entry.depth, DIRECTORY_INDICATOR_COLORS) : api.theme.current.text}>{"  ".repeat(entry.depth)}</text>
                    <text fg={hovered() === `tree:${entry.relativePath}` ? hoverColor : entry.directory ? directoryColor(entry.depth, DIRECTORY_INDICATOR_COLORS) : api.theme.current.text}>
                      {entry.directory ? (expanded().has(entry.relativePath) ? "- " : "+ ") : "  "}
                    </text>
                    <text fg={hovered() === `tree:${entry.relativePath}` ? hoverColor : entry.directory ? directoryColor(entry.depth, DIRECTORY_COLORS) : api.theme.current.text}>{entry.name}</text>
                  </box>}
                </For>
                <Show when={tree().length >= MAX_TREE_ITEMS}>
                  <text fg={api.theme.current.textMuted}>File list truncated. Use refresh or collapse folders.</text>
                </Show>
              </box>

              <Show when={changed().length > 0}>
                <text fg={api.theme.current.accent}><b>Changed Files</b></text>
                <For each={changed()}>{(file) => <text fg={api.theme.current.textMuted}>{file.file}</text>}</For>
              </Show>
            </Show>
          </box>
        )
      },
    },
  })
}

const plugin: TuiPluginModule & { id: string } = {
  id: "openSidebar",
  tui,
}

export default plugin
