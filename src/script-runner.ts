import { spawn } from "node:child_process"
import type { Script } from "./helpers.js"

export type RunTarget = "pwsh"

function available(command: string): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = spawn(process.platform === "win32" ? "where.exe" : "which", [command], {
      stdio: "ignore",
      windowsHide: true,
    })
    probe.once("error", () => resolve(false))
    probe.once("close", (code) => resolve(code === 0))
  })
}

function spawnCommand(command: string, args: string[], cwd: string): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false
    const child = spawn(command, args, {
      cwd,
      detached: true,
      stdio: "ignore",
      windowsHide: false,
    })
    const finish = (started: boolean) => {
      if (settled) return
      settled = true
      resolve(started)
    }
    child.once("error", () => finish(false))
    child.once("spawn", () => {
      child.unref()
      finish(true)
    })
  })
}

function shellArgs(command: string): string[] {
  const encoded = Buffer.from(command, "utf16le").toString("base64")
  return ["-NoLogo", "-NoExit", "-EncodedCommand", encoded]
}

export async function runScript(script: Script, cwd: string): Promise<RunTarget | undefined> {
  if (!await available("pwsh")) return undefined
  const command = process.platform === "win32" ? "cmd.exe" : "pwsh"
  const args = process.platform === "win32"
    ? ["/d", "/c", "start", "", "pwsh", ...shellArgs(script.command)]
    : shellArgs(script.command)
  return await spawnCommand(command, args, cwd) ? "pwsh" : undefined
}

export function commandArgs(command: string): string[] {
  return shellArgs(command)
}
