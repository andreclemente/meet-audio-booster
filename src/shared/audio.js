export function readAudioParam(param, fallback = 1) {
  const value = Number(param?.value)
  return Number.isFinite(value) ? value : fallback
}

const gainSchedules = new WeakMap()
const GAIN_RAMP_SECONDS = 0.01

export function writeAudioParam(param, value, { context, immediate = true } = {}) {
  if (!param) return false
  const safe = Number.isFinite(value) ? Math.max(0, value) : 1
  // AudioParam has no context; the owning AudioNode supplies its clock.
  const now = Number.isFinite(context?.currentTime) ? context.currentTime : 0
  const previous = gainSchedules.get(param)
  if (!immediate && previous?.target === safe) return true
  const current = previous
    ? previous.from + (previous.target - previous.from) * Math.min(1, Math.max(0, (now - previous.start) / GAIN_RAMP_SECONDS))
    : readAudioParam(param)
  try {
    if (immediate || !context) {
      // Cancel *all* queued automation, including a boost scheduled while paused.
      param.cancelScheduledValues?.(0)
      param.setValueAtTime(safe, now)
      gainSchedules.set(param, { from: safe, target: safe, start: now })
    } else {
      try {
        if (typeof param.cancelAndHoldAtTime !== 'function') throw new Error('No hold API')
        param.cancelAndHoldAtTime(now)
      } catch { param.cancelScheduledValues?.(0) }
      param.setValueAtTime(current, now)
      param.linearRampToValueAtTime(safe, now + GAIN_RAMP_SECONDS)
      gainSchedules.set(param, { from: current, target: safe, start: now })
    }
    return true
  } catch {
    // Older/failed automation APIs still get an exact target, not stale boosts.
    try { param.cancelScheduledValues?.(0) } catch {}
    try { param.value = safe } catch { return false }
    gainSchedules.set(param, { from: safe, target: safe, start: now })
    return true
  }
}

export function createAudioContext() {
  const Context = globalThis.AudioContext || globalThis.webkitAudioContext
  if (!Context) return null
  try { return new Context() } catch { return null }
}
