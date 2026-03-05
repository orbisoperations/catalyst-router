import { z } from 'zod'
import { Actions } from '../action-types.js'

export const TickMessageSchema = z.object({
  action: z.literal(Actions.Tick),
  data: z.object({
    now: z.number(),
  }),
})
