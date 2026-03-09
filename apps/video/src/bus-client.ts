import { getLogger } from '@catalyst/telemetry'

const logger = getLogger(['video', 'bus-client'])

export interface StreamEntry {
  name: string
  protocol: string
  endpoint?: string
  source: 'local' | 'remote'
  sourceNode: string
  metadata?: Record<string, unknown>
  nodePath?: string[]
}

export interface StreamCatalog {
  streams: StreamEntry[]
}

export interface VideoAction {
  action: string
  data: {
    name: string
    protocol: string
    endpoint?: string
    metadata?: Record<string, unknown>
  }
}

export interface DispatchCapability {
  dispatch(action: VideoAction): Promise<{ success: boolean }>
}

export class VideoBusClient {
  private _catalog: StreamCatalog = { streams: [] }
  private _dispatchCapability: DispatchCapability | undefined

  get catalog(): StreamCatalog {
    return this._catalog
  }

  setCatalog(catalog: StreamCatalog): void {
    this._catalog = catalog
    logger.info`Catalog updated: ${catalog.streams.length} streams`
  }

  setDispatch(capability: DispatchCapability): void {
    this._dispatchCapability = capability
    logger.info`Dispatch capability set`
  }

  clearDispatch(): void {
    this._dispatchCapability = undefined
    logger.info`Dispatch capability cleared`
  }

  get hasDispatch(): boolean {
    return this._dispatchCapability !== undefined
  }

  async dispatch(action: VideoAction): Promise<{ success: boolean }> {
    if (!this._dispatchCapability) {
      throw new Error('Cannot dispatch: no orchestrator connection (dispatch capability not set)')
    }
    return this._dispatchCapability.dispatch(action)
  }
}
