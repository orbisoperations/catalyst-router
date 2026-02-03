// IBGP Resource Policy
permit (
    principal,
    action in [Action::"open", Action::"close", Action::"update"],
    resource is IBGP
)
when {
    principal in Role::"admin" || principal in Role::"peer"
};

// Peer Resource Policy
permit (
    principal,
    action in [Action::"create", Action::"update", Action::"delete", Action::"list", Action::"view"],
    resource is Peer
)
when {
    principal in Role::"admin" || principal in Role::"peer_custodian"
};

// Route Resource Policy
permit (
    principal,
    action in [Action::"create", Action::"delete"],
    resource is Route
)
when {
    principal in Role::"admin" || principal in Role::"data_custodian"
};

permit (
    principal,
    action in [Action::"list", Action::"view"],
    resource is Route
)
when {
    principal in Role::"admin" || principal in Role::"data_custodian" || principal in Role::"user"
};

// Token Resource Policy
permit (
    principal,
    action in [Action::"create", Action::"revoke", Action::"list"],
    resource is Token
)
when {
    principal in Role::"admin"
};
