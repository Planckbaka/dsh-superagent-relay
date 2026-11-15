# Superagent Relay for DeepSeek Harness

Superagent Relay is an independent community preview derived from the MIT-licensed [DeepSeek Superagent prototype](https://github.com/deepseek-ai/dsh-superagent-prototype/tree/8c32a9dc5d72c033816c6a8110b37f40cf94fba4). It runs as a native DSH Web bundle. Install it in a separate profile; it shares runtime and panel identifiers with the upstream bundle.

The local preview exercises ticket intake, isolated DSH Worker sessions and persisted reports. A one-shot public GitHub Issue test imports its title and state, then saves the Worker summary locally. It does not monitor your inbox or write to GitHub. QQ and WeChat have a normalization library only. A local Discord conversation adapter has passed a real request-to-Worker-to-reply test, but it is not included in the existing release asset; see the [implementation gap audit](docs/010-superagent-gap-audit.md).

## Install the preview

Verified host: DSH Web 0.2.2-rc.2 on macOS. Create a fresh profile and add the prebuilt package:

```sh
dsh relay --from-default-profile web --dump-config >/dev/null
dsh plugin --profile relay add https://github.com/Planckbaka/dsh-superagent-relay/releases/download/v0.1.0-preview.1/dsh-superagent-relay-0.1.0-preview.1.tgz
```

In that profile’s `cordis.patch.yml`, set a new absolute state path, and disable upstream channels for the local preview:

```yaml
- id: dsh-superagent
  config:
    stateDir: /absolute/path/to/relay-preview-state
- id: dsh-superagent-github
  disabled: true
- id: dsh-superagent-feishu
  disabled: true
```

Configure a model in the relay profile first (a local Magpie gateway works). Then run:

```sh
DSH_SUPERAGENT_READ_ONLY=1 DSH_SUPERAGENT_LOCAL_FIXTURE=1 dsh relay --host 127.0.0.1 --port 3083
```

Use the launch URL and open **Superagent → Ended tickets**. Use a fresh state directory: fixture mode replaces the Source configuration in its database. Do not expose this experimental profile to the network. The upstream repository automation mode grants Workers broader permissions; it is outside the verified preview and should never use a personal maintainer credential.

## Build and contribute

Node 24 and the pnpm version in `package.json`:

```sh
pnpm install --frozen-lockfile
pnpm check
pnpm pack
```

Use GitHub Issues for reproducible bugs and pull requests for contributions. Include DSH version, platform, expected behavior, and a sanitized reproduction. See [maintainer workflow](docs/maintainer-workflow.md). Join the [Superagent Relay Discord community](https://discord.gg/dTJFHEFNyJ) for user discussion and contributor coordination. GitHub Issues and pull requests remain the record for bugs, implementation proposals and reviews. Joining Discord does not grant permission to execute agent tasks.

MIT; upstream attribution is preserved in [LICENSE](LICENSE).


## Implementation status

The upstream core, the local tested checkout and the published release are separate artifacts.
The local Discord round trip has been verified; full Source/Policy/Outbox integration, structured
human questions, pause semantics, real failure recovery and the dedicated GitHub write pilot
still need work or further acceptance. Read the [2026-11-15 design gap audit](docs/010-superagent-gap-audit.md)
for evidence, priorities and acceptance gates. The audit does not mean these changes have shipped
in `v0.1.0-preview.1`.

Repository topics support discovery; they do not guarantee acceptance into a curated DSH Market catalog.
