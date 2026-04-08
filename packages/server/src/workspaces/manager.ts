import path from "path"
import { EventBus } from "../events/bus"
import type { SettingsService } from "../settings/service"
import type { BinaryResolver } from "../settings/binaries"
import { FileSystemBrowser } from "../filesystem/browser"
import { searchWorkspaceFiles, WorkspaceFileSearchOptions } from "../filesystem/search"
import { clearWorkspaceSearchCache } from "../filesystem/search-cache"
import { WorkspaceDescriptor, WorkspaceFileResponse, FileSystemEntry } from "../api-types"
import { Logger } from "../logger"
import { SharedHostInfo, SharedOpencodeHostManager } from "./shared-host"
import { resolveBinaryPath } from "./binary-path"

interface WorkspaceManagerOptions {
  rootDir: string
  settings: SettingsService
  binaryResolver: BinaryResolver
  eventBus: EventBus
  logger: Logger
  getServerBaseUrl: () => string
  /** Optional CA bundle path to trust CodeNomad HTTPS certs. */
  nodeExtraCaCertsPath?: string
}

interface WorkspaceRecord extends WorkspaceDescriptor {}

export class WorkspaceManager {
  private readonly workspaces = new Map<string, WorkspaceRecord>()
  private readonly sharedHost: SharedOpencodeHostManager

  constructor(private readonly options: WorkspaceManagerOptions) {
    this.sharedHost = new SharedOpencodeHostManager(this.options)
  }

  list(): WorkspaceDescriptor[] {
    return Array.from(this.workspaces.values())
  }

  get(id: string): WorkspaceDescriptor | undefined {
    return this.workspaces.get(id)
  }

  findWorkspaceIdsByDirectory(directory: string): string[] {
    const normalized = normalizeWorkspacePath(directory)
    if (!normalized) {
      return []
    }

    const exactMatches: string[] = []
    const containingMatches: string[] = []
    for (const workspace of this.workspaces.values()) {
      const workspacePath = normalizeWorkspacePath(workspace.path)
      if (!workspacePath) {
        continue
      }

      if (workspacePath === normalized) {
        exactMatches.push(workspace.id)
        continue
      }

      if (isSubpath(normalized, workspacePath)) {
        containingMatches.push(workspace.id)
      }
    }

    return exactMatches.length > 0 ? exactMatches : containingMatches
  }

  getInstancePort(id: string): number | undefined {
    return this.workspaces.get(id)?.port
  }

  getInstanceAuthorizationHeader(id: string): string | undefined {
    const workspace = this.workspaces.get(id)
    if (!workspace || workspace.status !== "ready") {
      return undefined
    }

    return this.sharedHost.getInfo()?.authorization
  }

  getSharedHostManager(): SharedOpencodeHostManager {
    return this.sharedHost
  }

  async ensureSharedHostReady(): Promise<SharedHostInfo> {
    return this.sharedHost.ensureStarted()
  }

  listFiles(workspaceId: string, relativePath = "."): FileSystemEntry[] {
    const workspace = this.requireWorkspace(workspaceId)
    const browser = new FileSystemBrowser({ rootDir: workspace.path })
    return browser.list(relativePath)
  }

  searchFiles(workspaceId: string, query: string, options?: WorkspaceFileSearchOptions): FileSystemEntry[] {
    const workspace = this.requireWorkspace(workspaceId)
    return searchWorkspaceFiles(workspace.path, query, options)
  }

  readFile(workspaceId: string, relativePath: string): WorkspaceFileResponse {
    const workspace = this.requireWorkspace(workspaceId)
    const browser = new FileSystemBrowser({ rootDir: workspace.path })
    const contents = browser.readFile(relativePath)
    return {
      workspaceId,
      relativePath,
      contents,
    }
  }

  writeFile(workspaceId: string, relativePath: string, contents: string): void {
    const workspace = this.requireWorkspace(workspaceId)
    const browser = new FileSystemBrowser({ rootDir: workspace.path })
    browser.writeFile(relativePath, contents)
  }

