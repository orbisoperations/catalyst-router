permit (
    principal is CATALYST::DATA_CUSTODIAN,
    action in [
        CATALYST::Action::"ROUTE_CREATE",
        CATALYST::Action::"ROUTE_DELETE"
    ],
    resource
)
when {
    principal.trustedDomains.contains(resource.domainId) &&
    (principal.trustedNodes.isEmpty() || principal.trustedNodes.contains(resource.nodeId))
};
