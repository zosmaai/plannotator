# Inbox: one Inbox, or one each?

Updated: 2026-11-25

Status: proposed. The owner decides; this document is the costing, not the change.

## Status / Context

The sign-in door merged with `main` at `6e3abbe` (zosmaai/plannotator#1). It lets more than one address
into one Inbox and says nothing about what that means. What the code does:

- **Four ways in, one set of data.** The window's own loopback port answers
  `served(req, "local")` (`packages/server/inbox.ts:8762`); the tailnet listener answers
  `served(req, "tailnet")` (`:8800`); the Cloudflare door the same (`:8822`); and the account door is
  built at `:8830-8838` with the comment "Like the Cloudflare door: through the window as `tailnet`, so
  no `/mcp`, no connection route, no device door" (`:8833`) and dispatches at `:8834`. All four land in
  one pipeline.
- **Two gates, and only two.** An account must exist in `<dataDir>/auth.sqlite`
  (`packages/server/inbox-auth-instance.ts:28`), and its address must be on `inboxAuth.allow`
  (`isAllowedAuthEmail`, `packages/shared/inbox/auth-door.ts:76-79`). `sessionUser`
  (`packages/server/inbox-auth-instance.ts:208-212`) checks both and returns `{ id, email, name }`.
- **After the gate, the account disappears.** The door calls `sessionUser` twice
  (`packages/server/inbox-auth-door.ts:163` on the login page, `:186` for every other request) and uses
  the answer only as a yes/no. Then `context.note?.("auth_door_request", { path: … })` (`:207`) records
  the first three path segments, and `context.dispatch(rebuild(req, scrubAuthDoorHeaders(req.headers)))`
  (`:208`) hands the request on. No header names the account; the door's cookies are dropped on the way
  in (`scrubAuthDoorHeaders` at `packages/server/inbox-auth-door.ts:78`, `withoutAuthCookies` at
  `packages/shared/inbox/auth-door.ts:153`) — deliberate, `adr/implementation/inbox-auth.md:29`, "The
  door's cookies stop at the door."
- **What no door hands on, whatever the session.** `CLOSED`
  (`packages/server/inbox-auth-door.ts:61-66`) refuses `/mcp`, `/api/inbox/bridge`,
  `/api/inbox/control` and a launched session's permission hook. So an account at the door can do
  whatever the window can do, and nothing an agent can do.
- **Accounts are minted at the terminal only.** `plannotator inbox auth add | list | remove | on | off |
  status` (`apps/hook/server/inbox-auth-command.ts:15`), and self-sign-up is off
  (`packages/server/inbox-auth-instance.ts:92`). The password floor is 12 (`:26`), sessions live 7 days
  (`:24`). Nothing in the window lists these accounts or shows which one you are: Settings → Accounts
  (`packages/server/inbox.ts:7637`, `packages/core/inbox-types.ts:3101`) reads the *computer's* Claude
  and Codex logins through `cswap`, and its own switch is off (`INBOX_ACCOUNT_SWITCHING: boolean = false`,
  `packages/core/inbox-types.ts:3122`).
- **One data folder, chosen once per process.** `getPlannotatorDataDir()`
  (`packages/shared/data-dir.ts:63`: `PLANNOTATOR_DATA_DIR`, else `~/.plannotator`, else XDG). Nothing in
  a running Inbox chooses a different folder for a different request. In it live the threads
  (`packages/shared/inbox/store.ts`), the devices — `inbox/devices.jsonl`,
  `inbox/device-secrets/<dev id>`, `inbox/device-commands.jsonl`
  (`packages/shared/inbox/devices.ts:5-7`, `:23-25`) — the registry `inbox.json`, and the door's
  `auth.sqlite` and `auth-secret`, the latter 0600 in a 0700 folder
  (`packages/server/inbox-auth-instance.ts:27`, `:73-74`, `:81`).
- **The registry names a run, not a person.** `{ v, pid, port, url, version, token, serverSession,
  startedAt, follows?, home?, tailnet?, lan?, tailscale? }` (`packages/shared/inbox/registry.ts:4`; `token`
  `:48`, "rotates on every start; it guards the connection routes only" `:11`; `serverSession` `:49`).
  `inboxSessionLineage` (`:125`, comment at `:95-98`) keeps previous runs' `serverSession`s so a window left
  open across a restart still belongs to *the same folder*, as does the entry's `inbox/` folder identity —
  device and inode, "a copy has another" (`:101-102`); `probeInboxData` (`:242`) reports "another Inbox
  (pid …) owns … now" when it does not (`:266`). Belonging is proved by a folder and a run, never by an
  account.
- **Messages say where they were written, not who wrote them.** `InboxMessage.author` is an `InboxAuthor`
  (`packages/core/inbox-types.ts:579`, the union at `:310-328`): the person's half is `{ kind: "person" }`
  and nothing else, while an agent's carries `host`, `session`, `name` and, from a linked computer,
  `machine` — an agent is attributed down to the session that wrote, a person to nothing. `InboxSentFrom` is
  `here | tailnet | cloudflare | phone | machine{name, via?}` (`packages/core/inbox-sent-from.ts:12-19`),
  worked out from `{ via, ownNode, cloudflare, window }` (`packages/server/inbox-sent-from.ts:13-24`,
  `inboxRequestSentFrom` `:37`, `sentFromOf` at `packages/server/inbox.ts:5838`) and stored as `sent_from`
  on a person's message (`packages/core/inbox-types.ts:916`) — "absent from this computer": a line written
  at this keyboard records neither a person nor a place.
- **Devices are paired per computer.** Pairing (`packages/server/inbox-devices.ts`, offer lifetime at `:105`)
  stores the token's SHA-256 and never the token (`packages/shared/inbox/devices.ts:14`, `:34`), with the
  secret `0600` in a `0700` folder (`packages/server/inbox-devices.test.ts:191`). Nothing there names a
  person either.

Today's answer, in one line: **many accounts may enter, they share one Inbox, and inside the Inbox they
are indistinguishable.** That is what the door's shape implies, not what anyone chose.

## The two models

### A. One Inbox, several accounts (co-owners)

This is what is built. To make it honest rather than accidental:

- **Who may do what.** Every allowed account owns everything: same threads, same replies, same Settings,
  same archive. No role, and a role should not be added — one needs a per-route check that exists nowhere
  in the pipeline, plus a screen to manage it. The real owner is the person at the terminal: only they can
  run `auth add`, `auth remove`, `auth on`, `auth off`, and only they can read the folder on disk. That is
  already true and keeps for free.
- **The audit trail.** Today there is one line, `auth_door_request`
  (`packages/server/inbox-auth-door.ts:207`), three path segments, and only when debug logging is on
  (`packages/server/inbox.ts:6093` — `note` is passed to the door only when `debugLog` exists, `:8837`;
  off unless `PLANNOTATOR_INBOX_DEBUG` or the config-only flag says otherwise). The seam is tiny:
  `sessionUser`'s `{ id, email, name }` is already in the door's hand at `:186`, so the note gains an
  `account` field. For the stronger version — which person wrote this line in this thread — the field goes
  on `InboxSentFrom` (`packages/core/inbox-sent-from.ts:12-19`) and its facts
  (`packages/server/inbox-sent-from.ts:13-24`), which already carry place and machine and already reach
  every write; `machine` was added the same additive way, so `account` follows it.
- **What "remove someone" means.** `auth remove <email>` asks "Remove … and end its sessions?"
  (`apps/hook/server/inbox-auth-command.ts:17`, `:210`), deletes the account row and nothing else. Their threads
  stay, their machines stay paired, their phones keep working. In model A that is the right meaning, and
  it must be written down: removing a person closes the door, it does not erase them. Taking an address off
  the allowlist is the softer half and is already documented (`docs/agent-guides/inbox-sign-in.md:29`).
- **Two people on one computer.** Nothing changes and nothing can: this computer's own port asks for no
  password — "On this computer nothing asks for a password", `apps/hook/server/inbox-auth-command.ts:22-23`),
  the phone pairs to the computer, `sent-from: here` means this computer. Two people at one keyboard are one person to the Inbox. Say so; it is fine for work and
  wrong for a household.