  async create(folder: string, name?: string): Promise<WorkspaceDescriptor> {
    const id = `${Date.now().toString(36)}`
    const binary = this.options.binaryResolver.resolveDefault()
    const resolvedBinaryPath = resolveBinaryPath(binary.path, this.options.logger)
    const workspacePath = path.isAbsolute(folder) ? folder : path.resolve(this.options.rootDir, folder)
    clearWorkspaceSearchCache(workspacePath)

    this.options.logger.info({ workspaceId: id, folder: workspacePath }, "Creating workspace")

    const proxyPath = `/workspaces/${id}/worktrees/root/instance`

    const descriptor: WorkspaceRecord = {
      id,
      path: workspacePath,
      name,
      status: "starting",
      proxyPath,
      binaryId: resolvedBinaryPath,
      binaryLabel: binary.label,
      binaryVersion: binary.version,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }

    this.workspaces.set(id, descriptor)

    this.options.eventBus.publish({ type: "workspace.created", workspace: descriptor })

    try {
      const hostInfo = await this.sharedHost.ensureStarted()

      this.applySharedHostDescriptorState(descriptor, hostInfo)
      descriptor.status = "ready"
      descriptor.error = undefined
      descriptor.updatedAt = new Date().toISOString()
      this.options.eventBus.publish({ type: "workspace.started", workspace: descriptor })
      this.options.logger.info({ workspaceId: id, sharedHostPort: hostInfo.port }, "Workspace ready")
      return descriptor
    } catch (error) {
      descriptor.status = "error"
      descriptor.pid = undefined
      descriptor.port = undefined
      descriptor.error = error instanceof Error ? error.message : String(error)
      descriptor.updatedAt = new Date().toISOString()
      this.options.eventBus.publish({ type: "workspace.error", workspace: descriptor })
      this.options.logger.error({ workspaceId: id, err: error }, "Workspace failed to start")
      throw error
    }
  }

  async delete(id: string): Promise<WorkspaceDescriptor | undefined> {
    const workspace = this.workspaces.get(id)
    if (!workspace) return undefined

    this.options.logger.info({ workspaceId: id }, "Stopping workspace")

    this.workspaces.delete(id)
    clearWorkspaceSearchCache(workspace.path)
    this.options.eventBus.publish({ type: "workspace.stopped", workspaceId: id })
    return workspace
  }

  async shutdown() {
    this.options.logger.info("Shutting down all workspaces")

    await this.sharedHost.shutdown().catch((error) => {
      this.options.logger.error({ err: error }, "Failed to stop shared host during shutdown")
    })

    for (const workspace of this.workspaces.values()) {
      workspace.status = "stopped"
      workspace.pid = undefined
      workspace.port = undefined
      workspace.updatedAt = new Date().toISOString()
    }

    this.workspaces.clear()
    this.options.logger.info("All workspaces cleared")
  }

  private requireWorkspace(id: string): WorkspaceRecord {
    const workspace = this.workspaces.get(id)
    if (!workspace) {
      throw new Error("Workspace not found")
    }
    return workspace
  }

  private applySharedHostDescriptorState(workspace: WorkspaceRecord, hostInfo: SharedHostInfo) {
    // `pid`/`port` remain populated for UI compatibility, but now describe the shared host.
    workspace.binaryId = hostInfo.binaryPath
    workspace.binaryVersion = hostInfo.binaryVersion ?? workspace.binaryVersion
    workspace.pid = hostInfo.pid
    workspace.port = hostInfo.port
  }
}

function normalizeWorkspacePath(input: string): string {
  const trimmed = input.trim()
  if (!trimmed) {
    return ""
  }

  try {
    return path.normalize(trimmed)
  } catch {
    return trimmed
  }
}

function isSubpath(candidate: string, root: string): boolean {
  const rel = path.relative(root, candidate)
  if (rel === "") return true
  if (rel === "..") return false
  if (rel.startsWith(`..${path.sep}`)) return false
  if (path.isAbsolute(rel)) return false
  return true
}
