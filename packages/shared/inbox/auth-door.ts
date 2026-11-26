import type { PlannotatorConfig } from "../config";
import { isEmailAddress, isPublicDnsName, normalizeCfAccessEmail } from "./cf-access";

/**
 * The Inbox's sign-in door: a second loopback listener (like the tailnet's and
 * Cloudflare Access's) that asks for a session before it hands a request to the
 * window. It exists for people who want the Inbox on a public address without
 * Cloudflare Access or Tailscale, with accounts of its own.
 *
 * Off and invisible until `inboxAuth` is set in config.json (or the env names
 * it). The window's own loopback port is untouched: on this computer nothing
 * asks for a password.
 */

export const INBOX_AUTH_ENV = "PLANNOTATOR_INBOX_AUTH";
export const INBOX_AUTH_PORT_ENV = "PLANNOTATOR_INBOX_AUTH_PORT";
/**
 * The port the door's *address* carries, for a person whose proxy ends TLS somewhere other than 443 —
 * `4255` for `tailscale serve --https=4255`, where people sign in at
 * `https://inbox.example.com:4255`. Opt-in, and nothing about signing in depends on it: the door
 * answers its name at whatever port it is published at (`doorAnswersHost`) and accepts a sign-in from
 * the origin the request actually arrived at (`doorOrigins`), with this unset.
 *
 * What it decides is the address the door calls itself: the URL it prints on its pages, the URL the CLI
 * and Settings show, and the URL written into the registry — for people who want that address pinned to
 * one port. It does not narrow the `Host` allowlist. It does decide where a passkey lives: with it set,
 * keys are minted and accepted at `https://<host>:<port>`, and the bare name keeps accepting them too
 * (`passkeyOrigin`, `passkeyOrigins`, `doorOffersPasskeys`). Change the pinned port and the keys made at
 * the old one have to be registered again.
 */
export const INBOX_AUTH_HTTPS_PORT_ENV = "PLANNOTATOR_INBOX_AUTH_HTTPS_PORT";
export const INBOX_AUTH_HOST_ENV = "PLANNOTATOR_INBOX_AUTH_HOST";
export const INBOX_AUTH_ALLOW_ENV = "PLANNOTATOR_INBOX_AUTH_ALLOW";
/** The secret better-auth signs sessions with. Generated into the data folder when unset. */
export const INBOX_AUTH_SECRET_ENV = "PLANNOTATOR_AUTH_SECRET";
export const DEFAULT_INBOX_AUTH_PORT = 19501;
/**
 * The address the door listens on. `127.0.0.1` is the right default because the thing that publishes
 * the door (`tailscale serve`, Cloudflare Access, a TLS proxy) usually runs on this same machine.
 *
 * It is the wrong address when that proxy runs somewhere else and reaches this machine over its own
 * network: in a container or a VM, `tailscale serve` on the host proxies to the container's address,
 * while a listener bound to `127.0.0.1` inside the container answers its own loopback only. The
 * published address then answers 502 and the door logs nothing, because no request ever reaches it.
 * `PLANNOTATOR_INBOX_AUTH_BIND=0.0.0.0` (or the machine's address) is what such a setup needs.
 *
 * Binding wider does not widen who may come in: `Host` is still checked by `doorAnswersHost` and
 * every request still needs a session.
 */
export const INBOX_AUTH_BIND_ENV = "PLANNOTATOR_INBOX_AUTH_BIND";
export const DEFAULT_INBOX_AUTH_BIND = "127.0.0.1";

/** The address the door's listener takes: `PLANNOTATOR_INBOX_AUTH_BIND`, or loopback when it is unset or blank. */
export function doorBindAddress(env: NodeJS.ProcessEnv = process.env): string {
  const asked = (env[INBOX_AUTH_BIND_ENV] ?? "").trim();
  return asked === "" ? DEFAULT_INBOX_AUTH_BIND : asked;
}
/** Better-auth's own base path; nothing else may take it. */
export const AUTH_BASE_PATH = "/api/auth";
export const AUTH_LOGIN_PATH = "/login";
/**
 * Passkeys at the door: the page that lists and removes them, and the door's own two endpoints for
 * that. They are door paths and not window paths — the window is the Inbox on this computer, which is
 * already signed in by being here — and they name the signed-in account by its session, never by an
 * address in the request, so a call cannot ask for somebody else's passkeys.
 */
