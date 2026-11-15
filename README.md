# Superagent Relay for DeepSeek Harness

Superagent Relay is an independent community plugin derived from the MIT-licensed [DeepSeek Superagent prototype](https://github.com/deepseek-ai/dsh-superagent-prototype/tree/8c32a9dc5d72c033816c6a8110b37f40cf94fba4). It runs as a native DSH Web bundle, connecting GitHub and Discord to policy-gated evaluation, isolated ticket workspaces and persistent result delivery.

**Current release: 0.1.0-preview.2.** This preview replaces the earlier read-only fixture distribution. It includes native Discord intake and configurable execution permissions. Automated checks and live provider/account checks have passed; a complete Discord → Worker → GitHub PR → Discord result acceptance is still pending. See [acceptance evidence and limits](docs/011-native-implementation.md).

## Install

Use Node.js `^22.19.0` or `>=24.0.0`, Python 3.9+ and a compatible DSH Web host. The local deployment uses DSH Web 0.2.2-rc.2 and Node 24. Create a separate profile because the bundle shares runtime and panel identifiers with upstream Superagent:

```sh
dsh relay --from-default-profile web --dump-config >/dev/null
dsh plugin --profile relay add https://github.com/Planckbaka/dsh-superagent-relay/releases/download/v0.1.0-preview.2/dsh-superagent-relay-0.1.0-preview.2.tgz
```

Configure the profile's model and a fresh absolute `stateDir`. Keep the bundled legacy GitHub/Feishu watch plugins disabled; native Sources are configured through Superagent settings. Do not set `DSH_SUPERAGENT_LOCAL_FIXTURE`, `DSH_SUPERAGENT_READ_ONLY`, or legacy Discord lab/chat flags for a native deployment.

For deployment with one-time account, policy and Discord initialization, extract the release archive and use its launcher:

```sh
mkdir relay-package
tar -xzf dsh-superagent-relay-0.1.0-preview.2.tgz -C relay-package
python3 relay-package/package/scripts/relay-web.py \
  --home /absolute/private/relay-home \
  --repository YOUR_OWNER/YOUR_REPO \
  --github-cli /absolute/private/gh-agent \
  --agent-login YOUR_BOT_LOGIN --allow-github YOUR_MAINTAINER_LOGIN \
  --discord-config /absolute/private/discord.json \
  --permission workspace-write --initialize
```

The launcher installs the extracted package in a dedicated fresh profile. It requires a dedicated GitHub bot with repository Write access and an executable wrapper using the bot's private GitHub configuration. It checks the actual login and push permission, strips inherited GitHub tokens and refuses the repository owner's identity. `--check-only` verifies these prerequisites without starting a profile.

The private Discord configuration contains `channel`, `owner` and an absolute `tokenFile` path. Enable Message Content and grant the bot access to read and send in the chosen channel. A new task must **mention the actual bot user**, not a role. Reply to a bound task message for follow-ups. Only explicitly allowed people may authorize work; joining the community grants no task authority. Native intake begins at the current channel tail and does not replay fixture history.

Configure a model in the dedicated profile, or add `--magpie-url http://127.0.0.1:3425/v1`. Keep `MAGPIE_GATEWAY_KEY` in the process environment or the private home's `.env`. The default Magpie model is `zhipu/glm-5.3-flash`; `--model` overrides it. No credentials are included in the release.

The Web server binds to loopback and retains DSH login. Add `--supervise` for crash recovery and authenticated health probes; it does not install boot autostart. Initial flags populate a fresh profile once; later changes belong to the authenticated panel. See [deployment](docs/006-deployment.md) and [native setup and delivery guarantees](docs/011-native-implementation.md).

## Permissions and limits

Execution settings support `read-only`, `workspace-write` (default) and `danger-full-access`. Only the authenticated management panel can change the permission preset or Discord credential-file selection. Repository Write access is separate from an individual ticket's authority. An authorized ticket may push its branch and propose a PR; merge and release remain with maintainers. Protect the default branch with required review and no bot bypass.

Full access runs as the operator's OS user. Use a dedicated OS account or container for isolation; an account wrapper alone does not isolate programs. Outbound replies have persistent receipts and chunk checkpoints; ambiguous network delivery is not an unlimited exactly-once guarantee. Discord Gateway, registered slash commands, attachments, interactive approval buttons, QQ and WeChat transports are not implemented by this release. Historical lab/chat adapters remain compatibility fixtures and are not the recommended deployment path.

## Upgrade from preview.1

Stop the old listener before enabling the new Discord Source. Preserve a private backup of its state and credentials, then create a fresh native profile/state directory. Do not reuse the fixture database: native intake uses real source identities and separate task conversations. The old preview.1 release remains available for rollback and is marked superseded. See [release notes](CHANGELOG.md).

## Build and contribute

Use Node 24 and the pnpm version in `package.json`:

```sh
pnpm install --frozen-lockfile
pnpm check
pnpm pack
```

Report reproducible bugs through GitHub Issues and propose changes through PRs. Include the DSH version, platform, expected behavior and a sanitized reproduction. See [maintainer workflow](docs/maintainer-workflow.md). Join the [Discord community](https://discord.gg/dTJFHEFNyJ).

The GitHub `dsh-plugin` topic supports discovery; curated market inclusion requires a separate catalog submission and is not implied by a release.

MIT; upstream attribution is preserved in [LICENSE](LICENSE).
