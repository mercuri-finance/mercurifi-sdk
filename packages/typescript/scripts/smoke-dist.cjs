// Requires the built package through its own "exports", as a CommonJS consumer would.
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const sdk = require('@mercurifi/sdk');

for (const name of [
  'createClient',
  'localKey',
  'generateAgentKey',
  'decodeRevert',
  'verifyBuiltTx',
  'openStream',
  'wrapUntrusted',
]) {
  if (typeof sdk[name] !== 'function') {
    console.error(`CJS build is missing ${name}`);
    process.exit(1);
  }
}
const { version } = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8'));
if (sdk.SDK_VERSION !== version) {
  console.error(`CJS build reports SDK_VERSION ${sdk.SDK_VERSION}, package.json says ${version}`);
  process.exit(1);
}
console.log(`CJS ok ${sdk.SDK_VERSION}`);
