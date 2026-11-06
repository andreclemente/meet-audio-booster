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
  var defaults = () => ({ gains: {}, position: null, collapsed: false });
  function sanitize(value) {
    if (!value || typeof value !== "object") return defaults();
    return {
      gains: value.gains && typeof value.gains === "object" ? value.gains : {},
      position: value.position && Number.isFinite(value.position.left) && Number.isFinite(value.position.top) ? { left: value.position.left, top: value.position.top } : null,
      collapsed: value.collapsed === true
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
    const gain = Math.max(0, Number(value) || 0);
    for (const key of participantStorageKeys(participant)) settings.gains[key] = gain;
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
      multiplier: 1,
      confirmedIdentity: null,
      quietIdentity: null
    };
  }
  function isQuietMediaTransition(pipelines, routing) {
    const identity = routing?.quietIdentity;
    if (!identity || routing.routingState !== "energy-idle") return false;
    const { pipeline, streamKey, stream, participant, participantKey } = identity;
    if (!stream || !pipeline.tracks?.length || !pipeline.elements?.size) return false;
    const currentTracks = stream.getAudioTracks?.() || [];
    return pipelines.includes(pipeline) && !pipelines.some((item) => item.activeByEnergy) && pipeline.streamKey === streamKey && pipeline.stream === stream && pipeline.associationReliable && pipeline.participantKey === participantKey && participant.present !== false && pipeline.tracks.every((track) => track.readyState === "live") && [...pipeline.elements].every((element) => element.isConnected !== false && element.srcObject === stream) && currentTracks.length === pipeline.tracks.length && pipeline.tracks.every((track) => currentTracks.includes(track));
  }
  function routeGoogleAudio(previous = createRoutingState(), observation = {}) {
    const now = observation.now ?? Date.now();
    const participants = observation.participants || {};
    const ui = [...new Set(observation.uiSpeakerKeys || [])];
    const active = (observation.pipelines || []).filter((pipeline2) => pipeline2.activeByEnergy);
    if (active.length > 1) return neutral(previous, "multiple-active-streams", null, now);
    if (ui.length > 1) return neutral(previous, "ambiguous", null, now);
    if (!active.length) {
      const identity = previous.routingState === "confirmed-speaker" ? previous.confirmedIdentity : previous.quietIdentity;
      const quiet = { ...neutral(previous, "energy-idle", null, now), quietIdentity: identity };
      if (identity && participants[identity.participantKey] === identity.participant && (!ui.length || ui[0] === identity.participantKey) && isQuietMediaTransition(observation.pipelines || [], quiet)) return quiet;
      return neutral(previous, ui.length ? "stale-ui-speaker" : "idle", null, now);
    }
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
      quietIdentity: null,
      confirmedIdentity: { pipeline, streamKey: pipeline.streamKey, stream: pipeline.stream, participant, participantKey: energyKey },
      multiplier: participant.muted ? 0 : Math.max(0, Number(participant.value) || 0)
    };
  }

  // src/state.js
  function createState(storage = globalThis.localStorage) {
    const settings = loadSettings(storage);
    return {
      platform: null,
      participants: /* @__PURE__ */ new Map(),
      settings,
      status: "Starting…",
      audioUnavailable: false,
      closed: false,
      panelCollapsed: settings.collapsed,
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
        rosterSignature: "",
        localPresentationActive: false
      }
    };
  }
  function upsertParticipant(state, data) {
    const existing = state.participants.get(data.key);
    if (existing) {
      if (data.name && data.name !== existing.name) {
        existing.name = data.name;
        if (!existing.adjusted) existing.value = getParticipantGain(state.settings, existing);
      }
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
    return location?.hostname === "meet.google.com" ? "google-meet" : null;
  }

  // src/shared/dom.js
  var ICON_WORDS = /* @__PURE__ */ new Set([
    "keep_outline",
    "keep_off",
    "mic",
    "mic_none",
    "mic_off",
    "more_vert",
    "call_end",
    "volume_up",
    "volume_off",
    "videocam",
    "videocam_off",
    "devices",
    "visual_effects",
    "frame_person",
    "person",
    "group",
    "chat",
    "people"
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
    return String(value || "").replace(/\s+\(.*?\)$/, "").replace(/\s+/g, " ").trim();
  }
  function isValidParticipantName(value) {
    const name = cleanName(value);
    if (!name || name.length > 80) return false;
    if (ICON_WORDS.has(name.toLocaleLowerCase())) return false;
    return !/^(?:[a-z]+_){1,}[a-z]+$/.test(name.toLocaleLowerCase()) && !/^\d+$/.test(name);
  }
  function participantNameLeaves(element) {
    const names = [];
    const pending = [...element.children || []];
    while (pending.length && names.length < 8) {
      const child = pending.shift();
      const children = [...child.children || []];
      if (children.length) pending.unshift(...children);
      else {
        const name = cleanName(child.textContent);
        if (isValidParticipantName(name)) names.push(name);
      }
    }
    return names;
  }
  function extractCandidateName(element) {
    const explicit = cleanName(element.getAttribute?.("data-participant-name") || element.getAttribute?.("data-self-name"));
    if (isValidParticipantName(explicit)) return explicit;
    const aggregate = cleanName(element.textContent);
    const leafNames = participantNameLeaves(element);
    if (leafNames.length >= 2 && leafNames.every((name) => name === leafNames[0]) && aggregate === leafNames.join("")) {
      return leafNames[0];
    }
    return aggregate;
  }
  function extractNameFromParticipantRoot(root) {
    if (!root?.getAttribute?.("data-participant-id")) return null;
    const candidates = root.querySelectorAll?.(PARTICIPANT_NAME_SELECTORS) || [];
    const controlLabels = /* @__PURE__ */ new Set();
    const ownElement = (element) => !element.closest || element.closest("[data-participant-id]") === root;
    for (const element of root.querySelectorAll?.("[aria-label], [data-tooltip]") || []) {
      if (!ownElement(element)) continue;
      for (const attr of ["aria-label", "data-tooltip"]) {
        const value = cleanName(element.getAttribute?.(attr)).toLocaleLowerCase();
        if (value) controlLabels.add(value);
      }
    }
    for (const element of candidates) {
      if (!ownElement(element)) continue;
      if (!element.matches?.(PARTICIPANT_NAME_SELECTORS)) continue;
      if (element.matches?.('button, [role="button"], [aria-hidden="true"]')) continue;
      const name = extractCandidateName(element);
      if (isValidParticipantName(name) && !controlLabels.has(name.toLocaleLowerCase())) return name;
    }
    return null;
  }
  function isRecognizedParticipantRoot(root) {
    if (!root?.getAttribute?.("data-participant-id")) return false;
    return Boolean(root.getAttribute("data-requested-participant-id") || extractNameFromParticipantRoot(root));
  }

  // src/platforms/google-meet/participants.js
  var PRESENTATION_ICONS = /* @__PURE__ */ new Set(["zoom_in", "zoom_out", "open_in_full", "stylus_laser_pointer"]);
  var MICROPHONE_ICONS = /* @__PURE__ */ new Set(["mic", "mic_none", "mic_off"]);
  function ownIcons(root) {
    const icons = /* @__PURE__ */ new Set();
    for (const icon of root?.querySelectorAll?.(MATERIAL_ICON_SELECTOR) || []) {
      if (icon.closest && icon.closest("[data-participant-id]") !== root) continue;
      icons.add((icon.textContent || "").trim());
    }
    return icons;
  }
  var MICROPHONE_PATH_PREFIXES = ["M12 14c1.66 0 3-1.34 3-3V5", "M19 11h-1.7c0 .74-.16 1.43-.43 2.05"];
  function hasOwnMicrophonePath(root) {
    for (const path of root?.querySelectorAll?.("svg path") || []) {
      if (path.closest && path.closest("[data-participant-id]") !== root) continue;
      const d = (path.getAttribute?.("d") || "").replace(/\s+/g, " ").trim();
      if (MICROPHONE_PATH_PREFIXES.some((prefix) => d.startsWith(prefix))) return true;
    }
    return false;
  }
  function hasMicrophoneIndicator(root) {
    const icons = ownIcons(root);
    return [...MICROPHONE_ICONS].some((icon) => icons.has(icon)) || hasOwnMicrophonePath(root);
  }
  function isPresentationRoot(root) {
    if (!root?.getAttribute?.("data-participant-id")) return false;
    if (hasMicrophoneIndicator(root)) return false;
    const icons = ownIcons(root);
    return [...PRESENTATION_ICONS].some((icon) => icons.has(icon));
  }
  function isLocalPresentationRoot(root) {
    return isPresentationRoot(root) && ownIcons(root).has("stylus_laser_pointer");
  }
  function hasLocalPresentation(root = document) {
    return [...root.querySelectorAll?.("[data-participant-id]") || []].some(isLocalPresentationRoot);
  }
  var BUTTON_SELECTOR = 'button, [role="button"]';
  var MATERIAL_ICON_SELECTOR = [
    ...[
      "google-symbols",
      "material-icons",
      "material-icons-outlined",
      "material-icons-round",
      "material-icons-sharp",
      "material-icons-two-tone",
      "material-symbols-outlined",
      "material-symbols-rounded",
      "material-symbols-sharp"
    ].flatMap((className) => [`i.${className}`, `span.${className}`])
  ].join(", ");
  function hasOwnSelfControls(root) {
    const icons = /* @__PURE__ */ new Set();
    for (const button of root?.querySelectorAll?.(BUTTON_SELECTOR) || []) {
      if (button.closest?.("[data-participant-id]") !== root) continue;
      for (const icon of button.querySelectorAll?.(MATERIAL_ICON_SELECTOR) || []) {
        if (icon.closest?.("[data-participant-id]") !== root || icon.closest?.(BUTTON_SELECTOR) !== button) continue;
        icons.add((icon.textContent || "").trim());
      }
    }
    return icons.has("visual_effects");
  }
  function isSelfParticipant(root) {
    return hasOwnSelfControls(root);
  }
  function extractGoogleName(root) {
    return extractNameFromParticipantRoot(root);
  }
  function isGoogleParticipantSpeaking(root) {
    if (!root) return false;
    if (root.matches?.(".BlxGDf") || root.querySelector?.(".BlxGDf")) return true;
    const nodes = [root, ...root.querySelectorAll?.("[data-is-speaking], [data-speaking], [aria-current]") || []];
    return nodes.some((node) => {
      return /^(true|speaking|active)$/i.test(node.getAttribute?.("data-is-speaking") || "") || /^(true|speaking|active)$/i.test(node.getAttribute?.("data-speaking") || "") || /^(speaking|active)$/i.test(node.getAttribute?.("aria-current") || "");
    });
  }
  function scoreRoot(element) {
    return Math.min((element.innerText || "").length, 500) + Math.min(element.querySelectorAll?.("*").length || 0, 500);
  }
  function scanMeetParticipants(root = document, selfIds = /* @__PURE__ */ new Set(), presentationIds = /* @__PURE__ */ new Set()) {
    const roots = /* @__PURE__ */ new Map();
    for (const element of root.querySelectorAll?.("[data-participant-id]") || []) {
      const participantId = element.getAttribute("data-participant-id");
      if (!participantId) continue;
      if (isSelfParticipant(element)) selfIds.add(participantId);
      if (isPresentationRoot(element)) presentationIds.add(participantId);
      if (!isRecognizedParticipantRoot(element) || isLocalPresentationRoot(element)) continue;
      const current = roots.get(participantId);
      if (!current || scoreRoot(element) > scoreRoot(current)) roots.set(participantId, element);
    }
    const found = [];
    for (const [participantId, element] of roots) {
      if (selfIds.has(participantId) || presentationIds.has(participantId)) continue;
      const name = extractGoogleName(element);
      if (!name) continue;
      found.push({ key: `id:${participantId}`, participantId, name, element, speaking: isGoogleParticipantSpeaking(element), hasMicrophone: hasMicrophoneIndicator(element) });
    }
    return found;
  }
  function updateMissingParticipants(participants, found, { now, selfIds, presentationIds = /* @__PURE__ */ new Set(), isMember = () => false, graceMs = 8e3 }) {
    const excluded = (id) => selfIds.has(id) || presentationIds.has(id);
    for (const participant of participants) {
      if (participant.platform !== "google-meet" || found.has(participant.key)) continue;
      if (!excluded(participant.participantId) && isMember(participant.participantId)) {
        participant.present = true;
        participant.lastSeenAt = now;
        continue;
      }
      participant.speaking = false;
      if (excluded(participant.participantId) || now - participant.lastSeenAt > graceMs) participant.present = false;
    }
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

  // src/platforms/google-meet/presentation.js
  var HOOK_KEY = "__meetingAudioBoosterDisplayCaptureHook";
  function installLocalPresentationCaptureHook(onActive, mediaDevices = globalThis.navigator?.mediaDevices) {
    if (!mediaDevices) return () => {
    };
    const owner = Object.getPrototypeOf(mediaDevices) || mediaDevices;
    const original = owner.getDisplayMedia;
    if (typeof original !== "function" || owner[HOOK_KEY]) return () => {
    };
    const captures = /* @__PURE__ */ new Set();
    let active = false;
    let disposed = false;
    let captureTimer = null;
    const stopPolling = () => {
      if (captureTimer === null) return;
      clearInterval(captureTimer);
      captureTimer = null;
    };
    const emit = (next) => {
      if (disposed || active === next) return;
      active = next;
      onActive(next);
    };
    const removeCapture = (capture) => {
      if (!captures.delete(capture)) return;
      for (const track of capture.tracks) track.removeEventListener?.("ended", capture.checkEnded);
      if (!captures.size) stopPolling();
      emit(captures.size > 0);
    };
    const wrapped = async function(...args) {
      const stream = await original.apply(this, args);
      if (disposed) return stream;
      const allTracks = stream?.getTracks?.() || [];
      const tracks = allTracks.length ? allTracks : stream?.getVideoTracks?.() || [];
      if (!tracks.length || tracks.every((track) => track.readyState === "ended")) return stream;
      const videoTracks = stream?.getVideoTracks?.() || [];
      const capture = { tracks, videoTracks, checkEnded: null };
      capture.checkEnded = () => {
        const primaryTracks = videoTracks.length ? videoTracks : tracks;
        if (primaryTracks.every((track) => track.readyState === "ended")) removeCapture(capture);
      };
      captures.add(capture);
      for (const track of tracks) track.addEventListener?.("ended", capture.checkEnded);
      if (captureTimer === null) captureTimer = setInterval(() => {
        for (const current of captures) current.checkEnded();
      }, 250);
      emit(true);
      return stream;
    };
    owner[HOOK_KEY] = wrapped;
    owner.getDisplayMedia = wrapped;
    return () => {
      if (disposed) return;
      disposed = true;
      stopPolling();
      for (const capture of captures) {
        for (const track of capture.tracks) track.removeEventListener?.("ended", capture.checkEnded);
      }
      captures.clear();
      if (owner.getDisplayMedia === wrapped) owner.getDisplayMedia = original;
      if (owner[HOOK_KEY] === wrapped) delete owner[HOOK_KEY];
    };
  }

  // src/shared/audio.js
  function readAudioParam(param, fallback = 1) {
    const value = Number(param?.value);
    return Number.isFinite(value) ? value : fallback;
  }
  var gainSchedules = /* @__PURE__ */ new WeakMap();
  var GAIN_RAMP_SECONDS = 0.01;
  function writeAudioParam(param, value, { context, immediate = true } = {}) {
    if (!param) return false;
    const safe = Number.isFinite(value) ? Math.max(0, value) : 1;
    const now = Number.isFinite(context?.currentTime) ? context.currentTime : 0;
    const previous = gainSchedules.get(param);
    if (!immediate && previous?.target === safe) return true;
    const current = previous ? previous.from + (previous.target - previous.from) * Math.min(1, Math.max(0, (now - previous.start) / GAIN_RAMP_SECONDS)) : readAudioParam(param);
    try {
      if (immediate || !context) {
        param.cancelScheduledValues?.(0);
        param.setValueAtTime(safe, now);
        gainSchedules.set(param, { from: safe, target: safe, start: now });
      } else {
        try {
          if (typeof param.cancelAndHoldAtTime !== "function") throw new Error("No hold API");
          param.cancelAndHoldAtTime(now);
        } catch {
          param.cancelScheduledValues?.(0);
        }
        param.setValueAtTime(current, now);
        param.linearRampToValueAtTime(safe, now + GAIN_RAMP_SECONDS);
        gainSchedules.set(param, { from: current, target: safe, start: now });
      }
      return true;
    } catch {
      try {
        param.cancelScheduledValues?.(0);
      } catch {
      }
      try {
        param.value = safe;
      } catch {
        return false;
      }
      gainSchedules.set(param, { from: safe, target: safe, start: now });
      return true;
    }
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

  // src/platforms/google-meet/levels.js
  var LEVEL_SAMPLE_MS = 100;
  var LEVEL_NOISE_FLOOR_DB = -55;
  var LEVEL_WARMUP_FRAMES = 30;
  var LEVEL_SETTLE_MS = 250;
  var LEVEL_WINDOW_FRAMES = 300;
  var AUTO_HORIZON_MS = 18e4;
  var AUTO_MAX_FRAMES = 120;
  var AUTO_MAX_STANDARD_ERROR_DB = 1.5;
  var AUTO_MAX_SPREAD_DB = 2 * 1.96 * AUTO_MAX_STANDARD_ERROR_DB;
  function median(values) {
    if (!values.length) return NaN;
    const sorted = [...values].sort((a, b) => a - b), middle = sorted.length >> 1;
    return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
  }
  function weightedMedian(portions) {
    const ordered = [...portions].sort((a, b) => a.db - b.db);
    const total = ordered.reduce((sum, p) => sum + p.support, 0);
    let cumulative = 0;
    for (let i = 0; i < ordered.length; i++) {
      cumulative += ordered[i].support;
      if (cumulative < total / 2) continue;
      return cumulative === total / 2 && ordered[i + 1] ? (ordered[i].db + ordered[i + 1].db) / 2 : ordered[i].db;
    }
    return NaN;
  }
  function meanSquare(buffer) {
    if (!buffer?.length) return 0;
    let sum = 0;
    for (let index = 0; index < buffer.length; index++) sum += buffer[index] * buffer[index];
    return sum / buffer.length;
  }
  function powerToDb(power) {
    return Number.isFinite(power) && power > 0 ? 10 * Math.log10(power) : -Infinity;
  }
  function sumTapPower(slots) {
    const meter = slots?.[0]?.audibleMeter;
    if (!meter || !slots.every((slot) => slot.audibleMeter === meter)) return NaN;
    return meter.read(slots);
  }
  function sumPipelinePower(pipelines) {
    let power = 0;
    for (const pipeline of pipelines || []) {
      const rms = Number(pipeline?.rms);
      if (Number.isFinite(rms) && rms > 0) power += rms * rms;
    }
    return power;
  }
  function attributeLevelSample({ available, speakers, routingState, appliedParticipantKey, localPresentationActive } = {}) {
    if (available !== true || localPresentationActive) return null;
    if (!Array.isArray(speakers) || speakers.length !== 1) return null;
    const key = speakers[0]?.key;
    if (!key || routingState !== "confirmed-speaker" || appliedParticipantKey !== key) return null;
    return key;
  }
  function createTypicalLevelEstimator({ warmupFrames = LEVEL_WARMUP_FRAMES, window = LEVEL_WINDOW_FRAMES } = {}) {
    if (!(window >= 1)) throw new RangeError("window must be positive");
    const ring = new Float64Array(window);
    const scratch = new Float64Array(window);
    let next = 0, size = 0, total = 0, cached = null;
    return {
      add(db) {
        if (!Number.isFinite(db)) return;
        ring[next] = db;
        next = (next + 1) % window;
        size = Math.min(size + 1, window);
        total++;
        cached = null;
      },
      get frames() {
        return total;
      },
      get typicalDb() {
        if (total < warmupFrames || !size) return null;
        if (cached === null) {
          const sorted = scratch.subarray(0, size);
          sorted.set(ring.subarray(0, size));
          sorted.sort();
          const middle = size >> 1;
          cached = size % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
        }
        return cached;
      }
    };
  }
  function createParticipantLevelMeter({
    sampleMs = LEVEL_SAMPLE_MS,
    noiseFloorDb = LEVEL_NOISE_FLOOR_DB,
    warmupFrames = LEVEL_WARMUP_FRAMES,
    settleMs = LEVEL_SETTLE_MS,
    window = LEVEL_WINDOW_FRAMES
  } = {}) {
    const estimators = /* @__PURE__ */ new Map();
    const recent = /* @__PURE__ */ new Map();
    const openPortions = /* @__PURE__ */ new Map();
    function closePortion(key) {
      const portion = openPortions.get(key);
      if (portion) portion.closed = true;
      openPortions.delete(key);
    }
    let clock = 0;
    let lastSampleAt = -Infinity;
    let settleKey = null;
    let settleSince = 0;
    let live = null;
    function prune(participantKeys) {
      if (!estimators.size) return;
      const present = participantKeys instanceof Set ? participantKeys : new Set(participantKeys || []);
      for (const key of estimators.keys()) if (!present.has(key)) estimators.delete(key);
      for (const key of recent.keys()) if (!present.has(key)) {
        recent.delete(key);
        openPortions.delete(key);
      }
      if (live && !present.has(live.key)) live = null;
    }
    function tick({ now, participantKeys, attributedKey = null, readPower }) {
      if (now < clock) reset();
      clock = now;
      prune(participantKeys);
      if (attributedKey !== settleKey) {
        closePortion(settleKey);
        settleKey = attributedKey;
        settleSince = now;
      }
      if (!attributedKey || live?.key !== attributedKey) live = null;
      if (now - lastSampleAt < sampleMs) return false;
      lastSampleAt = now;
      live = null;
      if (!attributedKey || now - settleSince < settleMs) return false;
      const db = powerToDb(readPower());
      if (!(db >= noiseFloorDb)) {
        closePortion(attributedKey);
        return false;
      }
      live = { key: attributedKey, db: Math.min(db, 0) };
      let estimator = estimators.get(attributedKey);
      if (!estimator) estimators.set(attributedKey, estimator = createTypicalLevelEstimator({ warmupFrames, window }));
      estimator.add(live.db);
      let frames = recent.get(attributedKey) || [];
      frames = frames.filter((frame) => now - frame.at <= AUTO_HORIZON_MS);
      let portion = openPortions.get(attributedKey);
      if (portion && now - portion.until > 350) {
        closePortion(attributedKey);
        portion = null;
      }
      if (!portion) {
        portion = { since: now, until: now, support: 0, count: 0, closed: false };
        openPortions.set(attributedKey, portion);
      }
      portion.support += Math.min(250, now - portion.until);
      portion.until = now;
      portion.count++;
      frames.push({ at: now, db: live.db, portion });
      if (now - portion.since >= 1900) closePortion(attributedKey);
      if (frames.length > AUTO_MAX_FRAMES) frames.shift();
      recent.set(attributedKey, frames);
      return true;
    }
    function levelFor(key, { since = -Infinity } = {}) {
      const estimator = estimators.get(key);
      const frames = (recent.get(key) || []).filter((frame) => clock - frame.at <= AUTO_HORIZON_MS && frame.at >= since);
      const groups = /* @__PURE__ */ new Map();
      for (const frame of frames) {
        if (!groups.has(frame.portion)) groups.set(frame.portion, []);
        groups.get(frame.portion).push(frame.db);
      }
      const portions = [];
      for (const [portion, values] of groups) {
        const support2 = portion.support;
        if (!portion.closed || values.length !== portion.count || values.length < 3 || support2 < 600) continue;
        values.sort((a, b) => a - b);
        const trim = Math.floor(values.length / 10);
        const core = values.slice(trim, values.length - trim);
        portions.push({
          db: core.reduce((sum, db) => sum + db, 0) / core.length,
          support: support2,
          count: values.length
        });
      }
      const center0 = weightedMedian(portions);
      const scale0 = Math.max(2, 1.4826 * median(portions.map((p) => Math.abs(p.db - center0))));
      const totalSupport = portions.reduce((sum, p) => sum + p.support, 0);
      const typical = portions.filter((p) => Math.abs(p.db - center0) <= 3 * scale0);
      const agreeing2 = typical.reduce((sum, p) => sum + p.support, 0) * 4 >= totalSupport * 3 ? typical : portions;
      const support = agreeing2.reduce((sum, p) => sum + p.support, 0);
      const inlierFrames = agreeing2.reduce((sum, p) => sum + p.count, 0);
      const center = support > 0 ? agreeing2.reduce((sum, p) => sum + p.db * p.support, 0) / support : NaN;
      const variance = agreeing2.length > 1 ? agreeing2.reduce((sum, p) => sum + (p.db - center) ** 2, 0) / (agreeing2.length - 1) : Infinity;
      const standardError = Math.sqrt(variance / agreeing2.length);
      const ready = agreeing2.length >= 3 && inlierFrames >= 24 && support >= 6e3 && Number.isFinite(center) && standardError <= AUTO_MAX_STANDARD_ERROR_DB;
      const autoDb = ready ? center : null;
      return {
        liveDb: live?.key === key ? live.db : null,
        typicalDb: estimator ? estimator.typicalDb : null,
        frames: estimator ? estimator.frames : 0,
        // Reported spread is the 95% interval width of the level estimate.
        autoDb,
        autoSpread: ready ? 2 * 1.96 * standardError : Infinity,
        // False while the newest completed portion is excluded as an outlier:
        // a sustained change starts as outliers, so the stale level must not act.
        autoLatestAgrees: ready && agreeing2.includes(portions.at(-1)),
        autoSupportMs: support,
        autoInlierFrames: inlierFrames,
        autoInlierPortions: agreeing2.length,
        autoPortions: portions.length,
        autoFrames: frames.length,
        autoSince: frames[0]?.at ?? null,
        sampledAt: frames.at(-1)?.at ?? null
      };
    }
    function reset() {
      estimators.clear();
      recent.clear();
      openPortions.clear();
      live = null;
      settleKey = null;
      settleSince = 0;
      lastSampleAt = -Infinity;
    }
    return { tick, levelFor, reset };
  }

  // src/platforms/google-meet/audible-meter.js
  function createAudibleMeter({ mappings, connect, disconnect }) {
    const edges = [], automated = /* @__PURE__ */ new WeakSet();
    let revision = 0, overflow = false, probe = null, stable = null, nativeSignature = null, contractActive = false;
    let continuity = {}, reason = "unverified", ownership = [], positiveNative = false;
    const type = (node) => node?.constructor?.name;
    const restores = [], newSources = /* @__PURE__ */ new WeakSet(), newGains = /* @__PURE__ */ new WeakSet();
    const Gain = globalThis.GainNode;
    if (typeof Gain === "function") {
      const wrapper = new Proxy(Gain, { construct(target, args, newTarget) {
        const node = Reflect.construct(target, args, newTarget);
        newGains.add(node);
        return node;
      } });
      try {
        globalThis.GainNode = wrapper;
        restores.push(() => {
          if (globalThis.GainNode === wrapper) globalThis.GainNode = Gain;
        });
      } catch {
        overflow = true;
      }
    }
    const Worklet = globalThis.AudioWorkletNode;
    if (typeof Worklet === "function") {
      const wrapper = new Proxy(Worklet, { construct(target, args, newTarget) {
        const node = Reflect.construct(target, args, newTarget);
        newSources.add(node);
        return node;
      } });
      try {
        globalThis.AudioWorkletNode = wrapper;
        restores.push(() => {
          if (globalThis.AudioWorkletNode === wrapper) globalThis.AudioWorkletNode = Worklet;
        });
      } catch {
        overflow = true;
      }
    }
    for (const Context of [globalThis.BaseAudioContext, globalThis.AudioContext, globalThis.OfflineAudioContext]) {
      const proto = Context?.prototype;
      if (!proto || !Object.hasOwn(proto, "createGain")) continue;
      const original = proto.createGain;
      const wrapper = function(...args) {
        const node = original.apply(this, args);
        newGains.add(node);
        return node;
      };
      try {
        proto.createGain = wrapper;
        restores.push(() => {
          if (proto.createGain === wrapper) proto.createGain = original;
        });
      } catch {
        overflow = true;
      }
    }
    for (const name of ["setValueAtTime", "linearRampToValueAtTime", "exponentialRampToValueAtTime", "setTargetAtTime", "setValueCurveAtTime"]) {
      const proto = globalThis.AudioParam?.prototype, original = proto?.[name];
      if (typeof original !== "function") continue;
      const wrapper = function(...args) {
        const result = original.apply(this, args);
        automated.add(this);
        return result;
      };
      try {
        proto[name] = wrapper;
        restores.push(() => {
          if (proto[name] === wrapper) proto[name] = original;
        });
      } catch {
        overflow = true;
      }
    }
    function clearProbe() {
      if (!probe) return;
      for (const node of probe.terminals) {
        try {
          disconnect.call(node, probe.bus);
        } catch {
        }
      }
      try {
        disconnect.call(probe.bus);
      } catch {
      }
      try {
        disconnect.call(probe.splitter);
      } catch {
      }
      probe = null;
    }
    function changed() {
      continuity = {};
      reason = "unverified";
      revision++;
      stable = null;
      clearProbe();
    }
    function nativeChanged(compatible) {
      if (!compatible) {
        changed();
        return;
      }
      revision++;
      reason = "static-native-gain";
      stable = null;
      clearProbe();
    }
    function unavailable() {
      if (contractActive) {
        contractActive = false;
        changed();
      }
      return NaN;
    }
    function connected(source, args) {
      const [destination, output = 0, input = 0] = args;
      if (edges.some((e) => e.source === source && e.destination === destination && e.output === output && e.input === input)) return;
      if (edges.length >= 1024) {
        overflow = true;
        changed();
        return;
      }
      edges.push({ source, destination, output, input });
      changed();
    }
    function disconnected(source, args) {
      for (let i = edges.length - 1; i >= 0; i--) {
        const e = edges[i];
        if (e.source !== source) continue;
        if (args.length && (typeof args[0] === "number" ? e.output !== args[0] : e.destination !== args[0] || args.length > 1 && e.output !== args[1] || args.length > 2 && e.input !== args[2])) continue;
        edges.splice(i, 1);
      }
      changed();
    }
    function read(slots) {
      const active = mappings();
      if (overflow || !active.length || slots.length !== active.length) return unavailable();
      const context = active[0].booster.context;
      if (!context?.createChannelSplitter || active.some((m) => m.booster.context !== context)) return unavailable();
      const document2 = globalThis.document;
      const elements = document2?.querySelectorAll ? [...document2.querySelectorAll("audio,video")] : [document2?.querySelector?.("audio,video")].filter(Boolean);
      const externalPlayback = elements.some((element) => {
        if (typeof element?.getAttribute !== "function") return true;
        const stream = element.srcObject;
        if (typeof globalThis.MediaStream === "function" && stream instanceof globalThis.MediaStream) {
          return stream.getAudioTracks().length !== 0;
        }
        return !!(stream || element.currentSrc || element.getAttribute?.("src"));
      });
      if (externalPlayback) return unavailable();
      const gains = /* @__PURE__ */ new Set(), terminals = /* @__PURE__ */ new Set(), visiting = /* @__PURE__ */ new Set();
      let valid = true;
      function walk(node) {
        if (visiting.has(node) || type(node) !== "GainNode" || !newGains.has(node) || node.context !== context || gains.size > 128) {
          valid = false;
          return;
        }
        if (gains.has(node)) return;
        gains.add(node);
        visiting.add(node);
        const outgoing = edges.filter((e) => e.source === node);
        if (!outgoing.length) valid = false;
        for (const e of outgoing) {
          if (e.output !== 0 || e.input !== 0) {
            valid = false;
            continue;
          }
          if (e.destination === context.destination) terminals.add(node);
          else if (type(e.destination) === "GainNode") walk(e.destination);
          else valid = false;
        }
        visiting.delete(node);
      }
      for (const m of active) {
        if (m.input !== 0 || !newSources.has(m.source) || m.source.context !== context) valid = false;
        walk(m.destination);
        if (edges.some((e) => e.destination === m.source)) valid = false;
        for (const e of edges.filter((e2) => e2.source === m.source)) {
          if (!active.some((a) => a.source === e.source && a.destination === e.destination && a.output === e.output && a.input === e.input) && type(e.destination) !== "MediaStreamAudioDestinationNode") valid = false;
        }
      }
      for (const e of edges) if (gains.has(e.destination) && !gains.has(e.source) && !active.some((m) => m.source === e.source && m.destination === e.destination && m.output === e.output && m.input === e.input)) valid = false;
      const multiplier = slots[0].actualValue;
      if (!(multiplier > 0) || slots.some((s) => Math.abs(s.actualValue - multiplier) > 1e-5 || Math.abs(s.targetValue - multiplier) > 1e-5)) valid = false;
      for (const gain of gains) if (automated.has(gain.gain) || !Number.isFinite(gain.gain.value) || edges.some((e) => e.destination === gain.gain)) valid = false;
      if (!valid || !terminals.size) {
        stable = null;
        clearProbe();
        return unavailable();
      }
      const channelContract = [];
      for (const node of /* @__PURE__ */ new Set([context.destination, ...active.map((m) => m.source), ...gains])) {
        const { channelCount, channelCountMode, channelInterpretation } = node;
        if (!Number.isInteger(channelCount) || channelCount < 1 || channelCount > 32 || !["max", "clamped-max", "explicit"].includes(channelCountMode) || !["speakers", "discrete"].includes(channelInterpretation)) return unavailable();
        channelContract.push(node, channelCount, channelCountMode, channelInterpretation);
      }
      const nextOwnership = [
        context,
        ...channelContract,
        ...slots,
        ...active.flatMap((m) => [m.source, m.destination, m.booster, m.output, m.input]),
        ...gains,
        ...terminals
      ];
      if (nextOwnership.length !== ownership.length || nextOwnership.some((v, i) => v !== ownership[i])) {
        ownership = nextOwnership;
        changed();
      }
      if (!contractActive) {
        contractActive = true;
        changed();
      }
      const nextNative = [...gains].map((g) => g.gain.value).join(":");
      const nextPositive = [...gains].every((g) => g.gain.value > 0);
      if (nativeSignature !== nextNative) {
        nativeSignature = nextNative;
        nativeChanged(positiveNative && nextPositive);
      }
      positiveNative = nextPositive;
      const signature = [revision, multiplier, nextNative].join(":");
      const now = context.currentTime;
      if (!stable || stable.signature !== signature) {
        stable = { signature, at: now };
        return NaN;
      }
      if (now - stable.at < 0.1) return NaN;
      if (!probe) {
        try {
          const channels = context.destination.channelCount;
          if (!(channels >= 1 && channels <= 8)) return unavailable();
          const bus = context.createGain(), splitter = context.createChannelSplitter(channels);
          bus.channelCount = channels;
          bus.channelCountMode = "explicit";
          connect.call(bus, splitter);
          const analysers = Array.from({ length: channels }, (_, i) => {
            const analyser = context.createAnalyser();
            analyser.fftSize = 2048;
            connect.call(splitter, analyser, i);
            return { analyser, buffer: new Float32Array(2048) };
          });
          probe = { bus, splitter, analysers, terminals: [...terminals], at: now };
          for (const node of terminals) connect.call(node, bus);
        } catch {
          clearProbe();
          return unavailable();
        }
        return NaN;
      }
      if (now - probe.at < 0.1) return NaN;
      let power = 0;
      for (const { analyser, buffer } of probe.analysers) {
        analyser.getFloatTimeDomainData(buffer);
        power += meanSquare(buffer);
      }
      const normalized = power / (multiplier * multiplier);
      return Number.isFinite(normalized) ? normalized : unavailable();
    }
    return {
      connected,
      disconnected,
      read(slots) {
        try {
          return read(slots);
        } catch {
          return unavailable();
        }
      },
      changed,
      get generation() {
        return revision;
      },
      get continuity() {
        return { token: continuity, reason, generation: revision };
      },
      dispose() {
        contractActive = false;
        changed();
        for (const restore of restores.reverse()) restore();
        edges.length = 0;
      }
    };
  }

  // src/platforms/google-meet/audio-worklet.js
  var TAP_FFT_SIZE = 2048;
  function createSourceTap(source, output, context, connect, disconnect) {
    if (typeof context?.createAnalyser !== "function") return null;
    let analyser;
    try {
      analyser = context.createAnalyser();
      analyser.fftSize = TAP_FFT_SIZE;
      connect.call(source, analyser, output);
    } catch {
      return null;
    }
    const buffer = new Float32Array(analyser.fftSize || TAP_FFT_SIZE);
    let connected = true;
    return {
      analyser,
      buffer,
      readMeanSquare() {
        if (!connected) return 0;
        try {
          analyser.getFloatTimeDomainData(buffer);
        } catch {
          return 0;
        }
        return meanSquare(buffer);
      },
      disconnect() {
        if (!connected) return;
        connected = false;
        try {
          disconnect.call(source, analyser, output, 0);
        } catch {
        }
      }
    };
  }
  function normalizeIndex(value) {
    return value === void 0 ? 0 : value;
  }
  function connectionMatches(mapping, args) {
    if (!args.length) return true;
    if (typeof args[0] === "number") return mapping.output === args[0];
    if (args[0] !== mapping.destination) return false;
    if (args.length > 1 && mapping.output !== normalizeIndex(args[1])) return false;
    if (args.length > 2 && mapping.input !== normalizeIndex(args[2])) return false;
    return true;
  }
  function installAudioWorkletHook(onSlot, onRemove = () => {
  }) {
    if (!globalThis.AudioNode || globalThis.__meetingAudioBoosterWorkletHook) return () => {
    };
    const originalConnect = AudioNode.prototype.connect;
    const originalDisconnect = AudioNode.prototype.disconnect;
    const mappings = [];
    let disposed = false;
    const meter = createAudibleMeter({ mappings: () => mappings, connect: originalConnect, disconnect: originalDisconnect });
    const connectWrapper = function(...args) {
      if (disposed) return originalConnect.apply(this, args);
      const destination = args[0];
      const isPooledConnection = this?.constructor?.name === "AudioWorkletNode" && destination?.constructor?.name === "GainNode";
      if (!isPooledConnection || typeof destination?.context?.createGain !== "function") {
        const result = originalConnect.apply(this, args);
        meter.connected(this, args);
        return result;
      }
      const output = normalizeIndex(args[1]);
      const input = normalizeIndex(args[2]);
      const existing = mappings.find((item) => item.source === this && item.destination === destination && item.output === output && item.input === input);
      if (existing) return destination;
      let removedDirect = false;
      try {
        originalDisconnect.call(this, destination, output, input);
        removedDirect = true;
      } catch (error) {
        if (error?.name !== "InvalidAccessError") throw error;
      }
      let booster;
      let sourceConnected = false;
      try {
        booster = destination.context.createGain();
        booster.gain.value = 1;
        const sourceArgs = args.length > 1 ? [booster, args[1]] : [booster];
        const destinationArgs = args.length > 2 ? [destination, 0, args[2]] : [destination];
        originalConnect.apply(this, sourceArgs);
        sourceConnected = true;
        originalConnect.apply(booster, destinationArgs);
      } catch (error) {
        if (sourceConnected) {
          try {
            originalDisconnect.call(this, booster, output, 0);
          } catch {
          }
        }
        if (removedDirect) {
          try {
            originalConnect.apply(this, args);
          } catch {
          }
        }
        throw error;
      }
      const tap = createSourceTap(this, output, destination.context, originalConnect, originalDisconnect);
      if (tap) tap.audibleMeter = meter;
      mappings.push({ source: this, destination, booster, output, input, tap, originalArgs: [...args] });
      meter.connected(this, args);
      try {
        onSlot(booster, tap, meter);
      } catch {
      }
      return destination;
    };
    const disconnectWrapper = function(...args) {
      if (disposed) return originalDisconnect.apply(this, args);
      const matched = mappings.filter((mapping) => mapping.source === this && connectionMatches(mapping, args));
      if (!matched.length) {
        const result = originalDisconnect.apply(this, args);
        meter.disconnected(this, args);
        return result;
      }
      let nativeError = null;
      if (!args.length || typeof args[0] === "number") originalDisconnect.apply(this, args);
      else {
        try {
          originalDisconnect.apply(this, args);
        } catch (error) {
          nativeError = error;
        }
        for (const mapping of matched) {
          try {
            originalDisconnect.call(this, mapping.booster, mapping.output, 0);
          } catch {
          }
        }
      }
      for (const mapping of matched) {
        try {
          originalDisconnect.call(mapping.booster, mapping.destination, 0, mapping.input);
        } catch {
        }
        mapping.tap?.disconnect();
        const index = mappings.indexOf(mapping);
        if (index >= 0) mappings.splice(index, 1);
        try {
          onRemove(mapping.booster);
        } catch {
        }
      }
      if (nativeError && nativeError.name !== "InvalidAccessError") throw nativeError;
      meter.disconnected(this, args);
    };
    AudioNode.prototype.connect = connectWrapper;
    AudioNode.prototype.disconnect = disconnectWrapper;
    globalThis.__meetingAudioBoosterWorkletHook = { originalConnect, originalDisconnect };
    return () => {
      if (disposed) return;
      disposed = true;
      meter.dispose();
      for (const mapping of [...mappings]) {
        try {
          writeAudioParam(mapping.booster.gain, 1, { context: mapping.booster.context });
        } catch {
        }
        let restored = false;
        try {
          originalConnect.apply(mapping.source, mapping.originalArgs);
          restored = true;
        } catch {
        }
        if (restored) {
          try {
            originalDisconnect.call(mapping.source, mapping.booster, mapping.output, 0);
          } catch {
          }
          try {
            originalDisconnect.call(mapping.booster, mapping.destination, 0, mapping.input);
          } catch {
          }
          try {
            onRemove(mapping.booster);
          } catch {
          }
        }
        mapping.tap?.disconnect();
      }
      mappings.length = 0;
      if (AudioNode.prototype.connect === connectWrapper) AudioNode.prototype.connect = originalConnect;
      if (AudioNode.prototype.disconnect === disconnectWrapper) AudioNode.prototype.disconnect = originalDisconnect;
      delete globalThis.__meetingAudioBoosterWorkletHook;
    };
  }
  function createPooledSlot(gain, id, tap = null, audibleMeter = tap?.audibleMeter ?? null) {
    const baseGain = readAudioParam(gain.gain);
    let neutralized = true;
    return {
      id,
      gain,
      baseGain,
      nativeValue: baseGain,
      appliedMultiplier: 1,
      targetValue: baseGain,
      participantKey: null,
      tap,
      audibleMeter,
      get actualValue() {
        return readAudioParam(gain.gain);
      },
      set(multiplier, immediate = false) {
        const safe = Number.isFinite(multiplier) ? Math.max(0, multiplier) : 1;
        if (safe === this.appliedMultiplier && !immediate) return;
        writeAudioParam(gain.gain, safe, { context: gain.context, immediate });
        neutralized = immediate && safe === 1;
        this.appliedMultiplier = safe;
        this.targetValue = safe;
        this.participantKey = null;
      },
      release() {
        if (neutralized) return;
        writeAudioParam(gain.gain, 1, { context: gain.context });
        neutralized = true;
        this.appliedMultiplier = 1;
        this.targetValue = 1;
        this.participantKey = null;
      },
      neutral() {
        this.release();
      },
      destroy() {
        this.release();
        tap?.disconnect();
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
  function createMediaElementPipeline(context, audio, id, accepts = () => true, onRelease = () => {
  }) {
    const stream = audio.srcObject;
    const tracks = [...stream?.getAudioTracks?.() || []];
    if (!accepts(stream) || !tracks.length || tracks.some((track) => track.readyState === "ended")) return null;
    let destroyed = false;
    function eligible() {
      for (const element of [...pipeline.elements]) {
        if (element.srcObject !== stream || element.isConnected === false) pipeline.releaseElement(element);
      }
      const current = stream?.getAudioTracks?.() || [];
      return !destroyed && pipeline.elements.size > 0 && accepts(stream) && current.length === tracks.length && tracks.every((track) => track.readyState !== "ended" && current.includes(track));
    }
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
      eligible,
      sample() {
        if (!eligible()) {
          this.destroy();
          return this;
        }
        Object.assign(this, analyser.sample());
        return this;
      },
      activate() {
        if (!eligible()) {
          this.destroy();
          return false;
        }
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
        writeAudioParam(gain.gain, 1, { context });
        this.appliedMultiplier = 1;
        this.targetValue = 1;
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
        onRelease(element);
      },
      set(multiplier, immediate = false) {
        if (!eligible()) {
          this.destroy();
          return;
        }
        const safe = Number.isFinite(multiplier) ? Math.max(0, multiplier) : 1;
        this.appliedMultiplier = safe;
        this.targetValue = safe;
        if ((this.connected || immediate) && this.activate()) writeAudioParam(gain.gain, safe, { context, immediate: immediate && safe === 1 });
      },
      destroy() {
        if (destroyed) return;
        destroyed = true;
        this.rms = 0;
        this.activeByEnergy = false;
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
  })(), accepts = () => true } = {}) {
    let pipelines = [];
    let hasAudio = false;
    const byElement = /* @__PURE__ */ new WeakMap();
    function prune() {
      for (const pipeline of [...pipelines]) if (!pipeline.eligible()) remove(pipeline);
    }
    function scan(root = document) {
      prune();
      hasAudio = false;
      const seen = /* @__PURE__ */ new Set();
      for (const audio of root.querySelectorAll?.("audio") || []) {
        const stream = audio.srcObject;
        const tracks = stream?.getAudioTracks?.() || [];
        if (tracks.some((track) => track.readyState !== "ended")) hasAudio = true;
        if (!accepts(stream) || !tracks.length || tracks.some((track) => track.readyState === "ended")) {
          const previous2 = byElement.get(audio);
          if (previous2) {
            previous2.releaseElement(audio);
            byElement.delete(audio);
          }
          continue;
        }
        const key = mediaStreamKey(stream);
        seen.add(key);
        const previous = byElement.get(audio);
        if (previous?.stream === stream && previous.elements.has(audio)) continue;
        if (previous) {
          previous.releaseElement(audio);
          byElement.delete(audio);
        }
        let pipeline = pipelines.find((item) => item.stream === stream);
        if (!pipeline) {
          pipeline = createMediaElementPipeline(context, audio, nextId(), accepts, (element) => byElement.delete(element));
          if (!pipeline) continue;
          pipelines.push(pipeline);
        } else pipeline.elements.add(audio);
        byElement.set(audio, pipeline);
        if (pipeline.connected) pipeline.activate();
      }
      for (const pipeline of [...pipelines]) {
        for (const element of [...pipeline.elements]) {
          if (!element.isConnected || element.srcObject !== pipeline.stream || !accepts(element.srcObject)) {
            pipeline.releaseElement(element);
            byElement.delete(element);
          }
        }
        const live = pipeline.tracks.some((track) => track.readyState !== "ended");
        if (!seen.has(pipeline.streamKey) || !pipeline.elements.size || !live) remove(pipeline);
      }
      return pipelines;
    }
    function remove(pipeline) {
      for (const element of pipeline.elements) byElement.delete(element);
      pipeline.destroy();
      pipelines = pipelines.filter((item) => item !== pipeline);
    }
    function destroy() {
      for (const pipeline of [...pipelines]) remove(pipeline);
    }
    return { scan, prune, destroy, get hasAudio() {
      return hasAudio;
    }, get pipelines() {
      return pipelines;
    } };
  }

  // src/platforms/google-meet/media-ownership.js
  function installRemoteMediaOwnership(scope = globalThis) {
    const peers = /* @__PURE__ */ new Set();
    const parents = /* @__PURE__ */ new WeakMap();
    const origins = /* @__PURE__ */ new WeakMap();
    const restores = [];
    let disposed = false;
    const pcPrototype = scope.RTCPeerConnection?.prototype;
    const trackPrototype = scope.MediaStreamTrack?.prototype;
    const getReceivers = pcPrototype?.getReceivers;
    function observe(peer) {
      if (!disposed) peers.add(peer);
    }
    function wrap(owner, name, factory) {
      if (!owner || typeof owner[name] !== "function") return;
      const original = owner[name];
      const wrapped = factory(original);
      try {
        owner[name] = wrapped;
        if (owner[name] === wrapped) restores.push(() => {
          if (owner[name] === wrapped) owner[name] = original;
        });
      } catch {
      }
    }
    wrap(pcPrototype, "setRemoteDescription", (original) => function(...args) {
      observe(this);
      return original.apply(this, args);
    });
    wrap(trackPrototype, "clone", (original) => function(...args) {
      const clone = original.apply(this, args);
      if (!disposed) parents.set(clone, this);
      return clone;
    });
    function refresh() {
      if (disposed || typeof getReceivers !== "function") return;
      for (const peer of peers) {
        if (peer.connectionState === "closed" || peer.signalingState === "closed") {
          peers.delete(peer);
          continue;
        }
        try {
          for (const receiver of getReceivers.call(peer)) {
            if (receiver.track?.kind === "audio") origins.set(receiver.track, peer);
          }
        } catch {
        }
      }
    }
    function remote(track) {
      if (disposed || track?.kind !== "audio" || track.readyState !== "live") return false;
      const seen = /* @__PURE__ */ new Set();
      for (let current = track; current && !seen.has(current); current = parents.get(current)) {
        if (current.readyState !== "live") return false;
        seen.add(current);
        const peer = origins.get(current);
        if (!peer || !peers.has(peer) || peer.connectionState === "closed" || peer.signalingState === "closed") continue;
        try {
          if (getReceivers.call(peer).some((receiver) => receiver.track === current)) return true;
        } catch {
        }
      }
      return false;
    }
    return {
      refresh,
      accepts(stream) {
        const tracks = stream?.getAudioTracks?.() || [];
        return tracks.length > 0 && tracks.every(remote);
      },
      dispose() {
        disposed = true;
        peers.clear();
        for (const restore of restores.reverse()) {
          try {
            restore();
          } catch {
          }
        }
      }
    };
  }

  // src/platforms/google-meet/membership.js
  var MAX_MEMBERS = 2048;
  var MAX_FIELDS = 64;
  var DISCOVERY_SAMPLE = 32;
  var ENTRIES_PER_TICK = 128;
  var FULL_SCAN_MS = 250;
  var MISMATCH_MS = 1e3;
  var mapSize = Object.getOwnPropertyDescriptor(Map.prototype, "size").get;
  var mapKeys = Map.prototype.keys;
  var mapEntries = Map.prototype.entries;
  var mapGet = Map.prototype.get;
  var mapHas = Map.prototype.has;
  function isObjectValue(value) {
    return value !== null && typeof value === "object";
  }
  function isLive(model) {
    try {
      return model.isDisposed() === false;
    } catch {
      return false;
    }
  }
  function isMembershipShaped(map) {
    try {
      const size = mapSize.call(map);
      if (!(size >= 1 && size <= MAX_MEMBERS)) return false;
      for (const [key, value] of mapEntries.call(map)) {
        if (typeof key !== "string" || !key || !isObjectValue(value)) return false;
      }
      return true;
    } catch {
      return false;
    }
  }
  function recordHoldsParticipant(record, id, isParticipantModel) {
    try {
      if (!isObjectValue(record)) return false;
      let found = 0;
      let fields = 0;
      for (const name in record) {
        if (++fields > MAX_FIELDS) return false;
        let descriptor;
        try {
          descriptor = Object.getOwnPropertyDescriptor(record, name);
        } catch {
          continue;
        }
        if (!descriptor || !("value" in descriptor) || !isObjectValue(descriptor.value)) continue;
        if (isParticipantModel(descriptor.value, id)) found++;
      }
      return found === 1;
    } catch {
      return false;
    }
  }
  function readKeys(map) {
    try {
      const size = mapSize.call(map);
      if (!(size >= 1 && size <= MAX_MEMBERS)) return null;
      const keys = [];
      for (const key of mapKeys.call(map)) {
        if (typeof key !== "string" || !key || keys.length >= MAX_MEMBERS) return null;
        keys.push(key);
      }
      return keys;
    } catch {
      return null;
    }
  }
  function validEntry(map, id, isParticipantModel) {
    try {
      return mapHas.call(map, id) && recordHoldsParticipant(mapGet.call(map, id), id, isParticipantModel);
    } catch {
      return false;
    }
  }
  function passesDiscovery(map, ids, isParticipantModel) {
    if (!ids.every((id) => validEntry(map, id, isParticipantModel))) return false;
    const sample = (readKeys(map) || []).slice(0, DISCOVERY_SAMPLE);
    return sample.length > 0 && sample.every((id) => validEntry(map, id, isParticipantModel));
  }
  function createMembershipTracker({ mismatchMs = MISMATCH_MS, entriesPerTick = ENTRIES_PER_TICK } = {}) {
    let map = null;
    let validated = /* @__PURE__ */ new Set();
    let complete = false;
    let mismatchSince = null;
    let anchors = [];
    let lastScan = -Infinity;
    let lastSize = -1;
    let scanOk = true;
    function drop() {
      map = null;
      validated = /* @__PURE__ */ new Set();
      complete = false;
      mismatchSince = null;
      anchors = [];
      lastScan = -Infinity;
      lastSize = -1;
      scanOk = true;
    }
    function adopt(candidate, tileModels) {
      drop();
      map = candidate;
      anchors = tileModels.slice(0, 64);
    }
    function finish({ state, members, reached }, ids, tileModels, isParticipantModel, discoveryIds = ids) {
      if (state !== "complete") return drop();
      if (!discoveryIds.length) {
        if (map && !reached.has(map)) drop();
        return;
      }
      const found = isParticipantModel ? members.filter((candidate) => discoveryIds.some((id) => validEntry(candidate, id, isParticipantModel)) && passesDiscovery(candidate, ids, isParticipantModel)) : [];
      if (found.length !== 1) return drop();
      if (found[0] !== map) adopt(found[0], tileModels);
    }
    function scan(now, levelValues, isParticipantModel) {
      const keys = readKeys(map);
      if (!keys) return false;
      const current = new Set(keys);
      for (const id of validated) if (!current.has(id)) validated.delete(id);
      if (isParticipantModel) {
        let checked = 0;
        for (const id of keys) {
          if (validated.has(id)) continue;
          if (checked++ >= entriesPerTick) break;
          if (!validEntry(map, id, isParticipantModel)) return false;
          validated.add(id);
        }
      }
      complete = validated.size === current.size;
      lastScan = now;
      lastSize = current.size;
      scanOk = !levelValues || keys.every((id) => levelValues.has(id));
      return true;
    }
    function update({ now, tileIds, levelValues, tileModels, isParticipantModel }) {
      if (!map) return;
      let size = -1;
      try {
        size = mapSize.call(map);
      } catch {
      }
      if (size !== lastSize || !complete || now - lastScan >= FULL_SCAN_MS) {
        if (!scan(now, levelValues, isParticipantModel)) return drop();
      }
      let covered = false;
      try {
        covered = tileIds.every((id) => mapHas.call(map, id));
      } catch {
      }
      const consistent = covered && scanOk;
      if (consistent) {
        mismatchSince = null;
        if (tileModels.length) anchors = [.../* @__PURE__ */ new Set([...tileModels, ...anchors.filter(isLive)])].slice(0, 64);
      } else {
        mismatchSince ??= now;
        if (now - mismatchSince > mismatchMs) return drop();
      }
      if (!tileIds.length && !tileModels.length && !anchors.some(isLive)) drop();
    }
    return {
      finish,
      update,
      reset: drop,
      get map() {
        return map;
      },
      get anchors() {
        return anchors.filter(isLive);
      },
      get trusted() {
        return Boolean(map && complete);
      },
      // Boolean membership answer only; never exposes the key set.
      has(id) {
        if (!map || !complete || typeof id !== "string") return false;
        try {
          return mapHas.call(map, id);
        } catch {
          return false;
        }
      }
    };
  }

  // src/platforms/google-meet/activity-registry.js
  var MAX_DEPTH = 4;
  var MAX_OBJECTS = 3e3;
  var MAX_KEYS_PER_OBJECT = 512;
  var MAX_MAP_SIZE = 2048;
  var MAX_VALUE = 5.5;
  var MAX_ANCHORS = 64;
  var MAX_CANDIDATES = 64;
  var DISCOVERY_MS = 1e3;
  var VERIFY_MS = 5e3;
  var MISMATCH_MS2 = 1e3;
  var SLICE_MS = 4;
  var MAX_SLICES = 5;
  var CLOCK_EVERY = 64;
  var mapSize2 = Object.getOwnPropertyDescriptor(Map.prototype, "size").get;
  var mapEntries2 = Map.prototype.entries;
  var mapHas2 = Map.prototype.has;
  var monotonic = typeof globalThis.performance?.now === "function" ? () => globalThis.performance.now() : () => Date.now();
  var wideObjects = /* @__PURE__ */ new WeakSet();
  function isMap(value) {
    try {
      return value instanceof Map && Number.isInteger(mapSize2.call(value));
    } catch {
      return false;
    }
  }
  function isSkipped(value) {
    try {
      if (value === globalThis || ArrayBuffer.isView(value)) return true;
      return typeof Node === "function" && value instanceof Node;
    } catch {
      return true;
    }
  }
  function readLevelRegistry(map) {
    try {
      const size = mapSize2.call(map);
      if (!(size >= 1 && size <= MAX_MAP_SIZE)) return null;
      const values = /* @__PURE__ */ new Map();
      for (const [key, value] of mapEntries2.call(map)) {
        if (typeof key !== "string" || !key || typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > MAX_VALUE) return null;
        values.set(key, value);
        if (values.size > MAX_MAP_SIZE) return null;
      }
      return values;
    } catch {
      return null;
    }
  }
  function registryStep(value) {
    return Math.floor(value);
  }
  function compareWithTiles(values, tileLevels) {
    let positive = false;
    for (const [id, level] of tileLevels) {
      const value = values.get(id);
      const step = Math.round(level * 5);
      if (value === void 0 || registryStep(value) !== step) return { ok: false, positive: false };
      if (step > 0) positive = true;
    }
    return { ok: tileLevels.size > 0, positive };
  }
  function ownDataValues(object) {
    const values = [];
    const push = (key) => {
      try {
        const descriptor = Object.getOwnPropertyDescriptor(object, key);
        if (descriptor && "value" in descriptor) values.push(descriptor.value);
      } catch {
      }
    };
    try {
      if (wideObjects.has(object)) return values;
      if (Array.isArray(object)) {
        const length = Object.getOwnPropertyDescriptor(object, "length")?.value;
        const count = Number.isInteger(length) ? Math.min(length, MAX_KEYS_PER_OBJECT) : 0;
        for (let index = 0; index < count; index++) push(index);
        return values;
      }
      const names = [];
      for (const name in object) {
        if (names.length >= MAX_KEYS_PER_OBJECT) {
          wideObjects.add(object);
          return values;
        }
        names.push(name);
      }
      for (const name of names) push(name);
    } catch {
    }
    return values;
  }
  function coversIds(map, ids) {
    try {
      return ids.every((id) => mapHas2.call(map, id));
    } catch {
      return false;
    }
  }
  function createRegistryWalk({ anchors, ids = [], discoveryIds = ids, target = null, targets = [target], clock = monotonic, sliceMs = SLICE_MS, maxSlices = MAX_SLICES }) {
    const visited = new Set(anchors);
    const queue = anchors.map((anchor) => [anchor, 0]);
    const candidates = /* @__PURE__ */ new Set();
    const members = /* @__PURE__ */ new Set();
    const wanted = new Set(targets.filter(Boolean));
    const reached = /* @__PURE__ */ new Set();
    let head = 0;
    let pending = null;
    let index = 0;
    let depth = 0;
    let slices = 0;
    let state = "running";
    function visit(value) {
      if (value === null || typeof value !== "object" || visited.has(value)) return 1;
      if (visited.size >= MAX_OBJECTS) {
        state = "complete";
        return 0;
      }
      visited.add(value);
      if (wanted.has(value)) reached.add(value);
      if (isSkipped(value)) return 1;
      if (isMap(value)) {
        if (!coversIds(value, ids)) return 1 + ids.length;
        if (readLevelRegistry(value)) {
          if (ids.length) candidates.add(value);
        } else if (discoveryIds.some((id) => mapHas2.call(value, id)) && isMembershipShaped(value)) members.add(value);
        else return 1 + mapSize2.call(value);
        if (candidates.size > MAX_CANDIDATES || members.size > MAX_CANDIDATES) state = "incomplete";
        return mapSize2.call(value);
      }
      if (depth + 1 < MAX_DEPTH) queue.push([value, depth + 1]);
      return 1;
    }
    function step() {
      if (state !== "running") return state;
      slices++;
      const start = clock();
      let work = 0;
      while (state === "running") {
        if (work >= CLOCK_EVERY) {
          work = 0;
          if (clock() - start >= sliceMs) {
            if (slices >= maxSlices) state = "incomplete";
            break;
          }
        }
        if (pending && index < pending.length) {
          work += visit(pending[index++]);
          continue;
        }
        if (head >= queue.length) {
          state = "complete";
          break;
        }
        const [object, objectDepth] = queue[head++];
        pending = ownDataValues(object);
        index = 0;
        depth = objectDepth;
        work = CLOCK_EVERY;
      }
      return state;
    }
    return { step, result: () => ({ state, candidates: [...candidates], members: [...members], reached, reachedTarget: reached.has(target) }) };
  }
  function isLive2(model) {
    try {
      return model.isDisposed() === false;
    } catch {
      return false;
    }
  }
  function agreeing(candidates, tileLevels) {
    return candidates.filter((candidate) => {
      const values = readLevelRegistry(candidate);
      return values && compareWithTiles(values, tileLevels).ok;
    });
  }
  function createActivityRegistry({ discoveryMs = DISCOVERY_MS, mismatchMs = MISMATCH_MS2, verifyMs = VERIFY_MS, clock = monotonic } = {}) {
    const membership = createMembershipTracker({ mismatchMs });
    let map = null;
    let trusted = false;
    let anchors = [];
    let mismatchSince = null;
    let lastDiscovery = -Infinity;
    let lastVerify = -Infinity;
    let walk = null;
    function drop() {
      map = null;
      trusted = false;
      anchors = [];
      mismatchSince = null;
    }
    function adopt(models) {
      anchors = [.../* @__PURE__ */ new Set([...models, ...anchors.filter(isLive2)])].slice(0, MAX_ANCHORS);
    }
    function trust(now) {
      if (!trusted) lastVerify = now;
      trusted = true;
    }
    function adoptUnique(found, now, tileLevels, tileModels) {
      drop();
      if (found.length !== 1) return;
      map = found[0];
      anchors = tileModels.slice(0, MAX_ANCHORS);
      const values = readLevelRegistry(map);
      if (values && compareWithTiles(values, tileLevels).positive) trust(now);
    }
    function finish({ purpose, target, run, ids }, now, tileLevels, tileModels, isParticipantModel, discoveryIds, discoveryModels) {
      const result = run.result();
      membership.finish(result, ids, [...tileModels, ...discoveryModels], isParticipantModel, discoveryIds);
      if (purpose === "members") return;
      const { state, candidates, reachedTarget } = result;
      const found = state === "complete" && tileLevels.size ? agreeing(candidates, tileLevels) : [];
      if (purpose === "discover") {
        if (!(trusted && found.length === 1 && found[0] === map)) adoptUnique(found, now, tileLevels, tileModels);
        return;
      }
      if (map !== target) return;
      if (state !== "complete" || !reachedTarget) return adoptUnique(found, now, tileLevels, tileModels);
      const values = readLevelRegistry(map);
      if (found.length > 1 && values && compareWithTiles(values, tileLevels).positive) drop();
    }
    function update({ now, tileLevels, tileModels, selfLevels = /* @__PURE__ */ new Map(), isParticipantModel = null, discoveryIds = [...tileLevels.keys()], discoveryModels = [] }) {
      let values = map ? readLevelRegistry(map) : null;
      if (map && !values) drop();
      const checked = map;
      if (map) {
        const self = new Map([...selfLevels].filter(([id]) => values.has(id)));
        if (tileLevels.size || self.size) {
          const check = tileLevels.size ? compareWithTiles(values, tileLevels) : { ok: true, positive: false };
          if (check.ok && (!self.size || compareWithTiles(values, self).ok)) {
            mismatchSince = null;
            if (check.positive) trust(now);
            adopt(tileModels);
          } else {
            mismatchSince ??= now;
            if (now - mismatchSince > mismatchMs) drop();
          }
        } else if (!anchors.some(isLive2)) drop();
      }
      const ids = [...tileLevels.keys()];
      const membershipModels = [.../* @__PURE__ */ new Set([...tileModels, ...discoveryModels])];
      const discovering = (!trusted || !membership.map) && discoveryIds.length && membershipModels.length && now - lastDiscovery >= discoveryMs;
      if (!walk && (discovering || (trusted || membership.map) && now - lastVerify >= verifyMs)) {
        const verify = Boolean(map && trusted);
        if (discovering) lastDiscovery = now;
        if (verify || !discovering) lastVerify = now;
        const roots = discovering && !verify ? membershipModels : [.../* @__PURE__ */ new Set([...membershipModels, ...anchors.filter(isLive2), ...membership.anchors])];
        const target = verify ? map : null;
        walk = { purpose: verify ? "verify" : discovering ? "discover" : "members", target, ids, run: createRegistryWalk({ anchors: roots, ids, discoveryIds, target, targets: [target, membership.map], clock }) };
      }
      if (walk && walk.run.step() !== "running") {
        const finished = walk;
        walk = null;
        finish(finished, now, tileLevels, tileModels, isParticipantModel, discoveryIds, discoveryModels);
      }
      if (map !== checked) values = map ? readLevelRegistry(map) : null;
      const levelValues = map && trusted ? values : null;
      membership.update({ now, tileIds: ids, levelValues, tileModels: membershipModels, isParticipantModel });
      return mismatchSince === null ? levelValues : null;
    }
    return {
      update,
      reset: () => {
        drop();
        membership.reset();
        walk = null;
        lastDiscovery = -Infinity;
        lastVerify = -Infinity;
      },
      get trusted() {
        return Boolean(map && trusted);
      },
      membership
    };
  }
  function readRegistryActivity(values, participants, known, selfIds) {
    const byId = /* @__PURE__ */ new Map();
    for (const participant of [...known, ...participants]) {
      if (participant?.participantId && !selfIds.has(participant.participantId)) byId.set(participant.participantId, participant);
    }
    const levels = /* @__PURE__ */ new Map();
    const speakers = [];
    let unknownSpeakers = 0;
    for (const [id, value] of values) {
      if (selfIds.has(id)) continue;
      const participant = byId.get(id);
      const step = registryStep(value);
      if (participant) {
        levels.set(participant.key, step / 5);
        if (step >= 1) speakers.push(participant);
      } else if (step >= 1) unknownSpeakers++;
    }
    const unknown = participants.filter((participant) => !levels.has(participant.key)).map((participant) => participant.key);
    return { available: unknown.length === 0, levels, unknown, speakers, unknownSpeakers, source: "meet-registry" };
  }

  // src/platforms/google-meet/native-activity.js
  var RING_RENDERER = /Math\.round\([^;]*?\.([A-Za-z_$][\w$]*)\(\)\*5\)/;
  var DELEGATING_GETTER = /^[A-Za-z_$][\w$]*\(\)\{return this\.[A-Za-z_$][\w$]*\.[A-Za-z_$][\w$]*\(\)\}$/;
  var MAX_ELEMENTS_PER_ROOT = 256;
  var MAX_MODELS_PER_ROOT = 16;
  var REDISCOVER_MS = 1e3;
  var GETTER_RETRY_MS = 1e3;
  var GETTER_STALE_MS = 1e4;
  var MAX_DISCOVERY_MODELS = 64;
  var MAX_DISCOVERY_ROOTS = 64;
  var MAX_DISCOVERY_VALUES = 4096;
  function isObject(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value) && !(typeof Node === "function" && value instanceof Node) && typeof value.nodeType !== "number";
  }
  function ownMethods(object, depth = 2) {
    const methods = [];
    let proto = Object.getPrototypeOf(object);
    for (let level = 0; level < depth && proto && proto !== Object.prototype; level++, proto = Object.getPrototypeOf(proto)) {
      for (const name of Object.getOwnPropertyNames(proto)) {
        const descriptor = Object.getOwnPropertyDescriptor(proto, name);
        if (typeof descriptor?.value === "function") methods.push([name, descriptor.value]);
      }
    }
    return methods;
  }
  function sourceOf(fn) {
    try {
      return Function.prototype.toString.call(fn);
    } catch {
      return "";
    }
  }
  function elementsOf(root, selector) {
    const nested = [...root?.querySelectorAll?.(selector) || []];
    return [root, ...nested].slice(0, MAX_ELEMENTS_PER_ROOT);
  }
  function holdersOf(element, budget) {
    const holders = [];
    const models = element?.__jsmodel;
    if (isObject(models)) for (const entry of valuesOf(models, budget)) holders.push(entry?.pending?.value);
    holders.push(element?.__jscontroller?.pending?.value);
    return holders.filter(isObject);
  }
  function findActivityGetterName(root) {
    let elements = [];
    try {
      elements = elementsOf(root, "[jscontroller]");
    } catch {
      return null;
    }
    for (const element of elements) {
      try {
        const controller = element?.__jscontroller?.pending?.value;
        if (!isObject(controller)) continue;
        for (const [name, fn] of ownMethods(controller)) {
          if (name === "constructor") continue;
          const source = sourceOf(fn);
          const match = source.match(RING_RENDERER);
          if (match && />\s*0/.test(source.slice(match.index))) return match[1];
        }
      } catch {
      }
    }
    return null;
  }
  function isParticipantSourceModel(value, participantId, activityGetter, identityCache = /* @__PURE__ */ new WeakMap()) {
    try {
      if (!isObject(value) || typeof value.isDisposed !== "function" || typeof value[activityGetter] !== "function") return false;
      const proto = Object.getPrototypeOf(value);
      if (!proto || proto === Object.prototype) return false;
      let candidates = identityCache.get(proto);
      if (!candidates) {
        const shaped = DELEGATING_GETTER.test(sourceOf(proto[activityGetter]));
        candidates = shaped ? ownMethods(value, 1).filter(([name, fn]) => name !== activityGetter && fn.length === 0 && DELEGATING_GETTER.test(sourceOf(fn))).map(([name]) => name) : [];
        identityCache.set(proto, candidates);
      }
      if (!candidates.length || value.isDisposed()) return false;
      for (const name of candidates) {
        try {
          if (value[name]() === participantId) return true;
        } catch {
        }
      }
    } catch {
    }
    return false;
  }
  function valuesOf(object, budget) {
    if (budget) return boundedValuesOf(object, budget);
    try {
      return Object.values(object);
    } catch {
      return [];
    }
  }
  function* boundedValuesOf(object, budget) {
    try {
      for (const key in object) {
        if (budget.values <= 0) return;
        budget.values--;
        if (Object.hasOwn(object, key)) yield object[key];
      }
    } catch {
    }
  }
  function discoverParticipantSourceModels(root, participantId, activityGetter, identityCache, budget) {
    const found = [];
    const seen = /* @__PURE__ */ new Set();
    const consider = (value) => {
      let object = false;
      try {
        object = isObject(value);
      } catch {
      }
      if (!object || seen.has(value)) return false;
      seen.add(value);
      if (!isParticipantSourceModel(value, participantId, activityGetter, identityCache)) return false;
      found.push(value);
      return true;
    };
    for (const element of elementsOf(root, "[jsmodel],[jscontroller]")) {
      if (budget && budget.values <= 0) break;
      let holders = [];
      try {
        holders = holdersOf(element, budget);
      } catch {
      }
      for (const holder of holders) {
        for (const value of valuesOf(holder, budget)) {
          if (found.length >= MAX_MODELS_PER_ROOT) return found;
          if (consider(value) || !seen.has(value)) continue;
          for (const nested of valuesOf(value, budget)) {
            if (found.length >= MAX_MODELS_PER_ROOT) return found;
            consider(nested);
          }
        }
      }
    }
    return found;
  }
  function readLevel(model, getter) {
    try {
      const level = model[getter]();
      return typeof level === "number" && Number.isFinite(level) && level >= 0 && level <= 1 ? level : null;
    } catch {
      return null;
    }
  }
  function strongestLevel(models, getter) {
    let level = null;
    for (const model of models) {
      const value = readLevel(model, getter);
      if (value !== null) level = Math.max(level ?? 0, value);
    }
    return level;
  }
  function isSpeakingLevel(level) {
    return Number.isFinite(level) && Math.round(level * 5) > 0;
  }
  function createNativeActivitySource({ rediscoverMs = REDISCOVER_MS } = {}) {
    let getter = null;
    let lastGetterAttempt = -Infinity;
    let lastConfirmedAt = 0;
    let identityCache = /* @__PURE__ */ new WeakMap();
    const entries = /* @__PURE__ */ new Map();
    const registry = createActivityRegistry();
    function rootsFor(participant, rootsByParticipantId) {
      const roots = rootsByParticipantId.get(participant.participantId) || [];
      if (participant.element && !roots.includes(participant.element)) roots.push(participant.element);
      return roots.filter((root) => root && root.isConnected !== false);
    }
    function modelsFor(participant, roots, now, budget) {
      const cached = entries.get(participant.key);
      const valid = cached?.models.filter((model) => isParticipantSourceModel(model, participant.participantId, getter, identityCache));
      if (cached && cached.participantId === participant.participantId && valid.length === cached.models.length && now - cached.discoveredAt < rediscoverMs) return valid;
      const models = [];
      for (const root of roots) {
        if (budget && (budget.roots-- <= 0 || budget.values <= 0)) break;
        for (const model of discoverParticipantSourceModels(root, participant.participantId, getter, identityCache, budget)) {
          if (!models.includes(model)) models.push(model);
        }
      }
      entries.set(participant.key, { participantId: participant.participantId, models, discoveredAt: now });
      return models;
    }
    function readUnsafe(participants, root, now, { known = participants, selfIds = /* @__PURE__ */ new Set() } = {}) {
      const rootsByParticipantId = /* @__PURE__ */ new Map();
      for (const element of root?.querySelectorAll?.("[data-participant-id]") || []) {
        const id = element.getAttribute?.("data-participant-id");
        if (!id) continue;
        if (!rootsByParticipantId.has(id)) rootsByParticipantId.set(id, []);
        rootsByParticipantId.get(id).push(element);
      }
      if (getter && participants.length && now - lastConfirmedAt > GETTER_STALE_MS) {
        getter = null;
        entries.clear();
        identityCache = /* @__PURE__ */ new WeakMap();
      }
      if (!getter && now - lastGetterAttempt >= GETTER_RETRY_MS) {
        lastGetterAttempt = now;
        for (const roots of rootsByParticipantId.values()) {
          for (const candidate of roots) {
            getter = findActivityGetterName(candidate);
            if (getter) break;
          }
          if (getter) break;
        }
        if (getter) lastConfirmedAt = now;
      }
      const levels = /* @__PURE__ */ new Map();
      const unknown = [];
      const tileLevels = /* @__PURE__ */ new Map();
      const tileModels = [];
      const selfTiles = [...selfIds].filter((id) => rootsByParticipantId.has(id)).map((id) => ({ key: `self:${id}`, participantId: id }));
      for (const key of entries.keys()) {
        const discoveryId = key.startsWith("discovery:") ? key.slice("discovery:".length) : null;
        if (!participants.some((participant) => participant.key === key) && !selfTiles.some((item) => item.key === key) && !(discoveryId && rootsByParticipantId.has(discoveryId))) entries.delete(key);
      }
      for (const participant of getter ? participants : []) {
        const roots = rootsFor(participant, rootsByParticipantId);
        const models = roots.length ? modelsFor(participant, roots, now) : [];
        const level = strongestLevel(models, getter);
        if (level === null) {
          unknown.push(participant.key);
          continue;
        }
        levels.set(participant.key, level);
        tileLevels.set(participant.participantId, level);
        tileModels.push(...models);
      }
      const selfLevels = /* @__PURE__ */ new Map();
      for (const self of getter ? selfTiles : []) {
        const models = modelsFor(self, rootsByParticipantId.get(self.participantId), now);
        tileModels.push(...models);
        const level = strongestLevel(models, getter);
        if (level !== null) selfLevels.set(self.participantId, level);
      }
      const discoveryIds = /* @__PURE__ */ new Set();
      const discoveryModels = [];
      const budget = { roots: MAX_DISCOVERY_ROOTS, values: MAX_DISCOVERY_VALUES };
      let attemptedIds = 0;
      for (const [id, roots] of getter ? rootsByParticipantId : []) {
        if (attemptedIds++ >= MAX_DISCOVERY_MODELS || budget.roots <= 0 || budget.values <= 0 || discoveryModels.length >= MAX_DISCOVERY_MODELS) break;
        for (const model of modelsFor({ key: `discovery:${id}`, participantId: id }, roots, now, budget)) {
          if (discoveryModels.length >= MAX_DISCOVERY_MODELS) break;
          discoveryIds.add(id);
          discoveryModels.push(model);
        }
      }
      if (levels.size || selfLevels.size) lastConfirmedAt = now;
      const isParticipantModel = getter ? (value, id) => isParticipantSourceModel(value, id, getter, identityCache) : null;
      const registryValues = registry.update({ now, tileLevels, tileModels, selfLevels, isParticipantModel, discoveryIds: [...discoveryIds], discoveryModels });
      if (registryValues) return readRegistryActivity(registryValues, participants, known, selfIds);
      if (!getter) return unavailable(participants);
      const speakers = participants.filter((participant) => isSpeakingLevel(levels.get(participant.key)));
      const available = participants.length > 0 && unknown.length === 0;
      return { available, levels, unknown, speakers, unknownSpeakers: 0, source: available ? "meet-tiles" : "unavailable" };
    }
    function unavailable(participants) {
      return { available: false, levels: /* @__PURE__ */ new Map(), unknown: participants.map((participant) => participant.key), speakers: [], unknownSpeakers: 0, source: "unavailable" };
    }
    function read(participants, root = globalThis.document, now = Date.now(), options = {}) {
      try {
        return readUnsafe(participants, root, now, options);
      } catch {
        return unavailable(participants);
      }
    }
    function reset() {
      entries.clear();
      registry.reset();
    }
    return {
      read,
      reset,
      get activityGetter() {
        return getter;
      },
      // Meet's in-call membership (tile-independent), as booleans only.
      get membershipTrusted() {
        return registry.membership.trusted;
      },
      isMember: (id) => registry.membership.has(id)
    };
  }

  // src/platforms/google-meet/measurement-continuity.js
  function createMeasurementContinuity() {
    let previousMode = null, previousUnits = [], previous = null;
    const same = (a, b) => a.length === b.length && a.every((value, i) => value === b[i]);
    const unitsOf = (g, pipelines) => g.mode === "media" ? pipelines.map((p) => ({ key: p, parts: [p, p.stream, ...p.tracks || []], generation: void 0 })) : g.slots.map((s) => ({ key: s, parts: [s, s.tap, s.audibleMeter], generation: s.audibleMeter?.generation }));
    return function observe(g, pipelines) {
      const units = unitsOf(g, pipelines);
      const before = new Map(previousUnits.map((u) => [u.key, u]));
      const kept = units.filter((u) => before.has(u.key));
      const keptUnchanged = kept.every((u) => {
        const o = before.get(u.key);
        return same(u.parts, o.parts) && u.generation === o.generation;
      });
      const unchanged = g.mode === previousMode && units.length === previousUnits.length && kept.length === units.length && keptUnchanged && units.every((u, i) => u.key === previousUnits[i].key);
      if (unchanged) return null;
      const meter = g.mode === "worklet" && g.slots[0]?.audibleMeter;
      const membershipOnly = g.mode === "media" && previousMode === "media" && units.length > 0 && kept.length > 0 && keptUnchanged;
      const next = meter?.continuity;
      const sameOwners = g.mode === previousMode && units.length === previousUnits.length && units.every((u, i) => u.key === previousUnits[i].key && same(u.parts, previousUnits[i].parts));
      const compatible = sameOwners && previous?.meter === meter && g.slots.every((s) => s.audibleMeter === meter) && next?.token && next.token === previous.token && next.reason === "static-native-gain" && next.generation === meter.generation && next.generation > previous.generation;
      previousMode = g.mode;
      previousUnits = units;
      if (membershipOnly) return null;
      previous = next ? { meter, ...next } : null;
      return { reason: compatible ? "compatible-native-gain" : "measurement-graph" };
    };
  }

  // src/platforms/google-meet/row-admission.js
  var ROW_ADMISSION_MS = 400;
  function createRowAdmission({ minMs = ROW_ADMISSION_MS } = {}) {
    const pending = /* @__PURE__ */ new Map();
    let seen = /* @__PURE__ */ new Set();
    return {
      begin() {
        seen = /* @__PURE__ */ new Set();
      },
      // True once `key` with `name` is stable; call only for keys not yet rows.
      admit(key, name, now) {
        seen.add(key);
        const entry = pending.get(key);
        if (!entry || entry.name !== name) {
          pending.set(key, { name, since: now });
          return false;
        }
        if (now - entry.since < minMs) return false;
        pending.delete(key);
        return true;
      },
      // Forget candidates that disappeared this scan, so admission restarts.
      end() {
        for (const key of pending.keys()) if (!seen.has(key)) pending.delete(key);
      },
      clear() {
        pending.clear();
        seen = /* @__PURE__ */ new Set();
      }
    };
  }

  // src/platforms/google-meet/index.js
  function createWorkletSpeakerTracker({ confirmMs = 50 } = {}) {
    let confirmed = null;
    let candidateKey = null;
    let candidateSince = 0;
    function result(routingState, participant = null, multiplier = 1) {
      return {
        routingState,
        activeParticipantKey: participant?.key || null,
        appliedParticipantKey: participant?.key || null,
        multiplier,
        candidateParticipantKey: candidateKey,
        candidateSince
      };
    }
    function reset(routingState = "idle") {
      confirmed = null;
      candidateKey = null;
      candidateSince = 0;
      return result(routingState);
    }
    function update({ now, speakers = [] }) {
      if (speakers.length > 1) return reset("ambiguous");
      const speaker = speakers[0] || null;
      if (speaker) {
        if (confirmed?.key === speaker.key) {
          confirmed = speaker;
          candidateKey = null;
          candidateSince = 0;
          return result("confirmed-speaker", confirmed, confirmed.value);
        }
        if (confirmed) confirmed = null;
        if (candidateKey !== speaker.key) {
          candidateKey = speaker.key;
          candidateSince = now;
          return result("transitioning");
        }
        if (now - candidateSince < confirmMs) return result("transitioning");
        confirmed = speaker;
        candidateKey = null;
        candidateSince = 0;
        return result("confirmed-speaker", confirmed, confirmed.value);
      }
      candidateKey = null;
      candidateSince = 0;
      if (confirmed) return result("confirmed-speaker", confirmed, confirmed.value);
      return reset("idle");
    }
    return { update, reset };
  }
  function applyMediaPipelineOutputs(pipelines, routing, multiplier, immediate = false) {
    const selectedId = routing?.routingState === "confirmed-speaker" ? routing.appliedPipelineId : null;
    const selectedKey = routing?.appliedParticipantKey;
    const quiet = isQuietMediaTransition(pipelines, routing);
    for (const pipeline of pipelines) {
      const selected = pipeline.id === selectedId && pipeline.associationReliable && pipeline.participantKey === selectedKey;
      const quietOwner = quiet && routing.quietIdentity.pipeline === pipeline;
      pipeline.set(selected ? multiplier : 1, immediate || !selected && !quietOwner || !pipeline.connected);
    }
  }
  function activateMediaModePipelines(pipelines, routing) {
    applyMediaPipelineOutputs(pipelines, routing, routing?.multiplier ?? 1);
  }
  function resolveLocalPresentationActive({ captureActive, domActive, captureLifecycleSeen }) {
    return captureLifecycleSeen ? captureActive : captureActive || domActive;
  }
  function createGoogleMeetController({ state, context, setStatus, renderSoon, updateLiveUi, onLevelSample = () => {
  }, onLevelReset = () => {
  }, onStop = () => {
  }, mediaOwnership = installRemoteMediaOwnership(), rowAdmissionMs } = {}) {
    const learner = createAssociationLearner();
    const alignmentTracker = createFreshAlignmentTracker();
    const media = createMediaPipelineManager(context, { accepts: (stream) => mediaOwnership.accepts(stream) });
    const workletSpeakerTracker = createWorkletSpeakerTracker();
    const nativeActivity = createNativeActivitySource();
    const levelMeter = createParticipantLevelMeter();
    const observeMeasurement = createMeasurementContinuity();
    let stopped = false;
    const selfIds = /* @__PURE__ */ new Set(), presentationIds = /* @__PURE__ */ new Set();
    const rowAdmission = createRowAdmission({ minMs: rowAdmissionMs });
    let restoreHook, restoreCaptureHook, observer, mutationTimer, reconcileTimer, mediaTimer, routingTimer, visibilityHandler, slotCounter = 0;
    let capturePresentationActive = false;
    let domPresentationActive = false;
    let captureLifecycleSeen = false;
    function participants() {
      return visibleParticipants(state, "google-meet");
    }
    function knownParticipants() {
      return [...state.participants.values()].filter((item) => item.platform === "google-meet" && !selfIds.has(item.participantId) && !presentationIds.has(item.participantId));
    }
    function applyPresentationState() {
      const presenting = resolveLocalPresentationActive({
        captureActive: capturePresentationActive,
        domActive: domPresentationActive,
        captureLifecycleSeen
      });
      if (presenting === state.google.localPresentationActive) return presenting;
      state.google.localPresentationActive = presenting;
      renderSoon();
      return presenting;
    }
    function setCapturePresentationActive(active) {
      captureLifecycleSeen = true;
      capturePresentationActive = active;
      if (!active) domPresentationActive = hasLocalPresentation();
      return applyPresentationState();
    }
    function syncPresentationState() {
      domPresentationActive = hasLocalPresentation();
      return applyPresentationState();
    }
    function setMode(mode) {
      if (state.google.mode === mode) return;
      state.google.mode = mode;
      if (mode === "worklet") {
        for (const pipeline of media.pipelines) pipeline.deactivate();
      } else if (mode === "media") applyMediaPipelineOutputs(media.pipelines, null, 1, true);
      renderSoon();
    }
    function registerSlot(gain, tap = null, audibleMeter = null) {
      if (state.google.slots.some((slot) => slot.gain === gain)) return;
      state.google.slots.push(createPooledSlot(gain, `slot-${++slotCounter}`, tap, audibleMeter));
      setMode("worklet");
      syncPresentationState();
      renderSoon();
    }
    function unregisterSlot(gain) {
      const index = state.google.slots.findIndex((slot) => slot.gain === gain);
      if (index < 0) return;
      state.google.slots[index].destroy();
      state.google.slots.splice(index, 1);
      renderSoon();
    }
    function reconcile() {
      const now = Date.now();
      syncPresentationState();
      const found = /* @__PURE__ */ new Set();
      rowAdmission.begin();
      for (const data of scanMeetParticipants(document, selfIds, presentationIds)) {
        if (!data.element?.getAttribute?.("data-requested-participant-id") && !nativeActivity.isMember(data.participantId)) continue;
        if (!state.participants.has(data.key) && (!data.hasMicrophone || !rowAdmission.admit(data.key, data.name, now))) continue;
        found.add(data.key);
        const before = state.participants.get(data.key)?.value;
        const participant = upsertParticipant(state, {
          ...data,
          platform: "google-meet",
          present: true,
          lastSeenAt: now,
          extra: { participantId: data.participantId, element: data.element }
        });
        if (before !== void 0 && participant.value !== before) applyParticipantGain(participant);
      }
      rowAdmission.end();
      updateMissingParticipants(state.participants.values(), found, { now, selfIds, presentationIds, isMember: nativeActivity.isMember });
      const isSelfKey = (key) => selfIds.has(state.participants.get(key)?.participantId);
      if ([
        state.google.activeParticipantKey,
        state.google.appliedParticipantKey,
        state.google.transitionGuard.candidateParticipantKey,
        state.google.routing?.appliedParticipantKey,
        state.google.routing?.lastConfirmedParticipantKey,
        state.google.routing?.candidateParticipantKey
      ].some(isSelfKey)) {
        workletSpeakerTracker.reset();
        state.google.routing = createRoutingState();
        state.google.activeParticipantKey = null;
        state.google.appliedParticipantKey = null;
        state.google.routingState = "idle";
        state.google.transitionGuard.candidateParticipantKey = null;
        state.google.transitionGuard.candidateSince = 0;
        setOutputs(1, true);
      }
      const signature = participants().map((item) => `${item.key}:${item.name}`).join("|");
      if (signature !== state.google.rosterSignature) {
        state.google.rosterSignature = signature;
        renderSoon();
      }
    }
    function scanMedia() {
      mediaOwnership.refresh();
      media.scan();
      state.google.mediaPipelines = media.pipelines;
      if (state.google.slots.length) setMode("worklet");
      else if (media.hasAudio && performance.now() - state.google.modeStartedAt > 1200) setMode("media");
      if (state.google.mode === "media") activateMediaModePipelines(media.pipelines, state.google.routing);
    }
    function refreshMediaOwnership() {
      mediaOwnership.refresh();
      media.prune();
      state.google.mediaPipelines = media.pipelines;
    }
    function setOutputs(multiplier, immediate = false) {
      refreshMediaOwnership();
      if (state.google.mode === "media") applyMediaPipelineOutputs(media.pipelines, state.google.routing, multiplier, immediate);
      else for (const slot of state.google.slots) slot.set(multiplier, immediate);
    }
    function currentSpeakers(now) {
      const known = knownParticipants();
      const activity = nativeActivity.read(participants(), globalThis.document, now, { known, selfIds });
      for (const participant of known) {
        participant.speaking = activity.available && activity.speakers.includes(participant);
        if (participant.speaking) participant.lastSpeakingAt = now;
      }
      state.google.speakerSource = activity.available ? "meet-activity" : "unavailable";
      state.google.activitySource = activity.source;
      state.google.membershipTrusted = nativeActivity.membershipTrusted;
      state.google.unknownSpeakerCount = activity.unknown.length + activity.unknownSpeakers;
      return activity;
    }
    function neutralize(routingState, status) {
      workletSpeakerTracker.reset(routingState);
      state.google.routing = { ...createRoutingState(), routingState };
      state.google.activeParticipantKey = null;
      state.google.appliedParticipantKey = null;
      state.google.routingState = routingState;
      state.google.transitionGuard.candidateParticipantKey = null;
      state.google.transitionGuard.candidateSince = 0;
      setOutputs(1, true);
      setStatus(status);
    }
    function routeWorklet(now, speakers) {
      const routing = workletSpeakerTracker.update({ now, speakers });
      const active = state.participants.get(routing.appliedParticipantKey) || null;
      const status = active ? `${active.name} · automatic routing` : speakers.length > 1 ? "Overlapping speakers · using safe 100% volume" : !participants().length ? "Waiting for participants" : `${participants().length} participants ready`;
      state.google.activeParticipantKey = routing.activeParticipantKey;
      state.google.appliedParticipantKey = routing.appliedParticipantKey;
      state.google.routingState = routing.routingState;
      state.google.transitionGuard.candidateParticipantKey = routing.candidateParticipantKey;
      state.google.transitionGuard.candidateSince = routing.candidateSince;
      setOutputs(routing.multiplier, routing.routingState !== "confirmed-speaker");
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
        // A tileless participant is routable only while the registry names them as the speaker.
        now,
        participants: Object.fromEntries([...participants(), ...speakers].map((item) => [item.key, item])),
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
      setStatus(!media.pipelines.length ? "Remote audio ownership unavailable · using native playback" : active ? `${active.name} · automatic routing` : labels[routing.routingState] || `${participants().length} participants ready`);
    }
    function sampleLevels(now, activity = null) {
      const g = state.google;
      const invalidation = observeMeasurement(g, media.pipelines);
      if (invalidation) {
        levelMeter.reset();
        onLevelReset(now, invalidation);
      }
      const attributedKey = activity && attributeLevelSample({
        available: activity.available,
        speakers: activity.speakers,
        routingState: g.routingState,
        appliedParticipantKey: g.appliedParticipantKey,
        // Media graphs contain only verified remote audio; worklet semantics stay
        // unchanged because their pooled source has no equivalent provenance.
        localPresentationActive: g.localPresentationActive && g.mode !== "media"
      });
      try {
        const accepted = levelMeter.tick({
          // A hidden tile is not a departure; keep known membership evidence.
          now,
          participantKeys: knownParticipants().map((person) => person.key),
          attributedKey,
          readPower: () => g.mode === "media" ? sumPipelinePower(media.pipelines) : g.mode === "worklet" ? sumTapPower(g.slots) : 0
        });
        onLevelSample(now, accepted ? attributedKey : null);
      } catch {
      }
    }
    function route() {
      if (stopped) return;
      refreshMediaOwnership();
      const now = Date.now();
      const activity = currentSpeakers(now);
      if (activity.unknownSpeakers) neutralize("unknown-speaker", "Unrecognized speaker · using safe 100% volume");
      else if (!activity.available) {
        neutralize("speaker-data-unavailable", participants().length ? "Speaker data unavailable · using safe 100% volume" : "Waiting for participants");
      }
      if (activity.unknownSpeakers || !activity.available) {
        sampleLevels(now, activity);
        updateLiveUi();
        return;
      }
      const speakers = activity.speakers;
      if (state.google.mode === "media") routeMedia(now, speakers);
      else routeWorklet(now, speakers);
      sampleLevels(now, activity);
      updateLiveUi();
    }
    function start() {
      stopped = false;
      restoreCaptureHook = installLocalPresentationCaptureHook(setCapturePresentationActive);
      restoreHook = installAudioWorkletHook(registerSlot, unregisterSlot);
      reconcile();
      scanMedia();
      observer = observeMeetParticipants(() => {
        syncPresentationState();
        clearTimeout(mutationTimer);
        mutationTimer = setTimeout(reconcile, 80);
      });
      reconcileTimer = setInterval(reconcile, 750);
      mediaTimer = setInterval(scanMedia, 500);
      routingTimer = setInterval(route, 30);
      visibilityHandler = () => route();
      document.addEventListener("visibilitychange", visibilityHandler);
    }
    function stop() {
      stopped = true;
      onStop();
      observer?.disconnect();
      clearTimeout(mutationTimer);
      clearInterval(reconcileTimer);
      clearInterval(mediaTimer);
      clearInterval(routingTimer);
      if (visibilityHandler) document.removeEventListener("visibilitychange", visibilityHandler);
      restoreCaptureHook?.();
      restoreHook?.();
      if (state.google.mode === "media") setOutputs(1, true);
      for (const slot of state.google.slots) slot.destroy();
      state.google.slots = [];
      media.destroy();
      state.google.mediaPipelines = [];
      mediaOwnership.dispose();
      selfIds.clear();
      presentationIds.clear();
      rowAdmission.clear();
      workletSpeakerTracker.reset();
      nativeActivity.reset();
      levelMeter.reset();
    }
    function applyParticipantGain(participant) {
      syncPresentationState();
      if (state.google.activeParticipantKey === participant.key) setOutputs(participant.value);
    }
    return {
      start,
      stop,
      route,
      applyParticipantGain,
      setOutputs,
      levelFor: (key, options) => levelMeter.levelFor(key, options),
      get pipelines() {
        return media.pipelines;
      }
    };
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
  var levelTrackStyles = {
    position: "relative",
    height: "3px",
    borderRadius: "999px",
    background: "#3c4043",
    margin: "1px 2px 5px"
  };
  var levelFillStyles = {
    position: "absolute",
    left: "0",
    top: "0",
    height: "100%",
    width: "0%",
    borderRadius: "999px",
    background: "#8ab4f8",
    opacity: ".9"
  };
  var levelTickStyles = {
    position: "absolute",
    top: "-3px",
    left: "0%",
    width: "2px",
    height: "9px",
    marginLeft: "-1px",
    borderRadius: "1px",
    background: "#e8eaed",
    display: "none"
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
    slider.setAttribute("aria-label", `Volume for ${participant.name}`);
    Object.assign(slider.style, { width: "100%", margin: "0" });
    slider.oninput = () => {
      const next = Number(slider.value);
      onGain(participant, next);
      value.textContent = `${Math.round(next * 100)}%`;
    };
    const presets = document.createElement("div");
    const meter = renderLevelMeter();
    Object.assign(presets.style, { display: "flex", gap: "5px", marginTop: "7px", flexWrap: "wrap" });
    for (const [text, gain] of [["Mute", 0], ["50%", 0.5], ["100%", 1], ["250%", 2.5]]) {
      const button = makeButton(text, () => {
        slider.value = String(gain);
        onGain(participant, gain);
        value.textContent = `${Math.round(gain * 100)}%`;
      });
      button.setAttribute("aria-label", `${text} for ${participant.name}`);
      presets.append(button);
    }
    row.append(top, slider, meter, presets);
    return row;
  }
  function renderLevelMeter() {
    const track = document.createElement("div");
    track.dataset.role = "level-track";
    track.setAttribute("aria-hidden", "true");
    track.title = "Not heard yet";
    Object.assign(track.style, levelTrackStyles);
    const fill = document.createElement("div");
    fill.dataset.role = "level-fill";
    Object.assign(fill.style, levelFillStyles);
    const tick = document.createElement("div");
    tick.dataset.role = "level-tick";
    Object.assign(tick.style, levelTickStyles);
    track.append(fill, tick);
    return track;
  }

  // src/ui/balance.js
  var LEVEL_SCALE_MIN_DB = -60;
  function dbToScale(db) {
    if (typeof db !== "number" || Number.isNaN(db)) return 0;
    return Math.min(1, Math.max(0, (db - LEVEL_SCALE_MIN_DB) / -LEVEL_SCALE_MIN_DB));
  }
  function postVolumeDb(preDb, volume) {
    if (!Number.isFinite(preDb) || !Number.isFinite(volume) || volume <= 0) return null;
    return preDb + 20 * Math.log10(volume);
  }

  // src/ui/auto-balance.js
  var AUTO_TARGET_DB = -20;
  var AUTO_DEADBAND_DB = 1;
  var AUTO_STEP_DB = 0.1;
  function createAutoBalance({ participants, levels, onGain }) {
    let enabled = false, startedAt = 0, targetDb = null;
    const consumed = /* @__PURE__ */ new Map(), qualification = /* @__PURE__ */ new Map();
    const firstSeen = /* @__PURE__ */ new WeakMap();
    function stop() {
      enabled = false;
      targetDb = null;
      consumed.clear();
      qualification.clear();
    }
    function invalidate(now, { reason } = {}) {
      startedAt = now;
      if (reason !== "compatible-native-gain") targetDb = null;
      consumed.clear();
      qualification.clear();
    }
    function start(now) {
      stop();
      enabled = true;
      invalidate(now);
      for (const person of participants()) firstSeen.set(person, now);
    }
    function tick(now, sampledKey) {
      if (!enabled) return;
      const present = new Map(participants().map((person2) => [person2.key, person2]));
      for (const key of consumed.keys()) if (!present.has(key)) {
        consumed.delete(key);
        qualification.delete(key);
      }
      const person = present.get(sampledKey);
      if (person && !firstSeen.has(person)) firstSeen.set(person, now);
      const level = person && levels(person.key, { since: Math.max(startedAt, firstSeen.get(person)) });
      if (!person || !(person.value > 0 && person.value <= 6) || !Number.isFinite(level?.autoDb) || !(Number.isFinite(level.autoSupportMs) && level.autoSupportMs >= 6e3) || !(Number.isFinite(level.autoInlierFrames) && level.autoInlierFrames >= 24) || !(Number.isFinite(level.autoInlierPortions) && level.autoInlierPortions >= 3) || !(level.autoSpread <= AUTO_MAX_SPREAD_DB) || !Number.isFinite(level.autoSince) || level.autoSince < Math.max(startedAt, firstSeen.get(person)) || level.sampledAt !== now || now - startedAt < 1e3 || consumed.get(person.key) === now) {
        if (person && level?.sampledAt === now && consumed.get(person.key) !== now) qualification.delete(person.key);
        return;
      }
      if (level.autoLatestAgrees !== true) return;
      consumed.set(person.key, now);
      if (targetDb === null) targetDb = AUTO_TARGET_DB;
      const error = targetDb - (level.autoDb + 20 * Math.log10(person.value));
      const direction = Math.sign(error);
      if (Math.abs(error) <= Math.max(AUTO_DEADBAND_DB, level.autoSpread / 2)) {
        qualification.delete(person.key);
        return;
      }
      const old = qualification.get(person.key);
      const count = old?.person === person && old.direction === direction && now - old.at <= AUTO_HORIZON_MS ? old.count + 1 : 1;
      qualification.set(person.key, { person, direction, count, at: now });
      if (count < 30) return;
      const step = direction * AUTO_STEP_DB;
      const value = Math.max(0.05, Math.min(6, person.value * 10 ** (step / 20)));
      if (value !== person.value) onGain(person, value, { automatic: true });
    }
    return { start, stop, tick, invalidate, get enabled() {
      return enabled;
    }, get targetDb() {
      return targetDb;
    } };
  }

  // src/ui/panel.js
  function statusText(state, now = Date.now()) {
    if (state.autoBalanceEnabled) return state.autoBalanceReady ? "Auto Balance on" : "Learning levels…";
    const notice = state.statusNotice;
    return notice && now < notice.until ? notice.message : state.status;
  }
  function setStyle(element, name, value) {
    if (element && element.style[name] !== value) element.style[name] = value;
  }
  function updateLevelMeter(row, participant, levels) {
    const track = row.querySelector('[data-role="level-track"]');
    if (!track) return;
    const level = levels?.(participant.key) || null;
    const live = postVolumeDb(level?.liveDb, participant.value);
    const typical = postVolumeDb(level?.typicalDb, participant.value);
    const [fill, tick] = track.children;
    setStyle(fill, "width", live === null ? "0%" : `${(dbToScale(live) * 100).toFixed(2)}%`);
    setStyle(tick, "display", typical === null ? "none" : "block");
    if (typical !== null) setStyle(tick, "left", `${(dbToScale(typical) * 100).toFixed(2)}%`);
    const title = Number.isFinite(level?.typicalDb) ? "Typical speaking level after your volume" : "Not heard yet";
    if (track.title !== title) track.title = title;
  }
  function createPanelController(state, { participants, levels = () => null, onGain, onSave, onCollapse }) {
    const auto = createAutoBalance({ participants, levels, onGain });
    state.autoBalanceEnabled = false;
    let balanceButton = null;
    function updateBalanceButton() {
      const button = balanceButton;
      if (!button) return;
      button.textContent = "Auto Balance";
      button.setAttribute("aria-label", "Auto Balance");
      button.setAttribute("aria-pressed", String(auto.enabled));
      setStyle(button, "color", auto.enabled ? "#202124" : "#8ab4f8");
      setStyle(button, "background", auto.enabled ? "#8ab4f8" : "#303134");
      setStyle(button, "borderColor", "#8ab4f8");
      button.disabled = false;
    }
    function stopAuto() {
      auto.stop();
      state.autoBalanceEnabled = false;
      state.autoBalanceReady = false;
      updateBalanceButton();
      const status = document.getElementById(`${PANEL_ID}_status`);
      if (status) status.textContent = statusText(state);
    }
    function manualGain(participant, value) {
      stopAuto();
      onGain(participant, value);
    }
    function toggleAuto() {
      if (auto.enabled) stopAuto();
      else {
        auto.start(Date.now());
        state.autoBalanceEnabled = true;
        state.autoBalanceReady = false;
      }
      updateLiveUi();
    }
    function autoTick(now, sampledKey) {
      auto.tick(now, sampledKey);
      state.autoBalanceReady = auto.targetDb !== null;
    }
    function updateLiveUi() {
      if (!state.panel?.isConnected) return;
      updateBalanceButton();
      const status = document.getElementById(`${PANEL_ID}_status`);
      if (status) status.textContent = statusText(state);
      for (const participant of participants()) {
        const row = [...state.panel.querySelectorAll("[data-participant-key]")].find((item) => item.dataset.participantKey === participant.key);
        if (!row) continue;
        const active = state.google.activeParticipantKey === participant.key;
        const badge = row.querySelector('[data-role="badge"]');
        if (badge) {
          badge.style.background = active ? "#8ab4f8" : "#5f6368";
          badge.title = active ? "Active audio" : "Inactive";
        }
        const value = row.querySelector('[data-role="value"]');
        if (value) value.textContent = `${Math.round(participant.value * 100)}%`;
        const slider = row.querySelector('[data-role="slider"]');
        if (slider && document.activeElement !== slider) slider.value = String(participant.value);
        updateLevelMeter(row, participant, levels);
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
      const focused = document.activeElement;
      const focusedInside = [...panel.querySelectorAll("button, input, a")].includes(focused);
      const focusedRow = focusedInside ? focused.closest?.("[data-participant-key]") : null;
      const focusKey = focusedRow?.dataset.participantKey;
      const focusIndex = focusedRow ? [...focusedRow.querySelectorAll("button, input")].indexOf(focused) : -1;
      const focusLabel = focusedInside ? focused.getAttribute("aria-label") || focused.textContent : null;
      panel.replaceChildren();
      panel.style.display = "block";
      Object.assign(panel.style, panelStyles);
      if (state.settings.position) Object.assign(panel.style, { left: `${state.settings.position.left}px`, top: `${state.settings.position.top}px`, right: "auto" });
      else Object.assign(panel.style, { right: "12px", top: "72px", left: "auto" });
      const header = document.createElement("div");
      Object.assign(header.style, headerStyles);
      const titleWrap = document.createElement("div");
      Object.assign(titleWrap.style, { minWidth: "0", flex: "1 1 auto" });
      const title = document.createElement("div");
      title.textContent = "Google Meet Audio Booster";
      Object.assign(title.style, { fontWeight: "700", fontSize: "13px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" });
      const subtitle = document.createElement("div");
      const outputCount = state.google.mode === "media" ? state.google.mediaPipelines.length : state.google.slots.length;
      subtitle.textContent = `${listItems.length} participant${listItems.length === 1 ? "" : "s"} · ${outputCount} ${state.google.mode === "media" ? "media stream" : "audio slot"}${outputCount === 1 ? "" : "s"}`;
      Object.assign(subtitle.style, { opacity: "0.68", fontSize: "11px", marginTop: "2px" });
      titleWrap.append(title, subtitle);
      const body = document.createElement("div");
      body.id = `${PANEL_ID}_body`;
      function toggleCollapsed() {
        state.panelCollapsed = !state.panelCollapsed;
        updateCollapsedUi();
        onCollapse?.(state.panelCollapsed);
      }
      title.ondblclick = toggleCollapsed;
      const collapse = makeButton("", toggleCollapsed);
      collapse.type = "button";
      collapse.setAttribute("aria-controls", body.id);
      Object.assign(collapse.style, { width: "26px", height: "26px", padding: "0", fontSize: "16px", lineHeight: "16px", flex: "0 0 auto" });
      function updateCollapsedUi() {
        body.hidden = state.panelCollapsed;
        body.style.display = state.panelCollapsed ? "none" : "block";
        header.style.marginBottom = state.panelCollapsed ? "0" : headerStyles.marginBottom;
        const label = state.panelCollapsed ? "Expand panel" : "Collapse panel";
        collapse.textContent = state.panelCollapsed ? "+" : "−";
        collapse.title = label;
        collapse.setAttribute("aria-label", label);
        collapse.setAttribute("aria-expanded", String(!state.panelCollapsed));
      }
      updateCollapsedUi();
      const close = makeButton("×", hide);
      close.setAttribute("aria-label", "Close panel");
      Object.assign(close.style, { width: "26px", height: "26px", padding: "0", fontSize: "16px", lineHeight: "16px", flex: "0 0 auto" });
      const controls = document.createElement("div");
      Object.assign(controls.style, { display: "flex", gap: "4px", flex: "0 0 56px" });
      controls.append(collapse, close);
      header.append(titleWrap, controls);
      panel.append(header, body);
      makeDraggable(panel, header, onSave);
      const list = document.createElement("div");
      Object.assign(list.style, { maxHeight: "310px", overflowY: "auto", paddingRight: "4px" });
      if (!listItems.length) {
        const empty = document.createElement("div");
        empty.textContent = "Waiting for remote participants…";
        Object.assign(empty.style, { opacity: "0.75", padding: "8px 0" });
        list.append(empty);
      }
      for (const participant of listItems) list.append(renderParticipantRow(participant, manualGain));
      body.append(list);
      const footer = document.createElement("div");
      Object.assign(footer.style, { display: "flex", justifyContent: "space-between", alignItems: "center", gap: "6px", marginTop: "9px", paddingTop: "8px", borderTop: "1px solid #3c4043" });
      const status = document.createElement("div");
      status.id = `${PANEL_ID}_status`;
      status.textContent = statusText(state);
      Object.assign(status.style, { minHeight: "14px", marginTop: "0", color: "#bdc1c6", fontSize: "11px", lineHeight: "14px", flex: "1 1 auto", minWidth: "0", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" });
      const reset = makeButton("Reset", () => {
        stopAuto();
        for (const participant of participants()) onGain(participant, 1);
        render();
      });
      reset.setAttribute("aria-label", "Reset all participant volumes to 100%");
      reset.style.flex = "0 0 auto";
      balanceButton = makeButton("Auto Balance", toggleAuto);
      balanceButton.onmouseenter = balanceButton.onmouseleave = updateBalanceButton;
      balanceButton.style.flex = "0 0 auto";
      footer.append(status, balanceButton, reset);
      const support = document.createElement("a");
      support.textContent = "Support development";
      support.href = "https://buymeacoffee.com/andreclemente";
      support.target = "_blank";
      support.rel = "noopener noreferrer";
      support.referrerPolicy = "no-referrer";
      support.title = "Optional support — all features remain free";
      Object.assign(support.style, { display: "block", color: "#8ab4f8", fontSize: "11px", textDecoration: "none", lineHeight: "14px", minHeight: "14px", marginTop: "7px" });
      body.append(footer, support);
      state.panel = panel;
      updateLiveUi();
      recoverPosition(panel);
      if (focusKey !== void 0 && focusIndex >= 0) {
        const row = [...panel.querySelectorAll("[data-participant-key]")].find((item) => item.dataset.participantKey === focusKey);
        row?.querySelectorAll("button, input")[focusIndex]?.focus({ preventScroll: true });
      } else if (focusLabel) {
        [...panel.querySelectorAll("button, input, a")].find((item) => (item.getAttribute("aria-label") || item.textContent) === focusLabel)?.focus({ preventScroll: true });
      }
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
    return { render, show, hide, toggle, updateLiveUi, autoTick, stopAuto, invalidateAuto: (now, metadata) => auto.invalidate(now, metadata) };
  }
  function recoverPosition(panel) {
    const rect = panel.getBoundingClientRect();
    if (!Number.isFinite(globalThis.innerWidth) || !Number.isFinite(globalThis.innerHeight)) return;
    const left = Math.max(8, Math.min(rect.left, globalThis.innerWidth - rect.width - 8));
    const top = Math.max(8, Math.min(rect.top, globalThis.innerHeight - rect.height - 8));
    if (left !== rect.left || top !== rect.top) Object.assign(panel.style, { left: `${left}px`, top: `${top}px`, right: "auto" });
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
    globalThis.addEventListener("resize", () => recoverPosition(panel));
    globalThis.addEventListener("mousemove", (event) => {
      const start = panel.__boosterDrag;
      if (!start) return;
      panel.style.left = `${Math.max(8, start.left + event.clientX - start.x)}px`;
      panel.style.top = `${Math.max(8, start.top + event.clientY - start.y)}px`;
      panel.style.right = "auto";
      recoverPosition(panel);
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
      actualValue: Number(slot.actualValue),
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
      localPresentationActive: Boolean(state.google.localPresentationActive),
      transitionGuard: state.google.transitionGuard,
      slots,
      mediaPipelines,
      google: {
        mode: state.google.mode,
        routingState: state.google.routingState,
        localPresentationActive: Boolean(state.google.localPresentationActive),
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
  if (detectPlatform() === "google-meet" && !globalThis.__meetingAudioBoosterInstalled) {
    let getContext = function() {
      state.sharedCtx ||= createAudioContext();
      return state.sharedCtx;
    }, setStatus = function(message) {
      if (state.audioUnavailable) message = "Audio unavailable · controls are inactive";
      state.status = message;
      const status = document.getElementById(`${PANEL_ID}_status`);
      const shown = statusText(state);
      if (status && status.textContent !== shown) status.textContent = shown;
    }, renderSoon = function() {
      if (state.closed) return;
      clearTimeout(state.renderTimer);
      state.renderTimer = setTimeout(() => panel.render(), 120);
    }, applyGain = function(participant, value, { automatic = false } = {}) {
      if (!automatic) panel.stopAuto();
      participant.value = Number.isFinite(value) ? Math.min(6, Math.max(0, value)) : 1;
      participant.adjusted = true;
      if (!automatic) {
        setParticipantGain(state.settings, participant, participant.value);
        saveSettings(globalThis.localStorage, state.settings);
      }
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
      const common = { state, context, setStatus, renderSoon, updateLiveUi: panel.updateLiveUi, onLevelSample: panel.autoTick, onLevelReset: panel.invalidateAuto, onStop: panel.stopAuto, mediaOwnership };
      platformController = createGoogleMeetController(common);
      platformController.start();
      if (!context) setStatus("Audio unavailable · controls are inactive");
      panel.render();
    };
    globalThis.__meetingAudioBoosterInstalled = true;
    const mediaOwnership = installRemoteMediaOwnership();
    const state = createState();
    let platformController = null;
    const panel = createPanelController(state, {
      participants: () => visibleParticipants(state),
      // In-memory pre-volume levels from the controller; never persisted.
      levels: (key, options) => platformController?.levelFor?.(key, options) ?? null,
      onGain: applyGain,
      onCollapse: (collapsed) => {
        state.settings.collapsed = collapsed;
        saveSettings(globalThis.localStorage, state.settings);
      },
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
      value: Object.freeze({ bootApi: "modular-v1", platforms: Object.freeze(["google-meet"]), storageKey: "__meeting_audio_booster_v15" })
    });
    boot();
  }
})();
