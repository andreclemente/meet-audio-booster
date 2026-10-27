# Chrome Web Store: release → draft upload only

Publishing a **stable GitHub release** in `andreclemente/meet-audio-booster` starts
`.github/workflows/webstore-draft.yml`. This does **not** submit store review,
publish, cancel submissions, or change rollout percentages. Those operations
are deliberately absent from the uploader's endpoint allowlist.

## One-time setup (maintainer, outside this change)

1. The extension must already exist in the Chrome Web Store developer dashboard.
   Confirm the intended publisher and extension IDs there. Set repository Actions
   variables `CWS_PUBLISHER_ID` and `CWS_EXTENSION_ID` (not secrets). These IDs have
   been configured externally; the workflow never hardcodes their values.
2. In the publisher's Google Cloud project enable **Chrome Web Store API**.
   Configure the OAuth consent screen and an OAuth client for the account with
   access to this publisher/item. Use consent-screen **Production** status:
   External apps left in Testing generally receive refresh tokens that expire
   after seven days. Complete any Google verification requirements applicable to
   your project. Request offline access and scope
   `https://www.googleapis.com/auth/chromewebstore`; obtain a refresh token through
   Google's authorized OAuth flow. This scope can publish too: code isolation and
   environment protections, not OAuth scope, enforce this workflow's draft-only use.
3. Enter `CWS_CLIENT_ID`, `CWS_CLIENT_SECRET`, and `CWS_REFRESH_TOKEN` securely in
   GitHub Settings → Secrets and variables → Actions, preferably as secrets of
   the `chrome-web-store` environment. **Never paste credentials in chat, issues,
   source, logs, shell history, or artifacts.** No service account or WIF setup is
   required. Credentials are still missing; live authentication/upload is unverified.
4. Create/configure environment `chrome-web-store` with required reviewers and
   suitable deployment restrictions. Ensure release tag deployments are allowed
   (a main-only deployment restriction may block tag events). Protect main,
   release tags, workflow edits, and environment configuration. Merely referencing
   an environment in YAML does **not** prove reviewers/protections are configured.

## Release procedure

1. Make the intended version change through normal review. Package, root manifest,
   and freshly built dist manifest must all equal a stable `vN.N.N` tag, with
   numeric Chrome components 0–65535, no leading zeros and not all zero. No
   prerelease suffix or fourth stable-release component is supported. Version
   must exceed all API-reported published/submitted versions. This change itself
   does not bump any version.
2. Merge the release commit into main, create its tag, then publish the stable
   GitHub release. There is no push, PR, or arbitrary manual-ref upload trigger.
   The offline gate peels the tag to a commit, requires it to equal the exact
   original release event `github.sha` (`RELEASE_EVENT_SHA`), and checks its ancestry
   against fetched main before running release code. A moved tag is rejected even
   if its new target is on main, including on full reruns. Lightweight and annotated
   tags work. Old releases lacking this workflow/helper cannot use the new path.
3. The unprivileged job runs Node 22 `npm ci`, build, all Node tests, and Python
   unittest. It packages **dist contents**, not the dist directory: manifest is
   at ZIP root. ZIP timestamps, order and permissions are fixed; it uses stored
   entries (no compressor-version variability). The exact six-file allowlist is
   manifest, bundle, service worker and three icons. Extra/missing files, directories,
   symlinks, traversal/duplicate ZIP entries, mismatched metadata and digest fail.
   Environment files, credentials, sources and dependencies cannot be extra ZIP
   entries. The allowlist is not a secret scanner inside approved file contents;
   source review remains required.
4. Testers must download the exact `chrome-web-store-draft-<run>-<attempt>` workflow
   artifact for the intended release attempt (not a source archive or another run).
   Extract the artifact wrapper to obtain `extension.zip` and `extension.zip.sha256`,
   retained for 30 days. In that directory run `sha256sum -c extension.zip.sha256`
   and compare the digest to that run's recorded archive SHA256. Unzip this verified
   **extension.zip** into a clean directory and use Chrome's **Load unpacked** on
   that directory for testing. Load this ZIP's contents, **not a locally rebuilt
   equivalent**, even if versions match. The privileged
   job downloads the exact immutable artifact ID from this run, validates the SHA256
   and manifest again, and runs only the uploader from the **captured main SHA**.
   It never runs npm, artifact code, or the release's uploader with credentials.
   Approval does not silently switch to a newer main uploader revision.
