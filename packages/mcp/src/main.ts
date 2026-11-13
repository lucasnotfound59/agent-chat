import { startMcp } from './entry';
import { readTokenFromKeychain } from './hubClient';

// The production entry: the hub token comes from the macOS keychain only.
await startMcp(process.argv.slice(2), process.env, () => readTokenFromKeychain());
