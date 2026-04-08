import path from "path"
import { spawnSync } from "child_process"
import { Logger } from "../logger"

export function resolveBinaryPath(identifier: string, logger: Logger): string {
  if (!identifier) {
    return identifier
  }

  const looksLikePath = identifier.includes("/") || identifier.includes("\\") || identifier.startsWith(".")
  if (path.isAbsolute(identifier) || looksLikePath) {
    return identifier
  }

  const locator = process.platform === "win32" ? "where" : "which"

  try {
    const result = spawnSync(locator, [identifier], { encoding: "utf8" })
    if (result.status === 0 && result.stdout) {
      const candidates = result.stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .filter((line) => !/^INFO:/i.test(line))

      if (candidates.length > 0) {
        const resolved = pickBinaryCandidate(candidates)
        logger.debug({ identifier, resolved, candidates }, "Resolved binary path from system PATH")
        return resolved
      }
    } else if (result.error) {
      logger.warn({ identifier, err: result.error }, "Failed to resolve binary path via locator command")
    }
  } catch (error) {
    logger.warn({ identifier, err: error }, "Failed to resolve binary path from system PATH")
  }

  return identifier
}

function pickBinaryCandidate(candidates: string[]): string {
  if (process.platform !== "win32") {
    return candidates[0] ?? ""
  }

  const extensionPreference = [".exe", ".cmd", ".bat", ".ps1"]

  for (const ext of extensionPreference) {
    const match = candidates.find((candidate) => candidate.toLowerCase().endsWith(ext))
    if (match) {
      return match
    }
  }

  return candidates[0] ?? ""
}
