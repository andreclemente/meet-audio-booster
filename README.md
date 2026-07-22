# Meeting Audio Booster

Per-participant playback volume controls for Google Meet and Jitsi Meet. Preferences stay in browser `localStorage`; the extension has no telemetry and makes no network requests.

## Features

- Per-participant 0–600% controls, mute, and presets
- Compatible storage under `__meeting_audio_booster_v15`, including panel position
- Draggable panel that can be restored with the extension toolbar button
- Google Meet MAIN-world AudioWorklet interception (including Brave's pooled nodes) and Chromium media-element replay fallback
- Jitsi remote WebRTC track replay with an independent gain node per track
- JSON-serializable diagnostics from `window.__meetingAudioBoosterDebug()`

## Supported sites

The manifest is intentionally limited to `https://meet.google.com/*` and `https://meet.jit.si/*`. No additional hosts or permissions are requested. Self-hosted Jitsi instances are not included.

## Development

Requires Node.js 20 or newer.

```sh
npm install
npm test
npm run build
```

`npm run build` deterministically recreates `dist/` with the bundled MAIN-world script, service worker, manifest, and icons. `npm run watch` rebuilds the script while developing.

### Load unpacked

1. Run `npm install && npm run build`.
2. Open `chrome://extensions`, enable **Developer mode**, and choose **Load unpacked**.
3. Select the generated `dist/` directory (not `src/`).
4. Join a supported meeting and use the panel. If it is hidden, click the toolbar action.

The repository root remains directly loadable for compatibility, but `dist/` is the release artifact.

## Architecture

- `src/storage.js`, `state.js`: compatible preferences and shared state
- `src/ui/`: panel, participant row, and styles
- `src/platforms/google-meet/`: strict roster discovery, targeted speaker detection, per-pipeline RMS/hysteresis, repeated exclusive association learning, pooled AudioWorklet handling, media replay, and conservative routing state machine
- `src/platforms/jitsi/`: peer-connection hook, remote participant extraction, replay, and gain routing
- `src/shared/`: constants, audio/DOM helpers, and safe diagnostics
- `scripts/build.mjs`: MV3 release assembly

Meet's pooled AudioWorklet outputs are deliberately never permanently assigned to people. A speaker handoff resets every output to 100% before a confirmed new setting is applied. Media stream association is learned only after repeated exclusive UI and energy agreement, never from array or DOM order. Ambiguous, stale, overlapping, or unknown observations route at 100%.

## Exact limitations

- Meeting applications can change undocumented DOM and Web Audio internals; participant/speaker selectors may require maintenance.
- Google Meet routing is conservative. During overlap, handoff confirmation, stale UI, or unknown stream association it intentionally uses 100%, so a configured gain can briefly be inactive.
- RMS indicates that a stream carries energy; it cannot identify a person until repeated exclusive alignment establishes an association.
- Audio protected by browser/platform restrictions or created before MAIN-world hooks can be unavailable for replay.
- Jitsi support is limited to `meet.jit.si`; mixed streams that cannot be separated per remote track are excluded.
- Automated tests validate routing, storage, names, energy logic, build output, and MV3 policy, but real calls on current Meet/Jitsi builds still require manual browser testing.

## Privacy

Only gain preferences and panel position are stored locally. See [privacy.md](privacy.md).
