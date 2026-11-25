# Inbox: signing in with an account

Updated: 2026-11-25

Status: implemented in `zosmaai/plannotator`, not yet upstreamed. Passkeys added on top; TOTP
designed but not built (see "TOTP, if it is wanted").

## Summary

A third way to reach the Inbox from another device, after the tailnet and Cloudflare Access: a public name, one account of the Inbox's own, and a password. No Cloudflare account, no tailnet, no Access application. Built on Better Auth (`better-auth` 1.7.25, in `packages/server/package.json`), so the library owns the parts that are easy to get wrong: password hashing (its own scrypt), session cookies, session revocation, rate limiting.

It stays narrow:

- Off and invisible until `plannotator inbox auth on --host <name> --allow <email>` runs; `auth off` closes it and keeps the accounts.
- Nothing changes on this computer. The window keeps its loopback port and its URL; a start with no `inboxAuth` in config.json behaves exactly as before. Signing in happens on a second loopback listener (`19501` by default), and that listener is the only thing a tunnel or proxy points at.
- Accounts exist only because the person made them at the terminal (`plannotator inbox auth add <email>`). There is no self-sign-up.
- Agent routes never come in through it: `/mcp`, `/api/inbox/control/*`, `/api/inbox/bridge/*` and a launched session's permission hook are refused whatever the session, and the dispatch is the Cloudflare door's (`served(req, "tailnet")`).
- A session whose address is not on `inboxAuth.allow` gets nowhere, and the page says so.

## Decisions

**Better Auth, not a hand-written password table.** The alternative was 200 lines of scrypt, cookie signing and session revocation in `packages/server/inbox.ts`. Better Auth ships those with tests, plus the plugins the next steps want (passkeys, TOTP, password reset, magic links), so the seams are already there. It is a Bun-only dependency in `packages/server`, which is Bun-only, so nothing is vendored into the Pi twin.

**A second listener, not a change to the window's port.** The window's port is where agents, the phone door and the window itself live, guarded by Host, Origin and same-site rules that assume "loopback means this computer". A public name has to arrive somewhere else. The door is that somewhere else: loopback only, its own name as `Host` (check 0), its own session, and a dispatch marked `tailnet`, so every existing rule about what a non-local request may reach applies unchanged.

**Accounts at the terminal, not invites in the page.** An Inbox is one person's; the person at the machine is the only one who should be able to mint a login. `auth add` asks for the password twice, un-echoed, and a 12-character floor (`AUTH_MIN_PASSWORD_LENGTH`) is the only policy: a longer list of rules would be advice, and Better Auth's rate limit (10 sign-ins per address per 5 minutes) is what actually stops guessing.

**The allowlist gates entry, the account is the key.** Keeping both means an address can be taken out (it cannot get in, its account is not deleted) without deciding whether the account itself is gone. `auth list` marks an address that is not on the allowlist rather than hiding it, so the two lists cannot silently disagree.

**The window's card writes through the window, and the door is told not to answer itself.** The card could have fetched the door's own port, but then the browser needs a second origin, its CORS and its own guards — and a page served by the door carries the door's session cookie, so someone signed in at the door could change the door from it. Instead the card posts to `/api/inbox/sign-in*` on the window's port, guarded the way every other window route is (same Origin, this computer or the tailnet owner, never the device door or the relay), and nothing that arrived through a door changes how you get in: the sign-in door marks anything it forwarded (`Plannotator-Door: auth`, `markFromAuthDoor`), Cloudflare Access marks its own edge (`fromCfDoor`, the same mark the Access card answers with), and the window answers `403 { code: "local_only" }` (`refuseDoorOrigin`) before those routes run. The two doors are refused for different reasons and agree on the answer: a person who signed in at the sign-in door must not change the accounts and the allow list of the door that admitted them, and Access admits a whole team, so a teammate is not the owner of this Inbox. A door that answers that way is shown, not guessed: the card says where to change it and offers nothing to click.

**Read and write are separate, so a read cannot open a listener.** `configured` means config.json names `inboxAuth` at all — which is why the card offers **Set up** until it does — and `on` means the listener is open. The card makes the first account *before* it posts `on`: an open door nobody can enter locks the owner out of their own Inbox. A turn off keeps the accounts and the list, so opening it again is one click.

**One password floor, one place.** `AUTH_MIN_PASSWORD_LENGTH` lives in `packages/server/inbox-auth-instance.ts`, and the card, the CLI and the refusal all read it from there rather than each keeping a number. The card never changes a password — passwords are typed where they are used — so a forgotten one means remove the account and make it again, the same line the CLI teaches.

**The door's cookies stop at the door.** `scrubAuthDoorHeaders` drops `Cf-*`, `Tailscale-*`, `X-Forwarded-*` and `Plannotator-Door*`, and `withoutAuthCookies` drops `plannotator.session_token` / `__Secure-plannotator.session_token` before anything is handed to the window. The window never learns the door has sessions.

