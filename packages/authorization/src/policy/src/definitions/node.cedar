permit (
    principal is CATALYST::NODE,
    action in [
        CATALYST::Action::"IBGP_CONNECT",
        CATALYST::Action::"IBGP_DISCONNECT",
        CATALYST::Action::"IBGP_UPDATE"
    ],
    resource
);
