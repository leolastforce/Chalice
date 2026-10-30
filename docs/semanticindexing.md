# What does semantic file indexing refer to in Chalice?
Semantic indexing helps the agent find code by describing what it does, in scenarios where the agent might not know the exact filename or identifier. For example, the agent might search "the code that retries failed embedding requests" instead of guessing the function name.

It's an alternative option to the ordinary search tools, it's tool call is semantic_code_search.

# How the index is built
When indexing is turned on, Chalice finds eligible projects files (see ## Which files are ignored for details), divides their content into "chunks", and sends each "chunk" to your configured embedding provider. 

When the search happens, Chalice embeds that query with same provider and looks for chunks with similar vectors. The file path, line range, and short code snippet is then returned as the result from the tool.

> Supported providers for semantic file as of right now (feel free to request more in a github issue!):
- Voyage AI (Reccomended, considered to have the greatest indexing models overall.)
- Openrouter (Generally perfectly fine and easy to set up)
- Local OpenAI-compatible embeddings (See ## OpenAI-compatible embeddings provider information subcategory)

# Which files are indexed and how to explicitly ignore files?
Each file that is included in the list below will not be indexed:

- Git's ignore rules when the project is a Git repo
- Entries in ```.indexignore```
- Entries in ```.contextignore```
- Configured excluded directories, such as ```node_modules``` and ```dist```

Additionally, it is checked if a file is binary, oversized (768 KiB+), and files matching known secret filename or content patterns for privacy. Change this with /index config

# How does index updating work?
Alright so, you've indexed your project, and now you've added new changes, now what?

When indexing is enabled, a file watcher will update the index as files change. Small changes can be embedded automatically, but if many changes arrive together (common), the automatic embedding pauses and you will be notified to run /index update

# Tags
Tags let you filter semantic search results by project area without rebuilding the index.

```.index_tag``` files let you label directories so that you can filter search results. The tags are manually inputed and inherited from parent directories. Okay an example: a test tag in ```test/.index_tag``` applies to files under ```tests/```

Use ```exclude_tags``` to in turn remove tagged areas while still leaving untagged files eligible, use ```include_tags``` to restrict results to files with at least one listed tag.

Tag changes take effect at the tool call time so you do not need to reindex. Run /index tags to see tags

# Costs and provider
You will get an estimated token cost with the configured provider so you don't get caught offguard, for most repos, expect this to be dirt cheap, typically landing between 0.01 to 0.05$. If the provider remote's pricing is unknown, you'll just get an estimate in tokens instead.

The first time you enable indexing with a remote provider, Chalice will ask you to confirm that the code chunks can be sent to that provider, and local embeddings do not require an API key or send requests to a remote provider, so you will not be prompted. This is just a light privacy check <3

# OpenAI-compatible embeddings provider information
I wanted to clarify on how the OpenAI-compatible provider worked as an option since it doesn't work out of the box.

The local option connects to an embedding server running on your machine. It uses an OpenAI-compatible embeddings API, so the server needs to accept `POST /v1/embeddings` requests and return embedding vectors in the OpenAI response format. So, Chalice uses the server, and doesn't download or do anything from you

The default endpoint is `http://127.0.0.1:11434/v1/embeddings` with the model `nomic-embed-text`, which works with a compatible local setup such as Ollama. Make sure the server is running and the model is available before indexing. You can change the endpoint and model in `/index config`.

The local provider needs no API key and makes embedding requests to the configured local endpoint instead of a remote provider. The index and vectors are stored locally too. The separate `custom` provider can also connect to an OpenAI-compatible endpoint; configure its base URL, model, and API key environment variable in `/index config`.