**Passkeys are the door's, not the window's.** A passkey is another way through this door, so it is
managed on the door's own page (`/passkeys`), reachable only with a session — the natural gate, and
no new rule. Putting it in the window's Settings would have meant a signed-out person could not
enrol one, and would have put door state behind the window's own routes. It uses
`@better-auth/passkey` 1.7.25 (the release matched to `better-auth` 1.7.25); the door writes no
ceremony code, and a passkey sign-in makes the same session cookie a password makes, so the
allowlist, the `CLOSED` routes and the cookie stripping are untouched. The relying party is the
door's public name (`rpID` = `inboxAuth.host`, origin = `settings.baseUrl`): a passkey belongs to the
name the person is on, which is why the loopback address cannot use one, and why the page says so under its button.

**The door lists its own passkeys, and never hands a key back.** `GET /api/inbox/auth/passkeys`
answers for the session's user, takes no address from the request, and returns a name, a date and
the door's row id — not `publicKey`, `credentialID` or `counter`. Removing the last passkey of an
account with no password is refused (`409 last_way_in`): a second way in must not become the only
way out. The page's script lives in `inbox-auth-login.ts` beside the sign-in page's, because the CSP
names `'self'` only — a CDN or a `@simplewebauthn/browser` bundle would have broken it.

## TOTP, if it is wanted (designed, not built)

Not built: it needs an enrolment page, recovery codes and a decision about a lost phone, and it
changes the sign-in flow that both the password form and the passkey button sit on. The shape it
should take, so the next person does not have to decide again:

- `@better-auth/two-factor`, behind `inboxAuth.twoFactor: true` — parsed by the existing
  `parseInboxAuthSettings`/`resolveInboxAuth` idiom, no second config mechanism, env override
  `PLANNOTATOR_INBOX_AUTH_TWO_FACTOR` alongside the others.
- Enrolment at `/two-factor` on the door, styled from `AUTH_CSS`, reachable only with a session: a
  QR (drawn as an inline SVG, since the CSP allows no remote image), the secret in text, one code to
  confirm.
- The gate: a session made by password **or passkey** counts as `totpPending` until a code is given;
  the door sends a navigation to `/two-factor?next=…` and answers `401 totp_required` to a call,
  exactly where it answers `auth_required` today. A person who has not enrolled is not asked — the
  password and the passkey stay enough — so enrolment can never lock anyone out.
- `plannotator inbox auth add` prints the recovery codes it makes, and `auth remove` clears them.
- Tests belong beside `inbox-auth-passkey.test.ts`: TOTP is testable with a real code from the
  secret, no authenticator needed.

## Not built

Who else may change these settings from the window (the card is open to anyone the window already lets in — the tailnet owner and this computer — and gating it further needs the session roles the window does not keep yet), a way to change a password from the card, updating one address on the allowlist instead of the whole list, and rate limits on the settings routes. TOTP two-factor (designed above), password reset by email, invites with a link, passkey renaming, recovery codes, and more than one door at a time. Each is a Better Auth plugin away, and none is needed to let one person in at a public name.

## Files

- `packages/shared/inbox/auth-door.ts`: settings, allowlist, `safeNextPath`, `withoutAuthCookies`, `isAuthOwnedPath`, cookie name.
- `packages/server/inbox-auth-instance.ts`: the Better Auth instance, `<dataDir>/auth.sqlite`, `<dataDir>/auth-secret`, `list`/`set`/`remove`, `sessionUser`.
- `packages/server/inbox-auth-door.ts`: the listener and its checks; the registry record (`inbox_auth`).
- `packages/server/inbox-auth-login.ts`: the sign-in page, the passkeys page, `/auth.css`, `/auth.js`, `/passkeys.js`.
- `packages/server/passkey-fixtures.ts`: a software WebAuthn authenticator for tests (no new dependency).
- `apps/hook/server/inbox-auth-command.ts`: `plannotator inbox auth add | list | remove | on | off | status`.
- `packages/server/inbox-auth-routes.ts`: `/api/inbox/sign-in*` for the settings card, and the refusal that runs ahead of them.
- `packages/inbox/components/WithAnAccount.tsx`, `packages/inbox/data/inboxAuth.ts`, `packages/inbox/components/AskTwice.tsx`: the card in Settings → Remote devices, its read and writes, and remove-asked-twice.
- `docs/agent-guides/inbox-sign-in.md`: the guide.

## Tests

- `packages/server/inbox-auth-door.test.ts`: the door end to end on a real listener.
- `packages/server/inbox-auth-passkey.test.ts`: 14 tests, a real WebAuthn ceremony (register, sign in, replay, wrong key, wrong site, another account, the allowlist, removal, the last passkey, the page).
- `apps/hook/server/inbox-auth-command.test.ts`: the command, with the password asked for, config.json, the allowlist note, remove, off, `--json`.
- `packages/server/inbox-auth-routes.test.ts`: the routes against a real door in a temp data dir — never set up, account then open, on and off without losing accounts, the list growing by one, the minimum length, an address off the list, the door's own requests refused, config.json read back after each write.
- `packages/inbox/withAnAccountCard.test.tsx`: the card in the DOM test runner — waits for the read, the set-up form's order and one post at a time, the refused card, remove asked twice, the switch keeping accounts, an added address joining the list.
