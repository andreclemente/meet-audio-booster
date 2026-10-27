# Automated maintenance

Maintenance runs on pull requests, pushes to main, Mondays at 08:23 UTC,
and manual dispatch. GitHub schedules may be delayed.

Each run uses Node.js 22, installs the lockfile, rebuilds the extension and runs
all Node tests (build first, because architecture tests inspect generated bundles).
Scheduled/manual runs also audit all dependencies, including build tooling;
high/critical findings fail the check. Registry outages also fail visibly.

All runs on main share one concurrency group, including schedule and manual
runs, with cancellation disabled for running jobs. This serializes incident
writes across event types. GitHub concurrency is not a FIFO queue: a newer
pending run may replace an older pending run.

One active issue marked `<!-- mab-maintenance:v1 -->` tracks a weekly failure.
Repeated failures are silent; the next healthy scheduled/manual run closes it.
Issue creation and recovery are read back from the exact issue before success
is reported; a failed or inconsistent read-back fails the report job. Only a
confirmed new incident can trigger Discord delivery.
Do not manually close it to acknowledge a problem: leave it open until fixed.
Review the linked run logs; fix the root cause in a PR with a regression test.
Never run `npm audit fix --force` as unattended remediation.

PR and push checks have read-only permissions and no webhook access. Only the
scheduled/manual report job on main has issue-write permission and the optional
webhook secret. Cancelled/skipped verification does not resolve an incident.
Dependabot proposes npm and Actions updates weekly. Review and merge manually.
A green check is not a live Google Meet/Jitsi compatibility guarantee.
Before any release, test two remote participants, speaker handoff, overlap,
mute, 100% and boosted gain, reconnect and panel restoration in a real call.
Do not record or upload calls for maintenance diagnostics.

Optional Discord delivery uses the repository Actions secret
`MAB_DISCORD_WEBHOOK_URL`, for a webhook belonging to parent channel
1521087710574412027. It targets existing thread 1559885826564034561 only.
Provide the secret through approved credential management, not chat or git.
Without it, Issues works normally. Only a new incident posts a Discord alert.
Recovery is visible in the issue, not posted to Discord.
The helper restricts delivery to HTTPS discord.com webhook URLs, disables
mentions and redirects, and requires a message ID and the intended thread ID
in the response. Offline tests inject fetch; they never contact Discord.
If Discord delivery fails after issue creation, the report job fails visibly;
there is no automatic retry on later runs, to avoid duplicate messages.
Repair the webhook and notify the existing thread manually if needed. Likewise,
if issue creation succeeds but its read-back fails, inspect the issue and notify
manually: the next run will see the existing issue and remain silent.

No unattended merges, releases, publishing, audio changes or AI repair agents
are enabled. To pause, disable the Maintenance workflow in GitHub Actions;
Dependabot is configured separately in .github/dependabot.yml.
GitHub may disable schedules in inactive public repositories; inspect the
workflow status if weekly runs stop. This MVP has no independent watchdog.

## Local validation and activation

Run `npm ci`, `npm run build`, `npm test`, and
`actionlint .github/workflows/maintenance.yml`. Build overwrites the versioned
root bundle and recreates dist; use an isolated checkout, moving an existing
dist to a scratch backup first if preserving files is required.
Tests cover incident lifecycle/read-back, Discord outcomes and configuration
contracts. Actionlint checks workflow syntax/expressions; offline tests do not
prove real GitHub permissions, scheduling or Discord delivery.

After approved merge, manually dispatch on main and inspect verify/report logs.
Test controlled failure, repeat failure and recovery only in an approved sandbox,
not production. A real Discord probe requires separate consent. Until those runs
are inspected, remote incident lifecycle and optional Discord remain unverified.
Actions use major-version references maintained by Dependabot; SHA pinning is a
possible later hardening step, not part of this dependency-neutral change.
