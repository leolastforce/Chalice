import { describe, expect, it } from "vitest";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import hashline from "../index";
import { allocateAnchor, withAnchorSession } from "../src/anchor-registry";

describe("permission target bridge", () => {
  it("resolves anchors in the requesting session", async () => {
    const handlers = new Map<string, (data: unknown) => void>();
    const pi = {
      events: { on: (name: string, handler: (data: unknown) => void) => handlers.set(name, handler) },
      registerTool() {}, on() {}, registerCommand() {},
    } as unknown as ExtensionAPI;
    hashline(pi);
    const ctx = { sessionManager: { getSessionId: () => "permission-bridge-test" } } as unknown as ExtensionContext;
    const anchor = await withAnchorSession(ctx, () => allocateAnchor("/tmp/example.ts", "checksum"));
    let result: Promise<string> | undefined;
    handlers.get("chalice:hashline-resolve-target")?.({ ctx, first: anchor, respond: (value: Promise<string>) => { result = value; } });
    expect(await result).toBe("/tmp/example.ts");
  });
});
