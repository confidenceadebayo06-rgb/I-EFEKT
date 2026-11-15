# PWA integration tasks — incremental migration only

- [x] Preserve the existing `public/index.html` and all current UI interactions.
- [x] Connect the existing sign-in, registration and account flows through the same-origin `apiRequest` adapter with `credentials: 'include'` and a non-secret device label.
- [x] Resolve signed-in state by calling `GET /api/me` on startup.
- [ ] Never put passwords, session IDs, JWTs or reset tokens in localStorage or IndexedDB.
- [ ] Keep the current local preference keys readable during the migration.
- [ ] Continue defaulting personalization to off; persist explicit opt-in on the server.
- [ ] Do not cache `/api/auth/*`, `/api/me`, exports, private messages or signed media URLs in the service worker.
- [ ] Keep offline drafts and pending user actions separate from authoritative account state.
- [x] Add a device-management section to the existing Cloud Hub; list active sessions, identify the current device, revoke one session, and sign out other devices.
- [ ] Add a backup import wizard only after sign-in; preview, validate and obtain confirmation before import.
- [ ] Do not clear old localStorage keys until a verified import has completed and the user confirms cleanup.
- [ ] Complete a real desktop browser + mobile PWA sign-in test against staging (the automated staging test simulates two independent device clients; it does not replace physical-device verification).


## Staging session verification

The opt-in integration tests in `tests/security/staging-session-flows.test.mjs` use separate cookie jars to model simultaneous desktop and mobile PWA sessions. Configure these environment variables in a trusted staging runner (never commit them):

- `IEFEKT_TEST_BASE_URL`: staging origin, for example `https://staging.example.com`.
- `IEFEKT_STAGING_TEST_EMAIL` and `IEFEKT_STAGING_TEST_PASSWORD`: a dedicated, verified staging test account.
- Optional password-reset test: `IEFEKT_STAGING_RESET_TOKEN` and `IEFEKT_STAGING_RESET_PASSWORD`. Obtain the token through the staging test mailbox; use a disposable account because the test changes its password and revokes every session.

Run `npm run test:security` with the same environment variables. The staging integration cases are skipped unless their required values are present. Run them only against an isolated staging account, not a production account. A passing API test is not a substitute for checking the installed PWA UI on a physical mobile device.
