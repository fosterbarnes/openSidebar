import { For, Show, createMemo, createSignal } from "solid-js"
import type { TuiDialogSelectProps, TuiPlugin, TuiPluginModule, TuiPromptRef } from "@opencode-ai/plugin/tui"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { isDirectory, readScripts, readTree, rootSections, type Script } from "./helpers.js"
import { probeOpenAIUsage, type OpenAIUsage } from "./usage.js"
import { runScript as runNativeScript } from "./script-runner.js"

const DIRECTORY_COLORS = ["#F7E9B5", "#F4E1A0", "#F1D98B", "#EED076", "#EBC861"]
const DIRECTORY_INDICATOR_COLORS = ["#DCCF99", "#D5C184", "#CEB56F", "#C7A95A", "#C09D45"]
const MAX_TREE_ITEMS = 80
const ADD_ROOT = "__sidebar_add_custom_root__"
const RESET_ROOT = "__sidebar_reset_project_root__"
const RECENT_ROOTS = "__sidebar_recent_custom_roots__"
const FAVORITE_ROOTS = "__sidebar_favorite_custom_roots__"
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

function rootPinKey(worktree: string): string {
  return `opencode-sidebar-tools:file-root-pins:${worktree}`
}

function rootsKey(sessionID: string): string {
  return `opencode-sidebar-tools:file-roots:${sessionID}`
}

type RootState = { customRoots: string[]; activeRoot?: string }
type SelectedModel = { providerID: string; modelID: string }

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
  const value = api.kv.get<unknown>(rootPinKey(worktree), [])
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

