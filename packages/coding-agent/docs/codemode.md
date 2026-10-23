# Codemode

Codemode lets the model write a JavaScript script that orchestrates the tools active in the current session. Scripts run in a QuickJS WebAssembly sandbox with no Node.js, filesystem, or direct network access. Any tool calls still execute through the agent's normal validation, hooks, and permission checks. Calls that already completed are not rolled back if a later part of the script fails.

Codemode is available as a built-in extension but is inactive by default. Add it without replacing the default tools in `~/.pi/agent/settings.json`:

```json
{
  "defaultTools": ["+codemode"]
}
```

Alternatively, use `--tools read,bash,edit,write,codemode` to select an explicit allowlist. See [Settings](settings.md#tools) for tool selection and [Extensions](extensions.md#tool-exposure) for how nested calls are routed.

## Scripts

The `tools` object contains callable tools. Use `ALL_TOOLS` to inspect names and descriptions, and `describeTool(name)` to view a tool's declaration. Tool names are normalized to JavaScript identifiers, for example `tools.mcp__server__search`. Scripts can use `await`, `Promise.all`, `text()`, `console.log()`, and a top-level `return` value. The tool description includes the available declarations and model API.

Scripts can access the model catalog and run configured classifier models through `models.*`. Catalog entries omit custom headers so credentials are not passed into the sandbox. The model and classifier calls remain subject to normal provider authentication and model permissions.

`store(key, value)` and `load(key)` persist JSON-compatible values in the session. Writes are kept only when the script succeeds and follow the current session branch.

## Chalice MCP adapter

The built-in `Chalice/pi-mcp-adapter` remains the MCP client. Its `mcpScript` tool executes trusted adapter code outside the Codemode sandbox, so Codemode scripts cannot call `mcpScript` as a nested tool. When Codemode is active in `only` mode, active direct tools are hidden from the model and only callable nested tools are listed; use `on` mode if you also need to call `mcpScript` directly.

Codemode does not add Pi's built-in MCP client or tool-search extension. MCP server registration and adapter behavior remain documented in [MCP](mcp.md).
