permit (
    principal is CATALYST::USER,
    action == CATALYST::Action::"LOGIN",
    resource
)
when {
    principal.orgDomain == resource.orgDomain &&
    (principal.trustedNodes.isEmpty() || principal.trustedNodes.contains(resource.nodeId))
};