- **What the UI must show.** One thing: which account you are, so nobody answers a colleague's question
  thinking it is their own — "signed in as ada@…", in the window and on the phone. Nothing else: no member
  list, no owner badges, no "who did this" pane.

Size: a day. `packages/server/inbox-auth-door.ts` (name the account in the note, and pass it in one
header the window may read), `packages/core/inbox-sent-from.ts` + `packages/server/inbox-sent-from.ts`
(the field), `packages/server/inbox.ts:5838` (thread it through), one line in `packages/inbox`.

### B. An Inbox each

Per-account isolation. Every seam it moves, and the honest size of each (an account here means a folder of
its own, not a filter on the one that exists):

| Seam | What changes | Size |
| --- | --- | --- |
| Data folder | A folder per account instead of `getPlannotatorDataDir()` once per process (`packages/shared/data-dir.ts:63`) | day |
| The door | The door must *route*: session → that account's folder, and hold or start one server per account. Today its context takes one `dataDir` and one `dispatch` (`packages/server/inbox-auth-door.ts:47`, `:49`; built once at `packages/server/inbox.ts:8830`) | **rewrite** |
| `serverSession`, `inboxSessionLineage` | Both prove "this window belongs to this folder's run" (`packages/shared/inbox/registry.ts:49`, `:95-98`, `:125`); each account needs its own, and the window-mark test (`packages/server/inbox-sent-from.ts:20-24`) with them | weeks |
| Registry `inbox.json` | One entry per account per computer — and every reader (Settings, the CLI, the machine link) learns which one. The folder's own identity is checked by device:inode (`packages/shared/inbox/registry.ts:101-102`) | week |
| Tokens | The connection token (`packages/shared/inbox/registry.ts:48`, `:135`) and the device tokens (`packages/shared/inbox/devices.ts`) are minted per folder; per account, every caller that reads "the" token learns whose | week |
| Machines, phones, devices | `inbox/devices.jsonl`, `inbox/device-secrets/` per account (`packages/shared/inbox/devices.ts:5-7`); pairing (`packages/server/inbox-devices.ts:105`), the relay and the machine link become per person | week-plus |
| Threads, attachments, archive, undo | Every store call runs against a per-account store; today one store object is handed around the server and reached from one pipeline | **rewrite** |
| Secret vault | `auth-secret` and `device-secrets/` per folder; the door's signing secret is already per folder (`packages/server/inbox-auth-instance.ts:27`, `:73-74`) | day |
| The CLI | `plannotator inbox …` takes "<data dir> is what 'plannotator data-dir' prints" (`apps/hook/server/cli.ts:707`, `:908`) and launches one Inbox for this directory (`apps/hook/server/inbox-command.ts:156`) | week |
| The phone door | Pairing and the phone's token are per computer today (`packages/server/inbox-devices.ts`); per person an account has to enter the pairing flow | week |
| Two Inboxes open on one computer | The window's origin and window-mark rules assume one Inbox per port; two open windows mean two origins, two sessions, two agent sets — and agents live on the computer | **rewrite** |
| Agents | A session, its launch, its terminal, its permission prompts belong to the computer. Two people's Inboxes on one computer either drive the same agents or each need their own — undecided today | **rewrite** |

