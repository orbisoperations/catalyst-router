entity User in [Role] {
    id: String,
    roles: Set<Role>,
    email: String,
    passwordHash: String,
    roles: Set<String>,
    orgId: String,
    createdAt: String,
    lastLoginAt?: String
};

entity Role = {
    name: String
};

entity IBGP;
entity Peer;
entity Route;
entity Token;

action open, close appliesTo {
    principal: User,
    resource: IBGP
};

action update appliesTo {
    principal: User,
    resource: [IBGP, Peer]
};

action create appliesTo {
    principal: User,
    resource: [Peer, Route, Token]
};

action delete appliesTo {
    principal: User,
    resource: [Peer, Route]
};

action list appliesTo {
    principal: User,
    resource: [Peer, Route, Token]
};

action view appliesTo {
    principal: User,
    resource: [Peer, Route]
};

action revoke appliesTo {
    principal: User,
    resource: Token
};
