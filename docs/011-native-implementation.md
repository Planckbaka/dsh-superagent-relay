# 011 Native implementation and acceptance

This document records the implementation following [010 Gap audit](010-superagent-gap-audit.md). It distinguishes code and automated acceptance from a live deployment. The original audit is a historical baseline, not a claim that the gaps below remain unchanged.

## Implemented core changes

| Design requirement | Implementation | Acceptance |
| --- | --- | --- |
| Source-native actors | `src/sources/discord.ts` produces `discord` actors, immutable Trigger IDs and a separate root conversation for each task | Owner/unlisted sender policy and two-task isolation tests |
| Native admission | Discord calls SourceContext.receive; there is no direct accept or synthetic operator in native intake | A listed explicit request enters Eval; an unlisted user cannot directly create a ticket |
| Source/Policy settings | Native Source form and separate Discord user allowlist, receiving scope, thread context and channel links | Existing source/policy/management suites and native integration tests |
| Shared delivery | All native controls, acknowledgements, questions and composed results go through SQLite receipts, Effects, Outbox and SourceRegistry | Pause, failed-target isolation and existing Outbox tests |
| Structured questions | Concrete human_action is queued under its native attention ID; internal Worker summaries remain internal; the main Agent composes answers/results | Question, follow-up on the same ticket, ready result, and ordinary-progress silence tests |
| Pause | Sources continue durable intake while Eval/dispatch/Outbox delivery stop; chunk sends recheck pause | Intake-during-pause and resume delivery tests |
| Transient intake errors | Cursor advances only after successful native intake or an explicitly ignored event | Failed intake retries the same event; immutable Engine IDs deduplicate a crash after intake |
| Long reply recovery | Each successfully accepted chunk commits its next offset and returned message binding atomically | Failure after chunk one, recreated transport, no replay of known successful chunks |
| Authentication/rate limits | Bot identity checked against persisted identity, credential rotation revalidated; 401/403/404 retain receipts; Retry-After/cooldown recorded | Credential-bound transport and HTTP failure tests; no global listener exit on a target failure |
| Bounded transport indexes | 30-day retention for inactive bindings; delivery checkpoints removed only for settled receipts | Pending receipts and open conversations are retained; domain records remain governed by the Store |
| Write permissions | Execution panel exposes read-only/workspace-write/full access; changed mode restarts; root and descendant Worker Sessions receive the same ceiling | Settings guard and native bootstrap/CLI account tests |
| Dedicated write identity | Initial native setup records expected bot login; startup verifies actual login and repository push permission | Wrong identity, read-only account and inherited personal-token rejection tests |
| Ticket workspace | Fresh native bootstrap configures a separate clone and `agent/$DSH_SUPERAGENT_NAME` branch per ticket | Existing prepare/workspace tests and bootstrap assertions |
| Operational recovery | Packaged Python watchdog restarts crashed/unreachable DSH; authenticated probes; explicit supervisor stop remains stopped | Actual child process crash/restart, authenticated HTTP health and intentional stop test |
| Reproducible package inputs | Source build includes native transport and runtime; package includes prompts, docs and startup scripts | Typecheck, full test suite, build, archive inspection and isolated package import |

## Execution permissions and repository authority

`executor.permissionPreset` defaults to `workspace-write` for native deployments. An authenticated operator can choose `read-only` or `danger-full-access` on Execution settings. Models cannot change the preset or point Discord at a different credential file. Changing a preset restarts the runtime so restored Sessions and Worker subagents use the new setting. The explicit read-only environment override and legacy fixture mode take precedence.

The DSH `workspace-write` preset requests approval for wider execution. A repository Write role is separate from filesystem/shell permissions and from a Ticket's Mandate. A model's desire to write, an Issue author's message and Discord community membership do not grant authority. Keep proactive mode at `observe` until its decisions have been reviewed. An authorized repository ticket may edit its own workspace and propose work on its branch; the maintainer retains merge and release. Delivery prompts guide behavior; GitHub branch protection and OS/container isolation enforce the relevant boundaries. Full access is not a repository-only sandbox.

The launcher clears inherited `GH_TOKEN`, `GITHUB_TOKEN` and `GH_CONFIG_DIR` so they cannot silently override the dedicated wrapper. The wrapper itself must point to a private bot configuration. The host still runs operator-owned account probes and workspace preparation outside a Worker tool's filesystem restrictions; therefore the deployment account must itself have only the intended access.

## Fresh native deployment

Follow the dedicated account and branch-protection instructions in [006 Deployment](006-deployment.md). Use a fresh private DSH home, not the old fixture database. Node.js must satisfy the package engines; Python 3.9+ is required for the new launcher/watchdog scripts.

The Discord private configuration has exactly these metadata fields:

```json
{
  "channel": "YOUR_CHANNEL_ID",
  "owner": "YOUR_OWNER_USER_ID",
  "tokenFile": "/absolute/private/discord-bot-token"
}
```

Keep the token in the private file named by tokenFile, with permissions restricted to the deployment account. Enable the Discord application's Message Content capability and give the bot the channel permissions needed to view history and send messages. Role mentions are not bot mentions. The configured human owner is bootstrapped into the Discord policy allowlist; additional users are explicit policy changes. Each Source retains its own identity vocabulary.

First verify the GitHub account without changing a profile:

```sh
python3 scripts/relay-web.py --home /absolute/private/relay-home \
  --repository YOUR_OWNER/YOUR_REPO --github-cli /absolute/private/gh-agent \
  --agent-login YOUR_BOT_LOGIN --check-only
```

Then initialize/start it:

