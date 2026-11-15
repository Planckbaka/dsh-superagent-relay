# Deploying the Relay preview

Use this guide to take the [README](../README.md) install steps to a deployment that stays running: a dedicated DeepSeek Harness profile, the prebuilt release bundle, its state directory, and the service script that starts, checks and stops it. The preview is local software: keep the panel on loopback, do not expose the profile to the network, and treat the state directory as the only data to back up.

It covers the verified preview only. The full automation mode — an agent GitHub account that comments, pushes branches and opens pull requests — is documented separately: its deployment is [006 Deployment](006-deployment.md), and [maintainer workflow](maintainer-workflow.md) explains why the preview does not enable it.

## Prerequisites

- DeepSeek Harness Web, verified with 0.2.2-rc.2 on macOS; other versions must satisfy `engines.dsh` in `package.json`.
- A model configured in the relay profile before the first start.
- Python 3 and tmux for the service script, with `dsh` on `PATH`.
- No GitHub account, CLI or token for the bundle: it calls no GitHub API itself. For the one-shot Issue import below, you read a public Issue and supply its metadata.

## Profile configuration

The install steps in the README create the `relay` profile and install the release bundle. The profile's `cordis.patch.yml` sets the panel's address and the plugin's state directory. A complete configuration for the preview:

```yaml
- id: webserver
  config:
    host: 127.0.0.1
    port: 3083
- id: dsh-superagent
  config:
    stateDir: /absolute/path/to/relay-preview-state
- id: dsh-superagent-github
  disabled: true
- id: dsh-superagent-feishu
  disabled: true
```

| Key | Required | Meaning |
| --- | --- | --- |
| `stateDir` | yes | Absolute path holding the database, `orchestrator.sqlite`, and by default the Ticket directories in `work`. The plugin refuses to start without it. Back it up before upgrades |
| `promptMaxChars`, `admissionContextMaxPages`, `admissionContextTimeoutMs` | no | Machine limits, with the meanings given in [006 Deployment](006-deployment.md) |

Give the preview a fresh state directory: fixture mode replaces the Source configuration stored in the database. `DSH_HOME` relocates the default `~/.dsh`. Run the profile-creation command only once; it replaces an existing profile and deletes its `cordis.patch.yml`.

## Preview modes

Environment variables choose what the deployed bundle does. Set them where the service process reads them.

| Variable | Effect |
| --- | --- |
| `DSH_SUPERAGENT_READ_ONLY=1` | The management API answers reads only; a write receives 405, `This profile is read only`. Panel changes then go through `cordis.patch.yml` and a restart |
| `DSH_SUPERAGENT_LOCAL_FIXTURE=1` | Runs against a fixture deployment: setup substitutes a placeholder account and contacts no GitHub CLI, Worker Sessions run under DeepSeek Harness's read-only preset instead of full access, and the database is seeded with sample Tickets. Requires the read-only variable |
| `DSH_SUPERAGENT_GITHUB_ISSUE=<json>` | With the fixture: one seed Ticket reviewing a public Issue. The value is JSON with the Issue's `url`, `title` and `state`, which you read yourself; the application imports only that metadata, monitors nothing, and writes nothing to GitHub |

Without these variables the bundle starts the full automation mode of [006 Deployment](006-deployment.md): setup then requires an agent GitHub CLI with push access to a repository, and Workers run with full access as your OS user. That mode is outside the verified preview and must never use a personal maintainer credential.

A restart from a shell without the fixture variables therefore does not continue the fixture: the saved Source configuration belongs to it, so setup waits; see Troubleshooting.

## Start and stop

Foreground, as the README shows:

```sh
DSH_SUPERAGENT_READ_ONLY=1 DSH_SUPERAGENT_LOCAL_FIXTURE=1 dsh relay --host 127.0.0.1 --port 3083
```

As a service, run the script from a checkout of this repository. `start` runs `dsh --profile relay` in the tmux session `dsh-relay`; the panel's address comes from the profile's `webserver` entry, so `--url` must match it. Open the URL the log prints, then choose **Superagent** in the sidebar.

```sh
scripts/dsh-superagent --profile relay --url http://127.0.0.1:3083 start
scripts/dsh-superagent --profile relay --url http://127.0.0.1:3083 status
scripts/dsh-superagent --profile relay --url http://127.0.0.1:3083 stop
```

`status`, `start` and `restart` exit 0 while the service runs normally, 1 when it is down or unreachable and a restart may fix it, 2 when a part reports an error, and 3 when setup waits; [006 Deployment](006-deployment.md) describes each code and its parts. `stop` pauses automatic recovery until the next `start`, and `--respect-stop` keeps that pause across a `restart`. Export the preview variables in the shell you run `start` and `restart` from, and set `DSH_SUPERAGENT_PROFILE` and `DSH_SUPERAGENT_URL` to make the flags above the defaults.

For a check that repairs a down service, adapt the hourly check of [006 Deployment](006-deployment.md) with `--profile relay --url http://127.0.0.1:3083`, and run it only from a shell that exports the fixture variables.

## Logs, state and backups

The script keeps startup logs under `.artifacts/` in the checkout it runs from, as `dsh-superagent-relay-<date>-<time>-<pid>.log`, newest 20 kept. Everything else worth keeping is in the state directory: back up `orchestrator.sqlite` before an upgrade. A database written by a newer version cannot be opened by an older one, so the pre-upgrade backup is also the rollback path.

## Upgrade

1. Back up `<stateDir>/orchestrator.sqlite`.
2. `scripts/dsh-superagent --profile relay --url http://127.0.0.1:3083 stop`
3. Install the newer release tarball the way you installed this one, with `dsh plugin --profile relay` (see `dsh plugin --help`) or the DeepSeek Harness Plugin Manager. Do not rerun the profile-creation command; it would replace the profile.
4. Start again from a shell that exports the preview variables, then check `status`.

Read the release notes for configuration changes: keys the bundle no longer uses prevent startup.

## Troubleshooting

`status` prints failed parts and setup needs; `GET state` on the management API reports the same, and the overview links each setup problem to its setting. In preview mode the API answers reads only.

| Symptom | Cause and fix |
| --- | --- |
| `Local fixture requires read-only mode` (log, no start) | Set both `DSH_SUPERAGENT_READ_ONLY=1` and `DSH_SUPERAGENT_LOCAL_FIXTURE=1` |
| `status` exits 3 after a restart from a shell without the fixture variables | The saved Sources belong to the fixture, so setup waits for a repository and an agent CLI. Stop, and start again from a shell that exports both variables |
| The `dsh-superagent` entry fails to start | `stateDir` is missing or not absolute; set it in the profile's `cordis.patch.yml` |
| `dsh-superagent configuration has keys it does not use` (log) | Remove the named keys; `stateDir` is the only required one |
| Other symptoms | The [troubleshooting table in 006 Deployment](006-deployment.md#troubleshooting) covers the shared parts; its rows about Sources, accounts and GitHub access describe the full automation mode, not the preview |
