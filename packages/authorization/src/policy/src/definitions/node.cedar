permit (
    principal is CATALYST::NODE,
    action in [
        CATALYST::Action::"IBGP_CONNECT",
        CATALYST::Action::"IBGP_DISCONNECT",
        CATALYST::Action::"IBGP_UPDATE"
    ],
    resource
)
when {
    principal.orgDomain == resource.orgDomain &&
    (principal.trustedNodes.isEmpty() || principal.trustedNodes.contains(resource.nodeId))
};

// Allow NODE principals to check permissions via the auth service
permit (
    principal is CATALYST::NODE,
    action == CATALYST::Action::"CHECK_PERMISSIONS",
    resource is CATALYST::AdminPanel
);
