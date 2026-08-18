import { readFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

const USAGE_URL = "https://chatgpt.com/backend-api/wham/usage"
const GO_USAGE_URL = "https://opencode.ai/zen/go/v1/usage"
const OPENROUTER_URL = "https://openrouter.ai/api/v1/key"
const CURSOR_USAGE_URL = "https://cursor.com/api/usage-summary"
const REQUEST_TIMEOUT_MS = 15_000

export type UsageWindow = {
  usedPercent: number | null
  resetAt: string | null
  minutes: number | null
}

export type OpenAIUsage = {
  ok: true
  primary: UsageWindow
  secondary: UsageWindow
} | {
  ok: false
  reason?: "reauthenticate"
}

class UsageRequestError extends Error {
  readonly status: number

  constructor(status: number) {
    super(`Usage request failed with status ${status}.`)
    this.status = status
  }
}

export type OpenCodeGoUsage = {
  ok: true
  weekly: UsageWindow
} | {
  ok: false
}

export type OpenRouterUsage = {
  ok: true
  usedPercent: number
  remainingPercent: number
  usedUsd: number
  limitUsd: number
} | {
  ok: false
}

export type CursorUsage = {
  ok: true
  monthly: UsageWindow
} | {
  ok: false
  reason?: "need-token" | "reauthenticate"
}

type UsageOptions = {
  authPath?: string
  cursorSessionToken?: string
  cursorDbPath?: string
  env?: NodeJS.ProcessEnv
  homeDir?: string
  fetchImpl?: typeof fetch
  nowMs?: number
  timeoutMs?: number
  signal?: AbortSignal
}

export function resolveAuthPath({
  platform = process.platform,
  env = process.env,
  homeDir = os.homedir(),
}: {
  platform?: NodeJS.Platform
  env?: NodeJS.ProcessEnv
  homeDir?: string
} = {}): string {
  if (env.OPENCODE_AUTH_PATH) return env.OPENCODE_AUTH_PATH
  if (platform === "win32") return path.join(env.LOCALAPPDATA ?? path.join(homeDir, "AppData", "Local"), "opencode", "auth.json")
  if (platform === "darwin") return path.join(homeDir, "Library", "Application Support", "opencode", "auth.json")
  return path.join(env.XDG_DATA_HOME ?? path.join(homeDir, ".local", "share"), "opencode", "auth.json")
}

function resetDate(resetAt: unknown, resetAfterSeconds: unknown, nowMs: number): string | null {
  const timestamp = typeof resetAt === "number" && Number.isFinite(resetAt)
    ? resetAt
    : typeof resetAfterSeconds === "number" && Number.isFinite(resetAfterSeconds) && resetAfterSeconds >= 0
      ? nowMs / 1000 + resetAfterSeconds
      : null
  if (timestamp === null) return null
  const date = new Date(timestamp > 1_000_000_000_000 ? timestamp : timestamp * 1000)
  return Number.isNaN(date.valueOf())
    ? null
    : date.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })
}

function windowFromUsage(value: unknown, nowMs: number): UsageWindow | null {
  if (!value || typeof value !== "object") return null
  const window = value as { used_percent?: unknown; reset_at?: unknown; reset_after_seconds?: unknown; limit_window_seconds?: unknown }
  if (typeof window.used_percent !== "number" || !Number.isFinite(window.used_percent)) return null
  const usedPercent = Math.round(Math.max(0, Math.min(100, window.used_percent)))
  const minutes = typeof window.limit_window_seconds === "number" ? Math.round(window.limit_window_seconds / 60) : null
  return { usedPercent, resetAt: resetDate(window.reset_at, window.reset_after_seconds, nowMs), minutes }
}

function parseUsageResponse(value: unknown, nowMs: number): OpenAIUsage {
  if (!value || typeof value !== "object") return errorResult()
  const body = value as { rate_limit?: { primary_window?: unknown; secondary_window?: unknown } }
  const primary = windowFromUsage(body.rate_limit?.primary_window, nowMs)
  const secondary = windowFromUsage(body.rate_limit?.secondary_window, nowMs) ?? { usedPercent: null, resetAt: null, minutes: null }
  if (!primary) return errorResult()
  return {
    ok: true,
    primary,
    secondary,
  }
}

function usageHeaders(credentials: { access: string; accountId?: string }) {
  return {
    Authorization: `Bearer ${credentials.access}`,
    accept: "application/json",
    ...(credentials.accountId ? { "chatgpt-account-id": credentials.accountId } : {}),
  }
}

function errorResult(): OpenAIUsage {
  return { ok: false }
}

function goErrorResult(): OpenCodeGoUsage {
  return { ok: false }
}

function openRouterErrorResult(): OpenRouterUsage {
  return { ok: false }
}

async function fetchUsageResponse(
  options: UsageOptions,
  url: string,
  headers: Record<string, string>,
): Promise<unknown> {
  const fetchImpl = options.fetchImpl ?? fetch
  const response = await fetchImpl(url, {
    method: "GET",
    headers,
    signal: options.signal
      ? AbortSignal.any([options.signal, AbortSignal.timeout(options.timeoutMs ?? REQUEST_TIMEOUT_MS)])
      : AbortSignal.timeout(options.timeoutMs ?? REQUEST_TIMEOUT_MS),
  })
  if (!response.ok) throw new UsageRequestError(response.status)
  return response.json()
}

