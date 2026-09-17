# @brglng/pi-model-discovery

为 Pi 添加模型自动发现功能的 Pi 扩展。只需在 Pi 原生 `~/.pi/agent/models.json`
的 `providers` 下配置 Provider，即可使用模型自动发现，无需自行开发扩展。格式与
Pi 自带的模型配置完全相同，内置 `<baseUrl>/models` 发现与按模型覆盖。

## 安装

```bash
pi install /absolute/path/to/pi-model-discovery
```

发布后：

```bash
pi install npm:@brglng/pi-model-discovery
```

## 配置

Provider 定义在 Pi 原生 `~/.pi/agent/models.json` 的 `providers` 键下。键为
Provider ID，每个值对应一个 Provider。例如：

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

`baseUrl` 为该 Provider 的默认 URL，可省略。没有 `baseUrl` 的 Provider 仍会保留在
配置中，但扩展会跳过该 Provider 的远程模型发现。`apiKey` 使用 Pi 原生配置值语法。
API key 为 Provider 级别；Pi 原生模型配置不支持每个模型单独的 API key。支持字面量、
`$ENV_VAR`、`${ENV_VAR}` 与前导 `!command`。使用环境变量或命令引用时，实际 key
不会落盘到配置文件。

## 模型发现与覆盖

模型发现固定开启：扩展请求 `<baseUrl>/models` 并携带 Bearer token。支持常见
OpenAI `data` 响应、裸数组，以及 `models` 或 `output.models` 响应。设置
`PI_OFFLINE=1` 可在启动时跳过网络请求。

服务端返回的模型参数默认全部保留。`models` 数组中的条目可为配置的模型 ID 指定覆盖项。
Provider 与模型字段会按原样保留；此扩展不会校验不参与自身处理的字段。即使服务端没有
返回，`models` 中配置的模型 ID 也会保留。常见字段包括 `name`、`api`、`baseUrl`、
`reasoning`、`thinkingLevelMap`、`input`、`cost`、`contextWindow`、`maxTokens`、
`samplingParams`、`headers` 与 `compat`。因此每个模型可以单独指定
`openai-completions`、`openai-responses` 或 `anthropic-messages`，也可以单独指定
Endpoint。`anthropic-message` 也可作为别名。

模型发现失败时，显式配置的模型仍然可用。

## 命令

- `/model-discovery status` 显示已配置 Provider 及模型数量。
- `/model-discovery refresh` 刷新全部模型目录。
- `/model-discovery refresh <provider>` 刷新单个 Provider。

## 许可证

MPL-2.0
