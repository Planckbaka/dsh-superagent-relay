# Proposal: make ticket execution explainable

A Relay operator can see that a ticket is open and inspect its Worker Session, but several questions still require piecing together the entire ticket: did the Worker actually take my follow-up, did the latest attempt produce this report, and what changed after a restart? Answer those in the existing ticket detail before adding a second scheduler or a team abstraction.

## What to borrow

| Reference | Useful design | Relay decision |
| --- | --- | --- |
| [AgentTeams](https://github.com/NanmiCoder/dsh-agent-teams) | A task and activity view couples persisted task state with live Worker activity. | Render durable SQLite facts first. Add live activity only when the host can identify it reliably; a disconnected browser cannot change ticket state. Keep the existing Superagent Engine. |
| [MOA Plus](https://github.com/Burns1028/moa-plus) | Workers remain addressable, and work can be reviewed independently. | Link a report to its attempt and expose the existing Worker Session link. Defer shared memory and inter-Worker messaging until there is a case that needs them. A Worker report is not a review or merge decision. |
| [TheOne](https://github.com/YunongDai2005/dsh-theone) | One entry point hides session management while preserving topic context. | Keep the Ticket as the operator-facing unit. Use recorded thread and routing decisions rather than a model guess when explaining a follow-up. |

## Design

Add an **Execution evidence** section to the existing ticket detail. Use the existing authenticated GET ticket detail response. No new database, background poller, endpoint, or write action is needed for the first slice.

- **Attempts:** Use the persisted assignment ID and timestamps to identify an attempt. An ended attempt stays visible after a restart. Show the report under the assignment that produced it; never relabel an older report as the current attempt's result. If the cause of an ended attempt is not recorded, show “Ended” without inferring “Interrupted.”
- **Follow-ups:** Show “Queued” while in the undelivered set, “Delivered to session” once handed over, and “Read by Worker” only when the input has a recorded non-null read timestamp. Missing historical evidence is “Read status unknown”; it does not prove the Worker ignored the message. Neither delivery nor reading implies task completion.
- **Human actions:** Use the existing ticket stage and attention fields to surface what needs a person. Preserve the existing Session link and separate read-only preview from management. Do not echo untrusted raw text into new HTML, and do not publish transcripts or credentials to other channels.

Example: if attempt 1 produced a progress report, the host restarted, attempt 2 has started, and a follow-up was delivered but not read, show all four facts independently. The ticket remains active; the old report does not become attempt 2's result.

## Acceptance before enabling richer automation

1. A completed public Issue import shows its origin, the attempt that produced the report, and a link to the matching Worker Session. Refresh preserves those facts.
2. Keep A active, send a follow-up bound to A, and verify B sees no matching input. In A, queued, delivered, and read states follow the durable timestamps rather than a frontend timer. Run this with two real DSH sessions and keep the upstream mocked routing test as regression coverage.
3. Interrupt a real Worker after a deterministic test barrier. On restart, the same ticket and Worker Session have a new assignment; the old progress report remains under the old assignment. A report already in flight during cancellation or supersession must not overwrite the current attempt. Test this race separately with a controlled asynchronous dependency.
4. An authenticated read-only profile can inspect the evidence; anonymous requests still fail and the panel adds no write action. Old tickets without a read timestamp still render.

The existing real GitHub test proves one-shot Issue metadata import and a persisted Worker report. It does not prove live channel delivery, in-flight recovery, or autonomous maintenance. Until those gates pass, keep the repository's first maintainer loop one-shot and human-reviewed.