async function readAuthContent(options: UsageOptions): Promise<string> {
  if (options.env?.OPENCODE_AUTH_CONTENT) return options.env.OPENCODE_AUTH_CONTENT
  const authPaths = options.authPath
    ? [options.authPath]
    : [
        resolveAuthPath({ env: options.env, homeDir: options.homeDir }),
        path.join(options.homeDir ?? os.homedir(), ".local", "share", "opencode", "auth.json"),
      ]
  for (const authPath of [...new Set(authPaths)]) {
    try {
      return await readFile(authPath, "utf8")
    } catch {
      continue
    }
  }
  throw new Error("auth file not found")
}

export async function probeOpenAIUsage(options: UsageOptions = {}): Promise<OpenAIUsage> {
  const nowMs = options.nowMs ?? Date.now()
  let credentials: { access: string; accountId?: string }
  try {
    const raw = await readAuthContent(options)
    const openai = (JSON.parse(raw) as { openai?: { access?: unknown; accountId?: unknown; expires?: unknown } }).openai
    if (typeof openai?.expires === "number" && Number.isFinite(openai.expires) && openai.expires <= nowMs) {
      return { ok: false, reason: "reauthenticate" }
    }
    if (typeof openai?.access !== "string" || openai.access.trim() === "") return errorResult()
    credentials = {
      access: openai.access,
      accountId: typeof openai.accountId === "string" ? openai.accountId : undefined,
    }
  } catch {
    return errorResult()
  }

  try {
    return parseUsageResponse(await fetchUsageResponse(options, USAGE_URL, usageHeaders(credentials)), nowMs)
  } catch (error) {
    if (error instanceof UsageRequestError && error.status === 401) {
      return { ok: false, reason: "reauthenticate" }
    }
    return errorResult()
  }
}

function parseGoUsageResponse(value: unknown): OpenCodeGoUsage {
  if (!value || typeof value !== "object") return goErrorResult()
  const weekly = (value as { usage?: { weekly?: unknown } }).usage?.weekly
  if (!weekly || typeof weekly !== "object") return goErrorResult()
  const window = weekly as { percent?: unknown; resetsAt?: unknown }
  if (typeof window.percent !== "number" || !Number.isFinite(window.percent)) return goErrorResult()
  if (typeof window.resetsAt !== "string" || Number.isNaN(new Date(window.resetsAt).valueOf())) return goErrorResult()
  return {
    ok: true,
    weekly: {
      usedPercent: Math.round(Math.max(0, Math.min(100, window.percent))),
      resetAt: new Date(window.resetsAt).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }),
      minutes: 7 * 24 * 60,
    },
  }
}

export async function probeOpenCodeGoUsage(options: UsageOptions = {}): Promise<OpenCodeGoUsage> {
  let key: string
  try {
    const raw = await readAuthContent(options)
    const credential = (JSON.parse(raw) as { "opencode-go"?: { key?: unknown } })["opencode-go"]
    if (typeof credential?.key !== "string" || credential.key.trim() === "") return goErrorResult()
    key = credential.key
  } catch {
    return goErrorResult()
  }

  try {
    return parseGoUsageResponse(await fetchUsageResponse(options, GO_USAGE_URL, { Authorization: `Bearer ${key}`, accept: "application/json" }))
  } catch {
    return goErrorResult()
  }
}

function parseOpenRouterResponse(value: unknown): OpenRouterUsage {
  if (!value || typeof value !== "object") return openRouterErrorResult()
  const data = (value as { data?: { limit?: unknown; limit_remaining?: unknown } }).data
  if (!data || typeof data !== "object") return openRouterErrorResult()
  const { limit, limit_remaining } = data
  if (typeof limit !== "number" || !Number.isFinite(limit) || limit <= 0) return openRouterErrorResult()
  if (typeof limit_remaining !== "number" || !Number.isFinite(limit_remaining)) return openRouterErrorResult()
  const remaining = Math.max(0, Math.min(limit, limit_remaining))
  const usedUsd = limit - remaining
  return {
    ok: true,
    usedPercent: Math.round(usedUsd / limit * 100),
    remainingPercent: Math.round(remaining / limit * 100),
    usedUsd,
    limitUsd: limit,
  }
}

export async function probeOpenRouterUsage(options: UsageOptions = {}): Promise<OpenRouterUsage> {
  let key: string | undefined
  if (typeof options.env?.OPENROUTER_API_KEY === "string" && options.env.OPENROUTER_API_KEY.trim() !== "") {
    key = options.env.OPENROUTER_API_KEY.trim()
  } else {
    try {
      const raw = await readAuthContent(options)
      const credential = (JSON.parse(raw) as { openrouter?: { key?: unknown } }).openrouter
      if (typeof credential?.key === "string" && credential.key.trim() !== "") key = credential.key.trim()
    } catch {
      key = undefined
    }
  }
  if (!key) return openRouterErrorResult()

  try {
    return parseOpenRouterResponse(await fetchUsageResponse(options, OPENROUTER_URL, { Authorization: `Bearer ${key}`, accept: "application/json" }))
  } catch {
    return openRouterErrorResult()
  }
}

