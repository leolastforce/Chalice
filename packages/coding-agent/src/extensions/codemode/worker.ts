/**
 * Worker entry for the Codemode sandbox in bundled builds. The Node bundle and Bun binary include
 * this shim as a separate entrypoint so the sandbox can start its worker at runtime. The worker
 * specifier is resolved by `getCodemodeWorkerSpecifier()` in config.ts.
 */
import "@earendil-works/pi-codemode/worker";
