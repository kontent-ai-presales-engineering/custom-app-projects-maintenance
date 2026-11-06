// Fails when @kontent-ai/data-ops is not the version the patch and contract tests were
// validated against. To upgrade: regenerate the patch, run the tests, sync against a
// sandbox, then update VALIDATED_VERSION.
import { existsSync, readFileSync } from "node:fs";

const VALIDATED_VERSION = "2.8.1";
const patchFile = `patches/@kontent-ai__data-ops@${VALIDATED_VERSION}.patch`;

const fail = (message) => {
  console.error(`check:data-ops failed: ${message}`);
  process.exit(1);
};

const pkg = JSON.parse(readFileSync("package.json", "utf8"));
const declared = pkg.dependencies?.["@kontent-ai/data-ops"];
if (declared !== VALIDATED_VERSION) {
  fail(`package.json declares "${declared}", expected exactly "${VALIDATED_VERSION}".`);
}

// data-ops does not export its package.json, so read it from node_modules directly.
const installedPkgPath = "node_modules/@kontent-ai/data-ops/package.json";
if (!existsSync(installedPkgPath)) {
  fail("data-ops is not installed. Run pnpm install.");
}
const installed = JSON.parse(readFileSync(installedPkgPath, "utf8"));
if (installed.version !== VALIDATED_VERSION) {
  fail(`installed version is ${installed.version}, expected ${VALIDATED_VERSION}.`);
}

if (!existsSync(patchFile)) {
  fail(`patch file ${patchFile} is missing.`);
}

const internalExports = [
  "./internal/diff",
  "./internal/sync",
  "./internal/sync-run",
  "./internal/report",
  "./internal/patch-operation",
];
const missing = internalExports.filter((path) => !(path in (installed.exports ?? {})));
if (missing.length > 0) {
  fail(`patch not applied, missing exports: ${missing.join(", ")}. Run pnpm install.`);
}

console.log(`check:data-ops ok (${VALIDATED_VERSION}, patch applied)`);
