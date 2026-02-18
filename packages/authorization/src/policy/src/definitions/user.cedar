permit (
    principal is CATALYST::USER,
    action in [
        CATALYST::Action::"LOGIN",
        CATALYST::Action::"PEER_LIST",
        CATALYST::Action::"ROUTE_LIST"
    ],
    resource
)
when {
    principal.trustedDomains.contains(resource.domainId) &&
    (principal.trustedNodes.isEmpty() || principal.trustedNodes.contains(resource.nodeId))
};
