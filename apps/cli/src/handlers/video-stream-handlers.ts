import { createVideoClient } from '../clients/video-client.js'
import type { StreamEntry } from '../clients/video-client.js'
import { execFileSync } from 'node:child_process'
import type { ListStreamsInput, SubscribeStreamInput, PlayStreamInput } from '../types.js'

export type ListStreamsResult =
  | { success: true; data: { streams: StreamEntry[] } }
  | { success: false; error: string }

export type SubscribeStreamResult =
  | {
      success: true
      data: {
        name: string
        playbackEndpoints: { rtsp: string; hls: string; webrtc: string; srt: string }
      }
    }
  | { success: false; error: string }

export type PlayStreamResult =
  | { success: true; data: { player: string; protocol: string; url: string } }
  | { success: false; error: string }

export async function listStreamsHandler(input: ListStreamsInput): Promise<ListStreamsResult> {
  try {
    const client = createVideoClient(input.videoUrl)
    const query = {
      scope: input.scope,
      sourceNode: input.sourceNode,
      protocol: input.protocol,
    }
    const result = await client.listStreams(query, input.token)
    return { success: true, data: { streams: result.streams } }
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

export async function subscribeStreamHandler(
  input: SubscribeStreamInput
): Promise<SubscribeStreamResult> {
  try {
    const client = createVideoClient(input.videoUrl)
    const result = await client.subscribe(input.name, input.token)
    return {
      success: true,
      data: {
        name: result.stream.name,
        playbackEndpoints: result.stream.playbackEndpoints,
      },
    }
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

const PLAYERS = ['ffplay', 'mpv', 'vlc'] as const

function detectPlayer(preferred?: string): string | undefined {
  const whichCmd = process.platform === 'win32' ? 'where' : 'which'
  const candidates = preferred ? [preferred] : [...PLAYERS]
  for (const bin of candidates) {
    try {
      execFileSync(whichCmd, [bin], { stdio: 'ignore' })
      return bin
    } catch {
      // not found, try next
    }
  }
  return undefined
}

export async function playStreamHandler(input: PlayStreamInput): Promise<PlayStreamResult> {
  try {
    const player = detectPlayer(input.player)
    if (!player) {
      const searched = input.player ? `'${input.player}'` : PLAYERS.join(', ')
      return {
        success: false,
        error: `No video player found. Searched: ${searched}. Install ffmpeg (ffplay), mpv, or vlc.`,
      }
    }

    const client = createVideoClient(input.videoUrl)
    const result = await client.subscribe(input.name, input.token)
    const url = result.stream.playbackEndpoints[input.protocol]

    return {
      success: true,
      data: { player, protocol: input.protocol, url },
    }
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}
