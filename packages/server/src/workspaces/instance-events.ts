import { Agent, fetch } from "undici"
import { Agent as UndiciAgent } from "undici"
import { EventBus } from "../events/bus"
import { Logger } from "../logger"
import { WorkspaceManager } from "./manager"
import { InstanceStreamEvent, InstanceStreamStatus } from "../api-types"

const STREAM_AGENT = new UndiciAgent({ bodyTimeout: 0, headersTimeout: 0 })
const RECONNECT_DELAY_MS = 1000

interface InstanceEventBridgeOptions {
  workspaceManager: WorkspaceManager
  eventBus: EventBus
  logger: Logger
}

interface ActiveStream {
  controller: AbortController
  task: Promise<void>
}

interface ParsedSharedEvent {
  event: InstanceStreamEvent
  directories: string[]
}

export class InstanceEventBridge {
  private stream: ActiveStream | null = null

  constructor(private readonly options: InstanceEventBridgeOptions) {
    const bus = this.options.eventBus
    bus.on("workspace.started", () => this.ensureStream())
    bus.on("workspace.stopped", (event) => this.publishStatus(event.workspaceId, "disconnected", "workspace stopped"))
    bus.on("workspace.error", (event) => this.publishStatus(event.workspace.id, "disconnected", "workspace error"))
  }

  shutdown() {
    if (this.stream) {
      this.stream.controller.abort()
      this.stream = null
    }

    for (const workspace of this.options.workspaceManager.list()) {
      this.publishStatus(workspace.id, "disconnected")
    }
  }

  private ensureStream() {
    if (this.stream) {
      return
    }

    const controller = new AbortController()
    const task = this.runStream(controller.signal)
      .catch((error) => {
        if (!controller.signal.aborted) {
          this.options.logger.warn({ err: error }, "Shared instance event stream failed")
          this.publishStatusForAll("error", error instanceof Error ? error.message : String(error))
        }
      })
      .finally(() => {
        if (this.stream?.controller === controller) {
          this.stream = null
        }
      })

    this.stream = { controller, task }
  }

  private async runStream(signal: AbortSignal) {
    while (!signal.aborted) {
      const workspaces = this.options.workspaceManager.list()
      if (workspaces.length === 0) {
        await this.delay(RECONNECT_DELAY_MS, signal)
        continue
      }

      let host
      try {
        host = await this.options.workspaceManager.ensureSharedHostReady()
      } catch (error) {
        this.options.logger.warn({ err: error }, "Shared host is not ready for instance event streaming")
        this.publishStatusForAll("error", error instanceof Error ? error.message : String(error))
        await this.delay(RECONNECT_DELAY_MS, signal)
        continue
      }

      this.publishStatusForAll("connecting")

      try {
        await this.consumeStream(host.baseUrl, host.authorization, signal)
      } catch (error) {
        if (signal.aborted) {
          break
        }
        this.options.logger.warn({ err: error }, "Shared instance event stream disconnected")
        this.publishStatusForAll("error", error instanceof Error ? error.message : String(error))
        await this.delay(RECONNECT_DELAY_MS, signal)
      }
    }
  }

  private async consumeStream(baseUrl: string, authorization: string | undefined, signal: AbortSignal) {
    const url = `${baseUrl}/global/event`

    const headers: Record<string, string> = { Accept: "text/event-stream" }
    if (authorization) {
      headers.Authorization = authorization
    }

    const response = await fetch(url, {
      headers,
      signal,
      dispatcher: STREAM_AGENT,
    })

    if (!response.ok || !response.body) {
      throw new Error(`Instance event stream unavailable (${response.status})`)
    }

    this.publishStatusForAll("connected")

    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ""

    while (!signal.aborted) {
      const { done, value } = await reader.read()
      if (done || !value) {
        break
      }
      buffer += decoder.decode(value, { stream: true })
      buffer = this.flushEvents(buffer)
    }
  }

  private flushEvents(buffer: string) {
    let separatorIndex = buffer.indexOf("\n\n")

    while (separatorIndex >= 0) {
      const chunk = buffer.slice(0, separatorIndex)
      buffer = buffer.slice(separatorIndex + 2)
      this.processChunk(chunk)
      separatorIndex = buffer.indexOf("\n\n")
    }

    return buffer
  }

