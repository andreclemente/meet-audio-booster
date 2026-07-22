(() => {
  // src/shared/constants.js
  var STORAGE_KEY = "__meeting_audio_booster_v15";
  var LEGACY_STORAGE_KEYS = [
    "__meeting_audio_booster_v14",
    "__meeting_audio_booster_v13"
  ];
  var PANEL_ID = "__meeting_audio_booster_panel";
  var SPEAKER_CONFIRM_MS = 50;
  var ASSOCIATION_CONFIRMATIONS = 3;

  // src/storage.js
  var defaults = () => ({ gains: {}, position: null });
  function sanitize(value) {
    if (!value || typeof value !== "object") return defaults();
    return {
      gains: value.gains && typeof value.gains === "object" ? value.gains : {},
      position: value.position && typeof value.position === "object" ? value.position : null
    };
  }
  function loadSettings(storage = globalThis.localStorage) {
    if (!storage) return defaults();
    for (const key of [STORAGE_KEY, ...LEGACY_STORAGE_KEYS]) {
      try {
        const raw = storage.getItem(key);
        if (raw === null) continue;
        const settings = sanitize(JSON.parse(raw));
        if (key !== STORAGE_KEY && !saveSettings(storage, settings)) continue;
        return settings;
      } catch {
      }
    }
    return defaults();
  }
  function saveSettings(storage = globalThis.localStorage, settings) {
    try {
      storage.setItem(STORAGE_KEY, JSON.stringify(sanitize(settings)));
      return true;
    } catch {
      return false;
    }
  }
  function normalizeName(value) {
    return String(value || "").replace(/\s+/g, " ").trim().toLocaleLowerCase();
  }
  function participantStorageKeys(participant) {
    const keys = [];
    if (participant?.participantId) keys.push(`${participant.platform}:id:${participant.participantId}`);
    const name = normalizeName(participant?.name);
    if (name) keys.push(`${participant.platform}:name:${name}`);
    return [...new Set(keys)];
  }
  function getParticipantGain(settings, participant) {
    for (const key of participantStorageKeys(participant)) {
      const value = settings?.gains?.[key];
      if (typeof value === "number" && Number.isFinite(value)) return value;
    }
    return 1;
  }
  function setParticipantGain(settings, participant, value) {
    settings.gains ||= {};
    const key = participantStorageKeys(participant)[0];
    if (key) settings.gains[key] = Math.max(0, Number(value) || 0);
    return settings;
  }

  // src/platforms/google-meet/router.js
  function createRoutingState() {
    return {
      routingState: "idle",
      appliedParticipantKey: null,
      appliedPipelineId: null,
      lastConfirmedParticipantKey: null,
      candidateParticipantKey: null,
      candidateSince: 0,
      multiplier: 1
    };
  }
  function neutral(state, routingState, candidate = null, now = 0) {
    return {
      ...state,
      routingState,
      appliedParticipantKey: null,
      appliedPipelineId: null,
      candidateParticipantKey: candidate,
      candidateSince: candidate === state.candidateParticipantKey ? state.candidateSince : now,
      multiplier: 1
    };
  }
  function routeGoogleAudio(previous = createRoutingState(), observation = {}) {
    const now = observation.now ?? Date.now();
    const participants = observation.participants || {};
    const ui = [...new Set(observation.uiSpeakerKeys || [])];
    const active = (observation.pipelines || []).filter((pipeline2) => pipeline2.activeByEnergy);
    if (active.length > 1) return neutral(previous, "multiple-active-streams", null, now);
    if (ui.length > 1) return neutral(previous, "ambiguous", null, now);
    if (!active.length) return neutral(previous, ui.length ? "stale-ui-speaker" : "idle", null, now);
    const pipeline = active[0];
    const energyKey = pipeline.associationReliable ? pipeline.participantKey : null;
    if (!energyKey) return neutral(previous, "no-reliable-association", null, now);
    if (ui.length && ui[0] !== energyKey) return neutral(previous, "stale-ui-speaker", null, now);
    if (!participants[energyKey]) return neutral(previous, "no-reliable-association", null, now);
    if (previous.lastConfirmedParticipantKey && previous.lastConfirmedParticipantKey !== energyKey && previous.candidateParticipantKey !== energyKey) {
      return neutral(previous, "transitioning", energyKey, now);
    }
    if (previous.candidateParticipantKey === energyKey && previous.appliedParticipantKey === null && previous.routingState === "transitioning" && now - previous.candidateSince < SPEAKER_CONFIRM_MS) {
      return neutral(previous, "transitioning", energyKey, now);
    }
    const participant = participants[energyKey];
    return {
      ...previous,
      routingState: "confirmed-speaker",
      appliedParticipantKey: energyKey,
      appliedPipelineId: pipeline.id,
      lastConfirmedParticipantKey: energyKey,
      candidateParticipantKey: null,
      candidateSince: 0,
      multiplier: participant.muted ? 0 : Math.max(0, Number(participant.value) || 0)
    };
  }

  // src/state.js
  function createState(storage = globalThis.localStorage) {
    return {
      platform: null,
      participants: /* @__PURE__ */ new Map(),
      settings: loadSettings(storage),
      status: "Starting…",
      audioUnavailable: false,
      closed: false,
      panel: null,
      renderTimer: null,
      sharedCtx: null,
      google: {
        mode: "detecting",
        modeStartedAt: performance.now(),
        slots: [],
        mediaPipelines: [],
        activeParticipantKey: null,
        appliedParticipantKey: null,
        routingState: "idle",
        transitionGuard: { candidateParticipantKey: null, candidateSince: 0 },
        routing: createRoutingState(),
        rosterSignature: ""
      },
      jitsi: { pipelines: [], keepAliveTimer: null }
    };
  }
  function upsertParticipant(state, data) {
    const existing = state.participants.get(data.key);
    if (existing) {
      existing.name = data.name || existing.name;
      existing.present = data.present ?? existing.present;
      existing.speaking = data.speaking ?? existing.speaking;
      existing.lastSeenAt = data.lastSeenAt ?? Date.now();
      if (data.speaking) existing.lastSpeakingAt = Date.now();
      Object.assign(existing, data.extra || {});
      return existing;
    }
    const participant = {
      key: data.key,
      platform: data.platform,
      name: data.name,
      present: data.present ?? true,
      speaking: Boolean(data.speaking),
      lastSeenAt: data.lastSeenAt ?? Date.now(),
      lastSpeakingAt: data.speaking ? Date.now() : 0,
      ...data.extra
    };
    participant.value = getParticipantGain(state.settings, participant);
    state.participants.set(participant.key, participant);
    return participant;
  }
  function visibleParticipants(state, platform = state.platform) {
    return [...state.participants.values()].filter((participant) => participant.platform === platform && participant.present !== false).sort((a, b) => a.name.localeCompare(b.name));
  }

  // src/platforms/google-meet/platform.js
  function detectPlatform(location = globalThis.location) {
    return location?.hostname === "meet.google.com" ? "google-meet" : "jitsi";
  }

  // src/shared/dom.js
  var CONTROL_WORDS = /* @__PURE__ */ new Set([
    "people",
    "person",
    "group",
    "chat",
    "meeting details",
    "more options",
    "audio settings",
    "video settings",
    "settings",
    "close",
    "leave call",
    "present now",
    "raise hand",
    "keep_outline",
    "mic",
    "mic_off",
    "more_vert",
    "call_end",
    "volume_up",
    "videocam",
    "videocam_off",
    "devices"
  ]);
  var PARTICIPANT_NAME_SELECTORS = [
    "[data-self-name]",
    "[data-participant-name]",
    ".zWGUib",
    ".ZjFb7c",
    ".XEazBc",
    '[jsname="EydYod"]'
  ].join(", ");
  function cleanName(value) {
    return String(value || "").replace(/\s+\(.*?\)$/, "").replace(/,\s*(?:muted|not muted|speaking)$/i, "").replace(/\s+is speaking$/i, "").replace(/\s+/g, " ").trim();
  }
  function isSelfText(value) {
    return /(^|[\s(])you([\s)]|$)/i.test(value || "");
  }
  function isValidParticipantName(value) {
    const name = cleanName(value);
    if (!name || name.length > 80 || isSelfText(name)) return false;
    const lower = name.toLocaleLowerCase();
    if (CONTROL_WORDS.has(lower)) return false;
    if (/^(?:[a-z]+_){1,}[a-z]+$/.test(lower) || /^\d+$/.test(name)) return false;
    return !/(?:microphone|camera|google meet|meeting|participant|presentation|screen)/i.test(name);
  }
  function extractCandidateName(element) {
    const explicit = cleanName(element.getAttribute?.("data-participant-name") || element.getAttribute?.("data-self-name"));
    if (isValidParticipantName(explicit)) return explicit;
    const aggregate = cleanName(element.textContent);
    const childNames = [...element.children || []].map((child) => cleanName(child.textContent)).filter(isValidParticipantName);
    if (childNames.length >= 2 && childNames.every((name) => name === childNames[0]) && aggregate === childNames.join("")) {
      return childNames[0];
    }
    return aggregate;
  }
  function extractNameFromParticipantRoot(root) {
    if (!root?.getAttribute?.("data-participant-id")) return null;
    const candidates = root.querySelectorAll?.(PARTICIPANT_NAME_SELECTORS) || [];
    for (const element of candidates) {
      if (!element.matches?.(PARTICIPANT_NAME_SELECTORS)) continue;
      if (element.matches?.('button, [role="button"], [aria-hidden="true"]')) continue;
      const name = extractCandidateName(element);
      if (isValidParticipantName(name)) return name;
    }
    return null;
  }
  function isRecognizedParticipantRoot(root) {
    if (!root?.getAttribute?.("data-participant-id")) return false;
    return Boolean(root.getAttribute("data-requested-participant-id") || extractNameFromParticipantRoot(root));
  }

  // src/platforms/google-meet/participants.js
  function isSelfParticipant(root) {
    const text = root?.innerText || root?.textContent || "";
    if (isSelfText(text)) return true;
    const labels = [...root?.querySelectorAll?.("[aria-label]") || []].map((element) => element.getAttribute("aria-label") || "");
    if (labels.some((label) => /^(Reframe|Backgrounds and effects)$/i.test(label))) return true;
    return labels.some((label) => /^your\b|\byou are\b|\byou\s+\(/i.test(label) || /^(mute|unmute|turn (?:on|off)) your (?:microphone|camera)$/i.test(label));
  }
  function extractGoogleName(root) {
    return extractNameFromParticipantRoot(root);
  }
  function isGoogleParticipantSpeaking(root) {
    if (!root) return false;
    if (root.matches?.(".BlxGDf") || root.querySelector?.(".BlxGDf")) return true;
    const nodes = [root, ...root.querySelectorAll?.("[aria-label], [data-is-speaking], [data-speaking], [aria-current]") || []];
    return nodes.some((node) => {
      const label = node.getAttribute?.("aria-label") || "";
      return /(^|[,\s])speaking([,\s]|$)|\bis speaking\b/i.test(label) || /^(true|speaking|active)$/i.test(node.getAttribute?.("data-is-speaking") || "") || /^(true|speaking|active)$/i.test(node.getAttribute?.("data-speaking") || "") || /^(speaking|active)$/i.test(node.getAttribute?.("aria-current") || "");
    });
  }
  function scoreRoot(element) {
    return Math.min((element.innerText || "").length, 500) + Math.min(element.querySelectorAll?.("*").length || 0, 500);
  }
  function scanMeetParticipants(root = document) {
    const roots = /* @__PURE__ */ new Map();
    for (const element of root.querySelectorAll?.("[data-participant-id]") || []) {
      const participantId = element.getAttribute("data-participant-id");
      if (!participantId || !isRecognizedParticipantRoot(element)) continue;
      const current = roots.get(participantId);
      if (!current || scoreRoot(element) > scoreRoot(current)) roots.set(participantId, element);
    }
    const found = [];
    for (const [participantId, element] of roots) {
      if (isSelfParticipant(element)) continue;
      const name = extractGoogleName(element);
      if (!name) continue;
      found.push({ key: `id:${participantId}`, participantId, name, element, speaking: isGoogleParticipantSpeaking(element) });
    }
    return found;
  }
  function observeMeetParticipants(onChange, root = document.documentElement) {
    const observer = new MutationObserver(() => onChange());
    observer.observe(root, { childList: true, subtree: true, attributes: true, attributeFilter: ["data-participant-id"] });
    return observer;
  }

  // src/platforms/google-meet/association.js
  function createAssociationLearner(confirmations = ASSOCIATION_CONFIRMATIONS) {
    const records = /* @__PURE__ */ new Map();
    return {
      observe(pipelineId, participantKey, { exclusiveUi = false, exclusiveEnergy = false } = {}) {
        if (!pipelineId || !participantKey || !exclusiveUi || !exclusiveEnergy) return this.get(pipelineId);
        const old = records.get(pipelineId);
        const record = old?.candidate === participantKey ? { ...old, count: old.count + 1 } : { candidate: participantKey, count: 1, participantKey: null, associationReliable: false };
        if (record.count >= confirmations) {
          record.participantKey = participantKey;
          record.associationReliable = true;
        }
        records.set(pipelineId, record);
        return { participantKey: record.participantKey, associationReliable: record.associationReliable };
      },
      get(pipelineId) {
        const record = records.get(pipelineId);
        return { participantKey: record?.participantKey || null, associationReliable: Boolean(record?.associationReliable) };
      },
      forget(pipelineId) {
        records.delete(pipelineId);
      },
      clear() {
        records.clear();
      }
    };
  }
  function createFreshAlignmentTracker({ freshMs = 150 } = {}) {
    let uiKey = null;
    let energyId = null;
    let uiChangedAt = null;
    let energyChangedAt = null;
    let eligiblePair = null;
    return {
      observe(now, uiSpeakerKeys = [], energeticPipelineIds = []) {
        const nextUi = uiSpeakerKeys.length === 1 ? uiSpeakerKeys[0] : null;
        const nextEnergy = energeticPipelineIds.length === 1 ? energeticPipelineIds[0] : null;
        const uiChanged = nextUi !== uiKey;
        const energyChanged = nextEnergy !== energyId;
        if (uiChanged) uiChangedAt = now;
        if (energyChanged) energyChangedAt = now;
        uiKey = nextUi;
        energyId = nextEnergy;
        if (!uiKey || !energyId) {
          eligiblePair = null;
        } else if (uiChanged || energyChanged) {
          const transitionsAligned = uiChangedAt !== null && energyChangedAt !== null && Math.abs(uiChangedAt - energyChangedAt) <= freshMs;
          eligiblePair = transitionsAligned ? `${energyId}\0${uiKey}` : null;
        }
        const mayLearn = eligiblePair === `${energyId}\0${uiKey}` && now - Math.max(uiChangedAt, energyChangedAt) <= freshMs;
        return { mayLearn, uiKey, energyId, uiChanged, energyChanged };
      }
    };
  }

  // src/shared/audio.js
  function readAudioParam(param, fallback = 1) {
    const value = Number(param?.value);
    return Number.isFinite(value) ? value : fallback;
  }
  function writeAudioParam(param, value) {
    if (!param) return false;
    const safe = Number.isFinite(value) ? Math.max(0, value) : 1;
    try {
      param.setValueAtTime(safe, param.context?.currentTime || 0);
    } catch {
    }
    try {
      param.value = safe;
    } catch {
      return false;
    }
    return true;
  }
  function createAudioContext() {
    const Context = globalThis.AudioContext || globalThis.webkitAudioContext;
    if (!Context) return null;
    try {
      return new Context();
    } catch {
      return null;
    }
  }

  // src/platforms/google-meet/audio-worklet.js
  function installAudioWorkletHook(onSlot) {
    if (!globalThis.AudioNode || globalThis.__meetingAudioBoosterWorkletHook) return () => {
    };
    const original = AudioNode.prototype.connect;
    globalThis.__meetingAudioBoosterWorkletHook = original;
    const wrapper = function(...args) {
      const from = this;
      const to = args[0];
      const result = original.apply(from, args);
      if (from?.constructor?.name === "AudioWorkletNode" && to?.constructor?.name === "GainNode") onSlot(to);
      return result;
    };
    AudioNode.prototype.connect = wrapper;
    return () => {
      if (AudioNode.prototype.connect === wrapper) AudioNode.prototype.connect = original;
      delete globalThis.__meetingAudioBoosterWorkletHook;
    };
  }
  function createPooledSlot(gain, id) {
    const baseGain = readAudioParam(gain.gain);
    return {
      id,
      gain,
      baseGain,
      appliedMultiplier: 1,
      targetValue: baseGain,
      lastWriteAt: 0,
      // A pooled slot is deliberately never assigned a participant identity.
      participantKey: null,
      set(multiplier, immediate = false) {
        const safe = Number.isFinite(multiplier) ? Math.max(0, multiplier) : 1;
        const target = baseGain * safe;
        const actual = Number(gain?.gain?.value);
        const now = performance.now();
        this.appliedMultiplier = safe;
        this.targetValue = target;
        this.participantKey = null;
        if (!immediate && Number.isFinite(actual) && Math.abs(actual - target) <= 2e-3 && now - this.lastWriteAt < 90) return;
        writeAudioParam(gain.gain, target);
        this.lastWriteAt = now;
      },
      neutral(immediate = true) {
        this.set(1, immediate);
      }
    };
  }

  // src/platforms/google-meet/active-speaker.js
  function createRmsDetector({ onThreshold = 0.018, offThreshold = 9e-3, attackFrames = 2, releaseFrames = 5 } = {}) {
    let active = false;
    let above = 0;
    let below = 0;
    return {
      update(rms) {
        const value = Number.isFinite(rms) ? rms : 0;
        if (active) {
          below = value < offThreshold ? below + 1 : 0;
          if (below >= releaseFrames) {
            active = false;
            above = 0;
          }
        } else {
          above = value >= onThreshold ? above + 1 : 0;
          if (above >= attackFrames) {
            active = true;
            below = 0;
          }
        }
        return active;
      },
      get active() {
        return active;
      },
      reset() {
        active = false;
        above = 0;
        below = 0;
      }
    };
  }
  function calculateRms(buffer) {
    if (!buffer?.length) return 0;
    let sum = 0;
    for (let index = 0; index < buffer.length; index += 1) sum += buffer[index] * buffer[index];
    return Math.sqrt(sum / buffer.length);
  }
  function attachPipelineAnalyser(context, node, options = {}) {
    const analyser = context.createAnalyser();
    analyser.fftSize = options.fftSize || 256;
    const buffer = new Float32Array(analyser.fftSize);
    const detector = createRmsDetector(options);
    node.connect(analyser);
    return {
      analyser,
      buffer,
      detector,
      sample() {
        analyser.getFloatTimeDomainData(buffer);
        const rms = calculateRms(buffer);
        return { rms, activeByEnergy: detector.update(rms) };
      },
      disconnect() {
        try {
          analyser.disconnect();
        } catch {
        }
      }
    };
  }

  // src/platforms/google-meet/media-elements.js
  function mediaStreamKey(stream) {
    if (!stream) return "";
    return [stream.id || "stream", ...(stream.getAudioTracks?.() || []).map((track) => track.id)].join("|");
  }
  function createMediaElementPipeline(context, audio, id) {
    const stream = audio.srcObject;
    const tracks = stream?.getAudioTracks?.() || [];
    let source, gain, analyser;
    try {
      source = context.createMediaStreamSource(stream);
      gain = context.createGain();
      source.connect(gain);
      analyser = attachPipelineAnalyser(context, source);
    } catch {
      try {
        source?.disconnect();
      } catch {
      }
      try {
        gain?.disconnect();
      } catch {
      }
      return null;
    }
    const pipeline = {
      id,
      streamKey: mediaStreamKey(stream),
      stream,
      tracks,
      source,
      gain,
      analyser,
      elements: /* @__PURE__ */ new Set([audio]),
      originalStates: /* @__PURE__ */ new Map(),
      connected: false,
      participantKey: null,
      associationReliable: false,
      activeByEnergy: false,
      rms: 0,
      appliedMultiplier: 1,
      targetValue: 1,
      sample() {
        Object.assign(this, analyser.sample());
        return this;
      },
      activate() {
        if (!this.connected) {
          try {
            gain.connect(context.destination);
            this.connected = true;
          } catch {
            return false;
          }
        }
        for (const element of this.elements) {
          if (!this.originalStates.has(element)) this.originalStates.set(element, { muted: element.muted, volume: element.volume });
          element.muted = true;
          element.volume = 0;
        }
        context.resume?.().catch?.(() => {
        });
        return true;
      },
      deactivate() {
        if (this.connected) {
          try {
            gain.disconnect();
          } catch {
          }
          ;
          this.connected = false;
        }
        for (const [element, original] of this.originalStates) {
          element.muted = original.muted;
          element.volume = original.volume;
        }
        this.originalStates.clear();
      },
      releaseElement(element) {
        const original = this.originalStates.get(element);
        if (original) {
          element.muted = original.muted;
          element.volume = original.volume;
          this.originalStates.delete(element);
        }
        this.elements.delete(element);
      },
      set(multiplier, immediate = false) {
        const safe = Number.isFinite(multiplier) ? Math.max(0, multiplier) : 1;
        this.appliedMultiplier = safe;
        this.targetValue = safe;
        if ((this.connected || immediate) && this.activate()) writeAudioParam(gain.gain, safe);
      },
      destroy() {
        this.deactivate();
        analyser.disconnect();
        try {
          source.disconnect();
        } catch {
        }
        try {
          gain.disconnect();
        } catch {
        }
      }
    };
    return pipeline;
  }
  function createMediaPipelineManager(context, { nextId = /* @__PURE__ */ (() => {
    let id = 0;
    return () => `media-${++id}`;
  })() } = {}) {
    let pipelines = [];
    const byElement = /* @__PURE__ */ new WeakMap();
    function scan(root = document) {
      const seen = /* @__PURE__ */ new Set();
      for (const audio of root.querySelectorAll?.("audio") || []) {
        const stream = audio.srcObject;
        const tracks = stream?.getAudioTracks?.() || [];
        if (!tracks.length || tracks.every((track) => track.readyState === "ended")) continue;
        const key = mediaStreamKey(stream);
        seen.add(key);
        const previous = byElement.get(audio);
        if (previous?.streamKey === key) continue;
        if (previous) {
          previous.releaseElement(audio);
          byElement.delete(audio);
        }
        let pipeline = pipelines.find((item) => item.streamKey === key);
        if (!pipeline) {
          pipeline = createMediaElementPipeline(context, audio, nextId());
          if (!pipeline) continue;
          pipelines.push(pipeline);
        } else pipeline.elements.add(audio);
        byElement.set(audio, pipeline);
        if (pipeline.connected) pipeline.activate();
      }
      for (const pipeline of [...pipelines]) {
        for (const element of [...pipeline.elements]) {
          if (!element.isConnected || mediaStreamKey(element.srcObject) !== pipeline.streamKey) pipeline.releaseElement(element);
        }
        const live = pipeline.tracks.some((track) => track.readyState !== "ended");
        if (!seen.has(pipeline.streamKey) || !pipeline.elements.size || !live) remove(pipeline);
      }
      return pipelines;
    }
    function remove(pipeline) {
      pipeline.destroy();
      pipelines = pipelines.filter((item) => item !== pipeline);
    }
    function destroy() {
      for (const pipeline of [...pipelines]) remove(pipeline);
    }
    return { scan, destroy, get pipelines() {
      return pipelines;
    } };
  }

  // src/platforms/google-meet/index.js
  function collectCurrentUiSpeakers(participants, isSpeaking = (participant) => isGoogleParticipantSpeaking(participant.element)) {
    return participants.filter((participant) => {
      participant.speaking = isSpeaking(participant);
      if (participant.speaking) participant.lastSpeakingAt = Date.now();
      return participant.speaking;
    });
  }
  function applyMediaPipelineOutputs(pipelines, routing, multiplier, immediate = false) {
    const selectedId = routing?.routingState === "confirmed-speaker" ? routing.appliedPipelineId : null;
    const selectedKey = routing?.appliedParticipantKey;
    for (const pipeline of pipelines) {
      const selected = pipeline.id === selectedId && pipeline.associationReliable && pipeline.participantKey === selectedKey;
      pipeline.set(selected ? multiplier : 1, immediate);
    }
  }
  function activateMediaModePipelines(pipelines, routing) {
    applyMediaPipelineOutputs(pipelines, routing, routing?.multiplier ?? 1, true);
  }
  function createGoogleMeetController({ state, context, setStatus, renderSoon, updateLiveUi }) {
    const learner = createAssociationLearner();
    const alignmentTracker = createFreshAlignmentTracker();
    const media = createMediaPipelineManager(context);
    let restoreHook, observer, mutationTimer, reconcileTimer, mediaTimer, routingTimer, slotCounter = 0;
    function participants() {
      return visibleParticipants(state, "google-meet");
    }
    function setMode(mode) {
      if (state.google.mode === mode) return;
      state.google.mode = mode;
      if (mode === "worklet") {
        for (const pipeline of media.pipelines) pipeline.deactivate();
      } else if (mode === "media") applyMediaPipelineOutputs(media.pipelines, null, 1, true);
      renderSoon();
    }
    function registerSlot(gain) {
      if (state.google.slots.some((slot) => slot.gain === gain)) return;
      state.google.slots.push(createPooledSlot(gain, `slot-${++slotCounter}`));
      setMode("worklet");
      setOutputs(currentMultiplier(), true);
      renderSoon();
    }
    function reconcile() {
      const now = Date.now();
      const found = /* @__PURE__ */ new Set();
      for (const data of scanMeetParticipants()) {
        found.add(data.key);
        upsertParticipant(state, {
          ...data,
          platform: "google-meet",
          present: true,
          lastSeenAt: now,
          extra: { participantId: data.participantId, element: data.element }
        });
      }
      for (const participant of state.participants.values()) {
        if (participant.platform !== "google-meet" || found.has(participant.key)) continue;
        participant.speaking = false;
        if (now - participant.lastSeenAt > 8e3) participant.present = false;
      }
      const signature = participants().map((item) => `${item.key}:${item.name}`).join("|");
      if (signature !== state.google.rosterSignature) {
        state.google.rosterSignature = signature;
        renderSoon();
      }
    }
    function scanMedia() {
      media.scan();
      state.google.mediaPipelines = media.pipelines;
      if (state.google.slots.length) setMode("worklet");
      else if (media.pipelines.length && performance.now() - state.google.modeStartedAt > 1200) setMode("media");
      if (state.google.mode === "media") activateMediaModePipelines(media.pipelines, state.google.routing);
    }
    function setOutputs(multiplier, immediate = false) {
      if (state.google.mode === "media") applyMediaPipelineOutputs(media.pipelines, state.google.routing, multiplier, immediate);
      else for (const slot of state.google.slots) slot.set(multiplier, immediate);
    }
    function currentMultiplier() {
      const participant = state.participants.get(state.google.activeParticipantKey);
      return participant?.present ? participant.value : 1;
    }
    function currentUiSpeakers() {
      return collectCurrentUiSpeakers(participants());
    }
    function routeWorklet(now, speakers) {
      let active = speakers.length === 1 ? speakers[0] : null;
      let status = !participants().length ? "Waiting for participants" : speakers.length > 1 ? "Overlapping speakers · using safe 100% volume" : active ? `${active.name} · automatic routing` : `${participants().length} participants ready`;
      const nextKey = active?.key || null;
      const guard = state.google.transitionGuard;
      if (nextKey !== state.google.activeParticipantKey) {
        setOutputs(1, true);
        state.google.activeParticipantKey = null;
        state.google.appliedParticipantKey = null;
        state.google.routingState = nextKey ? "transitioning" : speakers.length > 1 ? "ambiguous" : "idle";
        if (nextKey !== guard.candidateParticipantKey) {
          guard.candidateParticipantKey = nextKey;
          guard.candidateSince = now;
        } else if (nextKey && now - guard.candidateSince >= 50) {
          state.google.activeParticipantKey = nextKey;
          state.google.appliedParticipantKey = nextKey;
          state.google.routingState = "confirmed-speaker";
          guard.candidateParticipantKey = null;
          guard.candidateSince = 0;
          setOutputs(active.value, true);
        }
      } else if (active) {
        state.google.routingState = "confirmed-speaker";
        state.google.appliedParticipantKey = active.key;
        setOutputs(active.value);
      } else {
        guard.candidateParticipantKey = null;
        guard.candidateSince = 0;
        state.google.routingState = speakers.length > 1 ? "ambiguous" : "idle";
        state.google.appliedParticipantKey = null;
        setOutputs(1);
      }
      setStatus(status);
    }
    function routeMedia(now, speakers) {
      for (const pipeline of media.pipelines) pipeline.sample();
      const energetic = media.pipelines.filter((pipeline) => pipeline.activeByEnergy);
      const alignment = alignmentTracker.observe(now, speakers.map((item) => item.key), energetic.map((item) => item.id));
      if (alignment.mayLearn && speakers.length === 1 && energetic.length === 1) {
        Object.assign(energetic[0], learner.observe(energetic[0].id, speakers[0].key, { exclusiveUi: true, exclusiveEnergy: true }));
      }
      state.google.routing = routeGoogleAudio(state.google.routing || createRoutingState(), {
        now,
        participants: Object.fromEntries(participants().map((item) => [item.key, item])),
        uiSpeakerKeys: speakers.map((item) => item.key),
        pipelines: media.pipelines
      });
      const routing = state.google.routing;
      state.google.routingState = routing.routingState;
      state.google.activeParticipantKey = routing.appliedParticipantKey;
      state.google.appliedParticipantKey = routing.appliedParticipantKey;
      state.google.transitionGuard.candidateParticipantKey = routing.candidateParticipantKey;
      state.google.transitionGuard.candidateSince = routing.candidateSince;
      setOutputs(routing.multiplier);
      const labels = {
        "multiple-active-streams": "Multiple active streams · using safe 100% volume",
        "stale-ui-speaker": "Stale speaker indicator · using safe 100% volume",
        "no-reliable-association": "Learning audio stream · using safe 100% volume",
        ambiguous: "Overlapping speakers · using safe 100% volume"
      };
      const active = state.participants.get(routing.appliedParticipantKey);
      setStatus(active ? `${active.name} · automatic routing` : labels[routing.routingState] || `${participants().length} participants ready`);
    }
    function route() {
      const now = Date.now();
      const speakers = currentUiSpeakers();
      if (state.google.mode === "media") routeMedia(now, speakers);
      else routeWorklet(now, speakers);
      updateLiveUi();
    }
    function start() {
      restoreHook = installAudioWorkletHook(registerSlot);
      reconcile();
      scanMedia();
      observer = observeMeetParticipants(() => {
        clearTimeout(mutationTimer);
        mutationTimer = setTimeout(reconcile, 80);
      });
      reconcileTimer = setInterval(reconcile, 750);
      mediaTimer = setInterval(scanMedia, 500);
      routingTimer = setInterval(route, 30);
    }
    function stop() {
      observer?.disconnect();
      clearTimeout(mutationTimer);
      clearInterval(reconcileTimer);
      clearInterval(mediaTimer);
      clearInterval(routingTimer);
      restoreHook?.();
      setOutputs(1, true);
      media.destroy();
    }
    function applyParticipantGain(participant) {
      if (state.google.activeParticipantKey === participant.key) setOutputs(participant.value, true);
    }
    return { start, stop, route, applyParticipantGain, setOutputs, get pipelines() {
      return media.pipelines;
    } };
  }

  // src/platforms/jitsi/rtc-hook.js
  function installRtcHook(onTrack) {
    const Original = globalThis.RTCPeerConnection;
    if (!Original || globalThis.__meetingAudioBoosterRtcHook) return () => {
    };
    globalThis.__meetingAudioBoosterRtcHook = Original;
    function Wrapped(...args) {
      const peer = new Original(...args);
      let handler = null;
      peer.addEventListener("track", (event) => {
        onTrack(event);
        if (typeof handler === "function") handler.call(peer, event);
      });
      Object.defineProperty(peer, "ontrack", {
        configurable: true,
        enumerable: true,
        get: () => handler,
        set: (value) => {
          handler = value;
        }
      });
      return peer;
    }
    Wrapped.prototype = Original.prototype;
    Object.setPrototypeOf(Wrapped, Original);
    globalThis.RTCPeerConnection = Wrapped;
    return () => {
      if (globalThis.RTCPeerConnection === Wrapped) globalThis.RTCPeerConnection = Original;
      delete globalThis.__meetingAudioBoosterRtcHook;
    };
  }

  // src/platforms/jitsi/participants.js
  function getJitsiParticipantId(streams = []) {
    const id = streams.map((stream) => stream.id).find((value) => value.includes("-audio-"));
    return id?.split("-audio-")[0] || null;
  }
  function isJitsiRemoteAudio(track, streams = []) {
    if (track?.kind !== "audio" || track.id === "remote-audio-1") return false;
    const ids = streams.map((stream) => stream.id);
    return !ids.includes("mixedmslabel") && !ids.includes("remote-audio-1") && ids.some((id) => id.includes("-audio-"));
  }
  function getJitsiName(participantId, fallback = "Remote participant") {
    if (!participantId) return fallback;
    try {
      const room = globalThis.APP?.conference?._room;
      const participant = room?.getParticipantById?.(participantId) || room?.participants?.[participantId];
      return participant?.getDisplayName?.() || participant?._displayName || participant?.displayName || participant?._identity?.user?.name || fallback;
    } catch {
      return fallback;
    }
  }

  // src/platforms/jitsi/router.js
  function routeJitsiParticipant(participant, multiplier) {
    const value = Number.isFinite(multiplier) ? Math.max(0, multiplier) : 1;
    if (participant.clonedTrack) participant.clonedTrack.enabled = value > 0;
    if (participant.gain?.gain) writeAudioParam(participant.gain.gain, value);
    participant.value = value;
    return participant;
  }

  // src/platforms/jitsi/index.js
  function createJitsiController({ state, context, renderSoon, updateLiveUi }) {
    let restoreHook;
    const originals = /* @__PURE__ */ new Map();
    function matchingAudio(pipeline, audio) {
      const stream = audio.srcObject;
      if (!stream?.getAudioTracks) return false;
      const trackIds = stream.getAudioTracks().map((track) => track.id);
      return trackIds.includes(pipeline.originalTrack.id) || pipeline.streamIds.includes(stream.id);
    }
    function muteOriginalPlayback() {
      for (const pipeline of state.jitsi.pipelines.filter((item) => item.originalTrack.readyState !== "ended")) {
        for (const audio of document.querySelectorAll("audio")) {
          if (!matchingAudio(pipeline, audio)) continue;
          if (!originals.has(audio)) originals.set(audio, { muted: audio.muted, volume: audio.volume });
          audio.muted = true;
          audio.volume = 0;
        }
      }
    }
    function restoreUnusedElements() {
      for (const [audio, original] of originals) {
        const stillUsed = state.jitsi.pipelines.some((item) => item.originalTrack.readyState !== "ended" && matchingAudio(item, audio));
        if (stillUsed) continue;
        audio.muted = original.muted;
        audio.volume = original.volume;
        originals.delete(audio);
      }
    }
    function teardown(pipeline) {
      pipeline.clonedTrack?.stop?.();
      try {
        pipeline.source?.disconnect();
      } catch {
      }
      try {
        pipeline.gain?.disconnect();
      } catch {
      }
      pipeline.present = false;
      state.jitsi.pipelines = state.jitsi.pipelines.filter((item) => item !== pipeline);
      restoreUnusedElements();
    }
    function onTrack(event) {
      const track = event.track;
      if (!isJitsiRemoteAudio(track, event.streams)) return;
      const participantId = getJitsiParticipantId(event.streams);
      const streamIds = (event.streams || []).map((stream) => stream.id);
      const streamKey = streamIds.join("|") || track.id;
      const key = participantId ? `id:${participantId}` : `stream:${streamKey}`;
      const existing = state.participants.get(key);
      if (existing?.clonedTrack?.readyState !== "ended") return;
      let clonedTrack, source, gain;
      try {
        clonedTrack = track.clone();
        source = context.createMediaStreamSource(new MediaStream([clonedTrack]));
        gain = context.createGain();
        source.connect(gain);
        gain.connect(context.destination);
      } catch {
        clonedTrack?.stop?.();
        try {
          source?.disconnect();
        } catch {
        }
        try {
          gain?.disconnect();
        } catch {
        }
        return;
      }
      const index = visibleParticipants(state, "jitsi").length;
      const participant = upsertParticipant(state, {
        key,
        platform: "jitsi",
        name: cleanName(getJitsiName(participantId, `Remote participant ${index + 1}`)),
        present: true,
        extra: { participantId, streamKey, streamIds, originalTrack: track, clonedTrack, source, gain }
      });
      if (!state.jitsi.pipelines.includes(participant)) state.jitsi.pipelines.push(participant);
      routeJitsiParticipant(participant, participant.value);
      muteOriginalPlayback();
      context?.resume?.().catch?.(() => {
      });
      track.addEventListener?.("ended", () => {
        teardown(participant);
        renderSoon();
      }, { once: true });
      renderSoon();
    }
    function keepAlive() {
      muteOriginalPlayback();
      context?.resume?.().catch?.(() => {
      });
      for (const pipeline of [...state.jitsi.pipelines]) {
        if (pipeline.originalTrack?.readyState === "ended") teardown(pipeline);
        else {
          pipeline.present = true;
          routeJitsiParticipant(pipeline, pipeline.value);
        }
      }
      updateLiveUi();
    }
    function start() {
      restoreHook = installRtcHook(onTrack);
      state.jitsi.keepAliveTimer = setInterval(keepAlive, 1e3);
    }
    function stop() {
      restoreHook?.();
      clearInterval(state.jitsi.keepAliveTimer);
      for (const pipeline of [...state.jitsi.pipelines]) teardown(pipeline);
      restoreUnusedElements();
    }
    return { start, stop, onTrack, applyParticipantGain: routeJitsiParticipant };
  }

  // src/ui/styles.js
  var panelStyles = {
    position: "fixed",
    zIndex: "2147483647",
    width: "310px",
    background: "#202124",
    color: "#fff",
    padding: "11px",
    borderRadius: "14px",
    fontFamily: "Arial, sans-serif",
    fontSize: "12px",
    boxShadow: "0 8px 28px rgba(0,0,0,.5)",
    userSelect: "none",
    boxSizing: "border-box"
  };
  var buttonStyles = {
    background: "#303134",
    color: "#fff",
    border: "1px solid #5f6368",
    borderRadius: "7px",
    padding: "5px 8px",
    cursor: "pointer",
    fontSize: "11px",
    lineHeight: "14px"
  };
  var headerStyles = {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    gap: "8px",
    marginBottom: "8px"
  };

  // src/ui/participant-row.js
  function makeButton(text, action) {
    const element = document.createElement("button");
    element.textContent = text;
    Object.assign(element.style, buttonStyles);
    element.addEventListener("mouseenter", () => {
      element.style.background = "#3c4043";
    });
    element.addEventListener("mouseleave", () => {
      element.style.background = "#303134";
    });
    element.onclick = action;
    return element;
  }
  function renderParticipantRow(participant, onGain) {
    const row = document.createElement("div");
    row.dataset.participantKey = participant.key;
    Object.assign(row.style, { padding: "9px 0", borderTop: "1px solid #3c4043" });
    const top = document.createElement("div");
    Object.assign(top.style, { display: "grid", gridTemplateColumns: "1fr auto 48px", alignItems: "center", gap: "7px", marginBottom: "5px" });
    const name = document.createElement("div");
    name.textContent = participant.name;
    Object.assign(name.style, { fontWeight: "600", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" });
    const badge = document.createElement("span");
    badge.dataset.role = "badge";
    Object.assign(badge.style, { minWidth: "8px", height: "8px", borderRadius: "999px", background: "#5f6368", boxShadow: "0 0 0 2px rgba(255,255,255,.06)" });
    const value = document.createElement("div");
    value.dataset.role = "value";
    value.textContent = `${Math.round(participant.value * 100)}%`;
    Object.assign(value.style, { opacity: "0.86", minWidth: "46px", textAlign: "right", fontVariantNumeric: "tabular-nums" });
    top.append(name, badge, value);
    const slider = document.createElement("input");
    Object.assign(slider, { type: "range", min: "0", max: "6", step: "0.05", value: String(participant.value) });
    slider.dataset.role = "slider";
    Object.assign(slider.style, { width: "100%", margin: "0" });
    slider.oninput = () => {
      const next = Number(slider.value);
      onGain(participant, next);
      value.textContent = `${Math.round(next * 100)}%`;
    };
    const presets = document.createElement("div");
    Object.assign(presets.style, { display: "flex", gap: "5px", marginTop: "7px", flexWrap: "wrap" });
    for (const [text, gain] of [["Mute", 0], ["50%", 0.5], ["100%", 1], ["250%", 2.5]]) {
      presets.append(makeButton(text, () => {
        slider.value = String(gain);
        onGain(participant, gain);
        value.textContent = `${Math.round(gain * 100)}%`;
      }));
    }
    row.append(top, slider, presets);
    return row;
  }

  // src/ui/panel.js
  function createPanelController(state, { participants, onGain, onSave }) {
    function updateLiveUi() {
      if (!state.panel?.isConnected) return;
      for (const participant of participants()) {
        const row = [...state.panel.querySelectorAll("[data-participant-key]")].find((item) => item.dataset.participantKey === participant.key);
        if (!row) continue;
        const active = participant.platform === "google-meet" ? state.google.activeParticipantKey === participant.key : participant.originalTrack?.readyState === "live";
        const badge = row.querySelector('[data-role="badge"]');
        if (badge) {
          badge.style.background = active ? "#8ab4f8" : "#5f6368";
          badge.title = active ? "Active audio" : "Inactive";
        }
        const value = row.querySelector('[data-role="value"]');
        if (value) value.textContent = `${Math.round(participant.value * 100)}%`;
        const slider = row.querySelector('[data-role="slider"]');
        if (slider && document.activeElement !== slider) slider.value = String(participant.value);
      }
    }
    function render() {
      if (state.closed || !document.documentElement) return;
      const listItems = participants();
      let panel = document.getElementById(PANEL_ID);
      if (!panel) {
        panel = document.createElement("div");
        panel.id = PANEL_ID;
        document.documentElement.append(panel);
      }
      panel.replaceChildren();
      panel.style.display = "block";
      Object.assign(panel.style, panelStyles);
      if (state.settings.position) Object.assign(panel.style, { left: `${state.settings.position.left}px`, top: `${state.settings.position.top}px`, right: "auto" });
      else Object.assign(panel.style, { right: "12px", top: "72px", left: "auto" });
      const header = document.createElement("div");
      Object.assign(header.style, headerStyles);
      const titleWrap = document.createElement("div");
      titleWrap.style.minWidth = "0";
      const title = document.createElement("div");
      title.textContent = state.platform === "google-meet" ? "Google Meet Audio Booster" : "Jitsi Audio Booster";
      Object.assign(title.style, { fontWeight: "700", fontSize: "13px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" });
      const subtitle = document.createElement("div");
      const outputCount = state.google.mode === "media" ? state.google.mediaPipelines.length : state.google.slots.length;
      subtitle.textContent = state.platform === "google-meet" ? `${listItems.length} participant${listItems.length === 1 ? "" : "s"} · ${outputCount} ${state.google.mode === "media" ? "media stream" : "audio slot"}${outputCount === 1 ? "" : "s"}` : `${listItems.length} remote audio track${listItems.length === 1 ? "" : "s"}`;
      Object.assign(subtitle.style, { opacity: "0.68", fontSize: "11px", marginTop: "2px" });
      titleWrap.append(title, subtitle);
      const close = makeButton("×", hide);
      Object.assign(close.style, { width: "26px", height: "26px", padding: "0", fontSize: "16px", lineHeight: "16px", flex: "0 0 auto" });
      header.append(titleWrap, close);
      panel.append(header);
      makeDraggable(panel, header, onSave);
      const list = document.createElement("div");
      Object.assign(list.style, { maxHeight: "310px", overflowY: "auto", paddingRight: "4px" });
      if (!listItems.length) {
        const empty = document.createElement("div");
        empty.textContent = "Waiting for remote participants…";
        Object.assign(empty.style, { opacity: "0.75", padding: "8px 0" });
        list.append(empty);
      }
      for (const participant of listItems) list.append(renderParticipantRow(participant, onGain));
      panel.append(list);
      const footer = document.createElement("div");
      Object.assign(footer.style, { display: "flex", justifyContent: "flex-end", alignItems: "center", gap: "6px", marginTop: "9px", paddingTop: "8px", borderTop: "1px solid #3c4043" });
      footer.append(makeButton("Reset all", () => {
        for (const participant of listItems) onGain(participant, 1);
        render();
      }));
      panel.append(footer);
      const status = document.createElement("div");
      status.id = `${PANEL_ID}_status`;
      status.textContent = state.status;
      Object.assign(status.style, { minHeight: "14px", marginTop: "7px", color: "#bdc1c6", fontSize: "11px", lineHeight: "14px" });
      panel.append(status);
      state.panel = panel;
      updateLiveUi();
    }
    function show() {
      state.closed = false;
      render();
      if (state.panel) state.panel.style.display = "block";
    }
    function hide() {
      state.closed = true;
      if (state.panel) state.panel.style.display = "none";
    }
    function toggle() {
      state.closed ? show() : hide();
    }
    return { render, show, hide, toggle, updateLiveUi };
  }
  function makeDraggable(panel, handle, onSave) {
    handle.style.cursor = "move";
    handle.onmousedown = (event) => {
      if (event.target.closest("button, input, textarea, select")) return;
      const rect = panel.getBoundingClientRect();
      panel.__boosterDrag = { x: event.clientX, y: event.clientY, left: rect.left, top: rect.top };
      event.preventDefault();
    };
    if (panel.__boosterDragInstalled) return;
    panel.__boosterDragInstalled = true;
    globalThis.addEventListener("mousemove", (event) => {
      const start = panel.__boosterDrag;
      if (!start) return;
      panel.style.left = `${Math.max(8, start.left + event.clientX - start.x)}px`;
      panel.style.top = `${Math.max(8, start.top + event.clientY - start.y)}px`;
      panel.style.right = "auto";
    });
    globalThis.addEventListener("mouseup", () => {
      if (!panel.__boosterDrag) return;
      panel.__boosterDrag = null;
      const rect = panel.getBoundingClientRect();
      onSave({ left: rect.left, top: rect.top });
    });
  }

  // src/shared/debug.js
  function jsonSafe(value) {
    return JSON.parse(JSON.stringify(value, (_key, item) => {
      if (item instanceof Map) return Object.fromEntries(item);
      if (item instanceof Set) return [...item];
      if (typeof item === "function" || typeof item === "symbol") return void 0;
      return item;
    }));
  }
  function createDebugInfo(state, visibleParticipants2) {
    const participants = visibleParticipants2().map((participant) => ({
      key: participant.key,
      name: participant.name,
      isSelf: Boolean(participant.isSelf),
      isSpeakingByUi: Boolean(participant.speaking),
      configuredMultiplier: Number.isFinite(participant.value) ? participant.value : 1,
      muted: Boolean(participant.muted || participant.value === 0)
    }));
    const slots = state.google.slots.map((slot) => ({
      id: slot.id,
      baseGain: slot.baseGain,
      appliedMultiplier: slot.appliedMultiplier,
      targetValue: slot.targetValue,
      actualValue: Number(slot.gain?.gain?.value),
      participantKey: null
    }));
    const mediaPipelines = state.google.mediaPipelines.map((pipeline) => {
      const track = pipeline.tracks?.[0];
      return {
        id: pipeline.id,
        streamId: pipeline.stream?.id || null,
        trackId: track?.id || null,
        connected: Boolean(pipeline.connected),
        muted: Boolean(track?.muted),
        readyState: track?.readyState || null,
        rms: Number(pipeline.rms) || 0,
        activeByEnergy: Boolean(pipeline.activeByEnergy),
        appliedMultiplier: Number.isFinite(pipeline.appliedMultiplier) ? pipeline.appliedMultiplier : 1,
        targetValue: Number.isFinite(pipeline.targetValue) ? pipeline.targetValue : 1,
        actualValue: Number.isFinite(Number(pipeline.gain?.gain?.value)) ? Number(pipeline.gain.gain.value) : null,
        participantKey: pipeline.participantKey || null,
        associationReliable: Boolean(pipeline.associationReliable),
        tracks: (pipeline.tracks || []).map((item) => ({ id: item.id, muted: item.muted, enabled: item.enabled, readyState: item.readyState }))
      };
    });
    return jsonSafe({
      platform: state.platform,
      status: state.status,
      participantCount: participants.length,
      participants,
      activeParticipantKey: state.google.activeParticipantKey,
      appliedParticipantKey: state.google.appliedParticipantKey,
      routingState: state.google.routingState,
      transitionGuard: state.google.transitionGuard,
      slots,
      mediaPipelines,
      google: {
        mode: state.google.mode,
        routingState: state.google.routingState,
        activeParticipantKey: state.google.activeParticipantKey,
        appliedParticipantKey: state.google.appliedParticipantKey,
        transitionGuard: state.google.transitionGuard,
        slots,
        mediaPipelines
      }
    });
  }
  function installDebugApi(state, visibleParticipants2) {
    globalThis.__meetingAudioBoosterDebug = () => createDebugInfo(state, visibleParticipants2);
  }

  // src/main.js
  if (!globalThis.__meetingAudioBoosterInstalled) {
    let getContext = function() {
      state.sharedCtx ||= createAudioContext();
      return state.sharedCtx;
    }, setStatus = function(message) {
      if (state.audioUnavailable) message = "Audio unavailable · controls are inactive";
      state.status = message;
      const status = document.getElementById(`${PANEL_ID}_status`);
      if (status) status.textContent = message;
    }, renderSoon = function() {
      if (state.closed) return;
      clearTimeout(state.renderTimer);
      state.renderTimer = setTimeout(() => panel.render(), 120);
    }, applyGain = function(participant, value) {
      participant.value = Number.isFinite(value) ? Math.max(0, value) : 1;
      setParticipantGain(state.settings, participant, participant.value);
      saveSettings(globalThis.localStorage, state.settings);
      platformController?.applyParticipantGain(participant, participant.value);
      panel.updateLiveUi();
    }, boot = function() {
      if (!document.documentElement) {
        setTimeout(boot, 100);
        return;
      }
      state.platform = detectPlatform();
      const context = getContext();
      state.audioUnavailable = !context;
      const common = { state, context, setStatus, renderSoon, updateLiveUi: panel.updateLiveUi };
      platformController = state.platform === "google-meet" ? createGoogleMeetController(common) : createJitsiController(common);
      platformController.start();
      if (!context) setStatus("Audio unavailable · controls are inactive");
      panel.render();
    };
    globalThis.__meetingAudioBoosterInstalled = true;
    const state = createState();
    let platformController = null;
    const panel = createPanelController(state, {
      participants: () => visibleParticipants(state),
      onGain: applyGain,
      onSave: (position) => {
        state.settings.position = position;
        saveSettings(globalThis.localStorage, state.settings);
      }
    });
    globalThis.__meetingAudioBooster = state;
    globalThis.__meetingAudioBoosterShow = panel.show;
    globalThis.__meetingAudioBoosterHide = panel.hide;
    globalThis.__meetingAudioBoosterToggle = panel.toggle;
    installDebugApi(state, () => visibleParticipants(state));
    Object.defineProperty(globalThis, "__meetingAudioBoosterModules", {
      configurable: true,
      value: Object.freeze({ bootApi: "modular-v1", platforms: Object.freeze(["google-meet", "jitsi"]), storageKey: "__meeting_audio_booster_v15" })
    });
    boot();
  }
})();
