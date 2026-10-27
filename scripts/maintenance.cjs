const marker = '<!-- mab-maintenance:v1 -->'

module.exports = async function reconcile({ github, context, status, runUrl }) {
  if (!['success', 'failure'].includes(status)) throw new Error('Unsupported status')
  const repo = context.repo
  const issues = await github.paginate(github.rest.issues.listForRepo, {
    ...repo, state: 'open', creator: 'github-actions[bot]', per_page: 100
  })
  const incident = issues.find(issue => !issue.pull_request && issue.body?.includes(marker))
  if (status === 'success') {
    if (incident) {
      const body = `${incident.body}\n\nRecovered: ${runUrl}`
      await github.rest.issues.update({ ...repo, issue_number: incident.number,
        state: 'closed', state_reason: 'completed', body })
      const { data } = await github.rest.issues.get({ ...repo, issue_number: incident.number })
      if (data?.number !== incident.number || data.state !== 'closed' || data.body !== body) {
        throw new Error('Issue recovery not confirmed by read-back')
      }
    }
    return null
  }
  if (incident) return null
  const body = `${marker}\n\nBuild, tests, installation or security audit failed.\n\nEvidence: ${runUrl}\n\nInspect the failed step before changing code. No release was published.`
  const { data: created } = await github.rest.issues.create({ ...repo,
    title: '[maintenance] Weekly verification failed', body })
  const { data } = await github.rest.issues.get({ ...repo, issue_number: created.number })
  if (data?.number !== created.number || data.state !== 'open' || data.body !== body ||
      !data.html_url || data.html_url !== created.html_url) {
    throw new Error('Issue creation not confirmed by read-back')
  }
  return data.html_url
}
