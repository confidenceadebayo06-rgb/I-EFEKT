# PWA integration tasks — incremental migration only

- [ ] Preserve the existing `public/index.html` and all current UI interactions.
- [ ] Add a small `authClient` adapter; use same-origin requests and `credentials: 'include'`.
- [ ] Resolve signed-in state by calling `GET /api/me` on startup.
- [ ] Never put passwords, session IDs, JWTs or reset tokens in localStorage or IndexedDB.
- [ ] Keep the current local preference keys readable during the migration.
- [ ] Continue defaulting personalization to off; persist explicit opt-in on the server.
- [ ] Do not cache `/api/auth/*`, `/api/me`, exports, private messages or signed media URLs in the service worker.
- [ ] Keep offline drafts and pending user actions separate from authoritative account state.
- [ ] Add session/device settings only after the session listing and revocation APIs are implemented.
- [ ] Add a backup import wizard only after sign-in; preview, validate and obtain confirmation before import.
- [ ] Do not clear old localStorage keys until a verified import has completed and the user confirms cleanup.
- [ ] Test on two independent browser profiles and a mobile PWA install.
