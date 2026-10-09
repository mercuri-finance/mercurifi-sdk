// Marks each build directory with its module type so Node resolves dist/esm as ESM and dist/cjs as CommonJS.
import { writeFileSync } from 'node:fs';

writeFileSync(new URL('../dist/esm/package.json', import.meta.url), '{ "type": "module" }\n');
writeFileSync(new URL('../dist/cjs/package.json', import.meta.url), '{ "type": "commonjs" }\n');
