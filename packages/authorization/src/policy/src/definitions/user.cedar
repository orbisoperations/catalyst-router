permit (
    principal is CATALYST::USER,
    action == CATALYST::Action::"LOGIN",
    resource
)
when {
    principal.trustedDomains.contains(resource.domainId) &&
    (principal.trustedNodes.isEmpty() || principal.trustedNodes.contains(resource.nodeId))
};

// Allow USER principals read-only access to list peers and routes
permit (
    principal is CATALYST::USER,
    action in [
        CATALYST::Action::"PEER_LIST",
        CATALYST::Action::"ROUTE_LIST"
    ],
    resource
)
when {
    principal.trustedDomains.contains(resource.domainId) &&
    (principal.trustedNodes.isEmpty() || principal.trustedNodes.contains(resource.nodeId))
};
