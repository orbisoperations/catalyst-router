permit (
    principal is CATALYST::NODE_CUSTODIAN,
    action in [
        CATALYST::Action::"PEER_CREATE",
        CATALYST::Action::"PEER_UPDATE",
        CATALYST::Action::"PEER_DELETE",
        CATALYST::Action::"IBGP_CONNECT",
        CATALYST::Action::"IBGP_DISCONNECT",
        CATALYST::Action::"IBGP_UPDATE"
    ],
    resource
);
