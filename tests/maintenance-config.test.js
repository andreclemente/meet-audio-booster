import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

test('maintenance runs on PRs, main and weekly with restricted reporting', async () => {
  const text = await readFile('.github/workflows/maintenance.yml', 'utf8')
  for (const value of ['pull_request:', 'branches: [main]', "cron: '23 8 * * 1'",
    'workflow_dispatch:', 'npm ci', 'npm run build', 'npm test',
    'npm audit --audit-level=high', 'contents: read', 'issues: write',
    "github.event_name == 'schedule'", "github.ref == 'refs/heads/main'",
    'scripts/maintenance.cjs', 'scripts/maintenance-discord.cjs',
    'node-version: \'22\'', 'persist-credentials: false']) {
    assert.ok(text.includes(value), `Missing: ${value}`)
  }
  assert.ok(text.indexOf('run: npm run build') < text.indexOf('run: npm test'))
  assert.doesNotMatch(text, /pull_request_target|--omit=dev|continue-on-error/)
  const group = text.match(/^  group: (.+)$/m)?.[1]
  assert.equal(group, 'maintenance-${{ github.ref }}', 'all main events must share one lock')
  assert.match(text, /cancel-in-progress: false/)
  assert.doesNotMatch(text, /fetch\(/, 'Discord transport belongs in tested helper')
  assert.match(text, /await reconcile[\s\S]*await notify/)
})
test('Dependabot maintains npm and Actions weekly without automerging', async () => {
  const text = await readFile('.github/dependabot.yml', 'utf8')
  assert.match(text, /package-ecosystem: npm/)
  assert.match(text, /package-ecosystem: github-actions/)
  assert.equal((text.match(/interval: weekly/g) || []).length, 2)
  assert.doesNotMatch(text, /auto-merge/)
})
