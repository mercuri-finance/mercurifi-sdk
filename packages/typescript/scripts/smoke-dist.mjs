// Imports the built package through its own "exports" (Node self-reference), as an ESM consumer would.
import { readFileSync } from 'node:fs';
import * as sdk from '@mercurifi/sdk';

for (const name of ['createClient', 'localKey', 'generateAgentKey', 'decodeRevert', 'verifyBuiltTx', 'openStream', 'wrapUntrusted']) {
  if (typeof sdk[name] !== 'function') {
    console.error(`ESM build is missing ${name}`);
    process.exit(1);
  }
}
const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
if (sdk.SDK_VERSION !== version) {
  console.error(`ESM build reports SDK_VERSION ${sdk.SDK_VERSION}, package.json says ${version}`);
  process.exit(1);
}
console.log(`ESM ok ${sdk.SDK_VERSION}`);