export const PASSKEY_PAGE_PATH = "/passkeys";
export const PASSKEY_JS_PATH = "/passkeys.js";
export const PASSKEY_API_PATH = "/api/inbox/auth/passkeys";
/** The page's own assets, served by the door and by nobody else. */
export const AUTH_ASSET_PATHS = ["/auth.css", "/auth.js", PASSKEY_JS_PATH] as const;
/** Every cookie the door's auth sets starts with this, and none of them reaches the window. */
export const AUTH_COOKIE_PREFIX = "plannotator";

export interface InboxAuthStored {
  on?: boolean;
  port?: number;
  host?: string;
  allow?: string[];
  /**
   * Opt-in: the port the door's own address carries, when the person wants it written down rather than
   * discovered from the request. Absent (or null, which a save writes when the field is cleared) means
   * the address carries no port, which is the normal case and works at any published port.
   */
  httpsPort?: number | null;
}

export interface InboxAuthSettings {
  port: number;
  host: string;
  allow: string[];
  /** The published HTTPS port the person pinned; null when the address carries no port. */
  httpsPort: number | null;
  /** The address the door calls itself: the name, with `:<httpsPort>` when one was pinned. */
  baseUrl: string;
}

/**
 * The address the door calls itself, from what config.json holds: `https://<host>`, with `:<httpsPort>`
 * when the person pinned one. Null when no host is configured.
 *
 * One place derives it, so the door's `baseUrl`, its card, its CLI line and its registry entry cannot
 * disagree about whether the address carries a port. It is what the door *says*; what it answers is
 * `doorAnswersHost`, and what a sign-in may come from is `doorOrigins`.
 */
export function authDoorUrl(stored: Pick<InboxAuthStored, "host" | "httpsPort"> | null | undefined): string | null {
  const host = typeof stored?.host === "string" ? stored.host.trim().toLowerCase().replace(/\.$/, "") : "";
  if (!host) return null;
  const httpsPort = typeof stored?.httpsPort === "number" ? stored.httpsPort : null;
  return `https://${host}${httpsPort ? `:${httpsPort}` : ""}`;
}

const normalHost = (host: string): string => host.trim().toLowerCase().replace(/\.$/, "");

/**
 * A `Host` header as the door compares it: the name, lower-cased and without a trailing dot, and the
 * port it carries (null when it carries none). Null for anything that is not a name plus an optional
 * port — brackets for IPv6 allowed, a nonsense port refused.
 */
export function parseDoorHost(hostHeader: string): { host: string; port: number | null } | null {
  const header = hostHeader.trim().toLowerCase().replace(/\.$/, "");
  const match = /^(\[[0-9a-f:.]+\]|[^:\[\]]+)(?::(\d{1,5}))?$/.exec(header);
  if (!match?.[1]) return null;
  const port = match[2] ? Number.parseInt(match[2], 10) : null;
  if (port !== null && (!Number.isInteger(port) || port < 1 || port > 65535)) return null;
  return { host: match[1], port };
}

/**
 * Does this `Host` header name this door? On the *name* only, at whatever port the publisher put after
 * it — bare, at `:443`, at `:4255` for `tailscale serve --https=4255`, at whatever the person's proxy
 * chose without ever telling this process.
 *
 * The port cannot be part of the name check, because the door does not know which port it is published
 * at and is not allowed to insist on one. Refusing a port nobody configured turns away the only address
 * the door exists at: every page, every sign-in, the login form included, all `403 forbidden_host`.
 *
 * What is refused is a *name* that is not this door's: another domain pointed at this loopback port, or
 * the loopback address itself, which is not a second way in. A request that carries no `Host` at all
 * answers, as it always has — Bun does hand those through (an HTTP/1.0 request, which is what a local
 * health check sends), it names nothing, so it is not somebody else's name, and it arrives with no
 * `Origin` either, which is what better-auth's own check needs to start a session.
 *
 * The port is not ignored everywhere: the `Origin` a sign-in may come from is this name with this port
 * (`doorOrigins`), so whoever arrives at `:9999` gets the pages and is then held to an
 * `Origin: https://<host>:9999` that no other site can produce.
 */
