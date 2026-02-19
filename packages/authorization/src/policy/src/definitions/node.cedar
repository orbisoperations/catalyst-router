permit (
    principal is CATALYST::NODE,
    action in [
        CATALYST::Action::"IBGP_CONNECT",
        CATALYST::Action::"IBGP_DISCONNECT",
        CATALYST::Action::"IBGP_UPDATE",
        CATALYST::Action::"IBGP_LIST",
        CATALYST::Action::"GATEWAY_CONFIG_UPDATE"
    ],
    resource
)
when {
    principal.trustedDomains.contains(resource.domainId) &&
    (principal.trustedNodes.isEmpty() || principal.trustedNodes.contains(resource.nodeId))
};
