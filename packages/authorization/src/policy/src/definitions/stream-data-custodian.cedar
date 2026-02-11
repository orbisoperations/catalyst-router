// DATA_CUSTODIAN principals can publish and subscribe to streams
// within their trusted domains/nodes.
permit (
    principal is CATALYST::DATA_CUSTODIAN,
    action in [CATALYST::Action::"STREAM_PUBLISH", CATALYST::Action::"STREAM_SUBSCRIBE"],
    resource is CATALYST::Stream
)
when {
    principal.trustedDomains.contains(resource.domainId) &&
    (principal.trustedNodes.isEmpty() || principal.trustedNodes.contains(resource.nodeId))
};