export function doorAnswersHost(hostHeader: string | null | undefined, settings: Pick<InboxAuthSettings, "host">): boolean {
  const header = hostHeader ?? "";
  if (header.trim() === "") return true;
  const at = parseDoorHost(header);
  return at !== null && at.host === normalHost(settings.host);
}

/**
 * The `Origin`s a sign-in at this arrival may come from: the address the request arrived at, and no
 * other. `Origin` is same-origin or nothing — whoever reaches the loopback port may send
 * `Host: anywhere:1`, but `doorAnswersHost` has already refused a name that is not this door's, so the
 * only port that can appear here is a port after *this* name.
 *
 * It follows the request rather than a setting because the port TLS ended on is the publisher's business,
 * not the door's: `tailscale serve --https=4255`, Caddy on 8443, TLS at the door itself, or plain 443 all
 * sign people in at the address the person used, with nothing written down. A passkey is deliberately not
 * in this list — `passkeyOrigin` and `passkeyOrigins` decide where one lives, from the settings, never
 * from the arrival.
 */
export function doorOrigins(hostHeader: string | null | undefined, settings: Pick<InboxAuthSettings, "host">): string[] {
  const host = normalHost(settings.host);
  const at = parseDoorHost(hostHeader ?? "");
  const port = at && at.host === host ? at.port : null;
  return port === null || port === 443 ? [`https://${host}`] : [`https://${host}`, `https://${host}:${port}`];
}

/**
 * The address a passkey belongs to, from what the door's settings say: `https://<host>` normally, and
 * `https://<host>:<httpsPort>` when the person pinned a published port — the same address `authDoorUrl`
 * derives for everything else the door prints, so the words on the passkey pages and the origin the
 * door mints for cannot disagree.
 *
 * A WebAuthn credential is checked against the exact origin it was made for, which is why this follows
 * the pin rather than the arrival: a key made at `https://<host>` could not come back at
 * `https://<host>:4255`. Pinning the port deliberately moves the keys there, and it is a setting, not a
 * discovery, because the door never learns which port its publisher chose. `rpID` stays the bare name
 * (WebAuthn forbids a port there), and `passkeyOrigins` accepts both addresses, so one key works at the
 * name and at the pinned port; a key made at one pinned port does not work at another.
 */
export function passkeyOrigin(settings: Pick<InboxAuthSettings, "host"> & { httpsPort?: number | null }): string {
  return authDoorUrl(settings) ?? `https://${normalHost(settings.host)}`;
}

/**
 * Every `Origin` a key may be minted for and come back from: the bare name, and the pinned port when one
 * is set. WebAuthn matches on the exact origin, so a person who registered a key before the port was
 * pinned would otherwise lose it, and one who registers at the pinned address would lose it the moment
 * they open the bare name — both addresses are this door's, so both are handed to better-auth's passkey
 * plugin and to `@simplewebauthn/server`, which verify against the list.
 */
export function passkeyOrigins(settings: Pick<InboxAuthSettings, "host"> & { httpsPort?: number | null }): string[] {
  const bare = `https://${normalHost(settings.host)}`;
  const pinned = passkeyOrigin(settings);
  return pinned === bare ? [bare] : [bare, pinned];
}

/** A loopback name: every browser treats `http://127.0.0.1` and `http://localhost` as a secure context. */
export function isLoopbackHost(host: string): boolean {
  return host === "localhost" || host === "::1" || host === "[::1]" || host.startsWith("127.");
}