Not a feature with a few corners: a second product that shares one screen.

## Security consequences

- **Isolation today: none.** There is no per-account check anywhere between the door and the store. Any
  allowed account can list every thread, read any thread by id, write, archive, delete. In model A that is
  the design and the guide must say it; in model B it is the whole cost.
- **The audit gap is real and double.** Nothing names the account, and the one line that exists is written
  only when debug logging is on. A shared Inbox cannot answer "who answered this?" even after the fact.
- **Deletion and retention.** Threads, attachments, archive and undo are per folder, and nothing is
  per-account, because a record carries no account. In A, leaving the group leaves your words behind; in B,
  leaving would take your folder with you, which nobody has built.
- **Shared machines.** A phone paired by one person shows another person's threads, same screen, same
  pocket. A has to live with that; B has to rebuild pairing.
- **What one password buys.** In A: everything everyone wrote, plus the write path to every agent the
  window can start (the door refuses only `CLOSED`, `packages/server/inbox-auth-door.ts:61-66`). In B: one
  person's threads and their own agents. Better in B, worse everywhere else — and in both, an address typed
  at the terminal is a co-owner of the whole Inbox.

## What the UX rules allow

`AGENTS.md:9`:

> **Never compromise UX.** Plannotator is an open-source product that has to work well and feel like
> magic; it is not an enterprise critical system. Don't add friction for defensive reasons: no extra
> gates, confirmations, owner-only checks, warnings or settings that make it harder to use. Fix real bugs
> without making the product worse to use, and when a safety idea would cost UX, ask the owner first.

