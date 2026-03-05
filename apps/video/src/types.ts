import { z } from 'zod'

export const RemoteMediaRouteSchema = z.object({
  name: z.string().min(1),
  endpoint: z.string().url(),
  protocol: z.literal('media'),
  peerName: z.string().optional(),
  tags: z.array(z.string()).optional(),
})

export const MediaRouteConfigSchema = z.object({
  routes: z.array(RemoteMediaRouteSchema),
})

export type RemoteMediaRoute = z.infer<typeof RemoteMediaRouteSchema>
export type MediaRouteConfig = z.infer<typeof MediaRouteConfigSchema>

export const OnReadyHookSchema = z.object({
  path: z.string().min(1),
  sourceType: z.string().optional(),
})

export const OnNotReadyHookSchema = z.object({
  path: z.string().min(1),
})

export type OnReadyHook = z.infer<typeof OnReadyHookSchema>
export type OnNotReadyHook = z.infer<typeof OnNotReadyHookSchema>

export const StreamListItemSchema = z.object({
  name: z.string(),
  source: z.enum(['local', 'remote']),
  protocols: z.record(z.string(), z.string()),
  tags: z.array(z.string()),
  availability: z.enum(['local', 'remote']),
})

export type StreamListItem = z.infer<typeof StreamListItemSchema>

export type UpdateResult = { success: true } | { success: false; error: string }