/**
 * May this arrival run a passkey ceremony?
 *
 * A ceremony needs a page the browser considers secure, and this door's own listener is plain HTTP:
 * whatever publishes it ended TLS somewhere Plannotator did not start and cannot see. So the rule is
 * what the arrival can prove, never what a header claims:
 *
 * - `arrival.tls` — TLS ended on the door's own listener. Not true today (it always binds plain HTTP),
 *   threaded because it is the only real proof available here, and the day the door serves TLS itself
 *   this is one flag rather than a re-think.
 * - a loopback `Host` — http on loopback is a secure context, WebAuthn included. The `Host` allowlist
 *   refuses a loopback name today, because the settings refuse one (`isPublicDnsName`); this is here for
 *   whoever lifts that, and it is pinned at this seam.
 * - otherwise the arrival is at the address the passkeys belong to: this name with no port, with `:443`,
 *   or with exactly the port the person pinned (`passkeyOrigin`, when `httpsPort` is set). Any other port
 *   is refused, because a key is minted for one exact origin: at a port nobody pinned, the browser would
 *   either fail WebAuthn's own origin check or take a key made at a *different* pinned port, so the door
 *   says its line instead of running a ceremony. A key made while one port was pinned does not work at
 *   another pinned port: changing the pin means registering the keys again.
 *
 * `x-forwarded-proto` is not consulted at all. Anything that can reach this loopback port can write it,
 * and a proxy that genuinely ended TLS sends exactly what a liar sends — the two are not
 * distinguishable by header — so a rule here can only ever close a ceremony, never open one. It used to,
 * and that was the wrong trade: a proxy forwarding its own loopback hop as `http` took `/passkeys`, the
 * list of keys and the removal of one away from a person whose browser was on TLS, and revoking a key is
 * the one action that only ever makes an account safer. Only the browser knows whether the page it
 * rendered is secure, and the page says the door's own line itself when `window.isSecureContext` is false.
 *
 * The password door is held to none of this, and neither is the window: only a ceremony needs a secure
 * page, and a proxy may forward its own loopback hop as `http` while serving the person TLS.
 */
export function doorOffersPasskeys(
  headers: Headers,
  settings: Pick<InboxAuthSettings, "host"> & { httpsPort?: number | null },
  arrival: { tls?: boolean } = {},
): boolean {
  if (arrival.tls === true) return true;
  const at = parseDoorHost(headers.get("host") ?? "");
  if (!at) return false;
  if (isLoopbackHost(at.host)) return true;
  if (at.host !== normalHost(settings.host)) return false;
  const pinned = settings.httpsPort ?? null;
  if (at.port !== null && at.port !== 443 && at.port !== pinned) return false;
  return true;
}

export type InboxAuthResolution =
  | { on: false; configured: boolean; settings: null; error: null }
  | { on: true; configured: true; settings: InboxAuthSettings; error: null }
  | { on: true; configured: true; settings: null; error: string };

function truthy(raw: string | undefined): boolean | undefined {
  const v = raw?.trim().toLowerCase();
  if (v === "1" || v === "true" || v === "on") return true;
  if (v === "0" || v === "false" || v === "off" || v === "disabled") return false;
  return undefined;
}

export function parseInboxAuthEnv(env: NodeJS.ProcessEnv = process.env): boolean | undefined {
  return truthy(env[INBOX_AUTH_ENV]);
}

export function storedInboxAuth(config: PlannotatorConfig): InboxAuthStored | null {
  const value = (config as { inboxAuth?: unknown }).inboxAuth;
  return value && typeof value === "object" && !Array.isArray(value) ? (value as InboxAuthStored) : null;
}

export function normalizeAuthEmail(email: string): string {
  return normalizeCfAccessEmail(email);
}

/** The allowlist from a config or env value: lowercased, de-duplicated, addresses only. */
export function parseAuthAllowList(raw: unknown): string[] {
  const parts = typeof raw === "string" ? raw.split(/[\s,]+/) : Array.isArray(raw) ? raw.filter((v): v is string => typeof v === "string") : [];
  return [...new Set(parts.map(normalizeAuthEmail).filter(Boolean))];
}

export function isAllowedAuthEmail(allow: readonly string[], email: string | null | undefined): boolean {
  if (!email) return false;
  const normalized = normalizeAuthEmail(email);
  return normalized !== "" && allow.includes(normalized);
}

