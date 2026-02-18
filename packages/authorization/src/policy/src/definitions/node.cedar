permit (
    principal is CATALYST::NODE,
    action in
        [CATALYST::Action::"IBGP_CONNECT",
         CATALYST::Action::"IBGP_DISCONNECT",
         CATALYST::Action::"IBGP_UPDATE",
         CATALYST::Action::"IBGP_LIST",
         CATALYST::Action::"GATEWAY_UPDATE"],
    resource
)
when
{
    principal.trustedDomains.contains(resource.domainId) &&
    (principal.trustedNodes.isEmpty() ||
     principal.trustedNodes.contains(resource.nodeId))
};

// Allow NODE principals to check permissions via the auth service
permit (
    principal is CATALYST::NODE,
    action == CATALYST::Action::"MANAGE",
    resource is CATALYST::AdminPanel
);
