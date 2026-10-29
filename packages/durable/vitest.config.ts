import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const chordSrcIndex = fileURLToPath(new URL("../chord/src/index.ts", import.meta.url));
const chordSrcContext = fileURLToPath(new URL("../chord/src/context/index.ts", import.meta.url));
const chordSrcDelta = fileURLToPath(new URL("../chord/src/delta/index.ts", import.meta.url));
const durableSrcIndex = fileURLToPath(new URL("./src/index.ts", import.meta.url));
const durableSrcTesting = fileURLToPath(new URL("./src/testing/index.ts", import.meta.url));

export default defineConfig({
	test: {
		environment: "node",
	},
	resolve: {
		conditions: ["source"],
		alias: [
			{ find: /^@earendil-works\/chord$/, replacement: chordSrcIndex },
			{ find: /^@earendil-works\/chord\/context$/, replacement: chordSrcContext },
			{ find: /^@earendil-works\/chord\/delta$/, replacement: chordSrcDelta },
			{ find: /^@earendil-works\/pi-durable$/, replacement: durableSrcIndex },
			{ find: /^@earendil-works\/pi-durable\/testing$/, replacement: durableSrcTesting },
		],
	},
	ssr: { resolve: { conditions: ["source"] } },
});