```sh
python3 scripts/relay-web.py --home /absolute/private/relay-home \
  --repository YOUR_OWNER/YOUR_REPO --github-cli /absolute/private/gh-agent \
  --agent-login YOUR_BOT_LOGIN --allow-github YOUR_MAINTAINER_LOGIN \
  --discord-config /absolute/private/discord.json \
  --permission workspace-write --initialize
```

Supply `--dsh /absolute/path/to/dsh` if DSH is not on PATH. A prebuilt installed package may be used in an already configured profile; `--initialize` installs the local package containing the launcher. Provider settings stay in the dedicated profile. For Magpie, add `--magpie-url http://127.0.0.1:3425/v1` with the provider key in this home's `.env` or environment. The default model is `zhipu/glm-5.3-flash`; provider availability and model access must be verified in that deployment.

Initialization records configuration once. Subsequent flags do not overwrite database settings; use the authenticated management panel for changes. The Web server listens on loopback and keeps DSH login enabled. Configure server-side authentication and transport before exposing it remotely.

`--supervise` adds bounded-backoff process recovery and authenticated health probes. It does not install an OS service, does not mean boot autostart, and does not turn a failed account configuration into a valid one. Its status file contains process/health states, not authentication URLs, model text or channel transcripts. Use foreground startup for initial Web setup. A supervisor intentional stop stops recovery. Native Engine/Store restore the Ticket state after a process restart; this is separate from a live model-interruption acceptance experiment.

## Delivery guarantees and limits

On first native startup, polling starts at the current channel tail. It does not replay the legacy file-based chat journal or reinterpret old synthetic lab tickets. Existing fixture state is retained. Reply bindings and unsent chunk checkpoints are persisted in the native SQLite store.

Discord's enforced nonce deduplication is recent-window protection. If Discord accepted a chunk but its HTTP response was lost before the local checkpoint, a retry after that window can duplicate the unknown chunk. Known successful chunks are not replayed. This is not an unlimited exactly-once guarantee. HTTP 401/403/404 preserve work for credential/access repair; one failed ticket's receipt does not prevent other tickets' receipts from being tried. Channel deletion and permission errors may be indistinguishable, so native delivery conservatively retains the receipt instead of declaring it delivered.

Closed/inactive conversation indexes may expire after 30 days. Pending delivery checkpoints are never pruned merely because they are old. Domain Ticket/history retention is separate. Large IM results are split without dropping Unicode characters; the orchestrator remains responsible for concise, appropriate human-facing wording.

`/help` and `/status` are human-owner controls and use the shared Outbox. Reply to a task message to select it; there is no implicit global-last-task selection. `/stop` enters the native domain as a human stop request for the main Agent to assess; it does not let an adapter forge a Mandate decision. Ordinary status chatter stays internal.

## Remaining live acceptance gates

Automated acceptance is not the same as testing an installed public release or completing a live Discord/model/GitHub change:

1. The dedicated bot must accept its repository Write invitation and sign in through its own wrapper. A maintainer login cannot substitute for this.
2. Run the native profile with its real model/provider; send an authorized Discord request, answer a concrete clarification, inspect the completed result, and compare persisted receipt/task records.
3. Authorize a harmless change in the target repository; verify bot-authored branch/push/PR, required review protection, refusal of a direct default-branch push, and no writes from an unlisted source user. Do not test protection by attempting destructive changes.
4. Interrupt a real in-flight model turn and an uncertain Discord send, restart, and record the observed result. Mocked model/HTTP failures and an actual host watchdog test do not prove that combined live scenario.
5. Build/install the exact reviewed archive in a clean profile. A stable release requires those gates. A preview may be published with these gates explicitly outstanding; do not claim preview.1 contains the native implementation.

Discord Gateway, attachments, registered slash commands, interactive approval buttons, QQ/WeChat and token streaming are optional channel extensions. They are not implemented by this core-completion change. The current implementation does not claim a Discord approval UI: wider execution approvals use DSH's authenticated UI.

## Verification record — 2026-11-15

- Supported runtime: Node.js v24.22.3.
- `pnpm check`: typecheck passed; 65 test files / 1243 tests passed; server and Web client builds passed.
- The watchdog test actually starts a local child HTTP server, verifies its authenticated health request, observes crash/restart, and verifies an intentional stop.
- The local native package version is `0.1.0-preview.2`. It was initially a local build; preview.2 release preparation now packages this implementation with the remaining live acceptance gates disclosed.
- The archive was inspected for required runtime assets/scripts, private configuration paths/files, known Discord/provider credential values and absolute developer home paths. No matches were found in the checked categories.
- The extracted package's server entry imported successfully using existing peer dependencies. This is a package-layout/import check, not a fresh dependency installation or real model acceptance.
- Initial native write preflight refused startup because the fresh dedicated account directory was not signed in. This was the state before the live deployment update below.

### Live deployment update — 2026-11-15

- Verified the local GitHub login as the dedicated bot `orionarch26`, with repository `pull` and `push` permissions and without administrator access. The bot was authenticated in the native deployment's separate private GitHub configuration and the launcher's identity/write preflight passed.
- Stopped the legacy Discord listener before starting the native profile, retaining its files and task history. The native authenticated Web server listens on loopback port 3085; its setup reports the expected bot and repository with no setup problem. GitHub, Discord and runtime health report ready.
- Verified a real `zhipu/glm-5.3-flash` completion through the existing local Magpie gateway. The native model catalog routes that same provider/model. This probe verifies provider access, not a completed orchestrated task.
- Verified repository remote access with the worker's isolated Git configuration. No branch push, PR creation, merge or release was performed by these checks.
- At this checkpoint the native task, decision and thread lists were empty. An owner-authored Discord request must mention the actual bot user (not a role), or reply to an already bound task. End-to-end task execution, bot-authored PR creation and Discord result delivery remain unverified until that real request completes.
