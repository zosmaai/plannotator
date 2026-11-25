/**
 * The settings card for the sign-in door: Settings → Remote devices, "Sign in with an account".
 *
 * Same shape as the Cloudflare Access card (`inbox-cf-access-routes.ts`), which is the Inbox's own
 * precedent for a card that changes how the Inbox can be reached: one GET that answers what the door
 * is and what it would take to change it, and POSTs named after the buttons.
 *
 * Who may change it: the Inbox's owner, and nobody else. Not a session — the owner is where the Inbox
 * runs, so a request that came in through a door is the one that is not them. Both doors are refused:
 * the sign-in door (`cameFromAuthDoor`), because a person who got in by signing must not change the
 * accounts and the allow list of the door that let them in, and turning it off from inside locks the
 * next person out — the same reason `bridge` is `local_only`; and Cloudflare Access, because Access
 * admits a whole team, and a teammate is not the person who owns this Inbox. The Access card already
 * refuses its own door that way (`fromCfDoor` in `inbox.ts`), so this card answers the same question
 * the same way. What is left is this computer and the owner's tailnet, which is what the Access card's
 * writes run on too: to open a door at all you have to be somewhere that is not that door. Gating
 * this card with sessions instead would close the tailnet path the Access card depends on, so it does
 * not happen here; said in `adr/implementation/inbox-auth.md`.
 */
import { loadConfig, saveConfig } from "@plannotator/shared/config";
import { existsSync } from "node:fs";
import { isEmailAddress, isPublicDnsName } from "@plannotator/shared/inbox/cf-access";
import {
  AUTH_LOGIN_PATH,
  cameFromAuthDoor,
  isAllowedAuthEmail,
  normalizeAuthEmail,
  parseAuthAllowList,
  parseInboxAuthSettings,
  resolveInboxAuth,
  storedInboxAuth,
  type InboxAuthStored,
} from "@plannotator/shared/inbox/auth-door";
import { AUTH_MIN_PASSWORD_LENGTH, inboxAuthDatabaseFile, openInboxAuth } from "./inbox-auth-instance";
import type { InboxAuthDoor } from "./inbox-auth-door";

export const AUTH_ROUTE = "/api/inbox/sign-in";

/** Paths a plain read may ask for; every other path under the route is a write. */
export const AUTH_READ_PATHS = [AUTH_ROUTE] as const;

export interface AuthRouteContext {
  dataDir: string;
  /** The door, for turning it on and off and for the last failure it met. */
  door: Pick<InboxAuthDoor, "restart" | "state">;
  json: (data: unknown, status?: number) => Response;
  readBody: (req: Request) => Promise<Record<string, unknown> | null>;
  /**
   * The window's `serverSession` nonce, checked the way every other card checks it (`inbox.ts`):
   * a card left open across an Inbox restart must not write to the server that replaced it.
   */
  sessionMismatch?: (body: Record<string, unknown> | null) => Response | null;
}

/** What an account looks like to the card. */
export interface AuthAccountView {
  email: string;
  name: string;
  createdAt: string;
  lastSeenAt: string | null;
  /** False when the address is off the list of addresses that may enter: the account exists, the door still refuses it. */
  allowed: boolean;
}

export interface AuthView {
  /** Whether this Inbox has ever been set up for a sign-in. */
  configured: boolean;
  /** Whether the door is listening now. */
  on: boolean;
  host: string;
  port: number;
  /** Where people sign in, or empty when there is no address to sign in at. */
  url: string;
  /** The addresses that may enter. */
  allow: string[];
  /** The door's last failure — a port another program took, settings that do not parse. */
  error: string;
  minPasswordLength: number;
  accounts: AuthAccountView[];
  /** A setting from the environment, which this card can show but cannot change. */
  pinnedByEnvironment: boolean;
}

/** The same shape the Access card and the door answer with: `answer()` in the window turns it into a thrown refusal. */
interface Refusal {
  error: string;
  code: string;
}

/**
 * The mount's one rule, kept where it can be tested: the owner changes how you get in, and a request
 * that arrived through a door did not. `fromAccessDoor` is the mount's own knowledge — Cloudflare
 * Access puts its own mark on what it forwards, and only `inbox.ts` can see it — so both answers come
 * in here rather than as two separate 403s that would drift apart. Asked from the computer itself or
 * over the owner's tailnet, neither flag is set and the card works.
 */
export function refuseDoorOrigin(
  req: Request,
  json: (data: unknown, status?: number) => Response,
  fromAccessDoor = false,
): Response | null {
  if (!cameFromAuthDoor(req) && !fromAccessDoor) return null;
  return json({ error: "Only the Inbox's owner changes how you get in. Change this on the computer itself or over your tailnet.", code: "local_only" } satisfies Refusal, 403);
}

