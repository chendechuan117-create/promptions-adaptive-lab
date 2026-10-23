# Security and deployment boundary

This repository is a local research prototype, not an authenticated public multi-user service.

- Keep `DEEPSEEK_API_KEY` on the server. Do not put it in browser bundles, screenshots, issue reports, or committed `.env` files.
- The server binds to `127.0.0.1`. The hostname allowlist and same-origin checks are defense-in-depth, not authentication or authorization.
- Before exposing an instance, add authenticated access, per-user session ownership, request limits and spending controls. The client-supplied request IDs used by this prototype are not authentication tokens.
- Inputs are sent to DeepSeek to generate cues and answers. Explain this to people using your deployment and publish the data-handling policy applicable to that deployment.
- Review exports before sharing them: a user-initiated JSON export contains their task, selections and notes.
- Do not open a public issue containing keys, private conversations or a live exploit against someone else's deployment.

The transport restricts provider endpoints and output sizes, rejects unexpected tool output and incomplete results, and does not return reasoning text. These measures do not establish semantic correctness or comprehensive security.
