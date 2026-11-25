# Inbox: signing in with an account

Updated: 2026-11-25

Status: implemented in `zosmaai/plannotator`, not yet upstreamed.

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

**The door's cookies stop at the door.** `scrubAuthDoorHeaders` drops `Cf-*`, `Tailscale-*`, `X-Forwarded-*` and `Plannotator-Door*`, and `withoutAuthCookies` drops `plannotator.session_token` / `__Secure-plannotator.session_token` before anything is handed to the window. The window never learns the door has sessions.

## Not built

Passkeys, TOTP two-factor, password reset by email, invites with a link, and more than one door at a time. Each is a Better Auth plugin away, and none is needed to let one person in at a public name.

## Files

- `packages/shared/inbox/auth-door.ts`: settings, allowlist, `safeNextPath`, `withoutAuthCookies`, `isAuthOwnedPath`, cookie name.
- `packages/server/inbox-auth-instance.ts`: the Better Auth instance, `<dataDir>/auth.sqlite`, `<dataDir>/auth-secret`, `list`/`set`/`remove`, `sessionUser`.
- `packages/server/inbox-auth-door.ts`: the listener and its checks; the registry record (`inbox_auth`).
- `packages/server/inbox-auth-login.ts`: the sign-in page, `/auth.css`, `/auth.js`.
- `apps/hook/server/inbox-auth-command.ts`: `plannotator inbox auth add | list | remove | on | off | status`.
- `docs/agent-guides/inbox-sign-in.md`: the guide.

## Tests

- `packages/server/inbox-auth-door.test.ts`: the door end to end on a real listener.
- `apps/hook/server/inbox-auth-command.test.ts`: the command, with the password asked for, config.json, the allowlist note, remove, off, `--json`.