const tui: TuiPlugin = async (api) => {
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
  let project = projectRoot()
  let rootState = loadRootState(api, sessionID)
  let root = rootState.activeRoot || project
  const hoverColor = midpointColor(api.theme.current.primary, DIRECTORY_COLORS[0])
  const headerButtonColor = palerColor(api.theme.current.accent)
  const promptRefs = new Map<string, TuiPromptRef>()
  const [scripts, setScripts] = createSignal(readScripts(project, root))
  const [scriptsOpen, setScriptsOpen] = createSignal(true)
  const [filesOpen, setFilesOpen] = createSignal(true)
  const [hovered, setHovered] = createSignal<string>()
  const [usage, setUsage] = createSignal<OpenAIUsage>({ ok: false })
  const [showRemaining, setShowRemaining] = createSignal(false)
  const [model, setModel] = createSignal<SelectedModel>()
  const [variant, setVariant] = createSignal("none")
  const [expanded, setExpanded] = createSignal<Set<string>>(new Set(["."]))
  const [tree, setTree] = createSignal(readTree(root, expanded()))
  let pins = loadPins(api, project)
  let rootPins = loadRootPins(api, project)
  let usageRunning = false
  const usageAbort = new AbortController()
  let modelStateWatcher: fs.FSWatcher | undefined

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
      const next = await probeOpenAIUsage({ signal: usageAbort.signal })
      if (!usageAbort.signal.aborted) setUsage(next)
    } finally {
      usageRunning = false
    }
  }
  const usageTimer = setInterval(() => void refreshUsage(), USAGE_REFRESH_INTERVAL_MS)
  void refreshUsage()

  const syncSession = (nextSessionID: string) => {
    const nextProject = projectRoot(nextSessionID)
    if (nextProject === project && nextSessionID === sessionID) return
    sessionID = nextSessionID
    project = nextProject
    rootState = loadRootState(api, sessionID)
    root = rootState.activeRoot || project
    pins = loadPins(api, project)
    rootPins = loadRootPins(api, project)
    setScriptsOpen(true)
    setFilesOpen(true)
    setExpanded(new Set(["."]))
    refreshSelectedModel(sessionID)
    refreshVariant(sessionID)
    setScripts(readScripts(project, root))
    setTree(readTree(root, expanded()))
  }
  const refresh = () => {
    const nextSessionID = currentSessionID()
    syncSession(nextSessionID)
    setScripts(readScripts(project, root))
    setTree(readTree(root, expanded()))
    void refreshUsage()
  }
  const saveRootState = () => api.kv.set(rootsKey(sessionID), rootState)
  const setRoot = (nextRoot: string) => {
    root = nextRoot
    const customRoots = nextRoot === project
      ? rootState.customRoots
      : [nextRoot, ...rootState.customRoots]
    const sections = rootSections(customRoots, [...rootPins])
    rootState = {
      customRoots: [...sections.recentRoots, ...sections.favoriteRoots],
      activeRoot: nextRoot === project ? undefined : nextRoot,
    }
    saveRootState()
    setExpanded(new Set(["."]))
    setScripts(readScripts(project, root))
    setTree(readTree(root, expanded()))
  }
  const savePins = () => api.kv.set(pinKey(project), [...pins].sort())
  const togglePin = (name: string) => {
    if (pins.has(name)) pins.delete(name)
    else pins.add(name)
    savePins()
    api.ui.toast({ variant: "success", message: `${pins.has(name) ? "Pinned" : "Unpinned"} script: ${name}` })
  }
  const saveRootPins = () => api.kv.set(rootPinKey(project), [...rootPins].sort())
  const toggleRootPin = (customRoot: string) => {
    if (rootPins.has(customRoot)) rootPins.delete(customRoot)
    else rootPins.add(customRoot)
    const sections = rootSections(rootState.customRoots, [...rootPins])
    rootState = { ...rootState, customRoots: [...sections.recentRoots, ...sections.favoriteRoots] }
    saveRootState()
    saveRootPins()
    api.ui.toast({ variant: "success", message: `${rootPins.has(customRoot) ? "Pinned" : "Unpinned"} root: ${customRoot}` })
  }
  const runScript = async (script: Script) => {
    const current = api.route.current
    const sessionID = current.name === "session" ? current.params?.sessionID : undefined
    const cwd = typeof sessionID === "string" ? api.state.session.get(sessionID)?.directory : project
    const target = await runNativeScript(script, cwd || project)
    if (target) {
      api.ui.toast({ variant: "success", message: `Started ${script.name} in ${target}.` })
    } else {
      api.ui.toast({ variant: "error", message: "Could not find PowerShell 7 (pwsh)." })
    }
  }
  const weeklyWindow = () => {
    const snapshot = usage()
    if (!snapshot.ok) return undefined
    return snapshot.primary.minutes !== null && snapshot.primary.minutes >= 7 * 24 * 60
      ? snapshot.primary
      : snapshot.secondary.minutes !== null && snapshot.secondary.minutes >= 7 * 24 * 60
        ? snapshot.secondary
        : undefined
  }
  const weeklyUsageText = () => {
    const weekly = weeklyWindow()
    if (!weekly || weekly.usedPercent === null) return { value: "unavailable", remaining: false }
    return showRemaining()
      ? { value: `${100 - weekly.usedPercent}%`, remaining: true }
      : { value: `${weekly.usedPercent}%`, remaining: false }
  }
  const usageRows = () => {
    const text = weeklyUsageText()
    return <>
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
          {text.remaining ? "Usage remaining:" : "Weekly usage:"}
        </text>
        <text fg={api.theme.current.textMuted}>{text.value}</text>
      </box>
      <box flexDirection="row" gap={1}>
        <text fg={api.theme.current.textMuted}>Reset date:</text>
        <text fg={api.theme.current.textMuted}>
          {weeklyWindow()?.resetAt || "unavailable"}
        </text>
      </box>
    </>
  }
  const toggleDirectory = (relativePath: string) => {
    const next = new Set<string>(expanded())
    if (next.has(relativePath)) next.delete(relativePath)
    else next.add(relativePath)
    setExpanded(next)
    setTree(readTree(root, next))
  }
  const insertPath = (sessionID: string, filePath: string, absolute = false) => {
    const ref = promptRefs.get(sessionID)
    if (!ref) {
      api.ui.toast({ variant: "warning", message: "Chat input is not ready yet." })
      return
    }
    const sessionRoot = api.state.session.get(sessionID)?.directory
    const relativePath = sessionRoot ? path.relative(sessionRoot, filePath) : filePath
    const mentionPath = !absolute && relativePath && !path.isAbsolute(relativePath) && !relativePath.startsWith(`..${path.sep}`)
      ? relativePath
      : filePath
    const mention = `@${mentionPath.replaceAll(path.sep, "/")}`
    const input = ref.current.input
    ref.set({ ...ref.current, input: input ? `${input} ${mention}` : mention })
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
  const selectRoot = () => {
    const sections = rootSections(rootState.customRoots, [...rootPins])
    const options = [
      { title: "Add custom dir...", value: ADD_ROOT },
      { title: "Recent", value: RECENT_ROOTS },
      ...sections.recentRoots.map((customRoot) => ({
        title: customRoot,
        value: customRoot,
        category: "Recent",
        footer: rootPins.has(customRoot) ? "* pinned" : "pin",
      })),
      { title: "Favorite", value: FAVORITE_ROOTS },
      ...sections.favoriteRoots.map((customRoot) => ({
        title: customRoot,
        value: customRoot,
        category: "Favorite",
        footer: "* pinned",
      })),
      { title: "Reset to project root", value: RESET_ROOT },
    ]
    const dialogProps = {
      title: `Project: ${project}`,
      skipFilter: true,
      options,
      current: ADD_ROOT,
      onSelect: (option: (typeof options)[number]) => {
        if (option.value === ADD_ROOT) promptForRoot()
        else if (option.value !== RECENT_ROOTS && option.value !== FAVORITE_ROOTS) {
          setRoot(option.value === RESET_ROOT ? project : option.value)
          api.ui.dialog.clear()
        }
      },
    // OpenCode supports renderFilter at runtime; the installed plugin types lag behind it.
    } as unknown as TuiDialogSelectProps<string>
    api.ui.dialog.replace(() => api.ui.DialogSelect(dialogProps))
  }
  const openRootPicker = () => setTimeout(selectRoot, 100)

  const disposers: Array<() => void> = []
  const rootCommands = rootSections(rootState.customRoots, [...rootPins])
  const commands = [
    {
      name: "sidebar.refresh",
      title: "Refresh project sidebar",
      category: "Sidebar",
      namespace: "sidebar",
      run: refresh,
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
      name: commandId("file-root-pin", customRoot),
      title: `Unpin file root: ${customRoot}`,
      category: "Project files",
      namespace: "sidebar",
      run: () => toggleRootPin(customRoot),
    })),
    ...rootCommands.recentRoots.map((customRoot) => ({
      name: commandId("file-root-pin", customRoot),
      title: `Pin file root: ${customRoot}`,
      category: "Project files",
      namespace: "sidebar",
      run: () => toggleRootPin(customRoot),
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
  const registered = api.keymap.registerLayer({ commands })
  if (typeof registered === "function") disposers.push(registered)
  disposers.push(api.event.on("file.watcher.updated", refresh))
  disposers.push(api.event.on("tui.session.select", () => queueMicrotask(refresh)))
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
  api.lifecycle.onDispose(() => {
    usageAbort.abort()
    clearInterval(usageTimer)
    modelStateWatcher?.close()
    disposers.forEach((dispose) => dispose())
  })

  api.slots.register({
    order: 200,
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
            >
              <text
                fg={hovered() === "scripts" ? hoverColor : api.theme.current.text}
                onMouseDown={() => setScriptsOpen((open) => !open)}
              >{scriptsOpen() ? "-" : "+"}</text>
              <text
                fg={hovered() === "scripts" ? hoverColor : api.theme.current.accent}
                onMouseDown={() => setScriptsOpen((open) => !open)}
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
                    if (event.button === 2) insertPath(props.session_id, script.filePath || path.join(project, "package.json"), true)
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
              <text fg={api.theme.current.textMuted}>{root}</text>
              <box flexDirection="column" gap={1}>
                <For each={tree()} fallback={<text fg={api.theme.current.textMuted}>No visible files</text>}>
                  {(entry) => <box
                    flexDirection="row"
                    paddingLeft={1}
                    paddingRight={1}
                    onMouseOver={() => setHovered(`tree:${entry.relativePath}`)}
                    onMouseOut={() => setHovered()}
                    onMouseDown={() => {
                      if (entry.directory) toggleDirectory(entry.relativePath)
                      else insertPath(props.session_id, entry.fullPath)
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
  id: "opencode.sidebar-tools",
  tui,
}

export default plugin
