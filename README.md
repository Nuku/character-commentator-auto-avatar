# NovelAI User Scripts

NovelAI `.naiscript` tools developed in this workspace.

## Scripts

- [Character Commentator](character-commentator.naiscript) — lets Lorebook characters comment on story events. Version 2.8.5 generates missing portraits with NovelAI Diffusion V5 Full, using NovelAI's `fur dataset` prompt tag for non-humanoid characters. GLM-4-6 writes natural-language visual summaries saved as `Appearance:` and `Appearance Form:` lines in each character's Lorebook entry. The `Automatically Generate Missing Avatars` setting defaults on and disables appearance analysis, image generation, and summary saving when switched off. A `Retry Avatar` button appears when an appearance summary exists; it runs a fresh summary and image generation pass, then updates the avatar while keeping the comment and retry controls visible.
- [Lorebook Growth Reviewer](Lorebook_Growth_Reviewer.naiscript) — reviews Lorebook entries for newly established facts and proposes updates after enough new words are added. Version 1.7.0.
- [Prose Coach](Prose_Coach.naiscript) — provides focused writing coaching for show-don't-tell, action tags, and selected text. Version 1.6.61.
- [Word Spellcheck Helper](Word_Spellcheck.naiscript) — checks a selected word and suggests alternatives. Version 1.0.1.

## Character Commentator bridge

Install [`Bridge.user.js`](Bridge.user.js) v3.0.39 in Tampermonkey or Violentmonkey, then import `character-commentator.naiscript` into NovelAI. Its `.user.js` URL supports one-click installation and GitHub-based updates. The bridge connects missing-avatar generation to NovelAI's image generator and returns the generated image for storage in the configured Lorebook entry.
