// A new participant row is admitted only once the same name has been seen in
// two scans at least `minMs` apart. During Meet layout changes a tile can
// briefly lack its self control or show another tile's label; one scan of
// that must never become a row (or a routing candidate).
export const ROW_ADMISSION_MS = 400

export function createRowAdmission({ minMs = ROW_ADMISSION_MS } = {}) {
  const pending = new Map()
  let seen = new Set()
  return {
    begin() { seen = new Set() },
    // True once `key` with `name` is stable; call only for keys not yet rows.
    admit(key, name, now) {
      seen.add(key)
      const entry = pending.get(key)
      if (!entry || entry.name !== name) { pending.set(key, { name, since: now }); return false }
      if (now - entry.since < minMs) return false
      pending.delete(key)
      return true
    },
    // Forget candidates that disappeared this scan, so admission restarts.
    end() { for (const key of pending.keys()) if (!seen.has(key)) pending.delete(key) },
    clear() { pending.clear(); seen = new Set() }
  }
}
