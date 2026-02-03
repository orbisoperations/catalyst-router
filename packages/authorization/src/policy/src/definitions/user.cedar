permit (
    principal is CATALYST::USER,
    action == CATALYST::Action::"LOGIN",
    resource
)
when {
    principal.trustedDomains.contains(resource.domainId) &&
    (principal.trustedNodes.isEmpty() || principal.trustedNodes.contains(resource.nodeId))
};
