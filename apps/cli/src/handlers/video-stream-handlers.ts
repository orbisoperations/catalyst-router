import { createVideoClient } from '../clients/video-client.js'
import type { StreamEntry } from '../clients/video-client.js'
import type {
  ListStreamsInput,
  GetStreamInput,
  SubscribeStreamInput,
  WatchStreamsInput,
} from '../types.js'

export type ListStreamsResult =
  | { success: true; data: { streams: StreamEntry[] } }
  | { success: false; error: string }

export type GetStreamResult =
  | { success: true; data: { stream: StreamEntry } }
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

export type WatchStreamsResult =
  | { success: true; data: { streams: StreamEntry[] } }
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

export async function getStreamHandler(input: GetStreamInput): Promise<GetStreamResult> {
  try {
    const client = createVideoClient(input.videoUrl)
    const result = await client.listStreams(undefined, input.token)
    const stream = result.streams.find((s) => s.name === input.name)
    if (!stream) {
      return { success: false, error: `Stream '${input.name}' not found` }
    }
    return { success: true, data: { stream } }
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

export async function watchStreamsHandler(input: WatchStreamsInput): Promise<WatchStreamsResult> {
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
