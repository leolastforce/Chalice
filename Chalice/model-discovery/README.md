# @brglng/pi-model-discovery

A Pi extension that adds model auto-discovery to Pi using only the
`providers` section of Pi's native `~/.pi/agent/models.json` — no extension
development needed. Same format as Pi's built-in model configuration, with
`<baseUrl>/models` discovery and per-model overrides built in.

## Installation

```bash
pi install /absolute/path/to/pi-model-discovery
```

After publication:

```bash
pi install npm:@brglng/pi-model-discovery
```

## Configuration

Providers are defined under the `providers` key of Pi's native
`~/.pi/agent/models.json`. The key is the provider ID; each value is one
provider. For example:

```json
{
  "providers": {
    "gateway": {
      "$schema": "https://raw.githubusercontent.com/brglng/pi-model-discovery/main/schemas/config.schema.json",
      "name": "My Gateway",
      "baseUrl": "https://api.example.com/v1",
      "apiKey": "$GATEWAY_API_KEY",
      "api": "openai-completions",
      "models": [
        {
          "id": "special-model",
          "api": "openai-responses",
          "baseUrl": "http://192.168.5.46:18000/v1",
          "maxTokens": 32768
        }
      ]
    }
  }
}
```

`baseUrl` is the provider default URL and is optional. Providers without a
`baseUrl` remain in the configuration, but the extension skips remote model
discovery for them. `apiKey` uses Pi's native config value syntax. API keys are
provider-level; Pi's native model configuration does not support a separate API
key per model. It supports literals, `$ENV_VAR`, `${ENV_VAR}`, and leading
`!command` values. The key is never stored in the configuration when an
environment variable or command reference is used.

## Model discovery and overrides

Model discovery is always enabled: the extension requests `<baseUrl>/models`
with a Bearer token. It accepts common OpenAI-style responses (`data`), bare
arrays, and catalogs nested under `models` or `output.models`. Set
`PI_OFFLINE=1` to skip all network requests during startup.

Server model metadata is used by default. Entries in the `models` array can
specify overrides for configured model IDs. Provider and model fields are kept
as supplied; this extension does not validate fields it does not consume.
Configured model IDs are also retained when the server does not return them.
Common fields include `name`, `api`, `baseUrl`, `reasoning`,
`thinkingLevelMap`, `input`, `cost`, `contextWindow`, `maxTokens`,
`samplingParams`, `headers`, and `compat`. This allows each model to select a
different endpoint and API type such as `openai-completions`,
`openai-responses`, or `anthropic-messages`. The spelling
`anthropic-message` is accepted as an alias.

If discovery fails, explicitly configured models remain available.

## Commands

- `/model-discovery status` shows configured providers and model counts.
- `/model-discovery refresh` refreshes every catalog.
- `/model-discovery refresh <provider>` refreshes one catalog.

## License

MPL-2.0