export function createAuthRoutes(context: AuthRouteContext) {
  /**
   * What the card shows. The settings come from the same resolver the door starts with, so the card
   * cannot say one thing while the door does another — including a host or port the environment pins.
   */
  async function view(): Promise<AuthView> {
    const config = loadConfig();
    const resolved = resolveInboxAuth(config, process.env, () => false);
    const stored = storedInboxAuth(config);
    const settings = resolved.settings;
    const state = context.door.state();
    const host = settings?.host ?? stored?.host ?? "";
    const allow = settings?.allow ?? stored?.allow ?? [];
    const port = settings?.port ?? stored?.port ?? state.port ?? 0;
    return {
      configured: resolved.configured,
      // What is listening, not what the settings ask for: a door that could not take its port reads
      // `on` here, so the card cannot show a switch on with nothing behind it.
      on: state.on,
      host,
      port,
      url: host ? `https://${host}${AUTH_LOGIN_PATH}` : "",
      allow,
      error: resolved.error ?? state.error ?? "",
      minPasswordLength: AUTH_MIN_PASSWORD_LENGTH,
      accounts: await accountsOf(config, allow),
      pinnedByEnvironment: process.env["PLANNOTATOR_INBOX_AUTH_HOST"] !== undefined || process.env["PLANNOTATOR_INBOX_AUTH_ALLOW"] !== undefined,
    };
  }

  /**
   * The accounts, read from the door's database. Asked for even when the door is closed: the card says
   * the accounts stay, and it can only say that while it can show them. An Inbox that has never had one
   * is left without a file — opening the folder would make the database and its secret just to answer
   * that there is nothing in them.
   */
  async function accountsOf(config: ReturnType<typeof loadConfig>, allow: string[]): Promise<AuthAccountView[]> {
    if (!existsSync(inboxAuthDatabaseFile(context.dataDir))) return [];
    const where = resolveInboxAuth(config, process.env, () => false).settings ?? openWithoutHost(config);
    const auth = await openInboxAuth({ dataDir: context.dataDir, baseUrl: where.baseUrl, allow: where.allow });
    try {
      return (await auth.list()).map((account) => ({
        email: account.email,
        name: account.name,
        createdAt: account.createdAt,
        lastSeenAt: account.lastSeenAt,
        allowed: isAllowedAuthEmail(allow, account.email),
      }));
    } finally {
      auth.close();
    }
  }

  /** A write's answer: the card's view, or the refusal with the status it deserves. */
  function answerWrite(result: AuthView | Refusal): Response {
    if (!("code" in result)) return context.json(result);
    // A config.json that could not be written (locked, or left unreadable) is not the request's fault.
    return context.json(result, result.code === "not_saved" ? 500 : 400);
  }

  /** Which part of the form was wrong. The parser answers with one message; the code names the field, the way `on` names the button. */
  function settingsCode(body: Record<string, unknown> | null): string {
    const stored = storedInboxAuth(loadConfig()) ?? {};
    const host = typeof body?.["host"] === "string" ? body["host"].trim().toLowerCase() : (stored.host ?? "");
    if (!isPublicDnsName(host)) return "bad_host";
    const allow = parseAuthAllowList(body?.["allow"]);
    if (allow.length === 0) return "empty_allow";
    if (allow.some((entry) => !isEmailAddress(entry))) return "bad_allow";
    // Anything else is the parser's own reason: a port another program has taken, a setting the environment pins.
    return "bad_settings";
  }

  /** The settings as the card would save them, run through the parser that guards the door. */
  function nextSettings(body: Record<string, unknown> | null): InboxAuthStored | { error: string } {
    const stored = storedInboxAuth(loadConfig()) ?? {};
    const host = typeof body?.["host"] === "string" ? body["host"] : stored.host ?? "";
    const allow = body?.["allow"] !== undefined ? parseAuthAllowList(body["allow"]) : stored.allow ?? [];
    const port = typeof body?.["port"] === "number" ? body["port"] : stored.port;
    return parseInboxAuthSettings({ host, allow, port }, process.env, () => false);
  }

  /**
   * Save and restart: the door re-reads config.json, so it does this instead of being called. Only the
   * four settings are written — the resolver derives the sign-in address from the host, so a `baseUrl`
   * left in the file would be a second answer to the same question.
   */
  async function apply(settings: InboxAuthStored): Promise<AuthView | Refusal> {
    const landed = saveConfig({ inboxAuth: { on: settings.on, host: settings.host, allow: settings.allow, port: settings.port } });
    if (!landed) {
      return {
        error: "The settings could not be saved to config.json. Fix or remove it on this computer, then try again.",
        code: "not_saved",
      };
    }
    // The door re-reads config.json, so it is told to restart rather than handed the settings.
    await context.door.restart();
    return view();
  }

  /** Add an account, replace the password of one that exists, or take one away. */
  async function manageAccount(body: Record<string, unknown> | null, remove: boolean): Promise<AuthView | Refusal> {
    const email = normalizeAuthEmail(typeof body?.["email"] === "string" ? body["email"] : "");
    if (!email.includes("@") || email.startsWith("@") || email.endsWith("@")) {
      return { error: "That is not an e-mail address.", code: "bad_email" };
    }
    const config = loadConfig();
    const settings = resolveInboxAuth(config, process.env, () => false).settings ?? openWithoutHost(config);
    const auth = await openInboxAuth({ dataDir: context.dataDir, baseUrl: settings.baseUrl, allow: settings.allow });
    try {
      if (remove) {
        await auth.remove(email);
        return view();
      }
      const password = typeof body?.["password"] === "string" ? body["password"] : "";
      if (password.length < AUTH_MIN_PASSWORD_LENGTH) {
        return { error: `A password must be at least ${AUTH_MIN_PASSWORD_LENGTH} characters.`, code: "short_password" };
      }
      const name = typeof body?.["name"] === "string" ? body["name"].trim() : "";
      const { created } = await auth.set({ email, password, name: name === "" ? undefined : name });
      if (!created) {
        // A password replaced for an account that was already signed in: those sessions are ended, the
        // same as when the account leaves.
        await auth.revokeSessions(email);
        return view();
      }
      return allowedAccount(config, settings.allow, email);
    } finally {
      auth.close();
    }
  }

  /**
   * A new account's address goes on the list of addresses that may enter, as the card promises. An
   * account off that list could never sign in, so adding one would be a trap: the door restarts so the
   * new address is one it checks.
   */
  async function allowedAccount(config: ReturnType<typeof loadConfig>, allow: string[], email: string): Promise<AuthView | Refusal> {
    if (isAllowedAuthEmail(allow, email)) return view();
    const stored = storedInboxAuth(config) ?? {};
    const parsed = parseInboxAuthSettings({ ...stored, allow: [...allow, email] }, process.env, () => false);
    // The door's own settings did not parse, so there is no list to write to: the account exists and
    // the card shows the door's own complaint.
    if ("error" in parsed) return view();
    return apply({ ...parsed, on: stored.on === true });
  }

  /**
   * An account can be added before the door has a host worth naming — the Set up card asks for both
   * at once. The address only names the database better-auth opens, so the loopback one is used.
   */
  function openWithoutHost(config: ReturnType<typeof loadConfig>): { baseUrl: string; allow: string[] } {
    const stored = storedInboxAuth(config) ?? {};
    const parsed = parseInboxAuthSettings({ host: stored.host ?? "", allow: stored.allow ?? [], port: stored.port }, process.env, () => false);
    return "error" in parsed ? { baseUrl: `http://127.0.0.1:${stored.port ?? 4352}`, allow: stored.allow ?? [] } : parsed;
  }

  async function handle(req: Request, path: string): Promise<Response | null> {
    if (path === AUTH_ROUTE && req.method === "GET") return context.json(await view());
    if (!path.startsWith(`${AUTH_ROUTE}/`)) return null;
    if (req.method !== "POST") {
      return context.json({ error: `No sign-in action ${req.method} ${path}.`, code: "unknown_action" } satisfies Refusal, 404);
    }

    const body = await context.readBody(req);
    // A card left open across an Inbox restart sends the old server's session: it is not the request's
    // body that is wrong, so nothing is written and the card is told to reload.
    const mismatch = context.sessionMismatch?.(body);
    if (mismatch) return mismatch;

    if (path === `${AUTH_ROUTE}/on`) {
      const settings = nextSettings(body);
      if ("error" in settings) return context.json({ error: settings.error, code: settingsCode(body) } satisfies Refusal, 400);
      // A door with no account on it lets nobody in, so it is not a door: ask for the account first.
      if ((await accountsOf(loadConfig(), settings.allow ?? [])).length === 0) {
        return context.json({ error: "Add an account before turning the door on.", code: "no_account" } satisfies Refusal, 400);
      }
      return answerWrite(await apply({ ...settings, on: true }));
    }

    if (path === `${AUTH_ROUTE}/off`) {
      const stored = storedInboxAuth(loadConfig()) ?? {};
      return answerWrite(await apply({ ...stored, on: false }));
    }

    if (path === `${AUTH_ROUTE}/allow`) {
      const stored = storedInboxAuth(loadConfig()) ?? {};
      const parsed = parseInboxAuthSettings({ host: stored.host ?? "", allow: parseAuthAllowList(body?.["allow"]), port: stored.port }, process.env, () => false);
      if ("error" in parsed) {
        const allow = parseAuthAllowList(body?.["allow"]);
        return context.json({ error: parsed.error, code: allow.length === 0 ? "empty_allow" : "bad_allow" } satisfies Refusal, 400);
      }
      return answerWrite(await apply({ ...stored, allow: parsed.allow }));
    }

    if (path === `${AUTH_ROUTE}/account` || path === `${AUTH_ROUTE}/account/remove`) {
      return answerWrite(await manageAccount(body, path.endsWith("/remove")));
    }

    return context.json({ error: `No sign-in action ${req.method} ${path}.`, code: "unknown_action" } satisfies Refusal, 404);
  }

  return { handle, view };
}
