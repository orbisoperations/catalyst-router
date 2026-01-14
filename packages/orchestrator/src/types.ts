
export type ServiceProtocol = 'tcp' | 'tcp:http' | 'tcp:graphql' | 'tcp:gql' | 'tcp:grpc' | 'udp';

export interface DataChannel {
    name: string;
    endpoint: string;
    protocol: ServiceProtocol;
    region?: string;
}
