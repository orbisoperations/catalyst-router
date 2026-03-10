permit (
    principal is CATALYST::USER,
    action in [
        CATALYST::Action::"LOGIN",
        CATALYST::Action::"PEER_LIST",
        CATALYST::Action::"ROUTE_LIST",
        CATALYST::Action::"STREAM_SUBSCRIBE"
    ],
    resource
)
when {
    principal.trustedDomains.contains(resource.domainId) &&
    (principal.trustedNodes.isEmpty() || principal.trustedNodes.contains(resource.nodeId))
};