`AGENTS.md:10`:

> **One experience across a person's devices.** Every Inbox feature works the same on a thread, agent or
> project that lives on another of the person's linked machines as on this one: tagging, Priority, pins,
> starting agents, replying, anything. Never ship a feature that works only on this machine's own threads,
> and never add a rule that treats a linked machine's thread differently.

And the door's own record, `adr/implementation/inbox-auth.md:25`: "An Inbox is one person's; the person at
the machine is the only one who should be able to mint a login" — echoed at
`docs/agent-guides/inbox-sign-in.md:37`: "`auth add` is the invite, and the person at the machine is the
only one who makes accounts."

Both rules lean toward A. Model B's smallest honest UI is a picker — "whose Inbox am I in?" — at every entry
point: window, phone, CLI, the next machine. That is the gate `AGENTS.md:9` forbids. And `AGENTS.md:10` bites
harder: one person's threads on two computers must still behave as one Inbox, so the machines feature gets
rebuilt per account.

Smallest UI change: **A** one line, "signed in as …". **B** an account picker plus a per-account phone
pairing flow, on every runtime.

## Recommendation

**Keep one Inbox, and make co-ownership a written-down state (model A).** The door already treats every
allowed account as the owner; the honest fix is to say that out loud and leave a trail that names the
account, rather than to build isolation nobody asked for. The person at the terminal stays the only one who
mints logins, which is the only real control and the cheapest one.

**The smallest honest first step** — about a day, useful on its own:

1. This ADR: one Inbox, several accounts, each account an owner inside it, the terminal is the root.
2. `auth_door_request` gains `account`, and is recorded whether or not debug logging is on
   (`packages/server/inbox-auth-door.ts:207`, `packages/server/inbox.ts:6093` and `:8837`).
3. `InboxSentFrom` gains `account`, so a thread says which person wrote each line the way it already says
   which machine (`packages/core/inbox-sent-from.ts:12-19`, `packages/server/inbox-sent-from.ts:13-24`).
4. One line in the window and on the phone: "signed in as ada@…".
5. A paragraph in `docs/agent-guides/inbox-sign-in.md` — who may get in, what they can do, what `auth remove`
   does and does not do. "Who can get in, what they can do" is that guide's subject, not a new guide's.

**What I would not build, and why.** No roles, no per-thread permissions, no per-account folders, no link
invites, no member screen, no per-account pairing, no "who changed this" UI. Each either contradicts
`AGENTS.md:9` (a gate, a check, a screen to learn) or is a slice of model B's rewrite taken out of context.
If a real second tenant turns up — a team that must not read each other's threads — cost model B again then,
with that user in front of you.

## Consequences, Risks, Alternatives considered

- **If A is chosen:** the allowlist becomes the whole security boundary, so `auth add` deserves a warning
  sentence in the guide. Threads gain an `account` field, additive; old records read unchanged. Machines and
  phones stay per computer — right for every work case, wrong for a shared household.
