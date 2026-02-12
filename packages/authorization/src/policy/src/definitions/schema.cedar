namespace CATALYST {
    entity ADMIN {
        id: String,
        name: String,
        type: String,
        trustedNodes: Set<String>,
        orgDomain: String
    };
    entity NODE {
        id: String,
        name: String,
        type: String,
        trustedNodes: Set<String>,
        orgDomain: String
    };
    entity DATA_CUSTODIAN {
        id: String,
        name: String,
        type: String,
        trustedNodes: Set<String>,
        orgDomain: String
    };
    entity NODE_CUSTODIAN {
        id: String,
        name: String,
        type: String,
        trustedNodes: Set<String>,
        orgDomain: String
    };
    entity USER {
        id: String,
        name: String,
        type: String,
        trustedNodes: Set<String>,
        orgDomain: String
    };

    entity IBGP {
        nodeId: String,
        orgDomain: String
    };
    entity Peer {
        nodeId: String,
        orgDomain: String
    };
    entity Route {
        nodeId: String,
        orgDomain: String
    };
    entity Token {
        nodeId: String,
        orgDomain: String
    };
    entity AdminPanel {
        nodeId: String,
        orgDomain: String
    };

    action LOGIN appliesTo {
        principal: [ADMIN, NODE, DATA_CUSTODIAN, NODE_CUSTODIAN, USER],
        resource: [AdminPanel, IBGP, Peer, Route, Token]
    };

    action IBGP_CONNECT appliesTo {
        principal: [ADMIN, NODE, NODE_CUSTODIAN],
        resource: [IBGP, AdminPanel]
    };

    action IBGP_DISCONNECT appliesTo {
        principal: [ADMIN, NODE, NODE_CUSTODIAN],
        resource: [IBGP, AdminPanel]
    };

    action IBGP_UPDATE appliesTo {
        principal: [ADMIN, NODE, NODE_CUSTODIAN],
        resource: [IBGP, AdminPanel]
    };

    action PEER_CREATE appliesTo {
        principal: [ADMIN, NODE_CUSTODIAN],
        resource: [Peer, AdminPanel]
    };

    action PEER_UPDATE appliesTo {
        principal: [ADMIN, NODE_CUSTODIAN],
        resource: [Peer, AdminPanel]
    };

    action PEER_DELETE appliesTo {
        principal: [ADMIN, NODE_CUSTODIAN],
        resource: [Peer, AdminPanel]
    };

    action ROUTE_CREATE appliesTo {
        principal: [ADMIN, DATA_CUSTODIAN],
        resource: [Route, AdminPanel]
    };

    action ROUTE_DELETE appliesTo {
        principal: [ADMIN, DATA_CUSTODIAN],
        resource: [Route, AdminPanel]
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

    action CHECK_PERMISSIONS appliesTo {
        principal: NODE,
        resource: AdminPanel
    };

    action MANAGE appliesTo {
        principal: [ADMIN, NODE, DATA_CUSTODIAN, NODE_CUSTODIAN, USER],
        resource: AdminPanel
    };
}
