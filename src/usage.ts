import { readFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

const USAGE_URL = "https://chatgpt.com/backend-api/wham/usage"
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
}

type UsageOptions = {
  authPath?: string
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

export async function probeOpenAIUsage(options: UsageOptions = {}): Promise<OpenAIUsage> {
  const fetchImpl = options.fetchImpl ?? fetch
  const nowMs = options.nowMs ?? Date.now()
  let credentials: { access: string; accountId?: string }
  try {
    const authPaths = options.authPath
      ? [options.authPath]
      : [
          resolveAuthPath({ env: options.env, homeDir: options.homeDir }),
          path.join(options.homeDir ?? os.homedir(), ".local", "share", "opencode", "auth.json"),
        ]
    const raw = options.env?.OPENCODE_AUTH_CONTENT
      ?? await (async () => {
        for (const authPath of [...new Set(authPaths)]) {
          try {
            return await readFile(authPath, "utf8")
          } catch {
            continue
          }
        }
        throw new Error("auth file not found")
      })()
    const openai = (JSON.parse(raw) as { openai?: { access?: unknown; accountId?: unknown } }).openai
    if (typeof openai?.access !== "string" || openai.access.trim() === "") return errorResult()
    credentials = {
      access: openai.access,
      accountId: typeof openai.accountId === "string" ? openai.accountId : undefined,
    }
  } catch {
    return errorResult()
  }

  try {
    const response = await fetchImpl(USAGE_URL, {
      method: "GET",
      headers: usageHeaders(credentials),
      signal: options.signal
        ? AbortSignal.any([options.signal, AbortSignal.timeout(options.timeoutMs ?? REQUEST_TIMEOUT_MS)])
        : AbortSignal.timeout(options.timeoutMs ?? REQUEST_TIMEOUT_MS),
    })
    if (!response.ok) return errorResult()
    return parseUsageResponse(await response.json(), nowMs)
  } catch {
    return errorResult()
  }
}
