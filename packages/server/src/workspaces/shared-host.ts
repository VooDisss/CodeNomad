import type { SettingsService } from "../settings/service"
import type { BinaryResolver } from "../settings/binaries"
import { Logger } from "../logger"
import { EventBus } from "../events/bus"
import { getOpencodeConfigDir } from "../opencode-config.js"
import {
  buildOpencodeBasicAuthHeader,
  DEFAULT_OPENCODE_USERNAME,
  generateOpencodeServerPassword,
  OPENCODE_SERVER_PASSWORD_ENV,
  OPENCODE_SERVER_USERNAME_ENV,
} from "./opencode-auth"
import { resolveBinaryPath } from "./binary-path"
import { OpencodeServerLaunchResult, waitForOpencodeServerReadiness, WorkspaceRuntime } from "./runtime"

const SHARED_HOST_RUNTIME_ID = "shared-host"

export interface SharedHostInfo {
  pid: number
  port: number
  baseUrl: string
  authorization: string
  username: string
  startedAt: string
  binaryPath: string
  binaryVersion?: string
}

interface SharedOpencodeHostManagerOptions {
  rootDir: string
  settings: SettingsService
  binaryResolver: BinaryResolver
  eventBus: EventBus
  logger: Logger
  getServerBaseUrl: () => string
  nodeExtraCaCertsPath?: string
}

export class SharedOpencodeHostManager {
  private readonly runtime: WorkspaceRuntime
  private readonly opencodeConfigDir: string
  private readonly logger: Logger
  private startPromise: Promise<SharedHostInfo> | null = null
  private info: SharedHostInfo | null = null
  private authorization: string | null = null

  constructor(private readonly options: SharedOpencodeHostManagerOptions) {
    this.runtime = new WorkspaceRuntime(this.options.eventBus, this.options.logger)
    this.opencodeConfigDir = getOpencodeConfigDir()
    this.logger = this.options.logger.child({ component: "shared-host" })
  }

  getInfo(): SharedHostInfo | null {
    return this.info
  }

  isRunning(): boolean {
    return this.info !== null
  }

  async ensureStarted(): Promise<SharedHostInfo> {
    if (this.info) {
      return this.info
    }

    if (!this.startPromise) {
      this.startPromise = this.start().finally(() => {
        this.startPromise = null
      })
    }

    return this.startPromise
  }

  async shutdown(): Promise<void> {
    if (!this.info && !this.startPromise) {
      return
    }

    this.logger.info("Stopping shared OpenCode host")
    try {
      await this.runtime.stop(SHARED_HOST_RUNTIME_ID)
    } finally {
      this.info = null
      this.authorization = null
    }
  }

  private async start(): Promise<SharedHostInfo> {
    const binary = this.options.binaryResolver.resolveDefault()
    const opencodeUsername = DEFAULT_OPENCODE_USERNAME
    const opencodePassword = generateOpencodeServerPassword()
    const authorization = buildOpencodeBasicAuthHeader({ username: opencodeUsername, password: opencodePassword })

    if (!authorization) {
      throw new Error("Failed to build OpenCode auth header")
    }

    const serverConfig = this.options.settings.getOwner("config", "server")
    const envVars = (serverConfig as any)?.environmentVariables
    const userEnvironment = envVars && typeof envVars === "object" && !Array.isArray(envVars) ? (envVars as any) : {}
    const binaryPath = resolveBinaryPath(binary.path, this.logger)

    this.authorization = authorization
    this.logger.info({ binary: binaryPath, rootDir: this.options.rootDir }, "Starting shared OpenCode host")

    try {
      const launchResult = await this.runtime.launch({
        workspaceId: SHARED_HOST_RUNTIME_ID,
        folder: this.options.rootDir,
        binaryPath,
        environment: {
          ...userEnvironment,
          OPENCODE_CONFIG_DIR: this.opencodeConfigDir,
          CODENOMAD_BASE_URL: this.options.getServerBaseUrl(),
          ...(this.options.nodeExtraCaCertsPath ? { NODE_EXTRA_CA_CERTS: this.options.nodeExtraCaCertsPath } : {}),
          [OPENCODE_SERVER_USERNAME_ENV]: opencodeUsername,
          [OPENCODE_SERVER_PASSWORD_ENV]: opencodePassword,
        },
        onExit: (info) => this.handleExit(info.code, info.requested),
      })

      const binaryVersion = await this.waitForReadiness(launchResult, authorization)
      const startedAt = new Date().toISOString()
      const info: SharedHostInfo = {
        pid: launchResult.pid,
        port: launchResult.port,
        baseUrl: `http://127.0.0.1:${launchResult.port}`,
        authorization,
        username: opencodeUsername,
        startedAt,
        binaryPath,
        binaryVersion: binaryVersion ?? binary.version,
      }

      this.info = info
      this.logger.info({ pid: info.pid, port: info.port }, "Shared OpenCode host ready")
      return info
    } catch (error) {
      this.authorization = null
      this.info = null
      this.logger.error({ err: error }, "Shared OpenCode host failed to start")
      throw error
    }
  }

  private async waitForReadiness(
    launchResult: OpencodeServerLaunchResult,
    authorization: string,
  ): Promise<string | undefined> {
    return waitForOpencodeServerReadiness({
      runtimeId: SHARED_HOST_RUNTIME_ID,
      port: launchResult.port,
      exitPromise: launchResult.exitPromise,
      getLastOutput: launchResult.getLastOutput,
      logger: this.logger,
      authorizationHeader: authorization,
    })
  }

  private handleExit(code: number | null, requested: boolean) {
    this.logger.info({ code, requested }, "Shared OpenCode host exited")
    this.info = null
    this.authorization = null
  }
}
