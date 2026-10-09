// Requires the built package through its own "exports", as a CommonJS consumer would.
const sdk = require('@mercurifi/sdk');

for (const name of ['createClient', 'localKey', 'generateAgentKey', 'decodeRevert', 'verifyBuiltTx', 'openStream', 'wrapUntrusted']) {
  if (typeof sdk[name] !== 'function') {
    console.error(`CJS build is missing ${name}`);
    process.exit(1);
  }
}
console.log(`CJS ok ${sdk.SDK_VERSION}`);
