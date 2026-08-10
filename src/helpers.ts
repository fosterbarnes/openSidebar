import fs from "node:fs"
import path from "node:path"

const IGNORED_DIRECTORIES = new Set([".git", "node_modules", "dist", "build", "coverage"])
const MAX_TREE_ITEMS = 80
const PACKAGE_MANAGERS = new Set(["npm", "pnpm", "yarn", "bun"])

export type Script = { name: string; command: string; filePath?: string }
export type TreeEntry = { name: string; relativePath: string; fullPath: string; directory: boolean; depth: number }

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

function fileScript(filePath: string): Script | undefined {
  const extension = path.extname(filePath).toLowerCase()
  const command = {
    ".ps1": `& ${shellPath(filePath)}`,
    ".sh": `sh ${shellPath(filePath)}`,
    ".bat": shellPath(filePath),
    ".cmd": shellPath(filePath),
    ".py": `python ${shellPath(filePath)}`,
    ".js": `node ${shellPath(filePath)}`,
    ".ts": `npx tsx ${shellPath(filePath)}`,
  }[extension]
  return command ? { name: path.relative(path.dirname(path.dirname(filePath)), filePath), command, filePath } : undefined
}

function readPackageScripts(directory: string): Script[] {
  try {
    const packageJson = JSON.parse(fs.readFileSync(path.join(directory, "package.json"), "utf8"))
    if (!packageJson.scripts || typeof packageJson.scripts !== "object") return []
    const manager = packageManager(directory)
    return Object.keys(packageJson.scripts)
      .filter((name) => /^[a-zA-Z0-9_:.\/-]+$/.test(name))
      .sort((a, b) => a.localeCompare(b))
      .map((name) => ({ name, command: `${manager} run ${name}` }))
  } catch {
    return []
  }
}

function readFileScripts(root: string): Script[] {
  const scriptsDirectory = path.basename(root) === ".scripts" ? root : path.join(root, ".scripts")
  try {
    return fs.readdirSync(scriptsDirectory, { withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => fileScript(path.join(scriptsDirectory, entry.name)))
      .filter((script): script is Script => Boolean(script))
      .sort((a, b) => a.name.localeCompare(b.name))
  } catch {
    return []
  }
}

export function readScripts(projectRoot: string, fileRoot = projectRoot): Script[] {
  return [...readPackageScripts(projectRoot), ...readFileScripts(fileRoot)]
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
