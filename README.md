# NovelAI User Scripts

NovelAI `.naiscript` tools developed in this workspace.

## Scripts

- [Character Commentator](character-commentator.naiscript) — lets Lorebook characters comment on story events. Version 2.8.7 generates missing portraits with NovelAI Diffusion V5 Full, using NovelAI's `fur dataset` prompt tag for animal and creature species, including upright anthros. Portrait prompts request centered vertical bust framing from the upper chest up, with the full head and shoulders visible. GLM-4-6 writes natural-language visual summaries saved as `Appearance:` and `Appearance Form:` lines in each character's Lorebook entry. The summary prioritizes current transformations and named forms over prior state, and dedicated appearance fields over generic attributes. The `Automatically Generate Missing Avatars` setting defaults on and disables appearance analysis, image generation, and summary saving when switched off. A `Retry Avatar` button appears when an appearance summary exists; it runs a fresh summary and image generation pass, then updates the avatar while keeping the comment and retry controls visible.
- [Lorebook Growth Reviewer](Lorebook_Growth_Reviewer.naiscript) — reviews Lorebook entries for newly established facts and proposes updates after enough new words are added. Version 1.7.0.
- [Prose Coach](Prose_Coach.naiscript) — provides focused writing coaching for show-don't-tell, action tags, and selected text. Version 1.6.61.
- [Word Spellcheck Helper](Word_Spellcheck.naiscript) — checks a selected word and suggests alternatives. Version 1.0.1.

## Character Commentator bridge

Install [`Bridge.user.js`](Bridge.user.js) v3.0.42 in Tampermonkey or Violentmonkey, then import `character-commentator.naiscript` into NovelAI. Its `.user.js` URL supports one-click installation and GitHub-based updates. The bridge connects missing-avatar generation to NovelAI's image generator and returns the generated image for storage in the configured Lorebook entry.

Character Commentator v2.10.4 adds `Generate Temporary Expressions` (disabled by default). When enabled and a character already has a saved avatar, it infers emotion from the generated comment and uses that original avatar as V4.5 Full Character & Style Precise Reference. Expression prompts also include the saved Avatar Style sentence and the character's saved `Appearance:` description when available. A saved `Appearance Form: NONHUMAN` marker adds `fur dataset`, matching base-avatar generation; humanoid or missing markers do not add it. The comment appears immediately with the saved avatar; its expression updates when image generation finishes, preserving the visible comment panel, buttons and callback. New avatars get expression variants on subsequent requests. Expression images are never written to the Lorebook, bridge image database or cache, or downloaded. Each expression consumes image-generation Anlas, including the Precise Reference surcharge. Enable this setting to opt in to that cost. Missing or older bridges skip expressions; generation failures keep the saved portrait.
