import { getLogger } from '@catalyst/telemetry'
import { CatalystRpcServer } from './rpc.js'

const logger = getLogger(['catalyst', 'node'])
const _rpcServer = new CatalystRpcServer()
logger.info`RPC server initialized`
