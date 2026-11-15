# Maintaining Relay with Relay

The earlier preview.1 fixture imported one public Issue and saved a local summary. Preview.2 uses native GitHub/Discord Sources, policy evaluation and ticket execution. Live account/provider checks have passed; full Discord-to-PR acceptance remains pending. Fixture results are historical evidence, not proof of native task completion.

## Repository write pilot

- The local fixture stays read-only. Repository writes use a separate native DSH Web profile, a dedicated OS account/workspace, and a dedicated GitHub user authenticated through its own `gh` wrapper. Limit that identity to this repository and verify its login and repository access before starting. Do not use the owner's personal token.
- Give the dedicated user repository **Write** access only when ready for the pilot. The upstream Source currently requires push access. Have the maintainer invite the bot and the bot accept the invitation. Keep automatic acceptance off or in observe mode; allowlist maintainers and authorize each write explicitly. Issue authors and Discord participants do not automatically become operators.
- An approved ticket may push its own branch and open or update its PR. Keep merge and release with humans. Protect the default branch with a GitHub ruleset requiring PR review and no bypass for the bot. The delivery prompt guides behavior; it does not enforce branch restrictions or reduce the OS scope of `danger-full-access`. Do not supply merge or release credentials to DSH.
- Before broader use, prove that an approved test branch and PR succeed under the bot identity, that a default-branch write is blocked by GitHub, and that an unapproved event stays local. To stop the pilot, stop its profile and remove the bot's repository access.
- Use one configured Discord channel and an explicit owner allowlist. New tasks must mention the actual bot user; follow-ups reply to bound task messages. Keep PR reviews on GitHub and keep credentials and private transcripts out of public issues, PRs and release artifacts.

For DSH Market, use the GitHub `dsh-plugin` topic for discovery and submit a separate entry to the [curated catalog](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin).

See the [ticket execution evidence proposal](ticket-execution-evidence.md) for the next reviewable improvement.
