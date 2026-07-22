import { createState, visibleParticipants } from './state.js'
import { saveSettings, setParticipantGain } from './storage.js'
import { detectPlatform } from './platforms/google-meet/platform.js'
import { createGoogleMeetController } from './platforms/google-meet/index.js'
import { createJitsiController } from './platforms/jitsi/index.js'
import { createPanelController } from './ui/panel.js'
import { installDebugApi } from './shared/debug.js'
import { PANEL_ID } from './shared/constants.js'
import { createAudioContext } from './shared/audio.js'

if (!globalThis.__meetingAudioBoosterInstalled) {
  globalThis.__meetingAudioBoosterInstalled = true
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
    if (status) status.textContent = message
  }
  function renderSoon() {
    if (state.closed) return
    clearTimeout(state.renderTimer)
    state.renderTimer = setTimeout(() => panel.render(), 120)
  }
  function applyGain(participant, value) {
    participant.value = Number.isFinite(value) ? Math.max(0, value) : 1
    setParticipantGain(state.settings, participant, participant.value)
    saveSettings(globalThis.localStorage, state.settings)
    platformController?.applyParticipantGain(participant, participant.value)
    panel.updateLiveUi()
  }
  const panel = createPanelController(state, {
    participants: () => visibleParticipants(state),
    onGain: applyGain,
    onSave: position => { state.settings.position = position; saveSettings(globalThis.localStorage, state.settings) }
  })

  globalThis.__meetingAudioBooster = state
  globalThis.__meetingAudioBoosterShow = panel.show
  globalThis.__meetingAudioBoosterHide = panel.hide
  globalThis.__meetingAudioBoosterToggle = panel.toggle
  installDebugApi(state, () => visibleParticipants(state))

  // A small, immutable diagnostics surface proves production is running the
  // modular entry without exposing mutable implementation internals.
  Object.defineProperty(globalThis, '__meetingAudioBoosterModules', {
    configurable: true,
    value: Object.freeze({ bootApi: 'modular-v1', platforms: Object.freeze(['google-meet', 'jitsi']), storageKey: '__meeting_audio_booster_v15' })
  })

  function boot() {
    if (!document.documentElement) { setTimeout(boot, 100); return }
    state.platform = detectPlatform()
    const context = getContext()
    state.audioUnavailable = !context
    const common = { state, context, setStatus, renderSoon, updateLiveUi: panel.updateLiveUi }
    platformController = state.platform === 'google-meet'
      ? createGoogleMeetController(common)
      : createJitsiController(common)
    platformController.start()
    if (!context) setStatus('Audio unavailable · controls are inactive')
    panel.render()
  }
  boot()
}
