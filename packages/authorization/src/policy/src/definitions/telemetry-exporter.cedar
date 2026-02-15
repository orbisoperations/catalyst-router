permit (
    principal is CATALYST::TELEMETRY_EXPORTER,
    action == CATALYST::Action::"TELEMETRY_EXPORT",
    resource
)
when {
    (principal.trustedDomains.isEmpty() || principal.trustedDomains.contains(resource.domainId)) &&
    (principal.trustedNodes.isEmpty() || principal.trustedNodes.contains(resource.nodeId))
};
