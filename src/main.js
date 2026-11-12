import { createState, visibleParticipants } from './state.js'
import { saveSettings, setParticipantGain, setParticipantUnmute, getParticipantUnmute, rememberAudible, watchSettings } from './storage.js'
import { detectPlatform } from './platforms/google-meet/platform.js'
import { createGoogleMeetController } from './platforms/google-meet/index.js'
import { installRemoteMediaOwnership } from './platforms/google-meet/media-ownership.js'
import { createPanelController, statusText } from './ui/panel.js'
import { installDebugApi } from './shared/debug.js'
import { PANEL_ID } from './shared/constants.js'
import { createAudioContext } from './shared/audio.js'

if (detectPlatform() === 'google-meet' && !globalThis.__meetingAudioBoosterInstalled) {
  globalThis.__meetingAudioBoosterInstalled = true
  // Install synchronously at document_start, before boot waits for the DOM:
  // negotiation and track cloning can precede documentElement creation.
  const mediaOwnership = installRemoteMediaOwnership()
  const state = createState()
  let platformController = null

  function getContext() {
    state.sharedCtx ||= createAudioContext()
    return state.sharedCtx
  }
  function setStatus(message) {
    if (state.audioUnavailable) message = 'Audio unavailable · controls are inactive'
    state.status = message
    const status = document.getElementById(`${PANEL_ID}_status`)
    const shown = statusText(state)
    if (status && status.textContent !== shown) status.textContent = shown
  }
  function renderSoon() {
    if (state.closed) return
    clearTimeout(state.renderTimer)
    state.renderTimer = setTimeout(() => panel.render(), 120)
  }
  function applyGain(participant, value, { automatic = false, dragging = false } = {}) {
    if (!automatic) panel.stopAuto()
    const next = Number.isFinite(value) ? Math.min(6, Math.max(0, value)) : 1
    rememberAudible(participant, next, { dragging })
    participant.value = next
    participant.adjusted = true // manual or automatic: a later rename never replaces it
    if (!automatic) {
      setParticipantGain(state.settings, participant, participant.value)
      if (participant.unmuteValue > 0) setParticipantUnmute(state.settings, participant, participant.unmuteValue)
      saveSettings(globalThis.localStorage, state.settings)
    }
    platformController?.applyParticipantGain(participant, participant.value)
    panel.updateLiveUi()
  }
  const panel = createPanelController(state, {
    participants: () => visibleParticipants(state),
    // In-memory pre-volume levels from the controller; never persisted.
    levels: (key, options) => platformController?.levelFor?.(key, options) ?? null,
    onGain: applyGain,
    unmuteValue: participant => participant.unmuteValue > 0 ? participant.unmuteValue : getParticipantUnmute(state.settings, participant),
    onAutoSettings: autoBalance => { state.settings.autoBalance = autoBalance; saveSettings(globalThis.localStorage, state.settings) },
    onCollapse: collapsed => { state.settings.collapsed = collapsed; saveSettings(globalThis.localStorage, state.settings) },
    onSave: position => { state.settings.position = position; saveSettings(globalThis.localStorage, state.settings) }
  })

  watchSettings(state.settings, { onChange: () => panel.syncAutoSettings() })
  globalThis.__meetingAudioBooster = state
  globalThis.__meetingAudioBoosterShow = panel.show
  globalThis.__meetingAudioBoosterHide = panel.hide
  globalThis.__meetingAudioBoosterToggle = panel.toggle
  installDebugApi(state, () => visibleParticipants(state))

  // A small, immutable diagnostics surface proves production is running the
  // modular entry without exposing mutable implementation internals.
  Object.defineProperty(globalThis, '__meetingAudioBoosterModules', {
    configurable: true,
    value: Object.freeze({ bootApi: 'modular-v1', platforms: Object.freeze(['google-meet']), storageKey: '__meeting_audio_booster_v15' })
  })

  function boot() {
    if (!document.documentElement) { setTimeout(boot, 100); return }
    state.platform = detectPlatform()
    const context = getContext()
    state.audioUnavailable = !context
    const common = { state, context, setStatus, renderSoon, updateLiveUi: panel.updateLiveUi, onLevelSample: panel.autoTick, onLevelReset: panel.invalidateAuto, onStop: () => panel.stopAuto({ persist: false }), mediaOwnership }
    platformController = createGoogleMeetController(common)
    platformController.start()
    if (!context) setStatus('Audio unavailable · controls are inactive')
    panel.render()
    if (context) panel.restoreAuto()
  }
  boot()
}
