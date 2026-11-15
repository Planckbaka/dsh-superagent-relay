# 012 Stable release acceptance

Preview.2 is the current published distribution. A stable `0.1.0` release requires the following evidence from the actual candidate; a successful standalone CLI call or fixture cannot substitute for a native ticket. See [native implementation](011-native-implementation.md) for delivery guarantees and [deployment](006-deployment.md) for account boundaries.

| Gate | Current evidence | Remaining requirement |
| --- | --- | --- |
| Source/build integrity | Preview.2 has 1243 passing tests, typecheck/build, source/package privacy checks and matching downloaded release assets | Run these checks for the stable candidate and require successful GitHub checks before review |
| Installability | Exact preview.2 archive installed and imported in a fresh profile on the existing DSH host | Repeat for the final stable archive; do not describe this as a clean-machine test |
| Identity and repository access | Dedicated bot login and Write permission verified; isolated worker Git configuration accesses the remote | Verify these again with the candidate |
| Authorization and change delivery | Automated owner/unlisted-user, pause and mandate checks pass | Real authorized request → native ticket → bot-authored branch/PR; inspect author, diff, ticket record and channel result |
| Human clarification | Automated structured question and bound follow-up checks pass | Answer a real worker question in Discord and confirm the same ticket continues |
| Restart/recovery | Real local subprocess watchdog test passes; preview.2 idle native restart preserved pause, Discord cursor, main Session and the empty ticket set, then resumed processing | Repeat with the candidate; separately interrupt an in-flight model turn and retry ambiguous delivery without claiming unlimited exactly-once semantics |
| Default branch protection | Active required-review, deletion and non-fast-forward rules; no bypass actors; one approval and last-push approval required | Independent maintainer review of the final source; do not use a real main push as a destructive protection test |
| Final release | Preview.2 is public, with source PR #4 pending | Publish a stable tag only for reviewed source with passing checks and disclosed remaining limitations |

## Repeatable package inspection

The candidate includes a standalone inspector that never extracts the archive:

```sh
pnpm check
pnpm pack --pack-destination .artifacts/candidate
python3 scripts/verify-release.py .artifacts/candidate/dsh-superagent-relay-*.tgz \
  --version "$(node -p 'require("./package.json").version')" \
  --output .artifacts/candidate/verification.json
```

It checks required runtime assets, package identity/version, duplicate entries, unsafe paths/links, unpacked size limits, private/generated filenames, GitHub token patterns and developer home paths. Pass `--secret-file /absolute/private/raw-token-file` to check a known credential without printing it. Output contains only categories and a digest. This is a bounded static scan, not a guarantee that arbitrary secrets or malicious code can never be present. Scan the public source changes as well, and keep credential files outside the repository.

The GitHub `Release readiness` workflow runs the locked dependency install, tests/typecheck/build and exact-package inspection on pushes and PRs with a read-only repository token. Its external actions are pinned to commit SHAs and the repository step does not persist Git credentials. It does not deploy, publish, review or merge.

## Real request and evidence

An allowed human sends a request mentioning the actual Discord bot user, for example a bounded README correction with an explicit instruction to create a PR and never merge or publish. A task must enter through the production Source, retaining its actual actor and immutable event ID. Never forge a human Discord event, reuse a fixture's synthetic operator, or count a PR created by the release operator as a Worker-authored PR.

Record event/ticket/assignment/receipt identifiers, the bot-authored PR URL and tested revision. Keep raw channel transcripts, cookies, keys and private channel IDs in the private deployment directory. A public report may summarize outcomes and link a public PR. Do not echo private content into CI logs.

For a clarification experiment, supply a task with one deliberately missing, harmless detail. Answer the actual worker question by replying to its message; check that the original ticket resumes. For interruption/recovery, start with no unrelated active tickets, retain a private backup and record exactly which component was interrupted. A model HTTP cancellation alone does not demonstrate ticket recovery. A restart with no in-flight work demonstrates startup/state persistence only.

## Promotion and rollback

Keep the preview.2 tag immutable while preparing the stable candidate. Use a new candidate version for changed package contents. Required review remains in force, even for a bot with repository Write access. The release operator must not switch to the maintainer's identity to self-approve or bypass protection.

Before promotion, match the tag commit, tested source revision, exact archive digest and independently reviewed PR. Preserve old private state before migration; stop the old listener before enabling its replacement. Rollback must restore a matching package and compatible private state, not mix a fixture database into native runtime state. Keep preview.2 available until the stable deployment is accepted.