export function cursorDbPath({
  platform = process.platform,
  env = process.env,
  homeDir = os.homedir(),
}: {
  platform?: NodeJS.Platform
  env?: NodeJS.ProcessEnv
  homeDir?: string
} = {}): string {
  const database = path.join("User", "globalStorage", "state.vscdb")
  if (platform === "win32") return path.join(env.APPDATA ?? path.join(homeDir, "AppData", "Roaming"), "Cursor", database)
  if (platform === "darwin") return path.join(homeDir, "Library", "Application Support", "Cursor", database)
  return path.join(env.XDG_CONFIG_HOME ?? path.join(homeDir, ".config"), "Cursor", database)
}

async function readCursorAccessToken(dbPath: string): Promise<string | undefined> {
  try {
    const sqlite = await import("node:sqlite")
    const db = new sqlite.DatabaseSync(dbPath, { readOnly: true })
    try {
      const row = db.prepare("SELECT value FROM ItemTable WHERE key = 'cursorAuth/accessToken'").get() as { value?: unknown } | undefined
      const value = row?.value
      if (typeof value === "string") return value
      if (value instanceof Uint8Array) return Buffer.from(value).toString("utf8")
      return undefined
    } finally {
      db.close()
    }
  } catch {
    return undefined
  }
}

export function cursorSessionCookie(value: string): string | undefined {
  const token = value.trim()
  if (!token) return undefined
  const decoded = token.includes("%3A%3A") ? token.replaceAll("%3A%3A", "::") : token
  const separator = decoded.indexOf("::")
  const jwt = separator === -1 ? decoded : decoded.slice(separator + 2)
  const parts = jwt.split(".")
  if (parts.length !== 3) return undefined
  const payload = parts[1].replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(parts[1].length / 4) * 4, "=")
  let sub: unknown
  try {
    sub = (JSON.parse(Buffer.from(payload, "base64").toString("utf8")) as { sub?: unknown }).sub
  } catch {
    return undefined
  }
  if (typeof sub !== "string" || sub.trim() === "") return undefined
  return `${encodeURIComponent(sub)}%3A%3A${jwt}`
}

function parseCursorUsageResponse(value: unknown, nowMs: number): CursorUsage {
  if (!value || typeof value !== "object") return { ok: false }
  const body = value as { billingCycleEnd?: unknown; billingCycleStart?: unknown; isUnlimited?: unknown; individualUsage?: unknown }
  const resetAt = [body.billingCycleEnd, body.billingCycleStart]
    .filter((item): item is string => typeof item === "string")
    .map((iso) => new Date(iso))
    .find((date) => !Number.isNaN(date.valueOf()))
  if (!resetAt) return { ok: false }
  const plan = body.individualUsage && typeof body.individualUsage === "object"
    ? (body.individualUsage as { plan?: unknown }).plan
    : undefined
  if (!plan || typeof plan !== "object") return { ok: false }
  const window = plan as { used?: unknown; limit?: unknown; autoPercentUsed?: unknown; totalPercentUsed?: unknown }
  const usedPercent = body.isUnlimited === true
    ? null
    : typeof window.autoPercentUsed === "number" && Number.isFinite(window.autoPercentUsed)
      ? Math.round(Math.max(0, Math.min(100, window.autoPercentUsed)))
      : typeof window.used === "number" && Number.isFinite(window.used)
        && typeof window.limit === "number" && Number.isFinite(window.limit) && window.limit > 0
        ? Math.round(Math.max(0, Math.min(100, window.used / window.limit * 100)))
        : typeof window.totalPercentUsed === "number" && Number.isFinite(window.totalPercentUsed)
          ? Math.round(Math.max(0, Math.min(100, window.totalPercentUsed <= 1 ? window.totalPercentUsed * 100 : window.totalPercentUsed)))
          : null
  if (usedPercent === null && body.isUnlimited !== true) return { ok: false }
  return {
    ok: true,
    monthly: {
      usedPercent,
      resetAt: resetAt.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }),
      minutes: null,
    },
  }
}

export async function probeCursorUsage(options: UsageOptions = {}): Promise<CursorUsage> {
  let token = await readCursorAccessToken(options.cursorDbPath ?? cursorDbPath({ env: options.env, homeDir: options.homeDir }))
  if (!token) token = options.cursorSessionToken?.trim()
  if (!token) return { ok: false, reason: "need-token" }
  const cookie = cursorSessionCookie(token)
  if (!cookie) return { ok: false, reason: "need-token" }

  try {
    return parseCursorUsageResponse(await fetchUsageResponse(options, CURSOR_USAGE_URL, { Cookie: `WorkosCursorSessionToken=${cookie}`, accept: "application/json" }), options.nowMs ?? Date.now())
  } catch (error) {
    if (error instanceof UsageRequestError && (error.status === 401 || error.status === 403)) {
      return { ok: false, reason: "reauthenticate" }
    }
    return { ok: false }
  }
}