- **Risks of A.** A shared address defeats attribution. Co-owners can delete each other's threads and nothing
  stops them; the archive and Undo are the recovery, as they already are. And someone new may open the window
  and find a stranger's threads — the "signed in as" line does not cover that surprise, the guide paragraph
  does.
- **Risks of B.** All of the table, and the rewrite rows are the product's shape, not a feature: the agent
  side lives on the computer and does not know accounts exist.
- **Alternatives considered.**
  - *Do nothing, and say so in the guide.* Cheapest and defensible: the door is off until someone runs
    `auth on`, and the only way in is an address the owner typed at the terminal. Its cost is silence — two
    people share a thread list with no signal the other is there and no record of who said what. If the
    owner picks this, one paragraph in `inbox-sign-in.md` is the whole job.
  - *A now, B if a real tenant appears.* This is the recommendation.
  - *Read-only guests* (see everything, answer nothing). Needs the per-route check A avoids; not worth it
    for a window at one person's machine.

## Findings

Recorded, not fixed.

- `packages/server/inbox-auth-door.ts:186`, `:207-208` — the door holds the account (`signed`) and throws it
  away: not in the note, not in a header, not in the dispatch.
- `packages/server/inbox.ts:6093`, `:8837` — `note` reaches the door only when debug logging is on, so a
  normal install leaves no trace of any door request; and the note keeps only three path segments
  (`inbox-auth-door.ts:207`), so it could not name a thread even when written.
- `packages/server/inbox.ts:7637`, `packages/core/inbox-types.ts:3101` — "Accounts" in the window means the
  computer's Claude and Codex logins, not the door's accounts; nothing lists the door's accounts or shows
  who you are, and the same word means two things in one product.
- `packages/server/inbox-auth-instance.ts:25-26` — the comment over the password floor reads "Shorter than
  better-auth's default of 8: this is one person's Inbox, not a public sign-up service", and the constant
  below it is `AUTH_MIN_PASSWORD_LENGTH = 12`, which is longer than 8. The reason given and the number
  disagree; the guide keeps the number and drops the reason (`docs/agent-guides/inbox-sign-in.md:27`).
- `packages/server/inbox-auth-door.ts:78` + `packages/shared/inbox/auth-door.ts:153` (and
  `adr/implementation/inbox-auth.md:29`) — the door's cookies and identity headers stop at the door, which
  is right for isolation and is also why the window cannot render "signed in as …": the fix must open a
  one-way seam (a single identity header the window may read) rather than reuse one that exists.
- `packages/shared/inbox/devices.ts:5-7`, `packages/server/inbox-devices.ts:105` — devices, phones and
  machine links belong to the computer; two people on one computer cannot be told apart, and a phone paired
  by one sees the other's everything.
- `packages/server/inbox-devices.ts:1257` — the phone door's allowlist carries `GET /api/inbox/accounts`,
  another per-computer read presented through a per-device door.
- `apps/hook/server/inbox-auth-command.ts:210` — `auth remove` ends sessions and deletes the account row
  only; threads, pairings and machines are untouched. Right for co-ownership, written nowhere.
- `packages/core/inbox-types.ts:310-328`, `:579`, `:916` — `InboxAuthor`'s person case carries no fields at
  all, and `sent_from` is absent for a message written at this computer. The Inbox cannot say who wrote a
  line even to itself, and the case with the least recorded is the owner's own keyboard; anything that wants
  to answer "who did this" starts in that union.
- `packages/shared/inbox/registry.ts:49`, `:95-98`, `:101-102`, `:125` — the window's proof of belonging
  (`serverSession`, the lineage, the folder's device:inode) proves a folder and a run. Per-account
  isolation has to rebuild that proof per account; it is not a flag.
- `packages/server/inbox-auth-door.ts:47` — the door's context takes one `dataDir`, so model B is not a
  routing tweak inside the door but a different shape of server.
- `packages/server/inbox-auth-door.ts:61-66` — `CLOSED`, four patterns, is all that stands between an account
  and the agent-facing routes; every new agent route has to be added to it by hand.