5. If reviewers are configured, approve the environment deployment. The script
   refreshes OAuth credentials, fetches exact item status, rejects active review/
   staged submission, warning/takedown, unknown states, concurrent async upload,
   and non-increasing versions, then makes **one** raw ZIP upload request:
   `POST https://chromewebstore.googleapis.com/upload/v2/publishers/{publisher}/items/{item}:upload`.
   The only other requests are OAuth token refresh and exact-item `:fetchStatus`.
6. Upload success always requires exact-target status readback with unchanged
   published/submitted revision snapshots. Synchronous `SUCCEEDED` also requires
   matching response name, item ID and `crxVersion`. Its readback permits only an
   absent async state or `SUCCEEDED`; explicit `FAILED`, `NOT_FOUND`, unspecified
   or conflicting in-progress states fail closed. Pre-existing stale async metadata
   may therefore cause a false alarm after synchronous success: inspect the
   dashboard manually rather than automatically retrying. Async `IN_PROGRESS` polls at
   five-second intervals (30 attempts by default, hard cap 60, each request timeout
   30 seconds). Only `SUCCEEDED` completes processing. Unknown, failed, unavailable
   or timed-out responses fail closed; no automatic POST retries occur.
7. **Manually verify the draft's version and package in the developer dashboard**,
   especially for async success: `fetchStatus` has neither an operation ID nor a
   draft-version field. Item-level observed completion is **not correlation to this
   upload or a version guarantee**; a stale/unrelated completion can be observed.
   Output `upload_processed`/`item_level_completion_observed` describes this limited
   observation; `upload_operation_correlation_verified` remains false, and async
   `upload_response_version_verified` is false. Readback detects revision changes,
   but cannot prove this upload's stored draft version.
   Run **manual real-call tests** on Google Meet and Jitsi (participant association,
   per-person gain/mute, navigation, reconnection and audio lifecycle). Only after
   those pass should a maintainer **manually submit store review** in the dashboard.

## Offline use and recovery

Python standard library only; no Google credentials are read for package/check:

```sh
npm ci
npm run build
npm test
python3 -m unittest discover -s tests -p 'test_*.py'
python3 scripts/webstore_draft.py package --tag v1.2.1 --output extension.zip
sha256sum extension.zip
python3 scripts/webstore_draft.py check --archive extension.zip --tag v1.2.1 --sha256 <64-hex-digest>
```

Use a clean isolated checkout: the build deletes/recreates dist and overwrites the
root bundle. Before a local build, move preexisting dist (and node_modules before
`npm ci`) to unique scratch backups if they must be preserved. Never overwrite an
existing archive: choose a new path. Package/check never make network requests.
Tests use clearly synthetic publisher/item IDs and injected network/sleep; they
never authenticate or access the real store.

Failures suppress raw API bodies, exception text and credentials. After any
ambiguous network failure, timeout, identity mismatch or concurrent status change,
**inspect the store manually before retrying**: the upload may already have taken
effect even if readback failed. Also inspect any prior draft before intentionally
replacing it; the API does not expose its version in fetchStatus. There is no
automatic upload retry or duplicate-upload guarantee. A maintainer can rerun the
failed release job through GitHub Actions once safe; do not create a manual-ref
upload workflow. Rerunning all jobs resolves main again but retains the original
release event SHA: the current peeled tag must still equal that SHA. Rerunning only the upload
job retains the original dependency outputs and captured uploader SHA. Releases
share one static concurrency group and running uploads are not cancelled; GitHub
can replace an older pending run, so serialization is **not** FIFO delivery.

Unchanged published/submitted snapshots detect some concurrent manual changes but
are not a transactional lock: avoid dashboard/API writes while this runs. Live
Google authorization, environment approvals, artifact transport and store behavior
must still be verified by a configured release; offline tests do not establish them.
Actions currently use reviewed major-version refs (artifact download uses v4.3.0);
full commit-SHA action pinning is deferred to a separate hardening change.

API contract: [v2 discovery](https://chromewebstore.googleapis.com/$discovery/rest?version=v2)
(checked 2026-10-27). Exact upload enum is `SUCCEEDED`, `IN_PROGRESS`, `FAILED`,
`NOT_FOUND`, `UPLOAD_STATE_UNSPECIFIED`; ignore discovery prose saying
`UPLOAD_IN_PROGRESS`, which is not an enum value.
