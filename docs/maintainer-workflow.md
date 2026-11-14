# Maintaining Relay with Relay

The first real-channel check is deliberately one-shot: an authenticated operator reads an existing public Issue and imports only its title, state and URL. Relay creates a ticket and saves its summary locally. The Issue author is data, not the authority that requested work. Live polling, comments, pushes and merges are not enabled.

Start community development with GitHub Issues and human-reviewed PRs. For later automation:

1. Use a dedicated bot identity restricted to this repository. Start with read-only access and observe triage quality.
2. Keep contributor messages as untrusted inputs. Maintainer approval is necessary for any proposed repository write; require human review for merge and release.
3. Add Discord after the server is created. Start with one allowlisted channel and explicit requests. Use stable message and ticket links, and have contributors use Issues for durable decisions.
4. Keep bot credentials, full agent transcripts and local state outside the repository and Discord. Never give the worker account-admin or release credentials.

For DSH Market, use the GitHub `dsh-plugin` topic for discovery and submit a separate entry to the [curated catalog](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin).
