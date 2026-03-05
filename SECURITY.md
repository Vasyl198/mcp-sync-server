# Security Policy

## Reporting a Vulnerability

If you discover a security issue, do not disclose it publicly.
Create a private report to the repository maintainers with reproduction steps,
affected components, and impact estimate.

## Secrets and Tokens

- Do not hardcode tokens, API keys, or secrets in source files.
- Use environment variables or secret managers.
- Revoke leaked tokens immediately.

## Required Hygiene Check

Run token hygiene checks before release:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File ops\autogen_engine\security_token_hygiene.ps1
```
