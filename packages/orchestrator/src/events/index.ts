import { z } from 'zod'
import { ServiceProtocolSchema } from '../rpc/schema/direct.js'

// Route event schema with Zod validation
export const RouteEventSchema = z.object({
  type: z.enum(['route:created', 'route:updated', 'route:deleted']),
  route: z.object({
    id: z.string(),
    name: z.string(),
    protocol: ServiceProtocolSchema,
    endpoint: z.string(),
    region: z.string().optional(),
    routeType: z.enum(['internal', 'proxy']),
    metadata: z.record(z.unknown()).optional(),
  }),
  timestamp: z.number(),
  source: z.enum(['local', 'peer']),
  peerId: z.string().optional(),
})

export type RouteEvent = z.infer<typeof RouteEventSchema>
export type RouteEventType = RouteEvent['type']

// Event handler type - supports both sync and async handlers
export type EventHandler<T = unknown> = (event: T) => void | Promise<void>

// Generic event emitter interface
export interface EventEmitter {
  emit(event: string, data: unknown): void
  on(event: string, handler: EventHandler): void
  off(event: string, handler: EventHandler): void
}

// Implementation of the event bus
export class PluginEventBus implements EventEmitter {
  private handlers: Map<string, Set<EventHandler>> = new Map()

  emit(event: string, data: unknown): void {
    const eventHandlers = this.handlers.get(event)
    if (eventHandlers) {
      for (const handler of eventHandlers) {
        // Fire and forget - don't block on async handlers
        Promise.resolve(handler(data)).catch((err) => {
          console.error(`[PluginEventBus] Event handler error for "${event}":`, err)
        })
      }
    }
  }

  on(event: string, handler: EventHandler): void {
    if (!this.handlers.has(event)) {
      this.handlers.set(event, new Set())
    }
    this.handlers.get(event)!.add(handler)
  }

  off(event: string, handler: EventHandler): void {
    const eventHandlers = this.handlers.get(event)
    if (eventHandlers) {
      eventHandlers.delete(handler)
      if (eventHandlers.size === 0) {
        this.handlers.delete(event)
      }
    }
  }

  // Typed helper for route events
  emitRouteEvent(event: RouteEvent): void {
    this.emit(event.type, event)
  }

  // Typed subscription helper for route events
  onRouteEvent(type: RouteEventType, handler: EventHandler<RouteEvent>): void {
    this.on(type, handler as EventHandler)
  }

  // Typed unsubscription helper for route events
  offRouteEvent(type: RouteEventType, handler: EventHandler<RouteEvent>): void {
    this.off(type, handler as EventHandler)
  }

  // Subscribe to all route events
  onAllRouteEvents(handler: EventHandler<RouteEvent>): void {
    this.on('route:created', handler as EventHandler)
    this.on('route:updated', handler as EventHandler)
    this.on('route:deleted', handler as EventHandler)
  }

  // Unsubscribe from all route events
  offAllRouteEvents(handler: EventHandler<RouteEvent>): void {
    this.off('route:created', handler as EventHandler)
    this.off('route:updated', handler as EventHandler)
    this.off('route:deleted', handler as EventHandler)
  }

  // For testing - clear all handlers
  clear(): void {
    this.handlers.clear()
  }
}

// Singleton for now (will be dependency-injected later)
export const eventBus = new PluginEventBus()
