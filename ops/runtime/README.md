# Local LLM runtime helpers

These scripts make the local LLM feel "inside" the lab by giving the lab a stable way to:
- probe the local OpenAI-compatible server (LM Studio / Ollama / llama.cpp server)
- run a chat request from PowerShell
- log outputs (you can paste into notes/events)

Current lab constraints:
- Use PowerShell (cmd is blocked)

## Unified lab stack (recommended)

Use one command to start:
- in-process local LLM backend (`local://swe`, no external server)
- SWE exec MCP server (3000)
- SWE reasoner MCP server (3001)
- optional bridge dialog window

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\ops\runtime\start_lab_stack.ps1 -OpenDialog
```

After startup, in the shell where you run the bridge consumer/dialog, set:

```powershell
$env:WINDSURF_SWE_MCP_URL="http://127.0.0.1:3000/mcp"
$env:WINDSURF_SWE_REASONER_MCP_URL="http://127.0.0.1:3001/mcp"
$env:WINDSURF_SWE_MODE="auto_exec"   # switch to llm_loop when needed
```
