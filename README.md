# NovelAI User Scripts

NovelAI `.naiscript` tools developed in this workspace.

## Scripts

- [Character Commentator](character-commentator.naiscript) — lets Lorebook characters comment on story events. Version 2.7.6 can generate and save missing character portraits when the Character Engine Bridge is installed, using NovelAI's `fur dataset` prompt tag for non-humanoid characters. Generated visual summaries are saved as an `Appearance:` line in each character's Lorebook entry.
- [Lorebook Growth Reviewer](Lorebook_Growth_Reviewer.naiscript) — reviews Lorebook entries for newly established facts and proposes updates after enough new words are added. Version 1.7.0.
- [Prose Coach](Prose_Coach.naiscript) — provides focused writing coaching for show-don't-tell, action tags, and selected text. Version 1.6.61.
- [Word Spellcheck Helper](Word_Spellcheck.naiscript) — checks a selected word and suggests alternatives. Version 1.0.1.

## Character Commentator bridge

Install [`Bridge.js`](Bridge.js) in a userscript manager such as Violentmonkey or Tampermonkey, then import `character-commentator.naiscript` into NovelAI. The bridge connects missing-avatar generation to NovelAI's image generator and returns the generated image for storage in the configured Lorebook entry.
