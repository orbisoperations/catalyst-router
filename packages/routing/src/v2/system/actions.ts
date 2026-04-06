import { z } from 'zod'
import { Actions } from '../action-types.js'

export const TickMessageSchema = z.object({
  action: z.literal(Actions.Tick),
  data: z.object({
    now: z.number(),
  }),
})

export const AdminGracefulShutdownMessageSchema = z.object({
  action: z.literal(Actions.AdminGracefulShutdown),
  data: z.object({}),
})

export const AdminCancelShutdownMessageSchema = z.object({
  action: z.literal(Actions.AdminCancelShutdown),
  data: z.object({}),
})