export function parseInboxAuthSettings(
  stored: InboxAuthStored,
  env: NodeJS.ProcessEnv = process.env,
  forbiddenPort: (port: number) => boolean = () => false,
): InboxAuthSettings | { error: string } {
  const hostRaw = env[INBOX_AUTH_HOST_ENV] ?? stored.host;
  const host = typeof hostRaw === "string" ? hostRaw.trim().toLowerCase().replace(/\.$/, "") : "";
  if (!isPublicDnsName(host)) return { error: "The hostname must be a public name like inbox.example.com." };

  const portRaw = env[INBOX_AUTH_PORT_ENV] ?? stored.port ?? DEFAULT_INBOX_AUTH_PORT;
  const port = typeof portRaw === "number" ? portRaw : Number.parseInt(String(portRaw), 10);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) return { error: "The listener port must be from 1024 to 65535." };
  if (forbiddenPort(port)) return { error: `Port ${port} is kept for the Inbox's own use.` };

  /**
   * The port the door's own address carries, when the person pinned one. It joins the host in
   * `baseUrl`, which is the address the door prints and copies; it is not needed to sign in at that
   * port (the `Host` allowlist is on the name, and a sign-in's `Origin` follows the request), and it
   * does not move a passkey, which belongs to the bare name.
   */
  const httpsPortRaw = env[INBOX_AUTH_HTTPS_PORT_ENV] ?? stored.httpsPort;
  let httpsPort: number | null = null;
  if (httpsPortRaw !== undefined && httpsPortRaw !== null && String(httpsPortRaw).trim() !== "") {
    const parsed = typeof httpsPortRaw === "number" ? httpsPortRaw : Number.parseInt(String(httpsPortRaw), 10);
    // 443 is already what `https://<host>` means: writing it down would put `:443` into an address no
    // browser ever sends, which is the same bug in the other direction. This is about the pinned address
    // only — a request that arrives at `:443` is answered whether or not anyone pinned a port.
    if (!Number.isInteger(parsed) || parsed < 1024 || parsed > 65535) {
      return { error: "The HTTPS port is the port people type after the name, where your proxy ends TLS (tailscale serve --https=4255). Leave it out when TLS ends at 443." };
    }
    httpsPort = parsed;
  }

  const allow = parseAuthAllowList(env[INBOX_AUTH_ALLOW_ENV] ?? stored.allow);
  if (allow.length === 0) return { error: "The allowlist must name at least one e-mail address." };
  const bad = allow.find((email) => !isEmailAddress(email));
  if (bad) return { error: `"${bad}" is not an e-mail address.` };

  return { port, host, allow, httpsPort, baseUrl: authDoorUrl({ host, httpsPort })! };
}

export function resolveInboxAuth(
  config: PlannotatorConfig,
  env: NodeJS.ProcessEnv = process.env,
  forbiddenPort: (port: number) => boolean = () => false,
): InboxAuthResolution {
  const stored = storedInboxAuth(config);
  const configured = stored !== null && (typeof stored.host === "string" ? stored.host !== "" : env[INBOX_AUTH_HOST_ENV] !== undefined);
  const fromEnv = parseInboxAuthEnv(env);
  const on = configured && (stored?.on === true || fromEnv === true) && fromEnv !== false;
  if (!on || !stored) return { on: false, configured, settings: null, error: null };
  const parsed = parseInboxAuthSettings(stored, env, forbiddenPort);
  return "error" in parsed
    ? { on: true, configured: true, settings: null, error: parsed.error }
    : { on: true, configured: true, settings: parsed, error: null };
}

/** The paths the door answers itself: never handed to the window. */
export function isAuthOwnedPath(path: string): boolean {
  if (path === AUTH_LOGIN_PATH || path === `${AUTH_LOGIN_PATH}/`) return true;
  if ((AUTH_ASSET_PATHS as readonly string[]).includes(path)) return true;
  if (path === PASSKEY_API_PATH || path.startsWith(`${PASSKEY_API_PATH}/`)) return true;
  // `PASSKEY_PAGE_PATH` is deliberately not here: the door answers it, but it is somewhere a
  // signed-in person may be sent back to, so a `?next=/passkeys` is a real destination, not the
  // sign-in page under another name.
  return path === AUTH_BASE_PATH || path.startsWith(`${AUTH_BASE_PATH}/`);
}

