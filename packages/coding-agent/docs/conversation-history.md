# Local conversation history search

Chalice can search prior session transcripts when you ask about an earlier discussion, decision, or detail that was not saved as a memory. This is separate from **Chalice Memory Saving** and is disabled by default. Enable **Chalice Conversation Search** in `/settings` to allow retrieval.

Search is local and uses lexical matching; it makes no embedding or network requests. Search results are short excerpts with session IDs, dates, and entry references. The model may request nearby messages to verify context. Retrieved excerpts are sent to the currently selected model as tool results.

## Scope and privacy

Search defaults to sessions whose recorded working directory exactly matches the current working directory. Use all-project scope only when you explicitly ask about history from another project or general personal history. The active session, forked sessions, and any session that recorded `/memory private on` are excluded. A private marker excludes that entire source session, including messages recorded before or after private mode.

Private mode prevents retrieval in the current session and excludes source sessions carrying a private marker. It does not disable transcript recording. Session files remain on disk until you delete them through the session picker or remove them yourself. Disabling history search prevents future retrieval, but cannot erase excerpts already returned to a model. Deleting a saved memory does not delete the conversation where it was discussed.

## Search limitations

Search scans a bounded set of local JSONL session files on demand. Results can be incomplete when a scan hits its time or size limit; the tool reports whether the scan completed. It searches the latest persisted branch, not abandoned branches, and skips malformed or oversized files. It searches user and assistant text only, honors context edits that replace or omit messages, and does not index tool output, images, thinking, or attachments.

Conversation references are validated against current local files and access scope. If a source was removed or changed after search, search again. History search does not automatically save retrieved facts as durable memories.
