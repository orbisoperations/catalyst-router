permit (
    principal is CATALYST::ADMIN,
    action,
    resource
)
when {
    (principal.orgDomain == "" || principal.orgDomain == resource.orgDomain) &&
    (principal.trustedNodes.isEmpty() || principal.trustedNodes.contains(resource.nodeId))
};