/**
 * A `?next=` value that may be sent back to after signing in: a path on this
 * site only. Anything else (another origin, a `//host`, the login page itself)
 * becomes the window's root.
 */
export function safeNextPath(raw: string | null | undefined): string {
  if (typeof raw !== "string" || raw === "") return "/";
  if (!raw.startsWith("/") || raw.startsWith("//") || raw.startsWith("/\\")) return "/";
  let url: URL;
  try {
    url = new URL(raw, "https://door.invalid");
  } catch {
    return "/";
  }
  if (url.origin !== "https://door.invalid") return "/";
  if (isAuthOwnedPath(url.pathname)) return "/";
  return `${url.pathname}${url.search}${url.hash}`;
}

/**
 * True when a Cookie header carries only the door's own cookies (they are dropped before the window sees it).
 *
 * better-auth names its cookie `__Secure-<prefix>.session_token` on HTTPS (and `<prefix>.session_token` on
 * plain HTTP), so the secure prefix is stripped before the name is compared: a cookie the window never sees
 * cannot be mistaken for one it owns, and one it owns never leaks into its own session check.
 */
export function withoutAuthCookies(value: string): string {
  return value
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part !== "")
    .filter((part) => {
      const name = part.slice(0, part.indexOf("=") === -1 ? undefined : part.indexOf("=")).replace(/^__(?:Secure|Host)-/i, "");
      // better-auth names its cookies `<prefix>.<name>`, so the dot is what makes one the door's: a window cookie
      // that happens to start the same letters (`plannotator-sidebar`) is the window's and is left alone.
      return !name.toLowerCase().startsWith(`${AUTH_COOKIE_PREFIX.toLowerCase()}.`);
    })
    .join("; ");
}

/** The cookie better-auth sets for a session on this door (`__Secure-` on HTTPS, as better-auth names it). */
export function authCookieName(secure: boolean): string {
  return `${secure ? "__Secure-" : ""}${AUTH_COOKIE_PREFIX}.session_token`;
}

/** The account whose session the sign-in door checked before it handed a request on. */
export interface InboxAuthDoorAccount {
  email: string;
  name: string | null;
}

/**
 * Requests the sign-in door handed on, remembered by the request object itself, with the account the
 * door checked for them. Nothing about the request says either: by the time the Inbox answers, the
 * door's headers are scrubbed and the address it came from is the machine's own loopback, so the only
 * honest mark is one the door leaves on the object it forwards. The account is marked the same way for
 * the same reason: it is what the door read out of the session it verified, not something the request
 * was allowed to say about itself.
 */
const fromAuthDoor = new WeakMap<Request, InboxAuthDoorAccount | null>();

/**
 * Say that this request arrived through the sign-in door, and as which account when the door read a
 * session. The door calls this on everything it hands on; the account is left out only where the door
 * answered without one, which today it never does.
 */
export function markFromAuthDoor(req: Request, account?: InboxAuthDoorAccount | null): void {
  fromAuthDoor.set(req, account ?? null);
}

/**
 * Did this request come in through the sign-in door? The settings for the door itself are answered
 * with no on every route, so a signed-in stranger could otherwise reach them; this is what tells the
 * Inbox that the person asking is already inside the room the door guards, and that closing it from
 * in there would lock the next person out.
 */
export function cameFromAuthDoor(req: Request): boolean {
  return fromAuthDoor.has(req);
}

/**
 * The account the sign-in door checked for this request, or null when it came in any other way: a
 * paired phone, a linked computer, this computer's own window. Only this door's accounts are told, so
 * a line that reached the Inbox elsewhere is never named by an account this Inbox cannot vouch for.
 */
export function authDoorAccount(req: Request): InboxAuthDoorAccount | null {
  return fromAuthDoor.get(req) ?? null;
}
