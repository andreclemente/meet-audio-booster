# Privacy Policy

Last updated: 2026-10-29

Meet Audio Booster does not collect, transmit, sell, or store personal information outside your browser.

## What the extension does

The extension runs only on `https://meet.google.com/*`. It reads the meeting page's participant and audio state to provide local per-participant playback volume controls. It does not support arbitrary or self-hosted meeting sites.

## Local data

The following preferences are stored in browser `localStorage`:

- Per-participant volume preferences
- Floating panel position
- Whether the panel is collapsed or expanded

Participant names or platform IDs may form local preference keys. This information remains in your browser's site storage. Clear site data for the supported meeting sites to remove it; uninstalling the extension does not necessarily clear site storage.

## Data collection

Meet Audio Booster:

- Does not send data to a server
- Does not use analytics, tracking, cookies, or advertising
- Does not share information with third parties
- Does not load remote code

## Optional external support

The optional Support development link opens `https://buymeacoffee.com/andreclemente` in a new tab only when clicked. No support widget, background request, or remote code is loaded by this link before a click. The URL includes no participant or meeting data; the link uses `noopener noreferrer` and `referrerPolicy="no-referrer"`. Once opened, Buy Me a Coffee handles the visit under its own privacy policy and terms. All extension features remain free, and local settings remain in your browser.

## Permissions

Access to Google Meet lets the extension discover remote participants and adjust local audio playback. The `scripting` permission lets the toolbar action call the already-installed MAIN-world panel show API. No other host permissions are requested.
