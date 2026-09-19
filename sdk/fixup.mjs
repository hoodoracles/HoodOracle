// Tell Node how to read each output directory.
//
// The package is "type": "module", so every .js under it is ESM unless a
// nearer package.json says otherwise. Without this marker the CommonJS build
// is parsed as ESM and require() fails on the first `exports.` assignment.
import { writeFileSync } from "node:fs";
writeFileSync("dist/cjs/package.json", JSON.stringify({ type: "commonjs" }, null, 2) + "\n");
writeFileSync("dist/esm/package.json", JSON.stringify({ type: "module" }, null, 2) + "\n");
console.log("dist/{cjs,esm}/package.json written");
