# Changelog

## 0.1.0-rc.1 (unreleased)

- Add read-only GitHub checks for locked installation, typecheck/tests/build and exact distribution inspection, with immutable external action pins and no stored Git credentials.
- Add a standalone archive inspector for required assets, version/identity, unsafe members, duplicates, unpacked limits, private files and credential/home-path matches; error output never includes matched values.
- Track stable promotion using separate real-task, clarification, recovery, artifact and independent-review evidence. Preview.2 remains immutable while these gates are pending.

## 0.1.0-preview.2

- Replace the fixture-first deployment instructions with native Discord/GitHub setup in a fresh authenticated DSH profile.
- Route Discord actors through native policy/Eval, tickets and the shared persistent Outbox. Preserve task-bound replies, structured questions, retry checkpoints and delivery cooldowns.
- Add operator-controlled read-only, workspace-write and full-access presets, including worker subagents and runtime restart on changes.
- Require a separately authenticated bot and verify its identity and repository Write access. Prepare a separate clone/branch per ticket.
- Package the native launcher and an optional process watchdog. Preserve upstream licensing and community links.
- Validation: 65 test files / 1243 tests, typecheck and build passed before release preparation. Live isolated bot access, native startup, worker remote access and a real GLM-5.3-Flash completion passed. Full Discord → Worker → PR → Discord acceptance and model-interruption recovery remain pending.
- Migration: stop the old listener, back up its private state and initialize a fresh native profile. Never copy fixture state into the native Store. Preview.1 is superseded but retained for rollback.

This is a prerelease. There is no claim of complete upstream parity, unlimited exactly-once delivery, clean-environment dependency installation, or completed live PR acceptance. No QQ/WeChat transport or interactive Discord approval UI is included.

## 0.1.0-preview.1 (superseded)

Initial read-only fixture preview. Retained as a historical rollback artifact; use preview.2 for native deployment.
