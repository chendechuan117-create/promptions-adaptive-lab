# Security and deployment boundary

This repository is a local research prototype, not an authenticated public multi-user service.

- Keep `DEEPSEEK_API_KEY` on the server. Do not put it in browser bundles, screenshots, issue reports, or committed `.env` files.
- The server binds to `127.0.0.1`. The hostname allowlist and same-origin checks are defense-in-depth, not authentication or authorization.
- Before exposing an instance, add authenticated access, per-user session ownership, request limits and spending controls. The client-supplied request IDs used by this prototype are not authentication tokens.
- Inputs are sent to DeepSeek to generate cues and answers. Explain this to people using your deployment and publish the data-handling policy applicable to that deployment.
- Review exports before sharing them: a user-initiated JSON export contains their task, selections and notes.
- Do not open a public issue containing keys, private conversations or a live exploit against someone else's deployment.

The transport restricts provider endpoints and output sizes, rejects unexpected tool output and incomplete results, and does not return reasoning text. These measures do not establish semantic correctness or comprehensive security.

The dynamic MCP card is a bounded trial, not an authenticated public service. It defaults to zero model calls; an operator can enable at most 100 attempts per instance. Use its private numeric budget ledger for a single server process so restarts do not reset the allowance. The ledger contains no task text. Failed/cancelled attempts consume allowance; there is no automatic paid retry. Random client IDs separate task snapshots, but they do not establish a person's identity. Anyone able to access an unauthenticated trial endpoint may consume its remaining shared allowance. Production still requires authentication and per-user authorization.

Only the current click's selection and note are sent as MCP tool inputs. Server memory retains bounded current-task snapshots with a two-hour validity window and a 30-second expiry sweeper, with no request-body logging or text persistence. New input is sent to DeepSeek along with the task state needed for that generation. Final handoff sends the ordered task state to ChatGPT only when the user requests it. A delivery without a confirmed acknowledgement is locked against blind resending.
