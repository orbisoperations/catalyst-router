import { ServiceProtocol } from './rpc/schema/direct.js';

export { ServiceProtocol };

export interface DataChannel {
    name: string;
    endpoint: string;
    protocol: ServiceProtocol;
    region?: string;
}
