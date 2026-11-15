# Discord conversation loop

## Scope and architecture

The plugin now includes `src/discord-chat.ts`, composed by `src/app/runtime.ts`.
It uses the existing Superagent Engine and Workers rather than creating a second agent execution path.
The feature is opt-in and currently runs on the isolated, read-only local profile. It is not a replacement
for all capabilities of the upstream Discord adapters (Gateway, attachments, interactive approval buttons,
slash-command registration and token streaming are not implemented).

Reference designs inspected:

- https://github.com/ghbhiee/dsh-plugin-discord : allowlisted session bridge, continuation and long output splitting.
- https://github.com/addozhang/dsh-discord : persistent bindings, owner controls, lifecycle feedback,
  deny-first authorization and outbound mention suppression.
- Existing plugin `src/app/outbox.ts`, `src/sources/feishu-loops.ts`: durable effects and checkpointed intake.

No upstream code was copied and no new dependency was added. This adapter uses a separate persistent transport
journal because the current local-fixture source has no external send address. A future production source
should use the shared SourceRegistry/Outbox directly rather than duplicating its delivery machinery.

## User interaction

Only the configured human owner in the configured channel can execute commands. Bot and webhook messages
are ignored. A mention of a role cannot authorize work; the owner receives a corrective hint.

- `@bot <task>` creates a task with the existing model and read-only Worker permission preset.
- Replying to a previously accepted user message or a bot task response continues that task, without another mention.
- `@bot /help` explains usage.
- `@bot /status` reports the latest associated task; reply to a particular task to select it.
- `@bot /stop` invokes Engine.stopTicket; reply to a particular task to select it.
- A human-stopped task cannot be resumed by a reply; start a new task instead.
- Other slash-prefixed text and tasks over 8000 characters receive a rejection reply.

The bot returns acceptance, changing progress/waiting/blocked/failed reports, and the terminal result.
Worker summaries are the authoritative answer. It does not stream private chain-of-thought or raw tool logs.
Model settings come from DSH; the Discord layer never receives provider credentials.

## Enable on an isolated profile

Build/package this checkout and install its generated archive in the intended DSH profile first. The old
installed lab archive does not acquire new code merely because this source checkout changed.

Keep the existing credential config shape (outside Git):

```json
{
  "channel": "DISCORD_CHANNEL_ID",
  "owner": "DISCORD_USER_ID",
  "tokenFile": "/absolute/private/path/to/bot-token"
}
```

IDs must be 16–22 digit strings. Restrict credential/config files to owner access. Do not put token text in
JSON, shell arguments, Git or screenshots. Grant the bot View Channel, Read Message History and Send Messages
in this channel. Enable Message Content Intent. No Administrator permission is needed.

Start the installed plugin in the isolated profile with:

```sh
DSH_SUPERAGENT_LOCAL_FIXTURE=1 \
DSH_SUPERAGENT_READ_ONLY=1 \
DSH_SUPERAGENT_DISCORD_CHAT=/absolute/private/path/to/discord.json \
dsh superagent-lab --host 127.0.0.1 --port 3084 --no-open
```

The profile must already have a working provider/model configuration. The chat option takes precedence over
the old arithmetic-only lab listener, which remains available independently. Do not enable both deliberately.
First startup establishes a cursor at the latest message; send the test after health becomes ready.
Subsequent starts resume the saved cursor and retry pending outbound replies.

## Reliability and failure semantics

The credential config's `.chat-state.json` sibling stores the consumer identity, cursor, message↔ticket
bindings, report revisions and pending replies. Writes use a mode-0600 temporary file and atomic rename.
This file contains private conversation results and must remain outside Git. The enclosing profile must
have a single running owner (the Superagent state-directory lock provides runtime exclusivity).

Intake is committed by Engine before the transport cursor advances. Stable trigger IDs recover a crash
between these two commits. Transport replies are persisted before the cursor advances, then delivered in
order. Recent ambiguous sends reuse deterministic Discord nonces with `enforce_nonce`; Discord's deduplication
window is finite, so a crash/retry far outside that window can produce duplicate messages. No global
exactly-once delivery guarantee is made. Bindings and delivery journal currently have no retention/compaction;
monitor disk growth for long-running deployments. Atomic rename protects process-crash recovery, not a
power-loss fsync guarantee.

Network/5xx failures retry with bounded exponential backoff. HTTP Retry-After is honored (bounded to five
minutes); 401/403/404 stop the adapter with an actionable health error rather than repeatedly submitting work.
Correct credentials/permissions then restart. Queue entries remain for recovery. Intake, delivery and health
run independently of Worker execution; no credential or raw fetch error is included in health messages.
Outbound messages disable all automatic mentions and reply pings. Long text is split below Discord's 2000
UTF-16-unit limit without splitting Unicode code points; Markdown code fences may span chunks.

## Acceptance

Automated coverage includes authorization, role rejection, Unicode splitting, acknowledgement→result,
reply binding, follow-up routing, stop controls, restart deduplication, permission-failure retention and 429
retry with stable nonce. Run `pnpm typecheck`, targeted Discord tests and `pnpm build` before installation.

Real acceptance remains a separate step: install the new build, grant channel Send Messages, start the profile,
send an owner mention, observe acceptance and final answer in Discord, reply with a follow-up, query status,
stop a longer task, and restart with pending delivery. Confirm the same ticket/session appears in the DSH UI.
Do not infer this new outbound implementation passed live acceptance from the earlier inbound-only sum test.
