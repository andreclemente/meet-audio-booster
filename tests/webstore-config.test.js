import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

test('store upload is stable-release-only with main ancestry and immutable checkouts', async () => {
  const text = await readFile('.github/workflows/webstore-draft.yml', 'utf8')
  for (const value of ['types: [published]', "github.event_name == 'release'",
    "github.repository == 'andreclemente/meet-audio-booster'", '!github.event.release.draft',
    '!github.event.release.prerelease', 'git merge-base --is-ancestor "$release_sha" origin/main',
    'ref: ${{ steps.gate.outputs.release_sha }}', 'ref: ${{ needs.package.outputs.trusted_sha }}',
    'persist-credentials: false', "node-version: '22'", 'npm ci', 'npm run build', 'npm test',
    "python3 -m unittest discover -s tests -p 'test_webstore_draft.py'", 'contents: read']) {
    assert.ok(text.includes(value), `Missing release gate: ${value}`)
  }
  assert.doesNotMatch(text, /workflow_dispatch:|pull_request|^  push:|continue-on-error|secrets: inherit/m)
  assert.match(text, /group: chrome-web-store-draft\s+cancel-in-progress: false/)
  assert.ok(text.indexOf('run: npm run build') < text.indexOf('run: npm test'))
  assert.match(text, /git rev-parse --verify "refs\/tags\/\$RELEASE_TAG\^\{commit\}"/)
})

test('credentials only reach trusted uploader, with exact artifact and offline checks', async () => {
  const text = await readFile('.github/workflows/webstore-draft.yml', 'utf8')
  const [build, upload] = text.split('\n  upload:\n')
  assert.ok(upload)
  assert.doesNotMatch(build, /secrets\.|CWS_CLIENT|CWS_REFRESH/)
  assert.doesNotMatch(upload, /run:.*(?:npm |node )|release_sha/)
  for (const value of ['environment: chrome-web-store', 'actions/download-artifact@v4',
    'artifact-ids: ${{ needs.package.outputs.artifact_id }}', 'merge-multiple: true',
    'CWS_CLIENT_ID: ${{ secrets.CWS_CLIENT_ID }}', 'CWS_CLIENT_SECRET: ${{ secrets.CWS_CLIENT_SECRET }}',
    'CWS_REFRESH_TOKEN: ${{ secrets.CWS_REFRESH_TOKEN }}',
    'CWS_PUBLISHER_ID: ${{ vars.CWS_PUBLISHER_ID }}', 'CWS_EXTENSION_ID: ${{ vars.CWS_EXTENSION_ID }}',
    'webstore_draft.py check', 'webstore_draft.py upload', 'needs.package.outputs.sha256']) {
    assert.ok(upload.includes(value), `Missing privileged isolation: ${value}`)
  }
  assert.match(build, /actions\/upload-artifact@v4/)
  assert.match(build, /if-no-files-found: error/)
  assert.match(build, /sha256sum release-artifact\/extension.zip/)
})
