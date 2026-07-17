pi 0.73.1 `--print --mode json` golden NDJSON fixtures — captured 2026-07-17 (openai-codex/gpt-5.4-mini).
No secrets. Used by the SP2 piEvents parser tests. See docs/superpowers/specs/2026-07-17-sp2-pi-ndjson-step0.md.
- 0.73.1-text.ndjson   : plain text turn (session→…→text_delta→message_end→agent_end)
- 0.73.1-tools.ndjson  : read+write+bash tool calls (tool_execution_* shapes)
- 0.73.1-resume.ndjson : --session <id> resume (same id, context retained)
