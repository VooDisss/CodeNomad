import { EventBus } from "../events/bus"
import { Logger } from "../logger"
import type { SettingsService } from "../settings/service"
import type { BinaryResolver } from "../settings/binaries"
import { getOpencodeConfigDir } from "../opencode-config.js"
import {
  buildOpencodeBasicAuthHeader,
  DEFAULT_OPENCODE_USERNAME,
  generateOpencodeServerPassword,
  OPENCODE_SERVER_PASSWORD_ENV,
  OPENCODE_SERVER_USERNAME_ENV,
} from "./opencode-auth"
import { resolveBinaryPath } from "./binary-path"
import { ProcessExitInfo, waitForOpencodeServerReadiness, WorkspaceRuntime } from "./runtime"

export interface WorkspaceHostInfo {
  workspaceId: string
  pid: number
  port: number
  authorization: string
  binaryPath: string
  binaryVersion?: string
}

interface WorkspaceHostManagerOptions {
  rootDir: string
  settings: SettingsService
  binaryResolver: BinaryResolver
  eventBus: EventBus
  logger: Logger
  getServerBaseUrl: () => string
  nodeExtraCaCertsPath?: string
}

interface StartWorkspaceHostOptions {
  workspaceId: string
  workspacePath: string
}

interface WorkspaceHostAuth {
  username: string
  password: string
  authorization: string
}

export class DedicatedWorkspaceHostManager {
  private readonly runtime: WorkspaceRuntime
  private readonly opencodeConfigDir: string
  private readonly logger: Logger
  private readonly authByWorkspace = new Map<string, WorkspaceHostAuth>()
  private readonly hosts = new Map<string, WorkspaceHostInfo>()

  constructor(
    private readonly options: WorkspaceHostManagerOptions,
    private readonly onHostExit: (workspaceId: string, info: { code: number | null; requested: boolean }) => void,
  ) {
    this.runtime = new WorkspaceRuntime(this.options.eventBus, this.options.logger)
    this.opencodeConfigDir = getOpencodeConfigDir()
    this.logger = this.options.logger.child({ component: "workspace-hosts" })
  }

  getHostInfo(workspaceId: string): WorkspaceHostInfo | undefined {
    return this.hosts.get(workspaceId)
  }

  getAuthorizationHeader(workspaceId: string): string | undefined {
    return this.authByWorkspace.get(workspaceId)?.authorization
  }

  async startWorkspaceHost(options: StartWorkspaceHostOptions): Promise<WorkspaceHostInfo> {
    const binary = this.options.binaryResolver.resolveDefault()
    const binaryPath = resolveBinaryPath(binary.path, this.options.logger)
    const serverConfig = this.options.settings.getOwner("config", "server")
    const envVars = (serverConfig as any)?.environmentVariables
    const userEnvironment = envVars && typeof envVars === "object" && !Array.isArray(envVars) ? (envVars as any) : {}

    const opencodeUsername = DEFAULT_OPENCODE_USERNAME
    const opencodePassword = generateOpencodeServerPassword()
    const authorization = buildOpencodeBasicAuthHeader({ username: opencodeUsername, password: opencodePassword })
    if (!authorization) {
      throw new Error("Failed to build OpenCode auth header")
    }

    this.authByWorkspace.set(options.workspaceId, {
      username: opencodeUsername,
      password: opencodePassword,
      authorization,
    })

    const environment = {
      ...userEnvironment,
      OPENCODE_CONFIG_DIR: this.opencodeConfigDir,
      CODENOMAD_INSTANCE_ID: options.workspaceId,
      CODENOMAD_BASE_URL: this.options.getServerBaseUrl(),
      ...(this.options.nodeExtraCaCertsPath ? { NODE_EXTRA_CA_CERTS: this.options.nodeExtraCaCertsPath } : {}),
      [OPENCODE_SERVER_USERNAME_ENV]: opencodeUsername,
      [OPENCODE_SERVER_PASSWORD_ENV]: opencodePassword,
    }

    try {
      const { pid, port, exitPromise, getLastOutput } = await this.runtime.launch({
        workspaceId: options.workspaceId,
        folder: options.workspacePath,
        binaryPath,
        environment,
        onExit: (info) => this.handleExit(info.workspaceId, info),
      })

      const runtimeVersion = await waitForOpencodeServerReadiness({
        runtimeId: options.workspaceId,
        port,
        exitPromise,
        getLastOutput,
        logger: this.options.logger,
        authorizationHeader: authorization,
      })

      const hostInfo: WorkspaceHostInfo = {
        workspaceId: options.workspaceId,
        pid,
        port,
        authorization,
        binaryPath,
        binaryVersion: runtimeVersion ?? binary.version,
      }
      this.hosts.set(options.workspaceId, hostInfo)
      return hostInfo
    } catch (error) {
      this.authByWorkspace.delete(options.workspaceId)
      this.hosts.delete(options.workspaceId)
      throw error
    }
  }

  async stopWorkspaceHost(workspaceId: string): Promise<void> {
    await this.runtime.stop(workspaceId)
  }

  async shutdown(): Promise<void> {
    const stopTasks: Array<Promise<void>> = []

    for (const workspaceId of this.hosts.keys()) {
      this.logger.info({ workspaceId }, "Stopping workspace host during shutdown")
      stopTasks.push(
        this.runtime.stop(workspaceId).catch((error) => {
          this.logger.error({ workspaceId, err: error }, "Failed to stop workspace host during shutdown")
        }),
      )
    }

    if (stopTasks.length > 0) {
      await Promise.allSettled(stopTasks)
    }

    this.hosts.clear()
    this.authByWorkspace.clear()
  }

  private handleExit(workspaceId: string, info: ProcessExitInfo) {
    this.hosts.delete(workspaceId)
    this.authByWorkspace.delete(workspaceId)
    this.onHostExit(workspaceId, { code: info.code, requested: info.requested })
  }
}
