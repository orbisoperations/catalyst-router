permit (
    principal is CATALYST::ADMIN,
    action,
    resource
)
when {
    (principal.trustedDomains.isEmpty() || principal.trustedDomains.contains(resource.domainId)) &&
    (principal.trustedNodes.isEmpty() || principal.trustedNodes.contains(resource.nodeId))
};
