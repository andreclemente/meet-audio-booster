const threadId = '1559885826564034561'

module.exports = async function notify({ issueUrl, webhookUrl, fetchImpl = globalThis.fetch }) {
  if (!issueUrl || !webhookUrl) return null
  let url
  try {
    url = new URL(webhookUrl)
  } catch {
    throw new Error('Invalid Discord webhook URL')
  }
  if (url.origin !== 'https://discord.com' || url.username || url.password ||
      !/^\/api\/webhooks\/\d+\/[A-Za-z0-9_-]+$/.test(url.pathname)) {
    throw new Error('Invalid Discord webhook origin/path')
  }
  url.searchParams.set('thread_id', threadId)
  url.searchParams.set('wait', 'true')
  const response = await fetchImpl(url, {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15000),
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      content: `Meet Audio Booster: manutenção falhou. Diagnóstico: ${issueUrl}`,
      allowed_mentions: { parse: [] }
    })
  })
  if (!response.ok) throw new Error(`Discord delivery failed: HTTP ${response.status}`)
  const message = await response.json()
  if (typeof message.id !== 'string' || !/^\d+$/.test(message.id) || message.channel_id !== threadId) {
    throw new Error('Discord did not confirm the intended thread')
  }
  return message.id
}
