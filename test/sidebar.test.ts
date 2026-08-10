import assert from "node:assert/strict"
import test from "node:test"
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { readScripts, readTree } from "../src/helpers.ts"
import { probeOpenAIUsage, resolveAuthPath } from "../src/usage.ts"
import { commandArgs } from "../src/script-runner.ts"

test("reads sorted package scripts", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "sidebar-tools-"))
  try {
    writeFileSync(
      path.join(root, "package.json"),
      JSON.stringify({ scripts: { test: "test", build: "build", "bad && delete": "danger" } })
    )
    assert.deepEqual(readScripts(root).map((script) => script.name), ["build", "test"])
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
    writeFileSync(authPath, JSON.stringify({ openai: { access: "secret", accountId: "account" } }))
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
