import { execSync } from "child_process"
import { createRequire } from "module"
import { fileURLToPath } from "url"

const require = createRequire(import.meta.url)
const packageJson = require("../../package.json") as { name: string; version: string }

const PACKAGE_NAME = packageJson.name
const NPM_REGISTRY_URL = "https://registry.npmjs.org"

export type PackageManager = "npm" | "pnpm" | "bun"

export interface UpgradeOptions {
  version?: string
  logger?: { info: (msg: string) => void; warn: (msg: string) => void; error: (msg: string) => void }
}

export async function upgradeServer(options: UpgradeOptions = {}): Promise<{ success: boolean; message: string }> {
  const { version, logger } = options
  const log = logger ?? {
    info: console.log,
    warn: console.warn,
    error: console.error,
  }

  log.info("Detecting package manager...")

  const packageManager = detectPackageManager()

  if (!packageManager) {
    log.error("Could not detect package manager. Please ensure npm, pnpm, or bun is installed.")
    return { success: false, message: "No package manager detected" }
  }

  log.info(`Detected package manager: ${packageManager}`)

  const targetVersion = version ?? (await fetchLatestVersion())

  if (!targetVersion) {
    log.error("Could not determine version to upgrade to.")
    return { success: false, message: "Failed to resolve version" }
  }

  log.info(`Upgrading ${PACKAGE_NAME} to version ${targetVersion}...`)

  const installCommand = buildInstallCommand(packageManager, PACKAGE_NAME, targetVersion)

  log.info(`Running: ${installCommand}`)

  try {
    execSync(installCommand, { stdio: "inherit" })
    log.info(`Successfully upgraded ${PACKAGE_NAME} to ${targetVersion}`)
    return { success: true, message: `Successfully upgraded to ${targetVersion}` }
  } catch (error) {
    log.error(`Failed to upgrade: ${error}`)
    return { success: false, message: `Upgrade failed: ${error}` }
  }
}

export function detectPackageManager(): PackageManager | null {
  const npmExecPath = process.env["npm_config_exec_path"]
  const pnpmExecPath = process.env["PNPM_HOME"]
  const bunExecPath = process.env["BUN_INSTALL"]

  if (pnpmExecPath || isCommandAvailable("pnpm")) {
    return "pnpm"
  }

  if (bunExecPath || isCommandAvailable("bun")) {
    return "bun"
  }

  if (npmExecPath || isCommandAvailable("npm")) {
    return "npm"
  }

  return null
}

function isCommandAvailable(command: string): boolean {
  try {
    execSync(`${command} --version`, { stdio: "ignore" })
    return true
  } catch {
    return false
  }
}

export async function fetchLatestVersion(): Promise<string | null> {
  try {
    const { fetch } = await import("undici")
    const response = await fetch(`${NPM_REGISTRY_URL}/${PACKAGE_NAME}/latest`, {
      headers: {
        Accept: "application/json",
        "User-Agent": "CodeNomad-CLI",
      },
    })

    if (!response.ok) {
      return null
    }

    const data = (await response.json()) as { version?: string }
    return data.version ?? null
  } catch {
    return null
  }
}

function buildInstallCommand(packageManager: PackageManager, packageName: string, version: string): string {
  const packageRef = `${packageName}@${version}`

  switch (packageManager) {
    case "pnpm":
      return `pnpm install -g ${packageRef}`
    case "bun":
      return `bun install -g ${packageRef}`
    case "npm":
    default:
      return `npm install -g ${packageRef}`
  }
}

export function getCurrentVersion(): string {
  return packageJson.version
}
