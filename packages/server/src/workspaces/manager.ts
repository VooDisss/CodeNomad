import path from "path"
import { EventBus } from "../events/bus"
import type { SettingsService } from "../settings/service"
import type { BinaryResolver } from "../settings/binaries"
import { FileSystemBrowser } from "../filesystem/browser"
import { searchWorkspaceFiles, WorkspaceFileSearchOptions } from "../filesystem/search"
import { clearWorkspaceSearchCache } from "../filesystem/search-cache"
import { WorkspaceDescriptor, WorkspaceFileResponse, FileSystemEntry } from "../api-types"
import { Logger } from "../logger"
import { SharedOpencodeHostManager } from "./shared-host"
import { resolveBinaryPath } from "./binary-path"
import { DedicatedWorkspaceHostManager } from "./workspace-hosts"

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
  private readonly workspaceHosts: DedicatedWorkspaceHostManager
  private readonly sharedHost: SharedOpencodeHostManager

  constructor(private readonly options: WorkspaceManagerOptions) {
    this.workspaceHosts = new DedicatedWorkspaceHostManager(this.options, (workspaceId, info) =>
      this.handleProcessExit(workspaceId, info),
    )
    this.sharedHost = new SharedOpencodeHostManager(this.options)
  }

  list(): WorkspaceDescriptor[] {
    return Array.from(this.workspaces.values())
  }

  get(id: string): WorkspaceDescriptor | undefined {
    return this.workspaces.get(id)
  }

  getInstancePort(id: string): number | undefined {
    return this.workspaceHosts.getHostInfo(id)?.port
  }

  getInstanceAuthorizationHeader(id: string): string | undefined {
    return this.workspaceHosts.getAuthorizationHeader(id)
  }

  getSharedHostManager(): SharedOpencodeHostManager {
    return this.sharedHost
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
      const hostInfo = await this.workspaceHosts.startWorkspaceHost({
        workspaceId: id,
        workspacePath,
      })

      descriptor.binaryId = hostInfo.binaryPath
      descriptor.binaryVersion = hostInfo.binaryVersion ?? descriptor.binaryVersion
      descriptor.pid = hostInfo.pid
      descriptor.port = hostInfo.port
      descriptor.status = "ready"
      descriptor.updatedAt = new Date().toISOString()
      this.options.eventBus.publish({ type: "workspace.started", workspace: descriptor })
      this.options.logger.info({ workspaceId: id, port: hostInfo.port }, "Workspace ready")
      return descriptor
    } catch (error) {
      descriptor.status = "error"
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
    const wasRunning = Boolean(this.workspaceHosts.getHostInfo(id))
    if (wasRunning) {
      await this.workspaceHosts.stopWorkspaceHost(id).catch((error) => {
        this.options.logger.warn({ workspaceId: id, err: error }, "Failed to stop workspace process cleanly")
      })
    }

    this.workspaces.delete(id)
    clearWorkspaceSearchCache(workspace.path)
    if (!wasRunning) {
      this.options.eventBus.publish({ type: "workspace.stopped", workspaceId: id })
    }
    return workspace
  }

  async shutdown() {
    this.options.logger.info("Shutting down all workspaces")

    await this.workspaceHosts.shutdown()
    await this.sharedHost.shutdown().catch((error) => {
      this.options.logger.error({ err: error }, "Failed to stop shared host during shutdown")
    })

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

  private handleProcessExit(workspaceId: string, info: { code: number | null; requested: boolean }) {
    const workspace = this.workspaces.get(workspaceId)
    if (!workspace) return

    this.options.logger.info({ workspaceId, ...info }, "Workspace process exited")

    workspace.pid = undefined
    workspace.port = undefined
    workspace.updatedAt = new Date().toISOString()

    if (info.requested || info.code === 0) {
      workspace.status = "stopped"
      workspace.error = undefined
      this.options.eventBus.publish({ type: "workspace.stopped", workspaceId })
    } else {
      workspace.status = "error"
      workspace.error = `Process exited with code ${info.code}`
      this.options.eventBus.publish({ type: "workspace.error", workspace })
    }
  }
}
