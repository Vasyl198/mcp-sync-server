# Run GGUF models without LM Studio (llama.cpp server)

Goal: run `qwen2.5-3b-instruct-q4_k_m.gguf` as a local OpenAI-compatible server, so the lab can talk to it via `OPENAI_BASE_URL`.

## Model path (as provided)
`C:\Users\anani\.lmstudio\models\Qwen\Qwen2.5-3B-Instruct-GGUF\qwen2.5-3b-instruct-q4_k_m.gguf`

## Recommended approach
Use **llama.cpp** `llama-server` (OpenAI-compatible endpoints are available in recent builds). Start it from PowerShell and point it at the GGUF file.

### Files in this folder
- `start_llama_server.ps1` — starts the server with safe defaults
- `probe_llama_server.ps1` — checks `/v1/models`
- `chat_llama_server.ps1` — simple chat call to `/v1/chat/completions`

## Notes
- Running "inside the lab" does NOT magically give the model date/time/web. You must inject facts/tools via the lab.
- If you want the lab to access the GGUF file via `fs`, add `C:\Users\anani\.lmstudio` to `MCP_ALLOWED_ROOTS`.
