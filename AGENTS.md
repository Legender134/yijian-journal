# 逸剑手札

Public Windows x64 Electron companion for Wandering Sword.

- Preserve the sandboxed renderer, disabled Node integration and narrow preload API.
- Keep application state outside installation with atomic replacement and a recoverable previous copy.
- Treat game saves as read-only except user-confirmed full restore or explicitly enabled native timeline saves. Restore requires a verified protection copy and stopped game. Native load requires compatibility, account, slot ownership, current-progress protection and verified backups.
- Never remove unrelated saves or silently overwrite a foreign slot. Slot 29 is reserved only after explicit timeline enablement.
- Automated tests use isolated temporary synthetic saves, never launch or attach the real game and never use personal save folders.
- Keep private save files, tokens, notes, diagnostics, build caches and test results out of commits and releases.
- No runtime npm dependencies or telemetry. Electron, packager and Playwright are development dependencies.
- Preserve third-party notices, UE4SS MIT license and hash-pinned provenance. Do not claim game assets or data are licensed as original project code.
- Required verification: `pnpm test`, then `pnpm smoke`. For a release: `pnpm package`, `pnpm test:package`, `pnpm release:zip`; inspect the exact staged files and archive before publishing.
