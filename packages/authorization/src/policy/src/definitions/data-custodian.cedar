permit (
    principal is CATALYST::DATA_CUSTODIAN,
    action in [
        CATALYST::Action::"ROUTE_CREATE",
        CATALYST::Action::"ROUTE_DELETE",
        CATALYST::Action::"ROUTE_LIST",
        CATALYST::Action::"STREAM_DISCOVER",
        CATALYST::Action::"STREAM_SUBSCRIBE"
    ],
    resource
)
when {
    principal.trustedDomains.contains(resource.domainId) &&
    (principal.trustedNodes.isEmpty() || principal.trustedNodes.contains(resource.nodeId))
};
