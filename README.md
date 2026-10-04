# Character Commentator — generated avatars

A Character Commentator NovelAI user script paired with a modified Character Engine Bridge userscript. When a selected Lorebook character has no saved avatar, the commentator requests a portrait from the bridge, saves the returned image data URI in the configured avatar Lorebook entry, and uses it for the comment.

## Files

- `character-commentator.naiscript` — Character Commentator 2.7.2 with automatic missing-avatar generation.
- `Bridge.js` — Character Engine Bridge 3.0.37 with a targeted reply event for generated image data.

## Requirements

- NovelAI User Scripts enabled.
- The Character Engine Bridge userscript installed in a userscript manager such as Violentmonkey or Tampermonkey.
- A Lorebook entry with the configured avatar Lorebook name (defaults to `Avatars`), and Lorebook edit permission when the image is saved.

## Install / update

1. Replace the installed Character Engine Bridge userscript with `Bridge.js`.
2. Import `character-commentator.naiscript` into NovelAI User Scripts.
3. On the first generated comment for a character without an avatar, approve Lorebook editing when prompted. The generated data URI is saved as `Character Name: data:image/...` in the configured avatar entry.

Image generation uses the bridge's NovelAI image-generation integration. If the bridge is unavailable or generation fails, Character Commentator uses its configured default avatar for that comment.

## Notes

The bridge source is based on Character Engine Bridge v3.0.36; this fork adds a reply containing the generated data URI for callers that provide `replyToSid` and `requestId`. The existing authorship and license headers are preserved in the source files.

If the bridge handshake is not detected, Character Commentator shows a **Copy Bridge Link** button. NovelAI's supported script UI does not provide an external-page navigation API, so the button copies the public bridge source URL for the user to open.
