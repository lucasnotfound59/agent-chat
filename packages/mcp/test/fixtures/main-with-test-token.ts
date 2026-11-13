import { startMcp } from '../../src/entry';

// Test-only entry: the same server as src/main.ts, but the token comes from AGENTCHAT_TEST_TOKEN
// instead of the keychain, so spawned-process tests never touch the real keychain.
const token = process.env.AGENTCHAT_TEST_TOKEN;
await startMcp(process.argv.slice(2), process.env, () => (token ? token : null));
