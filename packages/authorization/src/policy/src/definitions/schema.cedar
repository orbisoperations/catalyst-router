namespace CATALYST {
    entity ADMIN;
    entity NODE;
    entity DATA_CUSTODIAN;
    entity NODE_CUSTODIAN;
    entity USER;

    entity IBGP;
    entity Peer;
    entity Route;
    entity Token;
    entity AdminPanel;

    action LOGIN appliesTo {
        principal: [ADMIN, NODE, DATA_CUSTODIAN, NODE_CUSTODIAN, USER],
        resource: [AdminPanel, IBGP, Peer, Route, Token]
    };

    action IBGP_CONNECT appliesTo {
        principal: [ADMIN, NODE, NODE_CUSTODIAN],
        resource: IBGP
    };

    action IBGP_DISCONNECT appliesTo {
        principal: [ADMIN, NODE, NODE_CUSTODIAN],
        resource: IBGP
    };

    action IBGP_UPDATE appliesTo {
        principal: [ADMIN, NODE, NODE_CUSTODIAN],
        resource: IBGP
    };

    action PEER_CREATE appliesTo {
        principal: [ADMIN, NODE_CUSTODIAN],
        resource: Peer
    };

    action PEER_UPDATE appliesTo {
        principal: [ADMIN, NODE_CUSTODIAN],
        resource: Peer
    };

    action PEER_DELETE appliesTo {
        principal: [ADMIN, NODE_CUSTODIAN],
        resource: Peer
    };

    action ROUTE_CREATE appliesTo {
        principal: [ADMIN, DATA_CUSTODIAN],
        resource: Route
    };

    action ROUTE_DELETE appliesTo {
        principal: [ADMIN, DATA_CUSTODIAN],
        resource: Route
    };

    action TOKEN_CREATE appliesTo {
        principal: ADMIN,
        resource: Token
    };

    action TOKEN_REVOKE appliesTo {
        principal: ADMIN,
        resource: Token
    };

    action TOKEN_LIST appliesTo {
        principal: ADMIN,
        resource: Token
    };
}
