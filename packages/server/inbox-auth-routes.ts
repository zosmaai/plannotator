/**
 * The settings card for the sign-in door: Settings → Remote devices, "Sign in with an account".
 *
 * Same shape as the Cloudflare Access card (`inbox-cf-access-routes.ts`), which is the Inbox's own
 * precedent for a card that changes how the Inbox can be reached: one GET that answers what the door
 * is and what it would take to change it, and POSTs named after the buttons.
 *
 * Why this card is not behind a session. The Access card's writes are open to an anonymous request
 * on the main listener on purpose: to turn the door on from the tailnet you have to be on the
 * tailnet and not signed in at a door that does not exist yet. The main listener is the tailnet (or
 * this computer), so that is the trust the card already runs on — and turning the Access card on
 * publishes an Inbox to the internet, which is a wider step than this card can take. What this card
 * must not do is answer to someone who got in by signing at the door: that person would be changing
 * the accounts and the allow list of the door that let them in, and turning it off from inside locks
 * the next person out — the same reason `bridge` is `local_only`. So `inbox.ts` refuses a request the
 * door forwarded (`cameFromAuthDoor`), and the card says to change this on the computer itself or
 * over the tailnet. Gating this card with sessions as well would close the tailnet path the Access
 * card depends on, so it does not happen here; said in `adr/implementation/inbox-auth.md`.
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
  onAfterChange?: () => void;
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
 * The mount's one rule, kept where it can be tested: a request that came in through the sign-in door
 * does not get to change the door. It is the only card in Settings whose subject is the lock on the
 * room, and a sign-in that could close the door behind it would leave the next person outside — the
 * same reason `bridge` is `local_only`. Asked from the computer itself or over a tailnet it works.
 */
export function refuseDoorOrigin(req: Request, json: (data: unknown, status?: number) => Response): Response | null {
  if (!cameFromAuthDoor(req)) return null;
  return json({ error: "The sign-in door cannot change itself. Change it on the computer itself or over your tailnet.", code: "local_only" } satisfies Refusal, 403);
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
    let accounts: AuthAccountView[] = [];
    // Asked for even when the door is closed: the card says the accounts stay, and it can only say
    // that while it can show them. An Inbox that has never had one is left without a file — opening
    // the folder would make the database and its secret just to answer that there is nothing in them.
    if (existsSync(inboxAuthDatabaseFile(context.dataDir))) {
      const where = settings ?? openWithoutHost(config);
      const auth = await openInboxAuth({ dataDir: context.dataDir, baseUrl: where.baseUrl, allow: where.allow });
      try {
        accounts = (await auth.list()).map((account) => ({
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
    return {
      configured: resolved.configured,
      on: resolved.on,
      host,
      port,
      url: host ? `https://${host}${AUTH_LOGIN_PATH}` : "",
      allow,
      error: resolved.error ?? state.error ?? "",
      minPasswordLength: AUTH_MIN_PASSWORD_LENGTH,
      accounts,
      pinnedByEnvironment: process.env["PLANNOTATOR_INBOX_AUTH_HOST"] !== undefined || process.env["PLANNOTATOR_INBOX_AUTH_ALLOW"] !== undefined,
    };
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
  async function apply(settings: InboxAuthStored): Promise<AuthView> {
    saveConfig({ inboxAuth: { on: settings.on, host: settings.host, allow: settings.allow, port: settings.port } });
    await context.door.restart();
    context.onAfterChange?.();
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
      // A password replaced for an account that was already signed in: those sessions are ended, the
      // same as when the account leaves.
      if (!created) await auth.revokeSessions(email);
      return view();
    } finally {
      auth.close();
    }
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

    if (path === `${AUTH_ROUTE}/on` && req.method === "POST") {
      const body = await context.readBody(req);
      const settings = nextSettings(body);
      if ("error" in settings) return context.json({ error: settings.error, code: settingsCode(body) } satisfies Refusal, 400);
      return context.json(await apply({ ...settings, on: true }));
    }

    if (path === `${AUTH_ROUTE}/off` && req.method === "POST") {
      const stored = storedInboxAuth(loadConfig()) ?? {};
      return context.json(await apply({ ...stored, on: false }));
    }

    if (path === `${AUTH_ROUTE}/allow` && req.method === "POST") {
      const body = await context.readBody(req);
      const stored = storedInboxAuth(loadConfig()) ?? {};
      const parsed = parseInboxAuthSettings({ host: stored.host ?? "", allow: parseAuthAllowList(body?.["allow"]), port: stored.port }, process.env, () => false);
      if ("error" in parsed) {
        const allow = parseAuthAllowList(body?.["allow"]);
        return context.json({ error: parsed.error, code: allow.length === 0 ? "empty_allow" : "bad_allow" } satisfies Refusal, 400);
      }
      return context.json(await apply({ ...stored, allow: parsed.allow }));
    }

    if ((path === `${AUTH_ROUTE}/account` || path === `${AUTH_ROUTE}/account/remove`) && req.method === "POST") {
      const result = await manageAccount(await context.readBody(req), path.endsWith("/remove"));
      return "code" in result ? context.json(result, 400) : context.json(result);
    }

    if (path.startsWith(`${AUTH_ROUTE}/`)) {
      return context.json({ error: `No sign-in action ${req.method} ${path}.`, code: "unknown_action" } satisfies Refusal, 404);
    }

    return null;
  }

  return { handle, view };
}
