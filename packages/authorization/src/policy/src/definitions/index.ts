import CATALYST_SCHEMA from './schema.cedar' with { type: 'text' };
import adminPolicy from './admin.cedar' with { type: 'text' };
import nodePolicy from './node.cedar' with { type: 'text' };
import nodeCustodianPolicy from './node-custodian.cedar' with { type: 'text' };
import dataCustodianPolicy from './data-custodian.cedar' with { type: 'text' };
import userPolicy from './user.cedar' with { type: 'text' };

export {
    CATALYST_SCHEMA,
    adminPolicy,
    nodePolicy,
    nodeCustodianPolicy,
    dataCustodianPolicy,
    userPolicy
};

/**
 * All predefined Catalyst policies combined into a single Cedar string.
 */
export const ALL_POLICIES = [
    adminPolicy,
    nodePolicy,
    nodeCustodianPolicy,
    dataCustodianPolicy,
    userPolicy,
].join('\n');
