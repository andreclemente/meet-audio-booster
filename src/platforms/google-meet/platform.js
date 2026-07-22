export function detectPlatform(location = globalThis.location) {
  return location?.hostname === 'meet.google.com' ? 'google-meet' : 'jitsi'
}
