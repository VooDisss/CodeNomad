import path from "path"
import { EventBus } from "../events/bus"
import type { SettingsService } from "../settings/service"
import type { BinaryResolver } from "../settings/binaries"
import { FileSystemBrowser } from "../filesystem/browser"
import { searchWorkspaceFiles, WorkspaceFileSearchOptions } from "../filesystem/search"
import { clearWorkspaceSearchCache } from "../filesystem/search-cache"
import { WorkspaceDescriptor, WorkspaceFileResponse, FileSystemEntry } from "../api-types"
import { WorkspaceRuntime, ProcessExitInfo, waitForOpencodeServerReadiness } from "./runtime"
import { Logger } from "../logger"
import { getOpencodeConfigDir } from "../opencode-config.js"
import { SharedOpencodeHostManager } from "./shared-host"
import { resolveBinaryPath } from "./binary-path"
import {
  buildOpencodeBasicAuthHeader,
  DEFAULT_OPENCODE_USERNAME,
  generateOpencodeServerPassword,
  OPENCODE_SERVER_PASSWORD_ENV,
  OPENCODE_SERVER_USERNAME_ENV,
} from "./opencode-auth"

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
  private readonly runtime: WorkspaceRuntime
  private readonly sharedHost: SharedOpencodeHostManager
  private readonly opencodeConfigDir: string
  private readonly opencodeAuth = new Map<string, { username: string; password: string; authorization: string }>()

  constructor(private readonly options: WorkspaceManagerOptions) {
    this.runtime = new WorkspaceRuntime(this.options.eventBus, this.options.logger)
    this.sharedHost = new SharedOpencodeHostManager(this.options)
    this.opencodeConfigDir = getOpencodeConfigDir()
  }

  list(): WorkspaceDescriptor[] {
    return Array.from(this.workspaces.values())
  }

  get(id: string): WorkspaceDescriptor | undefined {
    return this.workspaces.get(id)
  }

  getInstancePort(id: string): number | undefined {
    return this.workspaces.get(id)?.port
  }

  getInstanceAuthorizationHeader(id: string): string | undefined {
    return this.opencodeAuth.get(id)?.authorization
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

    this.options.logger.info({ workspaceId: id, folder: workspacePath, binary: resolvedBinaryPath }, "Creating workspace")

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

    const serverConfig = this.options.settings.getOwner("config", "server")
    const envVars = (serverConfig as any)?.environmentVariables
    const userEnvironment = envVars && typeof envVars === "object" && !Array.isArray(envVars) ? (envVars as any) : {}

    const opencodeUsername = DEFAULT_OPENCODE_USERNAME
    const opencodePassword = generateOpencodeServerPassword()
    const authorization = buildOpencodeBasicAuthHeader({ username: opencodeUsername, password: opencodePassword })
    if (!authorization) {
      throw new Error("Failed to build OpenCode auth header")
    }
    this.opencodeAuth.set(id, { username: opencodeUsername, password: opencodePassword, authorization })

    const environment = {
      ...userEnvironment,
      OPENCODE_CONFIG_DIR: this.opencodeConfigDir,
      CODENOMAD_INSTANCE_ID: id,
      CODENOMAD_BASE_URL: this.options.getServerBaseUrl(),
      ...(this.options.nodeExtraCaCertsPath ? { NODE_EXTRA_CA_CERTS: this.options.nodeExtraCaCertsPath } : {}),
      [OPENCODE_SERVER_USERNAME_ENV]: opencodeUsername,
      [OPENCODE_SERVER_PASSWORD_ENV]: opencodePassword,
    }

    const logLevel = (serverConfig as any)?.logLevel

    try {
      const { pid, port, exitPromise, getLastOutput } = await this.runtime.launch({
        workspaceId: id,
        folder: workspacePath,
        binaryPath: resolvedBinaryPath,
        environment,
        logLevel,
        onExit: (info) => this.handleProcessExit(info.workspaceId, info),
      })

      const runtimeVersion = await this.waitForWorkspaceReadiness({ workspaceId: id, port, exitPromise, getLastOutput })
      if (runtimeVersion) {
        descriptor.binaryVersion = runtimeVersion
      }

      descriptor.pid = pid
      descriptor.port = port
      descriptor.status = "ready"
      descriptor.updatedAt = new Date().toISOString()
      this.options.eventBus.publish({ type: "workspace.started", workspace: descriptor })
      this.options.logger.info({ workspaceId: id, port }, "Workspace ready")
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
    const wasRunning = Boolean(workspace.pid)
    if (wasRunning) {
      await this.runtime.stop(id).catch((error) => {
        this.options.logger.warn({ workspaceId: id, err: error }, "Failed to stop workspace process cleanly")
      })
    }

    this.workspaces.delete(id)
    this.opencodeAuth.delete(id)
    clearWorkspaceSearchCache(workspace.path)
    if (!wasRunning) {
      this.options.eventBus.publish({ type: "workspace.stopped", workspaceId: id })
    }
    return workspace
  }

  async shutdown() {
    this.options.logger.info("Shutting down all workspaces")

    const stopTasks: Array<Promise<void>> = []

    for (const [id, workspace] of this.workspaces) {
      if (!workspace.pid) {
        this.options.logger.debug({ workspaceId: id }, "Workspace already stopped")
        continue
      }

      this.options.logger.info({ workspaceId: id }, "Stopping workspace during shutdown")
      stopTasks.push(
        this.runtime.stop(id).catch((error) => {
          this.options.logger.error({ workspaceId: id, err: error }, "Failed to stop workspace during shutdown")
        }),
      )
    }

    if (stopTasks.length > 0) {
      await Promise.allSettled(stopTasks)
    }

    this.workspaces.clear()
    this.opencodeAuth.clear()
    this.options.logger.info("All workspaces cleared")
  }

  private requireWorkspace(id: string): WorkspaceRecord {
    const workspace = this.workspaces.get(id)
    if (!workspace) {
      throw new Error("Workspace not found")
    }
    return workspace
  }

  private async waitForWorkspaceReadiness(params: {
    workspaceId: string
    port: number
    exitPromise: Promise<ProcessExitInfo>
    getLastOutput: () => string
  }): Promise<string | undefined> {
    return waitForOpencodeServerReadiness({
      runtimeId: params.workspaceId,
      port: params.port,
      exitPromise: params.exitPromise,
      getLastOutput: params.getLastOutput,
      logger: this.options.logger,
      authorizationHeader: this.opencodeAuth.get(params.workspaceId)?.authorization,
    })
  }

  private handleProcessExit(workspaceId: string, info: { code: number | null; requested: boolean }) {
    const workspace = this.workspaces.get(workspaceId)
    if (!workspace) return

    this.opencodeAuth.delete(workspaceId)

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