  private processChunk(chunk: string) {
    const lines = chunk.split(/\r?\n/)
    const dataLines: string[] = []

    for (const line of lines) {
      if (line.startsWith(":")) {
        continue
      }
      if (line.startsWith("data:")) {
        dataLines.push(line.slice(5).trimStart())
      }
    }

    if (dataLines.length === 0) {
      return
    }

    const payload = dataLines.join("\n").trim()
    if (!payload) {
      return
    }

    try {
      const parsed = this.parseSharedEventPayload(payload)
      if (!parsed) {
        this.options.logger.warn({ chunk: payload }, "Dropped malformed instance event")
        return
      }

      const targetInstanceIds = this.resolveTargetInstanceIds(parsed)
      if (targetInstanceIds.length === 0) {
        this.options.logger.debug({ eventType: parsed.event.type, directories: parsed.directories }, "Shared instance event did not match a workspace")
        return
      }

      this.options.logger.debug({ instanceIds: targetInstanceIds, eventType: parsed.event.type }, "Shared instance SSE event received")
      if (this.options.logger.isLevelEnabled("trace")) {
        this.options.logger.trace({ instanceIds: targetInstanceIds, event: parsed.event }, "Shared instance SSE event payload")
      }

      for (const instanceId of targetInstanceIds) {
        this.options.eventBus.publish({ type: "instance.event", instanceId, event: parsed.event })
      }
    } catch (error) {
      this.options.logger.warn({ chunk: payload, err: error }, "Failed to parse instance SSE payload")
    }
  }

  private parseSharedEventPayload(payload: string): ParsedSharedEvent | null {
    const parsed = JSON.parse(payload) as any
    if (!parsed || typeof parsed !== "object") {
      return null
    }

    // OpenCode SSE payload shapes vary across versions.
    // Common variants:
    // - { type, properties, ... }
    // - { payload: { type, properties, ... }, directory: "/abs/path" }
    // - { payload: { type, properties, ... } }
    const base = parsed.payload && typeof parsed.payload === "object" ? parsed.payload : parsed
    const event: InstanceStreamEvent | null = base && typeof base === "object" ? ({ ...base } as any) : null

    const directories = new Set<string>()
    const addDirectory = (value: unknown) => {
      if (typeof value === "string" && value.trim()) {
        directories.add(value.trim())
      }
    }

    addDirectory((parsed as any).directory)
    addDirectory((base as any)?.directory)
    addDirectory((base as any)?.properties?.directory)

    if (event && !(event as any).directory) {
      const firstDirectory = Array.from(directories)[0]
      if (firstDirectory) {
        ;(event as any).directory = firstDirectory
      }
    }

    if (!event || typeof (event as any).type !== "string") {
      return null
    }

    return {
      event,
      directories: Array.from(directories),
    }
  }

  private resolveTargetInstanceIds(parsed: ParsedSharedEvent): string[] {
    const matches = new Set<string>()

    for (const directory of parsed.directories) {
      for (const workspaceId of this.options.workspaceManager.findWorkspaceIdsByDirectory(directory)) {
        matches.add(workspaceId)
      }
    }

    return Array.from(matches)
  }

  private publishStatusForAll(status: InstanceStreamStatus, reason?: string) {
    for (const workspace of this.options.workspaceManager.list()) {
      this.publishStatus(workspace.id, status, reason)
    }
  }

  private publishStatus(instanceId: string, status: InstanceStreamStatus, reason?: string) {
    this.options.logger.debug({ instanceId, status, reason }, "Instance SSE status updated")
    this.options.eventBus.publish({ type: "instance.eventStatus", instanceId, status, reason })
  }

  private delay(duration: number, signal: AbortSignal) {
    if (duration <= 0) {
      return Promise.resolve()
    }
    return new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        signal.removeEventListener("abort", onAbort)
        resolve()
      }, duration)

      const onAbort = () => {
        clearTimeout(timeout)
        resolve()
      }

      signal.addEventListener("abort", onAbort, { once: true })
    })
  }
}
