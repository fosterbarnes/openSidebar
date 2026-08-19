import assert from "node:assert/strict"
import test from "node:test"
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { defaultScriptSettings, displayPath, everythingSearchArgs, everythingSearchQuery, loadSidebarSettings, MAX_RECENT_ROOTS, normalizeExtension, normalizeRootPath, normalizeSidebarSettings, normalizeScriptSettings, parseLauncher, promptProjectDirectory, readCursorSessionToken, readScripts, readTree, rootPathKey, rootSections, runEverythingSearch, sameRootPath, saveSidebarSettings, saveUserScriptSettings, sessionProjectDirectory, sidebarConfigPaths, writeCursorSessionToken, clearCursorSessionToken, cursorSessionSecretPath } from "../src/helpers.ts"
import { cursorSessionCookie, cursorDbPath, probeCursorUsage, probeOpenAIUsage, probeOpenCodeGoUsage, probeOpenRouterUsage, resolveAuthPath } from "../src/usage.ts"
import { commandArgs, scriptCommand, weztermArgs, weztermSendArgs } from "../src/script-runner.ts"

test("reads sorted package scripts", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "sidebar-tools-"))
  try {
    writeFileSync(
      path.join(root, "package.json"),
      JSON.stringify({ scripts: { test: "test", build: "build", "bad && delete": "danger" } })
    )
    assert.deepEqual(readScripts(root).map((script) => script.name), ["build", "test"])
    const settings = defaultScriptSettings()
    settings.shell = { executable: "bash", args: ["-c"] }
    assert.deepEqual(readScripts(root, root, settings)[0].launcher, settings.shell)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("discovers supported files in the active .scripts directory", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "sidebar-tools-"))
  try {
    mkdirSync(path.join(root, ".scripts"))
    writeFileSync(path.join(root, ".scripts", ".draftRelease.ps1"), "")
    writeFileSync(path.join(root, ".scripts", "notes.txt"), "")
    const scripts = readScripts(root, root)
    assert.deepEqual(scripts.map((script) => script.name), [path.join(".scripts", ".draftRelease.ps1")])
    assert.match(scripts[0].command, /\.draftRelease\.ps1/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("builds persistent PowerShell arguments for native script runners", () => {
  const args = commandArgs("npm run build")
  assert.deepEqual(args.slice(0, 3), ["-NoLogo", "-NoExit", "-EncodedCommand"])
  assert.equal(Buffer.from(args[3], "base64").toString("utf16le"), "npm run build")
})

test("resolves OpenCode auth paths and parses subscription windows", async () => {
  assert.equal(resolveAuthPath({ platform: "win32", env: {}, homeDir: "C:\\Users\\test" }), path.join("C:\\Users\\test", "AppData", "Local", "opencode", "auth.json"))
  assert.equal(resolveAuthPath({ platform: "linux", env: { XDG_DATA_HOME: "/tmp/data" }, homeDir: "/home/test" }), path.join("/tmp/data", "opencode", "auth.json"))

  const root = mkdtempSync(path.join(os.tmpdir(), "sidebar-usage-"))
  try {
    const authPath = path.join(root, "auth.json")
    writeFileSync(authPath, JSON.stringify({ openai: { access: "secret", accountId: "account", expires: Date.now() + 60_000 } }))
    let requestUrl = ""
    let requestMethod = ""
    const result = await probeOpenAIUsage({
      authPath,
      fetchImpl: async (url, init) => {
        requestUrl = String(url)
        requestMethod = init?.method ?? "GET"
        return new Response(JSON.stringify({
          plan_type: "plus",
          rate_limit: {
            primary_window: { used_percent: 27.5, reset_after_seconds: 3600, limit_window_seconds: 18_000 },
            secondary_window: { used_percent: 101, reset_at: 3600, limit_window_seconds: 604_800 },
          },
        }), { status: 200 })
      },
    })
    assert.equal(result.ok, true)
    assert.match(requestUrl, /chatgpt\.com\/backend-api\/wham\/usage$/)
    assert.equal(requestMethod, "GET")
    if (result.ok) {
      assert.equal(result.primary.usedPercent, 28)
      assert.equal(result.primary.minutes, 300)
      assert.equal(result.secondary.usedPercent, 100)
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("rejects a successful response without usage windows", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "sidebar-usage-"))
  try {
    const authPath = path.join(root, "auth.json")
    writeFileSync(authPath, JSON.stringify({ openai: { access: "secret" } }))
    const result = await probeOpenAIUsage({
      authPath,
      fetchImpl: async () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
    })
    assert.deepEqual(result, { ok: false })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("rejects malformed usage window values", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "sidebar-usage-"))
  try {
    const authPath = path.join(root, "auth.json")
    writeFileSync(authPath, JSON.stringify({ openai: { access: "secret" } }))
    const result = await probeOpenAIUsage({
      authPath,
      fetchImpl: async () => new Response(JSON.stringify({
        plan_type: "plus",
        rate_limit: { primary_window: {}, secondary_window: { used_percent: 20 } },
      }), { status: 200 }),
    })
    assert.deepEqual(result, { ok: false })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("accepts accounts with no secondary usage window", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "sidebar-usage-"))
  try {
    const authPath = path.join(root, "auth.json")
    writeFileSync(authPath, JSON.stringify({ openai: { access: "secret" } }))
    const result = await probeOpenAIUsage({
      authPath,
      fetchImpl: async () => new Response(JSON.stringify({
        plan_type: "plus",
        rate_limit: { primary_window: { used_percent: 4, reset_after_seconds: 60 }, secondary_window: null },
      }), { status: 200 }),
    })
    assert.equal(result.ok, true)
    if (result.ok) {
      assert.equal(result.primary.usedPercent, 4)
      assert.equal(result.secondary.usedPercent, null)
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("returns a neutral state when OpenCode is not connected to OpenAI", async () => {
  const result = await probeOpenAIUsage({ authPath: path.join(os.tmpdir(), "missing-openai-auth.json") })
  assert.deepEqual(result, { ok: false })
})

test("requires reauthentication for an expired OpenAI OAuth credential", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "sidebar-usage-"))
  try {
    const authPath = path.join(root, "auth.json")
    writeFileSync(authPath, JSON.stringify({ openai: { access: "secret", expires: 1_000 } }))
    let requested = false
    const result = await probeOpenAIUsage({
      authPath,
      nowMs: 2_000,
      fetchImpl: async () => {
        requested = true
        return new Response("", { status: 200 })
      },
    })
    assert.deepEqual(result, { ok: false, reason: "reauthenticate" })
    assert.equal(requested, false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("requires reauthentication for an unauthorized OpenAI usage request", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "sidebar-usage-"))
  try {
    const authPath = path.join(root, "auth.json")
    writeFileSync(authPath, JSON.stringify({ openai: { access: "secret" } }))
    const result = await probeOpenAIUsage({
      authPath,
      fetchImpl: async () => new Response("", { status: 401 }),
    })
    assert.deepEqual(result, { ok: false, reason: "reauthenticate" })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("filters generated directories and respects expansion", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "sidebar-tools-"))
  try {
    mkdirSync(path.join(root, "src", "nested"), { recursive: true })
    mkdirSync(path.join(root, "node_modules"))
    writeFileSync(path.join(root, "src", "main.ts"), "")
    writeFileSync(path.join(root, "src", "nested", "child.ts"), "")
    writeFileSync(path.join(root, ".scripts"), "")
    const tree = readTree(root, new Set(["src"]))
    assert.equal(tree.some((entry) => entry.name === "node_modules"), false)
    assert.equal(tree.some((entry) => entry.name === ".scripts"), true)
    assert.equal(tree.some((entry) => entry.relativePath === path.join("src", "main.ts")), true)
    assert.equal(tree.some((entry) => entry.name === "child.ts"), false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("expands directories beyond the old shallow depth limit", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "sidebar-tools-"))
  try {
    const nested = path.join(root, "one", "two", "three", "four")
    mkdirSync(nested, { recursive: true })
    writeFileSync(path.join(nested, "deep.ts"), "")
    const expanded = new Set([
      "one",
      path.join("one", "two"),
      path.join("one", "two", "three"),
      path.join("one", "two", "three", "four"),
    ])
    const tree = readTree(root, expanded)
    assert.equal(tree.some((entry) => entry.name === "deep.ts"), true)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("normalizes script settings and extensions", () => {
  const settings = normalizeScriptSettings({
    shell: { executable: " bash ", args: ["-c"] },
    languages: [{
      id: "custom",
      title: "Custom",
      enabled: false,
      launcher: { executable: "runner", args: ["--watch"] },
      extensions: ["foo", ".FOO", "bad extension"],
    }],
  })
  assert.deepEqual(settings.shell, { executable: "bash", args: ["-c"] })
  const custom = settings.languages.find((language) => language.id === "custom")
  assert.deepEqual(custom?.extensions, [".foo"])
  assert.equal(custom?.enabled, false)
  assert.equal(settings.languages.some((language) => language.id === "powershell"), true)
  assert.equal(normalizeExtension(".d.ts"), ".d.ts")
  assert.equal(normalizeExtension("bad extension"), undefined)
})

test("parses custom executable arguments without a shell", () => {
  assert.deepEqual(parseLauncher('runner "--label=hello world"'), ["runner", "--label=hello world"])
  assert.equal(parseLauncher('runner "unterminated'), undefined)
})

test("normalizes native and WezTerm terminal settings", () => {
  assert.equal(normalizeScriptSettings({ terminal: "wezterm-window" }).terminal, "wezterm-window")
  assert.equal(normalizeScriptSettings({ terminal: "unsupported" }).terminal, "native")
  assert.equal(defaultScriptSettings().terminal, "native")
})

test("normalizes WezTerm split sizes and inherits missing defaults", () => {
  const settings = normalizeScriptSettings({
    wezterm: {
      horizontal: { Percent: 30 },
      vertical: { Cells: 20 },
    },
  })
  assert.deepEqual(settings.wezterm, { horizontal: { Percent: 30 }, vertical: { Cells: 20 } })
  assert.deepEqual(normalizeScriptSettings({ wezterm: { horizontal: { Percent: 100 }, vertical: { Cells: 0 } } }).wezterm, {
    horizontal: { Percent: 50 },
    vertical: { Percent: 50 },
  })
  assert.deepEqual(normalizeScriptSettings({ wezterm: { horizontal: { Cells: 12 } } }).wezterm, {
    horizontal: { Cells: 12 },
    vertical: { Percent: 50 },
  })
})

test("builds shell commands for package and language scripts", () => {
  assert.equal(scriptCommand({ name: "build", command: "npm run build", terminal: "native", launcher: { executable: "pwsh", args: [] }, weztermSize: { Percent: 50 } }), "npm run build")
  assert.equal(scriptCommand({ name: "run.ps1", command: "", filePath: "C:\\work\\safe folder\\run.ps1", terminal: "native", launcher: { executable: "pwsh", args: ["-File"] }, weztermSize: { Percent: 50 } }), "pwsh '-File' 'C:\\work\\safe folder\\run.ps1'")
})

test("maps WezTerm terminal choices to CLI placement arguments", () => {
  assert.deepEqual(weztermArgs("wezterm-tab", "C:\\work"), ["cli", "spawn", "--cwd", "C:\\work"])
  assert.deepEqual(weztermArgs("wezterm-window", "C:\\work"), ["cli", "spawn", "--new-window", "--cwd", "C:\\work"])
  assert.deepEqual(weztermArgs("wezterm-horizontal", "C:\\work", { Percent: 30 }), ["cli", "split-pane", "--horizontal", "--percent", "30", "--cwd", "C:\\work"])
  assert.deepEqual(weztermArgs("wezterm-vertical", "C:\\work", { Cells: 20 }), ["cli", "split-pane", "--bottom", "--cells", "20", "--cwd", "C:\\work"])
})

test("places commands without submitting them and submits only when running", () => {
  const script = { name: "build", command: "npm run build", terminal: "wezterm-tab" as const, launcher: { executable: "pwsh", args: [] }, weztermSize: { Percent: 50 } }
  assert.deepEqual(weztermSendArgs(script, "7", false), ["cli", "send-text", "--pane-id", "7", "--no-paste", "npm run build"])
  assert.deepEqual(weztermSendArgs(script, "7", true), ["cli", "send-text", "--pane-id", "7", "--no-paste", "npm run build\r"])
})

test("discovers only enabled configured script extensions", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "sidebar-tools-"))
  try {
    mkdirSync(path.join(root, ".scripts"))
    writeFileSync(path.join(root, ".scripts", "run.foo"), "")
    writeFileSync(path.join(root, ".scripts", "skip.bar"), "")
    const settings = defaultScriptSettings()
    settings.languages = [{
      id: "custom",
      title: "Custom",
      enabled: true,
      launcher: { executable: "runner", args: ["--file"] },
      extensions: [".foo"],
    }, {
      id: "disabled",
      title: "Disabled",
      enabled: false,
      launcher: { executable: "runner", args: [] },
      extensions: [".bar"],
    }]
    const scripts = readScripts(root, root, settings)
    assert.deepEqual(scripts.map((script) => script.name), [path.join(".scripts", "run.foo")])
    assert.deepEqual(scripts[0].launcher, { executable: "runner", args: ["--file"] })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("orders recent roots and keeps favorites outside the recent limit", () => {
  const roots = Array.from({ length: MAX_RECENT_ROOTS + 2 }, (_, index) => `root-${MAX_RECENT_ROOTS + 1 - index}`)
  const sections = rootSections(roots, ["root-0", "root-0", "root-9"], () => true)
  assert.deepEqual(sections.favoriteRoots, ["root-0", "root-9"])
  assert.deepEqual(sections.recentRoots, [
    "root-8",
    "root-7",
    "root-6",
    "root-5",
    "root-4",
    "root-3",
    "root-2",
    "root-1",
  ])
})

test("filters stale roots and removes duplicate recent entries", () => {
  const sections = rootSections(
    ["missing", "valid", "valid", "favorite"],
    ["favorite", "stale"],
    (root) => root === "valid" || root === "favorite",
  )
  assert.deepEqual(sections, { recentRoots: ["valid"], favoriteRoots: ["favorite"] })
})

test("normalizes root paths for identity on Windows-style separators", () => {
  if (process.platform !== "win32") return
  const first = "C:\\Work\\repo"
  const second = "C:/Work/repo"
  assert.equal(rootPathKey(first), rootPathKey(second))
  assert.ok(sameRootPath(normalizeRootPath(first), normalizeRootPath(second)))
})

test("migrates recent file roots from legacy session customRoots", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "sidebar-recent-"))
  const custom = path.join(root, "custom")
  mkdirSync(custom)
  try {
    const settings = normalizeSidebarSettings({
      fileRoots: { session: { customRoots: [custom, custom], activeRoot: custom } },
    })
    assert.deepEqual(settings.recentFileRoots, [normalizeRootPath(custom)])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("builds Everything search query scoped to roots", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "sidebar-es-query-"))
  const nested = path.join(root, "nested")
  mkdirSync(nested)
  try {
    const query = everythingSearchQuery([root, nested], "readme")
    assert.match(query, /readme/)
    assert.doesNotMatch(query, /parent:/)
    assert.match(query, new RegExp(path.basename(root)))
    assert.match(query, /\|/)
    assert.ok(query.includes(`${nested}${path.sep}`))
    assert.doesNotMatch(query, /"/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("parses Everything search output and reports IPC errors", async () => {
  const file = path.join(os.tmpdir(), `sidebar-es-${process.pid}.txt`)
  writeFileSync(file, "sample")
  try {
    let capturedArgs: string[] = []
    const ok = await runEverythingSearch({
      query: "sample",
      roots: [os.tmpdir()],
      spawnImpl: async (_executable, args) => {
        capturedArgs = args
        return { stdout: `${file}\n`, code: 0 }
      },
    })
    assert.equal(ok.ok, true)
    if (ok.ok) {
      assert.equal(ok.entries.length, 1)
      assert.equal(ok.entries[0]?.directory, false)
    }
    assert.equal(capturedArgs.at(-2), "-search")
    assert.match(capturedArgs.at(-1) ?? "", /sample/)
    const ipc = await runEverythingSearch({
      query: "x",
      roots: [os.tmpdir()],
      spawnImpl: async () => ({ stdout: "", code: 8 }),
    })
    assert.deepEqual(ipc, { ok: false, error: "ipc-unavailable" })
    const missing = await runEverythingSearch({
      query: "x",
      roots: [os.tmpdir()],
      spawnImpl: async () => ({ stdout: "", code: null, error: Object.assign(new Error("missing"), { code: "ENOENT" }) }),
    })
    assert.deepEqual(missing, { ok: false, error: "missing-es" })
    const aborted = new AbortController()
    aborted.abort()
    const cancelled = await runEverythingSearch({
      query: "x",
      roots: [os.tmpdir()],
      signal: aborted.signal,
      spawnImpl: async () => ({ stdout: "", code: 1 }),
    })
    assert.deepEqual(cancelled, { ok: false, error: "aborted" })
  } finally {
    rmSync(file, { force: true })
  }
  assert.deepEqual(everythingSearchArgs("test query"), ["-n", "80", "-timeout", "2000", "-hide-empty-search-results", "-search", "test query"])
})

test("returns a neutral state for failed OpenAI usage requests", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "sidebar-usage-"))
  try {
    const authPath = path.join(root, "auth.json")
    writeFileSync(authPath, JSON.stringify({ openai: { access: "secret" } }))
    const result = await probeOpenAIUsage({
      authPath,
      fetchImpl: async () => new Response("", { status: 503 }),
    })
    assert.deepEqual(result, { ok: false })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("parses OpenCode Go weekly usage with its reset date", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "sidebar-go-usage-"))
  try {
    const authPath = path.join(root, "auth.json")
    writeFileSync(authPath, JSON.stringify({ "opencode-go": { key: "secret" } }))
    let requestUrl = ""
    let authorization = ""
    const result = await probeOpenCodeGoUsage({
      authPath,
      fetchImpl: async (url, init) => {
        requestUrl = String(url)
        authorization = String(new Headers(init?.headers).get("authorization"))
        return new Response(JSON.stringify({
          usage: { weekly: { status: "ok", percent: 27.5, resetsAt: "2026-08-17T00:00:00.000Z" } },
        }), { status: 200 })
      },
    })
    assert.equal(result.ok, true)
    assert.equal(requestUrl, "https://opencode.ai/zen/go/v1/usage")
    assert.equal(authorization, "Bearer secret")
    if (result.ok) {
      assert.equal(result.weekly.usedPercent, 28)
      assert.equal(result.weekly.minutes, 7 * 24 * 60)
      assert.match(result.weekly.resetAt ?? "", /2026/)
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("returns a neutral state for failed OpenCode Go usage requests", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "sidebar-go-usage-"))
  try {
    const authPath = path.join(root, "auth.json")
    writeFileSync(authPath, JSON.stringify({ "opencode-go": { key: "secret" } }))
    const result = await probeOpenCodeGoUsage({
      authPath,
      fetchImpl: async () => new Response("", { status: 503 }),
    })
    assert.deepEqual(result, { ok: false })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("parses OpenRouter key usage against its credit limit", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "sidebar-or-usage-"))
  try {
    const authPath = path.join(root, "auth.json")
    writeFileSync(authPath, JSON.stringify({ openrouter: { type: "api", key: "secret" } }))
    let requestUrl = ""
    let authorization = ""
    const result = await probeOpenRouterUsage({
      authPath,
      fetchImpl: async (url, init) => {
        requestUrl = String(url)
        authorization = String(new Headers(init?.headers).get("authorization"))
        return new Response(JSON.stringify({ data: { limit: 5, limit_remaining: 2.9 } }), { status: 200 })
      },
    })
    assert.equal(result.ok, true)
    assert.equal(requestUrl, "https://openrouter.ai/api/v1/key")
    assert.equal(authorization, "Bearer secret")
    if (result.ok) {
      assert.equal(result.usedPercent, 42)
      assert.equal(result.remainingPercent, 58)
      assert.equal(result.usedUsd, 2.1)
      assert.equal(result.limitUsd, 5)
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("falls back to the OPENROUTER_API_KEY environment variable", async () => {
  let authorization = ""
  const result = await probeOpenRouterUsage({
    authPath: path.join(os.tmpdir(), "missing-openrouter-auth.json"),
    env: { OPENROUTER_API_KEY: "env-secret" },
    fetchImpl: async (url, init) => {
      authorization = String(new Headers(init?.headers).get("authorization"))
      return new Response(JSON.stringify({ data: { limit: 5, limit_remaining: 5 } }), { status: 200 })
    },
  })
  assert.equal(result.ok, true)
  assert.equal(authorization, "Bearer env-secret")
})

test("returns a neutral state for failed OpenRouter usage requests", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "sidebar-or-usage-"))
  try {
    const authPath = path.join(root, "auth.json")
    writeFileSync(authPath, JSON.stringify({ openrouter: { type: "api", key: "secret" } }))
    const failed = await probeOpenRouterUsage({
      authPath,
      fetchImpl: async () => new Response("", { status: 503 }),
    })
    assert.deepEqual(failed, { ok: false })
    const noLimit = await probeOpenRouterUsage({
      authPath,
      fetchImpl: async () => new Response(JSON.stringify({ data: { limit: null, limit_remaining: 2.9 } }), { status: 200 }),
    })
    assert.deepEqual(noLimit, { ok: false })
    const noRemaining = await probeOpenRouterUsage({
      authPath,
      fetchImpl: async () => new Response(JSON.stringify({ data: { limit: 5 } }), { status: 200 }),
    })
    assert.deepEqual(noRemaining, { ok: false })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("formats displayed paths relative to the home directory", () => {
  assert.equal(displayPath("C:\\Users\\Foster\\Documents\\GitHub\\openSidebar", "C:\\Users\\Foster"), "/~Documents/GitHub/openSidebar")
  assert.equal(displayPath("C:\\Users\\Foster", "C:\\Users\\Foster"), "/~")
  assert.equal(displayPath("C:\\Work\\openSidebar", "C:\\Users\\Foster"), "C:/Work/openSidebar")
})

test("loads user sidebar settings with project overrides", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "sidebar-config-"))
  try {
    const paths = sidebarConfigPaths(root, root)
    mkdirSync(path.dirname(paths.user), { recursive: true })
    mkdirSync(path.dirname(paths.project), { recursive: true })
    writeFileSync(paths.user, JSON.stringify({ showMcp: false, showLsp: true, scripts: { terminal: "wezterm-tab" } }))
    writeFileSync(paths.project, JSON.stringify({ showMcp: true, scripts: { terminal: "native" } }))
    const settings = loadSidebarSettings(root, root, paths.user, paths.project)
    assert.deepEqual(settings.visibility, { showMcp: true, showLsp: true })
    assert.equal(settings.scripts.terminal, "native")
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("persists a project directory separately from OpenCode settings", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "sidebar-config-"))
  const projectDirectory = path.join(root, "project")
  mkdirSync(projectDirectory)
  try {
    const settings = normalizeSidebarSettings({ projectDirectory })
    assert.equal(settings.projectDirectory, projectDirectory)
    assert.equal(normalizeSidebarSettings({ projectDirectory: path.join(root, "missing") }).projectDirectory, undefined)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("resolves a project from an initial cd prompt without changing directories", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "sidebar-config-"))
  const project = path.join(root, "crow")
  mkdirSync(project)
  try {
    assert.equal(promptProjectDirectory(`cd ${project}`, root), project)
    assert.equal(promptProjectDirectory(`"cd ${project}"`, root), project)
    assert.equal(promptProjectDirectory(`cd ${path.join(root, "missing")}`, root), undefined)
    assert.equal(promptProjectDirectory(`Set directory to ${project}`, root), undefined)
    assert.equal(sessionProjectDirectory([{ id: "message", role: "user" }], () => [{ type: "text", text: `cd ${project}` }], root), project)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("sidebar settings default to showing MCP and LSP and ignore malformed files", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "sidebar-config-"))
  try {
    const paths = sidebarConfigPaths(root, root)
    mkdirSync(path.dirname(paths.user), { recursive: true })
    writeFileSync(paths.user, "not json")
    assert.deepEqual(loadSidebarSettings(root, root, paths.user, path.join(root, "missing.json")).visibility, {
      showMcp: true,
      showLsp: true,
    })
    assert.deepEqual(normalizeSidebarSettings({ showMcp: false, showLsp: "yes" }).visibility, {
      showMcp: false,
      showLsp: true,
    })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("normalizes persisted pins and session roots", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "sidebar-config-"))
  const custom = path.join(root, "custom")
  mkdirSync(custom)
  try {
    const settings = normalizeSidebarSettings({
      scriptPins: ["build", "build", 4],
      favoriteFileRoots: [custom, "missing"],
      fileRoots: { session: { customRoots: [custom, custom], activeRoot: custom } },
    })
    assert.deepEqual(settings.scriptPins, ["build"])
    assert.deepEqual(settings.favoriteFileRoots, [custom])
    assert.deepEqual(settings.fileRoots.session, { customRoots: [custom], activeRoot: custom })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("migrates legacy file root pins to favorite file roots", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "sidebar-favorites-"))
  const custom = path.join(root, "custom")
  mkdirSync(custom)
  try {
    const settings = normalizeSidebarSettings({ fileRootPins: [custom] })
    assert.deepEqual(settings.favoriteFileRoots, [custom])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("writes complete sidebar settings as JSON", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "sidebar-config-"))
  try {
    const filePath = path.join(root, ".config", "openSidebar.json")
    const settings = defaultScriptSettings()
    const sidebar = normalizeSidebarSettings({ scripts: settings, scriptPins: ["build"] })
    saveSidebarSettings(filePath, sidebar)
    assert.deepEqual(loadSidebarSettings(root, root, path.join(root, "missing-user.json"), filePath).scriptPins, ["build"])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("saveUserScriptSettings persists a global default applied when the project config has no scripts", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "sidebar-user-scripts-"))
  try {
    const home = path.join(root, "home")
    const userPath = path.join(home, ".config", "openSidebar", "config.json")
    mkdirSync(path.dirname(userPath), { recursive: true })
    writeFileSync(userPath, JSON.stringify({ showMcp: true, scripts: { terminal: "native" } }))
    saveUserScriptSettings(home, normalizeScriptSettings({ terminal: "wezterm-vertical", wezterm: { vertical: { Cells: 20 } } }))
    const projectPath = path.join(root, "project", ".config", "openSidebar.json")
    const settings = loadSidebarSettings(path.join(root, "project"), home, userPath, projectPath)
    assert.equal(settings.scripts.terminal, "wezterm-vertical")
    assert.deepEqual(settings.scripts.wezterm.vertical, { Cells: 20 })
    assert.equal(settings.visibility.showMcp, true)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

function fakeCursorJwt(sub: string): string {
  const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url")
  return `${encode({ alg: "none", typ: "JWT" })}.${encode({ sub, aud: "https://cursor.com", type: "session" })}.signature`
}

function cursorSummaryResponse(overrides: Record<string, unknown> = {}): Response {
  return new Response(JSON.stringify({
    billingCycleStart: "2026-08-18T04:42:35.000Z",
    billingCycleEnd: "2026-09-18T04:42:35.000Z",
    membershipType: "pro",
    isUnlimited: false,
    individualUsage: { plan: { used: 28, limit: 2000, remaining: 1972, totalPercentUsed: 0.0566 } },
    ...overrides,
  }), { status: 200 })
}

test("parses Cursor monthly usage with a pasted session cookie", async () => {
  const jwt = fakeCursorJwt("auth0|user_test")
  const missingDb = path.join(os.tmpdir(), "sidebar-cursor-missing-db", "state.vscdb")
  let requestUrl = ""
  let cookie = ""
  const result = await probeCursorUsage({
    cursorDbPath: missingDb,
    cursorSessionToken: `auth0|user_test::${jwt}`,
    fetchImpl: async (url, init) => {
      requestUrl = String(url)
      cookie = String(new Headers(init?.headers).get("cookie"))
      return cursorSummaryResponse()
    },
  })
  assert.equal(result.ok, true)
  assert.equal(requestUrl, "https://cursor.com/api/usage-summary")
  assert.equal(cookie, `WorkosCursorSessionToken=auth0%7Cuser_test%3A%3A${jwt}`)
  if (result.ok) {
    assert.equal(result.monthly.usedPercent, 1)
    assert.equal(result.monthly.apiUsedPercent, null)
    assert.match(result.monthly.resetAt ?? "", /2026/)
  }
})

test("uses Cursor autoPercentUsed when used over limit would disagree", async () => {
  const jwt = fakeCursorJwt("auth0|user_test")
  const result = await probeCursorUsage({
    cursorDbPath: path.join(os.tmpdir(), "sidebar-cursor-missing-db", "state.vscdb"),
    cursorSessionToken: `auth0|user_test::${jwt}`,
    fetchImpl: async () => cursorSummaryResponse({
      individualUsage: {
        plan: {
          used: 467,
          limit: 2000,
          remaining: 1533,
          autoPercentUsed: 1.0377777777777777,
          apiPercentUsed: 0,
          totalPercentUsed: 0.9434343434343434,
        },
      },
    }),
  })
  assert.equal(result.ok, true)
  if (result.ok) {
    assert.equal(result.monthly.usedPercent, 1)
    assert.equal(result.monthly.apiUsedPercent, 0)
  }
})

test("parses Cursor Other Models API percent independently", async () => {
  const jwt = fakeCursorJwt("auth0|user_test")
  const missingDb = path.join(os.tmpdir(), "sidebar-cursor-missing-db", "state.vscdb")
  const result = await probeCursorUsage({
    cursorDbPath: missingDb,
    cursorSessionToken: `auth0|user_test::${jwt}`,
    fetchImpl: async () => cursorSummaryResponse({
      individualUsage: {
        plan: {
          used: 467,
          limit: 2000,
          remaining: 1533,
          autoPercentUsed: 13.4,
          apiPercentUsed: 3.333,
        },
      },
    }),
  })
  assert.equal(result.ok, true)
  if (result.ok) {
    assert.equal(result.monthly.usedPercent, 13)
    assert.equal(result.monthly.apiUsedPercent, 3)
  }
  const omitted = await probeCursorUsage({
    cursorDbPath: missingDb,
    cursorSessionToken: `auth0|user_test::${jwt}`,
    fetchImpl: async () => cursorSummaryResponse({
      individualUsage: { plan: { autoPercentUsed: 13 } },
    }),
  })
  assert.equal(omitted.ok, true)
  if (omitted.ok) {
    assert.equal(omitted.monthly.usedPercent, 13)
    assert.equal(omitted.monthly.apiUsedPercent, null)
  }
})

test("builds a session cookie from a bare Cursor JWT", () => {
  const jwt = fakeCursorJwt("auth0|user_test")
  assert.equal(cursorSessionCookie(jwt), `auth0%7Cuser_test%3A%3A${jwt}`)
  assert.equal(cursorSessionCookie(`auth0|user_test%3A%3A${jwt}`), `auth0%7Cuser_test%3A%3A${jwt}`)
  assert.equal(cursorSessionCookie("not-a-jwt"), undefined)
  assert.equal(cursorSessionCookie(""), undefined)
})

test("auto-reads the Cursor session token from state.vscdb", async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "sidebar-cursor-db-"))
  try {
    let sqlite: typeof import("node:sqlite")
    try {
      sqlite = await import("node:sqlite")
    } catch {
      t.skip("node:sqlite unavailable")
      return
    }
    const dbPath = path.join(root, "state.vscdb")
    const jwt = fakeCursorJwt("auth0|user_db")
    const db = new sqlite.DatabaseSync(dbPath)
    db.exec("CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value TEXT)")
    db.prepare("INSERT INTO ItemTable (key, value) VALUES (?, ?)").run("cursorAuth/accessToken", jwt)
    db.close()
    let cookie = ""
    const result = await probeCursorUsage({
      cursorDbPath: dbPath,
      fetchImpl: async (url, init) => {
        cookie = String(new Headers(init?.headers).get("cookie"))
        return cursorSummaryResponse()
      },
    })
    assert.equal(result.ok, true)
    assert.equal(cookie, `WorkosCursorSessionToken=auth0%7Cuser_db%3A%3A${jwt}`)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("prefers the Cursor app database over a pasted session token", async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "sidebar-cursor-db-first-"))
  try {
    let sqlite: typeof import("node:sqlite")
    try {
      sqlite = await import("node:sqlite")
    } catch {
      t.skip("node:sqlite unavailable")
      return
    }
    const dbPath = path.join(root, "state.vscdb")
    const dbJwt = fakeCursorJwt("auth0|user_db")
    const pasteJwt = fakeCursorJwt("auth0|user_paste")
    const db = new sqlite.DatabaseSync(dbPath)
    db.exec("CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value TEXT)")
    db.prepare("INSERT INTO ItemTable (key, value) VALUES (?, ?)").run("cursorAuth/accessToken", dbJwt)
    db.close()
    let cookie = ""
    const result = await probeCursorUsage({
      cursorDbPath: dbPath,
      cursorSessionToken: `auth0|user_paste::${pasteJwt}`,
      fetchImpl: async (_url, init) => {
        cookie = String(new Headers(init?.headers).get("cookie"))
        return cursorSummaryResponse()
      },
    })
    assert.equal(result.ok, true)
    assert.equal(cookie, `WorkosCursorSessionToken=auth0%7Cuser_db%3A%3A${dbJwt}`)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("resolves the Cursor state database path per platform", () => {
  assert.equal(cursorDbPath({ platform: "win32", env: { APPDATA: "C:\\Users\\test\\AppData\\Roaming" }, homeDir: "C:\\Users\\test" }), path.join("C:\\Users\\test\\AppData\\Roaming", "Cursor", "User", "globalStorage", "state.vscdb"))
  assert.equal(cursorDbPath({ platform: "darwin", env: {}, homeDir: "/Users/test" }), path.join("/Users/test", "Library", "Application Support", "Cursor", "User", "globalStorage", "state.vscdb"))
  assert.equal(cursorDbPath({ platform: "linux", env: { XDG_CONFIG_HOME: "/tmp/config" }, homeDir: "/home/test" }), path.join("/tmp/config", "Cursor", "User", "globalStorage", "state.vscdb"))
})

test("requests a Cursor session token when none is available", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "sidebar-cursor-missing-"))
  try {
    const result = await probeCursorUsage({
      cursorDbPath: path.join(root, "missing", "state.vscdb"),
      fetchImpl: async () => { throw new Error("should not be called") },
    })
    assert.deepEqual(result, { ok: false, reason: "need-token" })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("requires a fresh Cursor session token for unauthorized requests", async () => {
  const jwt = fakeCursorJwt("auth0|user_test")
  const result = await probeCursorUsage({
    cursorDbPath: path.join(os.tmpdir(), "sidebar-cursor-missing-db", "state.vscdb"),
    cursorSessionToken: `auth0|user_test::${jwt}`,
    fetchImpl: async () => new Response("", { status: 401 }),
  })
  assert.deepEqual(result, { ok: false, reason: "reauthenticate" })
})

test("returns a neutral state for failed Cursor usage requests", async () => {
  const jwt = fakeCursorJwt("auth0|user_test")
  const missingDb = path.join(os.tmpdir(), "sidebar-cursor-missing-db", "state.vscdb")
  const failed = await probeCursorUsage({
    cursorDbPath: missingDb,
    cursorSessionToken: `auth0|user_test::${jwt}`,
    fetchImpl: async () => new Response("", { status: 503 }),
  })
  assert.deepEqual(failed, { ok: false })
  const malformed = await probeCursorUsage({
    cursorDbPath: missingDb,
    cursorSessionToken: `auth0|user_test::${jwt}`,
    fetchImpl: async () => new Response(JSON.stringify({ billingCycleEnd: "2026-09-18T04:42:35.000Z" }), { status: 200 }),
  })
  assert.deepEqual(malformed, { ok: false })
})

test("shows an unlimited Cursor plan with its reset date", async () => {
  const jwt = fakeCursorJwt("auth0|user_test")
  const result = await probeCursorUsage({
    cursorDbPath: path.join(os.tmpdir(), "sidebar-cursor-missing-db", "state.vscdb"),
    cursorSessionToken: `auth0|user_test::${jwt}`,
    fetchImpl: async () => cursorSummaryResponse({ isUnlimited: true }),
  })
  assert.equal(result.ok, true)
  if (result.ok) {
    assert.equal(result.monthly.usedPercent, null)
    assert.equal(result.monthly.apiUsedPercent, null)
    assert.match(result.monthly.resetAt ?? "", /2026/)
  }
})

test("persists a Cursor session token without disturbing other settings", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "sidebar-cursor-config-"))
  try {
    const configPath = path.join(root, ".config", "openSidebar", "config.json")
    const secretPath = cursorSessionSecretPath(root)
    assert.equal(readCursorSessionToken(root), undefined)
    mkdirSync(path.dirname(configPath), { recursive: true })
    writeFileSync(configPath, JSON.stringify({ showMcp: false, visibility: { showMcp: false } }))
    writeCursorSessionToken(root, "  auth0|user_test::eyJ.eyJ.x  ")
    const settings = JSON.parse(readFileSync(configPath, "utf8"))
    assert.equal(settings.showMcp, false)
    assert.equal(settings.cursorSessionToken, undefined)
    assert.equal(readFileSync(secretPath, "utf8").trim(), "auth0|user_test::eyJ.eyJ.x")
    assert.equal(readCursorSessionToken(root), "auth0|user_test::eyJ.eyJ.x")
    writeCursorSessionToken(root, "next-token")
    assert.equal(readCursorSessionToken(root), "next-token")
    assert.equal(JSON.parse(readFileSync(configPath, "utf8")).cursorSessionToken, undefined)
    clearCursorSessionToken(root)
    assert.equal(readCursorSessionToken(root), undefined)
    assert.equal(existsSync(secretPath), false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("moves a Cursor session token out of config.json into the secrets file", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "sidebar-cursor-migrate-"))
  try {
    const configPath = path.join(root, ".config", "openSidebar", "config.json")
    mkdirSync(path.dirname(configPath), { recursive: true })
    writeFileSync(configPath, JSON.stringify({ showMcp: false, cursorSessionToken: "legacy-token" }))
    assert.equal(readCursorSessionToken(root), "legacy-token")
    const settings = JSON.parse(readFileSync(configPath, "utf8"))
    assert.equal(settings.showMcp, false)
    assert.equal(settings.cursorSessionToken, undefined)
    assert.equal(readFileSync(cursorSessionSecretPath(root), "utf8").trim(), "legacy-token")
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

