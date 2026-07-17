(() => {
  if (window.__meetingAudioBoosterInstalled) return
  window.__meetingAudioBoosterInstalled = true

  const STORAGE_KEY = '__meeting_audio_booster_v14'
  const PANEL_ID = '__meeting_audio_booster_panel'
  const AudioContextClass = window.AudioContext || window.webkitAudioContext

  const state = {
    platform: null,
    participants: new Map(),
    settings: loadSettings(),
    panel: null,
    renderTimer: null,
    closed: false,
    status: 'Starting…',
    sharedCtx: null,

    google: {
      slots: [],
      originalConnect: null,
      scanTimer: null,
      routerTimer: null,
      slotCounter: 0,
      activeParticipantKey: null,
      lastSpeakerSeenAt: 0,
      rosterSignature: ''
    },

    jitsi: {
      keepAliveTimer: null
    }
  }

  window.__meetingAudioBooster = state
  window.__meetingAudioBoosterDebug = getDebugInfo

  function loadSettings() {
    try {
      const value = JSON.parse(localStorage.getItem(STORAGE_KEY)) || {}

      return {
        gains: value.gains || {},
        position: value.position || null
      }
    } catch {
      return {
        gains: {},
        position: null
      }
    }
  }

  function saveSettings() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state.settings))
  }

  function detectPlatform() {
    if (location.hostname === 'meet.google.com') return 'google-meet'

    if (
      window.APP?.conference ||
      window.JitsiMeetJS ||
      document.querySelector('#react, .filmstrip')
    ) {
      return 'jitsi'
    }

    // The manifest only injects this file into explicitly allowed meeting sites.
    // An unknown non-Google host is therefore treated as self-hosted Jitsi.
    return 'jitsi'
  }

  function getSharedAudioContext() {
    if (!AudioContextClass) return null

    state.sharedCtx ||= new AudioContextClass()
    return state.sharedCtx
  }

  function cleanName(value) {
    return value
      ?.replace(/\s+\(.*?\)$/, '')
      .replace(/^Mute\s+(.+?)'s microphone$/i, '$1')
      .replace(/^Unmute\s+(.+?)'s microphone$/i, '$1')
      .replace(/^Ask\s+(.+?)\s+to unmute$/i, '$1')
      .replace(/^More (?:actions|options) for\s+/i, '')
      .replace(/^Pin\s+/i, '')
      .replace(/\s+to your main screen$/i, '')
      .replace(/^Unpin\s+/i, '')
      .replace(/\s+from your main screen$/i, '')
      .replace(/^Remove\s+/i, '')
      .replace(/\s+from (?:the )?call$/i, '')
      .replace(/,\s*(?:muted|not muted|speaking)$/i, '')
      .replace(/\s+is speaking$/i, '')
      .replace(/'s (?:microphone|camera)$/i, '')
      .replace(/\s+/g, ' ')
      .trim()
  }

  function normalizeName(value) {
    return cleanName(value)?.toLocaleLowerCase() || ''
  }

  function isSelfText(value) {
    return /(^|[\s(])you([\s)]|$)/i.test(value || '')
  }

  function isValidParticipantName(value) {
    const name = cleanName(value)
    if (!name || name.length > 80) return false

    const lower = name.toLowerCase()
    const ignored = new Set([
      'people',
      'chat',
      'meeting details',
      'audio settings',
      'video settings',
      'more options',
      'host controls',
      'meeting tools',
      'send a reaction',
      'raise hand',
      'leave call',
      'present now',
      'activities',
      'captions',
      'visual effects',
      'settings',
      'close',
      'search for people',
      'add people',
      'in call',
      'contributors',
      'meeting host',
      'host',
      'co-host',
      'you',
      'me',
      'reframe',
      'backgrounds and effects',
      'frame_person',
      'visual_effects',
      'more_vert',
      'devices',
      'mic',
      'mic_off',
      'videocam',
      'videocam_off'
    ])

    return (
      !ignored.has(lower) &&
      !isSelfText(name) &&
      !lower.includes('presentation') &&
      !lower.includes('microphone') &&
      !lower.includes('camera') &&
      !lower.includes('screen') &&
      !lower.includes('participant') &&
      !lower.includes('meeting') &&
      !lower.includes('google meet') &&
      !/^\d+$/.test(name)
    )
  }

  function participantStorageKey(participant) {
    if (participant.platform === 'jitsi' && participant.participantId) {
      return `jitsi:id:${participant.participantId}`
    }

    return `${participant.platform}:name:${normalizeName(participant.name)}`
  }

  function getSavedGain(participant) {
    const value = state.settings.gains?.[participantStorageKey(participant)]
    return typeof value === 'number' ? value : 1
  }

  function saveParticipantGain(participant, value) {
    state.settings.gains ||= {}
    state.settings.gains[participantStorageKey(participant)] = value
    saveSettings()
  }

  function upsertParticipant(data) {
    const existing = state.participants.get(data.key)

    if (existing) {
      existing.name = data.name || existing.name
      existing.present = data.present ?? existing.present
      existing.speaking = data.speaking ?? existing.speaking
      existing.lastSeenAt = data.lastSeenAt ?? Date.now()

      if (data.speaking) {
        existing.lastSpeakingAt = Date.now()
      }

      Object.assign(existing, data.extra || {})
      return existing
    }

    const participant = {
      key: data.key,
      platform: data.platform,
      name: data.name,
      present: data.present ?? true,
      speaking: Boolean(data.speaking),
      lastSeenAt: data.lastSeenAt ?? Date.now(),
      lastSpeakingAt: data.speaking ? Date.now() : 0,
      value: 1,
      ...data.extra
    }

    participant.value = getSavedGain(participant)
    state.participants.set(participant.key, participant)
    return participant
  }

  function getVisibleParticipants(platform = state.platform) {
    return [...state.participants.values()]
      .filter((participant) => participant.platform === platform && participant.present)
      .sort((a, b) => a.name.localeCompare(b.name))
  }

  function applyParticipantGain(participant, value) {
    participant.value = value
    saveParticipantGain(participant, value)

    if (participant.platform === 'jitsi') {
      setJitsiParticipantGain(participant, value)
    }

    if (
      participant.platform === 'google-meet' &&
      state.google.activeParticipantKey === participant.key
    ) {
      setAllGoogleSlots(value, true)
    }

    updateLiveUi()
  }

  function setStatus(message) {
    state.status = message

    const status = document.getElementById(`${PANEL_ID}_status`)
    if (status) status.textContent = message
  }

  function renderSoon() {
    if (state.closed) return

    clearTimeout(state.renderTimer)
    state.renderTimer = setTimeout(renderPanel, 120)
  }

  // ---------------------------------------------------------------------------
  // Google Meet
  //
  // Meet reuses a pool of output GainNodes. A GainNode is not a participant.
  // Therefore, while exactly one participant is speaking, their configured
  // multiplier is applied to every pooled output slot. Only the slot carrying
  // actual audio is audible. When nobody or multiple people are speaking, all
  // slots are reset to 100%, preventing a previous boost leaking to someone else.
  // ---------------------------------------------------------------------------

  function initGoogleMeet() {
    hookGoogleAudioSlots()
    scanGoogleParticipants()

    state.google.scanTimer = setInterval(scanGoogleParticipants, 750)
    state.google.routerTimer = setInterval(routeGoogleAudio, 60)
  }

  function hookGoogleAudioSlots() {
    if (state.google.originalConnect) return

    const originalConnect = AudioNode.prototype.connect
    state.google.originalConnect = originalConnect

    AudioNode.prototype.connect = function (...args) {
      const from = this
      const to = args[0]
      const result = originalConnect.apply(this, args)

      if (
        state.platform === 'google-meet' &&
        from?.constructor?.name === 'AudioWorkletNode' &&
        to?.constructor?.name === 'GainNode'
      ) {
        registerGoogleSlot(to)
      }

      return result
    }
  }

  function registerGoogleSlot(gain) {
    if (state.google.slots.some((slot) => slot.gain === gain)) return

    const slot = {
      id: `slot-${++state.google.slotCounter}`,
      gain,
      baseGain: readAudioParam(gain.gain),
      appliedMultiplier: 1,
      targetValue: readAudioParam(gain.gain),
      lastWriteAt: 0
    }

    state.google.slots.push(slot)
    setGoogleSlotMultiplier(slot, currentGoogleMultiplier(), true)
    setStatus(
      `Detected ${state.google.slots.length} Google Meet audio slot${state.google.slots.length === 1 ? '' : 's'}`
    )
    renderSoon()
  }

  function readAudioParam(param) {
    const value = Number(param?.value)
    return Number.isFinite(value) && value > 0 ? value : 1
  }

  function writeAudioParam(param, value) {
    if (!param) return

    const now = param.context?.currentTime || 0

    // Meet regularly writes its own values back to these pooled GainNodes.
    // Use both APIs so our value takes effect immediately, then enforce it
    // again from the routing loop while the participant is active.
    try {
      param.setValueAtTime(value, now)
    } catch {}

    try {
      param.value = value
    } catch {}
  }

  function setGoogleSlotMultiplier(slot, multiplier, immediate = false) {
    const safeMultiplier = Number.isFinite(multiplier)
      ? Math.max(0, multiplier)
      : 1

    const target = slot.baseGain * safeMultiplier
    const actual = Number(slot.gain?.gain?.value)
    const now = performance.now()
    const wasOverwritten = !Number.isFinite(actual) || Math.abs(actual - target) > 0.002
    const enforcementDue = now - (slot.lastWriteAt || 0) >= 90

    slot.appliedMultiplier = safeMultiplier
    slot.targetValue = target

    if (!immediate && !wasOverwritten && !enforcementDue) return

    writeAudioParam(slot.gain.gain, target)
    slot.lastWriteAt = now
  }

  function setAllGoogleSlots(multiplier, immediate = false) {
    state.google.slots.forEach((slot) => {
      setGoogleSlotMultiplier(slot, multiplier, immediate)
    })
  }

  function currentGoogleMultiplier() {
    const participant = state.participants.get(state.google.activeParticipantKey)
    return participant?.present ? participant.value : 1
  }

  function scanGoogleParticipants() {
    const now = Date.now()
    const foundKeys = new Set()
    const candidates = new Set()

    document
      .querySelectorAll(
        '[data-participant-id], [role="listitem"], [role="gridcell"], [aria-label*="speaking" i]'
      )
      .forEach((element) => {
        const root = getGoogleParticipantRoot(element)
        if (root) candidates.add(root)
      })

    candidates.forEach((root) => {
      const data = extractGoogleParticipant(root)
      if (!data) return

      foundKeys.add(data.key)
      upsertParticipant({
        key: data.key,
        platform: 'google-meet',
        name: data.name,
        present: true,
        speaking: data.speaking,
        lastSeenAt: now,
        extra: {
          participantId: data.participantId,
          element: root
        }
      })
    })

    // Fallback for layouts where only action aria-labels expose the name.
    document
      .querySelectorAll('button[aria-label], div[aria-label], span[aria-label]')
      .forEach((element) => {
        const label = element.getAttribute('aria-label') || ''
        const name = extractGoogleNameFromText(label)

        if (!isValidParticipantName(name) || isSelfText(label)) return

        const root = getGoogleParticipantRoot(element)
        if (root && isSelfGoogleParticipant(root)) return

        const participantId =
          root?.getAttribute?.('data-participant-id') ||
          root?.querySelector?.('[data-participant-id]')?.getAttribute('data-participant-id') ||
          null

        const key = participantId
          ? `id:${participantId}`
          : `name:${normalizeName(name)}`

        const speaking = isGoogleParticipantSpeaking(root || element)

        foundKeys.add(key)
        upsertParticipant({
          key,
          platform: 'google-meet',
          name,
          present: true,
          speaking,
          lastSeenAt: now,
          extra: {
            participantId,
            element: root || element
          }
        })
      })

    for (const participant of state.participants.values()) {
      if (participant.platform !== 'google-meet') continue

      if (!foundKeys.has(participant.key)) {
        participant.speaking = false

        if (now - participant.lastSeenAt > 8000) {
          participant.present = false
        }
      }
    }

    const signature = getVisibleParticipants('google-meet')
      .map((participant) => `${participant.key}:${participant.name}`)
      .join('|')

    if (signature !== state.google.rosterSignature) {
      state.google.rosterSignature = signature
      renderSoon()
    }
  }

  function getGoogleParticipantRoot(element) {
    return (
      element?.closest?.('[data-participant-id]') ||
      element?.closest?.('[role="listitem"]') ||
      element?.closest?.('[role="gridcell"]') ||
      element ||
      null
    )
  }

  function extractGoogleParticipant(root) {
    if (!root || isSelfGoogleParticipant(root)) return null

    const participantId =
      root.getAttribute?.('data-participant-id') ||
      root.querySelector?.('[data-participant-id]')?.getAttribute('data-participant-id') ||
      null

    const name = extractGoogleNameFromElement(root)
    if (!isValidParticipantName(name)) return null

    return {
      participantId,
      key: participantId
        ? `id:${participantId}`
        : `name:${normalizeName(name)}`,
      name,
      speaking: isGoogleParticipantSpeaking(root)
    }
  }

  function isSelfGoogleParticipant(root) {
    if (!root) return false

    const text = root.innerText || root.textContent || ''
    if (isSelfText(text)) return true

    const labels = [...(root.querySelectorAll?.('[aria-label]') || [])]
      .map((element) => element.getAttribute('aria-label') || '')
      .filter(Boolean)

    // In the current Google Meet UI these controls are exposed only on the
    // local tile. This is substantially more reliable than looking for “You”,
    // which is not always present in the participant tile text.
    if (
      labels.some((label) => /^Reframe$/i.test(label)) ||
      labels.some((label) => /^Backgrounds and effects$/i.test(label))
    ) {
      return true
    }

    return labels.some((label) => {
      return (
        /^your\b/i.test(label) ||
        /\byou are\b/i.test(label) ||
        /\byou\s+\(/i.test(label) ||
        /^(mute|unmute|turn (?:on|off)) your (?:microphone|camera)$/i.test(label)
      )
    })
  }

  function extractGoogleNameFromElement(root) {
    const directValues = [
      root.getAttribute?.('aria-label'),
      root.getAttribute?.('title')
    ].filter(Boolean)

    for (const value of directValues) {
      const name = extractGoogleNameFromText(value)
      if (isValidParticipantName(name)) return name
    }

    const labelled = root.querySelectorAll?.('[aria-label], [title]') || []

    for (const element of labelled) {
      const value =
        element.getAttribute('aria-label') ||
        element.getAttribute('title') ||
        ''

      const name = extractGoogleNameFromText(value)
      if (isValidParticipantName(name)) return name
    }

    const visibleText = root.innerText || root.textContent || ''
    const lines = visibleText
      .split('\n')
      .map(cleanName)
      .filter(Boolean)

    return lines.find(isValidParticipantName) || null
  }

  function extractGoogleNameFromText(value) {
    if (!value) return null

    const matches = [
      value.match(/^Mute (.+)'s microphone$/i),
      value.match(/^Unmute (.+)'s microphone$/i),
      value.match(/^Ask (.+) to unmute$/i),
      value.match(/^More (?:actions|options) for (.+)$/i),
      value.match(/^Pin (.+?)(?: to your main screen)?$/i),
      value.match(/^Unpin (.+?)(?: from your main screen)?$/i),
      value.match(/^Remove (.+) from (?:the )?call$/i),
      value.match(/^(.+),\s*(?:muted|not muted|speaking)$/i),
      value.match(/^(.+?)\s+is speaking$/i),
      value.match(/^(.+)'s (?:microphone|camera)$/i)
    ]

    const match = matches.find(Boolean)
    return match ? cleanName(match[1]) : null
  }

  function isGoogleParticipantSpeaking(root) {
    if (!root) return false

    // Verified against the current Meet UI: the participant whose audio level
    // is active gets a descendant with the BlxGDf class. Meet may change other
    // colour/animation classes continuously, but BlxGDf was the common marker
    // for both local and remote speech in our probe.
    if (root.matches?.('.BlxGDf') || root.querySelector?.('.BlxGDf')) {
      return true
    }

    const directValues = [
      root.getAttribute?.('data-is-speaking'),
      root.getAttribute?.('data-speaking'),
      root.getAttribute?.('aria-current')
    ]

    if (directValues.some((value) => /^(true|speaking|active)$/i.test(value || ''))) {
      return true
    }

    const nodes = [
      root,
      ...(root.querySelectorAll?.(
        '[aria-label], [data-is-speaking], [data-speaking], [aria-current]'
      ) || [])
    ]

    return nodes.some((node) => {
      const label = node.getAttribute?.('aria-label') || ''
      const isSpeaking = node.getAttribute?.('data-is-speaking') || ''
      const speaking = node.getAttribute?.('data-speaking') || ''
      const current = node.getAttribute?.('aria-current') || ''

      return (
        /(^|[,\s])speaking([,\s]|$)/i.test(label) ||
        /\bis speaking\b/i.test(label) ||
        /^(true|speaking|active)$/i.test(isSpeaking) ||
        /^(true|speaking|active)$/i.test(speaking) ||
        /^(speaking|active)$/i.test(current)
      )
    })
  }

  function routeGoogleAudio() {
    const now = Date.now()
    const participants = getVisibleParticipants('google-meet')
    const recentSpeakers = participants.filter(
      (participant) =>
        participant.speaking ||
        now - participant.lastSpeakingAt < 450
    )

    let activeParticipant = null
    let status = 'Waiting for participants'

    if (participants.length === 1) {
      activeParticipant = participants[0]
      status = `${activeParticipant.name} · automatic routing`
    } else if (recentSpeakers.length === 1) {
      activeParticipant = recentSpeakers[0]
      state.google.lastSpeakerSeenAt = now
      status = `${activeParticipant.name} · automatic routing`
    } else if (recentSpeakers.length > 1) {
      status = 'Overlapping speakers · using safe 100% volume'
    } else if (participants.length) {
      status = `${participants.length} participants ready`
    }

    const nextKey = activeParticipant?.key || null

    if (nextKey !== state.google.activeParticipantKey) {
      state.google.activeParticipantKey = nextKey
      setAllGoogleSlots(activeParticipant?.value ?? 1, true)
    } else if (activeParticipant) {
      setAllGoogleSlots(activeParticipant.value)
    } else {
      // No reliable active-speaker identity: never leave an old boost behind.
      setAllGoogleSlots(1)
    }

    setStatus(status)
    updateLiveUi()
  }

  // ---------------------------------------------------------------------------
  // Jitsi
  // ---------------------------------------------------------------------------

  function initJitsi() {
    const OriginalRTCPeerConnection = window.RTCPeerConnection
    if (!OriginalRTCPeerConnection) return

    function WrappedRTCPeerConnection(...args) {
      const pc = new OriginalRTCPeerConnection(...args)
      let userOnTrack = null

      pc.addEventListener('track', (event) => {
        handleJitsiTrack(event)

        if (typeof userOnTrack === 'function') {
          userOnTrack.call(pc, event)
        }
      })

      Object.defineProperty(pc, 'ontrack', {
        get() {
          return userOnTrack
        },
        set(handler) {
          userOnTrack = handler
        },
        configurable: true
      })

      return pc
    }

    WrappedRTCPeerConnection.prototype = OriginalRTCPeerConnection.prototype
    Object.setPrototypeOf(WrappedRTCPeerConnection, OriginalRTCPeerConnection)

    window.RTCPeerConnection = WrappedRTCPeerConnection
    startJitsiKeepAlive()
  }

  function isJitsiRemoteAudio(track, streams) {
    if (!track || track.kind !== 'audio') return false
    if (track.id === 'remote-audio-1') return false

    const streamIds = streams?.map((stream) => stream.id) || []

    if (streamIds.includes('mixedmslabel')) return false
    if (streamIds.includes('remote-audio-1')) return false

    return streamIds.some((id) => id.includes('-audio-'))
  }

  function handleJitsiTrack(event) {
    const track = event.track
    if (!isJitsiRemoteAudio(track, event.streams)) return

    const streamKey =
      event.streams?.map((stream) => stream.id).join('|') || track.id

    const participantId = getJitsiParticipantId(event.streams)
    const key = participantId
      ? `id:${participantId}`
      : `stream:${streamKey}`

    const existing = state.participants.get(key)
    if (existing?.clonedTrack?.readyState !== 'ended') return

    muteOriginalJitsiPlayback()

    const index = getVisibleParticipants('jitsi').length
    const name = getJitsiParticipantName(
      participantId,
      `Remote participant ${index + 1}`
    )

    const ctx = getSharedAudioContext()
    if (!ctx) return

    const clonedTrack = track.clone()
    const source = ctx.createMediaStreamSource(new MediaStream([clonedTrack]))
    const gain = ctx.createGain()

    source.connect(gain)
    gain.connect(ctx.destination)

    const participant = upsertParticipant({
      key,
      platform: 'jitsi',
      name,
      present: true,
      speaking: false,
      extra: {
        participantId,
        streamKey,
        originalTrack: track,
        clonedTrack,
        source,
        gain
      }
    })

    setJitsiParticipantGain(participant, participant.value)
    renderSoon()
  }

  function muteOriginalJitsiPlayback() {
    document.querySelectorAll('audio').forEach((audio) => {
      if (!(audio.srcObject instanceof MediaStream)) return

      audio.muted = true
      audio.volume = 0
    })
  }

  function setJitsiParticipantGain(participant, value) {
    if (!participant.clonedTrack || !participant.gain) return

    participant.clonedTrack.enabled = value > 0
    participant.gain.gain.value = value

    const ctx = getSharedAudioContext()
    if (ctx?.state === 'suspended') {
      ctx.resume?.()
    }
  }

  function startJitsiKeepAlive() {
    if (state.jitsi.keepAliveTimer) return

    state.jitsi.keepAliveTimer = setInterval(() => {
      muteOriginalJitsiPlayback()

      const ctx = getSharedAudioContext()
      if (ctx?.state === 'suspended') {
        ctx.resume?.()
      }

      for (const participant of state.participants.values()) {
        if (participant.platform !== 'jitsi') continue

        if (participant.originalTrack?.readyState === 'ended') {
          participant.present = false
          participant.clonedTrack?.stop?.()
          continue
        }

        participant.present = true
        setJitsiParticipantGain(participant, participant.value)
      }

      updateLiveUi()
    }, 1000)
  }

  function getJitsiParticipantId(streams) {
    const streamId = streams
      ?.map((stream) => stream.id)
      .find((id) => id.includes('-audio-'))

    return streamId?.split('-audio-')[0] || null
  }

  function getJitsiParticipantName(participantId, fallback) {
    if (!participantId) return fallback

    try {
      const room = window.APP?.conference?._room
      const participant =
        room?.getParticipantById?.(participantId) ||
        room?.participants?.[participantId]

      const name =
        participant?.getDisplayName?.() ||
        participant?._displayName ||
        participant?.displayName ||
        participant?._identity?.user?.name

      if (name) return cleanName(name)
    } catch {}

    return fallback
  }

  // ---------------------------------------------------------------------------
  // UI
  // ---------------------------------------------------------------------------

  function renderPanel() {
    if (!document.documentElement || state.closed) return

    document.getElementById(PANEL_ID)?.remove()

    const participants = getVisibleParticipants()
    const panel = document.createElement('div')
    panel.id = PANEL_ID

    Object.assign(panel.style, {
      position: 'fixed',
      zIndex: '2147483647',
      width: '310px',
      background: '#202124',
      color: '#fff',
      padding: '11px',
      borderRadius: '14px',
      fontFamily: 'Arial, sans-serif',
      fontSize: '12px',
      boxShadow: '0 8px 28px rgba(0,0,0,.5)',
      userSelect: 'none',
      boxSizing: 'border-box'
    })

    if (state.settings.position) {
      panel.style.left = `${state.settings.position.left}px`
      panel.style.top = `${state.settings.position.top}px`
    } else {
      panel.style.right = '12px'
      panel.style.top = '72px'
    }

    const header = document.createElement('div')
    Object.assign(header.style, {
      display: 'flex',
      justifyContent: 'space-between',
      alignItems: 'center',
      gap: '8px',
      marginBottom: '8px'
    })

    const titleWrap = document.createElement('div')
    titleWrap.style.minWidth = '0'

    const title = document.createElement('div')
    title.textContent =
      state.platform === 'google-meet'
        ? 'Google Meet Audio Booster'
        : 'Jitsi Audio Booster'

    Object.assign(title.style, {
      fontWeight: '700',
      fontSize: '13px',
      overflow: 'hidden',
      textOverflow: 'ellipsis',
      whiteSpace: 'nowrap'
    })

    const subtitle = document.createElement('div')
    subtitle.textContent =
      state.platform === 'google-meet'
        ? `${participants.length} participant${participants.length === 1 ? '' : 's'} · ${state.google.slots.length} audio slot${state.google.slots.length === 1 ? '' : 's'}`
        : `${participants.length} remote audio track${participants.length === 1 ? '' : 's'}`

    Object.assign(subtitle.style, {
      opacity: '0.68',
      fontSize: '11px',
      marginTop: '2px'
    })

    titleWrap.appendChild(title)
    titleWrap.appendChild(subtitle)

    const close = makeButton('×', () => {
      state.closed = true
      panel.remove()
    })

    Object.assign(close.style, {
      width: '26px',
      height: '26px',
      padding: '0',
      fontSize: '16px',
      lineHeight: '16px',
      flex: '0 0 auto'
    })

    header.appendChild(titleWrap)
    header.appendChild(close)
    panel.appendChild(header)

    makeDraggable(panel, header)

    const list = document.createElement('div')
    Object.assign(list.style, {
      maxHeight: '310px',
      overflowY: 'auto',
      paddingRight: '4px'
    })

    if (!participants.length) {
      const empty = document.createElement('div')
      empty.textContent = 'Waiting for remote participants…'

      Object.assign(empty.style, {
        opacity: '0.75',
        padding: '8px 0'
      })

      list.appendChild(empty)
    }

    participants.forEach((participant) => {
      list.appendChild(renderParticipantRow(participant))
    })

    panel.appendChild(list)

    const footer = document.createElement('div')
    Object.assign(footer.style, {
      display: 'flex',
      justifyContent: 'flex-end',
      alignItems: 'center',
      gap: '6px',
      marginTop: '9px',
      paddingTop: '8px',
      borderTop: '1px solid #3c4043'
    })

    footer.appendChild(makeButton('Reset all', () => {
      participants.forEach((participant) => {
        applyParticipantGain(participant, 1)
      })

      if (state.platform === 'google-meet') {
        setAllGoogleSlots(currentGoogleMultiplier(), true)
      }

      renderPanel()
    }))

    panel.appendChild(footer)

    const status = document.createElement('div')
    status.id = `${PANEL_ID}_status`
    status.textContent = state.status

    Object.assign(status.style, {
      minHeight: '14px',
      marginTop: '7px',
      color: '#bdc1c6',
      fontSize: '11px',
      lineHeight: '14px'
    })

    panel.appendChild(status)
    document.documentElement.appendChild(panel)
    state.panel = panel

    updateLiveUi()
  }

  function renderParticipantRow(participant) {
    const row = document.createElement('div')
    row.dataset.participantKey = participant.key

    Object.assign(row.style, {
      padding: '9px 0',
      borderTop: '1px solid #3c4043'
    })

    const top = document.createElement('div')
    Object.assign(top.style, {
      display: 'grid',
      gridTemplateColumns: '1fr auto 48px',
      alignItems: 'center',
      gap: '7px',
      marginBottom: '5px'
    })

    const name = document.createElement('div')
    name.textContent = participant.name

    Object.assign(name.style, {
      fontWeight: '600',
      overflow: 'hidden',
      textOverflow: 'ellipsis',
      whiteSpace: 'nowrap'
    })

    const badge = document.createElement('span')
    badge.dataset.role = 'badge'
    Object.assign(badge.style, {
      minWidth: '8px',
      height: '8px',
      borderRadius: '999px',
      background: '#5f6368',
      boxShadow: '0 0 0 2px rgba(255,255,255,.06)'
    })

    const value = document.createElement('div')
    value.dataset.role = 'value'
    value.textContent = `${Math.round(participant.value * 100)}%`

    Object.assign(value.style, {
      opacity: '0.86',
      minWidth: '46px',
      textAlign: 'right',
      fontVariantNumeric: 'tabular-nums'
    })

    top.appendChild(name)
    top.appendChild(badge)
    top.appendChild(value)

    const slider = document.createElement('input')
    slider.type = 'range'
    slider.min = '0'
    slider.max = '6'
    slider.step = '0.05'
    slider.value = participant.value
    slider.dataset.role = 'slider'

    Object.assign(slider.style, {
      width: '100%',
      margin: '0'
    })

    slider.oninput = () => {
      const next = Number(slider.value)
      applyParticipantGain(participant, next)
      value.textContent = `${Math.round(next * 100)}%`
    }

    const buttons = document.createElement('div')
    Object.assign(buttons.style, {
      display: 'flex',
      gap: '5px',
      marginTop: '7px',
      flexWrap: 'wrap'
    })

    buttons.appendChild(makePresetButton('Mute', participant, slider, value, 0))
    buttons.appendChild(makePresetButton('50%', participant, slider, value, 0.5))
    buttons.appendChild(makePresetButton('100%', participant, slider, value, 1))
    buttons.appendChild(makePresetButton('250%', participant, slider, value, 2.5))

    row.appendChild(top)
    row.appendChild(slider)
    row.appendChild(buttons)

    return row
  }

  function makePresetButton(text, participant, slider, valueElement, value) {
    return makeButton(text, () => {
      slider.value = String(value)
      applyParticipantGain(participant, value)
      valueElement.textContent = `${Math.round(value * 100)}%`
    })
  }

  function makeButton(text, onClick) {
    const button = document.createElement('button')
    button.textContent = text

    Object.assign(button.style, {
      background: '#303134',
      color: '#fff',
      border: '1px solid #5f6368',
      borderRadius: '7px',
      padding: '5px 8px',
      cursor: 'pointer',
      fontSize: '11px',
      lineHeight: '14px'
    })

    button.addEventListener('mouseenter', () => {
      button.style.background = '#3c4043'
    })

    button.addEventListener('mouseleave', () => {
      button.style.background = '#303134'
    })

    button.onclick = onClick
    return button
  }

  function makeDraggable(panel, handle) {
    let dragging = false
    let startX = 0
    let startY = 0
    let startLeft = 0
    let startTop = 0

    handle.style.cursor = 'move'

    handle.addEventListener('mousedown', (event) => {
      if (event.target.closest('button, input, textarea, select')) return

      dragging = true
      startX = event.clientX
      startY = event.clientY

      const rect = panel.getBoundingClientRect()
      startLeft = rect.left
      startTop = rect.top

      event.preventDefault()
    })

    window.addEventListener('mousemove', (event) => {
      if (!dragging) return

      panel.style.left = `${Math.max(8, startLeft + event.clientX - startX)}px`
      panel.style.top = `${Math.max(8, startTop + event.clientY - startY)}px`
      panel.style.right = 'auto'
    })

    window.addEventListener('mouseup', () => {
      if (!dragging) return

      dragging = false

      const rect = panel.getBoundingClientRect()
      state.settings.position = {
        left: rect.left,
        top: rect.top
      }

      saveSettings()
    })
  }

  function updateLiveUi() {
    if (!state.panel?.isConnected) return

    for (const participant of getVisibleParticipants()) {
      const row = [...state.panel.querySelectorAll('[data-participant-key]')]
        .find((element) => element.dataset.participantKey === participant.key)

      if (!row) continue

      const badge = row.querySelector('[data-role="badge"]')
      const value = row.querySelector('[data-role="value"]')
      const slider = row.querySelector('[data-role="slider"]')

      const active =
        participant.platform === 'google-meet'
          ? state.google.activeParticipantKey === participant.key
          : participant.originalTrack?.readyState === 'live'

      if (badge) {
        badge.style.background = active ? '#8ab4f8' : '#5f6368'
        badge.title = active ? 'Active audio' : 'Inactive'
      }

      if (value) {
        value.textContent = `${Math.round(participant.value * 100)}%`
      }

      if (slider && document.activeElement !== slider) {
        slider.value = String(participant.value)
      }
    }
  }

  function getDebugInfo() {
    return {
      platform: state.platform,
      status: state.status,
      participants: getVisibleParticipants().map((participant) => ({
        key: participant.key,
        name: participant.name,
        speaking: participant.speaking,
        speakingMarker: Boolean(
          participant.element?.matches?.('.BlxGDf') ||
          participant.element?.querySelector?.('.BlxGDf')
        ),
        value: participant.value,
        participantId: participant.participantId || null
      })),
      google: {
        activeParticipantKey: state.google.activeParticipantKey,
        slots: state.google.slots.map((slot) => ({
          id: slot.id,
          baseGain: slot.baseGain,
          appliedMultiplier: slot.appliedMultiplier
        }))
      }
    }
  }

  function boot() {
    if (!document.documentElement) {
      setTimeout(boot, 100)
      return
    }

    state.platform = detectPlatform()

    if (state.platform === 'google-meet') {
      initGoogleMeet()
    } else {
      initJitsi()
    }

    renderPanel()
  }

  boot()
})()
