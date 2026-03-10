import type { ListRelaysInput } from '../types.js'

export type ListRelaysResult =
  | { success: true; data: { available: false } }
  | { success: false; error: string }

export async function listRelaysHandler(_input: ListRelaysInput): Promise<ListRelaysResult> {
  return { success: true, data: { available: false } }
}
