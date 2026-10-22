# MCP

Chalice keeps MCP support in the `Chalice/pi-mcp-adapter` extension rather than in the Pi core. The adapter is the authoritative implementation for loading MCP configuration and exposing MCP tools.

The adapter reads its project configuration from `.mcp.json` and its global configuration from the Chalice agent directory. Install or enable the adapter through the normal Chalice extension settings for the working directory.

Extensions that register MCP servers should use the adapter's public extension API. Do not add a second MCP client or server registry to the coding agent core.
