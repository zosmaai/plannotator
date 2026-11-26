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
 * The HTTPS port: the port people type after the name when whatever publishes this door ends TLS on a
 * port other than 443. `tailscale serve --https=4255` is exactly that, and the browser at
 * `https://inbox.example.com:4255` then sends `Host: inbox.example.com:4255` and an `Origin` with the
 * same port.
 *
 * This is configured on purpose and never read off the `Host` header the door is asked to answer. The
 * `Host` check is a name allowlist; a door that learned its own HTTPS port from that header would let
 * anything able to reach the loopback port teach it to trust `https://any-name:any-port` as an origin,
 * and would move a passkey's relying party to that name. Trusting what a proxy forwards is fine for a
 * same-site page redirect, which is what a guessed port would be used for; it is not fine for the
 * origin a credential is minted for or the origin a sign-in is accepted from.
 */
export const INBOX_AUTH_HTTPS_PORT_ENV = "PLANNOTATOR_INBOX_AUTH_HTTPS_PORT";
export const INBOX_AUTH_HOST_ENV = "PLANNOTATOR_INBOX_AUTH_HOST";
export const INBOX_AUTH_ALLOW_ENV = "PLANNOTATOR_INBOX_AUTH_ALLOW";
/** The secret better-auth signs sessions with. Generated into the data folder when unset. */
export const INBOX_AUTH_SECRET_ENV = "PLANNOTATOR_AUTH_SECRET";
export const DEFAULT_INBOX_AUTH_PORT = 19501;
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
   * The port the public address carries, when the proxy ends TLS there instead of on 443: `4255` for
   * `tailscale serve --https=4255`, so people sign in at `https://inbox.example.com:4255`. Absent (or
   * null, which a save writes when the field is cleared) means 443, which is what `https://<host>`
   * already means.
   */
  httpsPort?: number | null;
}

export interface InboxAuthSettings {
  port: number;
  host: string;
  allow: string[];
  /** The published HTTPS port; null when TLS ends at 443 so the address carries no port. */
  httpsPort: number | null;
  /** What better-auth calls itself: the public address people sign in at, port and all. */
  baseUrl: string;
}

/**
 * The address people sign in at, from what config.json holds: `https://<host>`, with `:<httpsPort>`
 * when one was named. Null when no host is configured.
 *
 * One place derives it, so the door's `baseUrl`, its card, its CLI line and its pages cannot disagree
 * about whether the address carries a port — and a browser compares `Origin` against exactly that.
 */
export function authDoorUrl(stored: Pick<InboxAuthStored, "host" | "httpsPort"> | null | undefined): string | null {
  const host = typeof stored?.host === "string" ? stored.host.trim().toLowerCase().replace(/\.$/, "") : "";
  if (!host) return null;
  const httpsPort = typeof stored?.httpsPort === "number" ? stored.httpsPort : null;
  return `https://${host}${httpsPort ? `:${httpsPort}` : ""}`;
}

/**
 * Does this `Host` header name this door?
 *
 * The bare name, the name with `:443`, and — only when the person configured one — the name with its
 * published HTTPS port. A proxy that ends TLS on a port passes it straight through (`tailscale serve
 * --https=4255` gives `Host: inbox.example.com:4255`), so refusing the port as well would turn away the
 * very address the door is published at. Stripping any port instead would let the same name with a
 * made-up port through the gate, and it is that same name-plus-port that the Origin check and each
 * passkey's origin are matched against; so the allowed ports come from the settings, never from the
 * header.
 */
export function doorAnswersHost(
  hostHeader: string | null | undefined,
  settings: Pick<InboxAuthSettings, "host" | "httpsPort">,
): boolean {
  const header = (hostHeader ?? "").trim().toLowerCase().replace(/\.$/, "");
  if (header === "") return true;
  const match = /^(.*?)(?::(\d+))?$/.exec(header);
  const host = match?.[1] ?? "";
  const port = match?.[2] ? Number.parseInt(match[2], 10) : null;
  if (host !== settings.host) return false;
  return port === null || port === 443 || (settings.httpsPort !== null && port === settings.httpsPort);
}

/**
 * Did the request reach the door over TLS?
 *
 * The door listens on plain loopback HTTP; whatever publishes it ends TLS and says so in
 * `x-forwarded-proto`. A missing header says nothing, so nothing is refused on a guess. `http` says the
 * browser is on an `http://` address, where a passkey cannot be minted at all and where the door's own
 * `__Secure-` session cookie cannot exist either — so the passkey ceremony is refused there instead of
 * running along until WebAuthn fails.
 */
export function arrivedOverTls(headers: Headers): boolean {
  const proto = (headers.get("x-forwarded-proto") ?? "").split(",")[0]?.trim().toLowerCase() ?? "";
  return proto === "" || proto === "https";
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
   * The port the public address carries. It joins the host in `baseUrl`, which is the `Origin`
   * better-auth accepts a sign-in from and the origin a passkey is minted for; leaving it out is what
   * makes a door published at `https://<host>:4255` refuse the very address it works at, with
   * `INVALID_ORIGIN`.
   */
  const httpsPortRaw = env[INBOX_AUTH_HTTPS_PORT_ENV] ?? stored.httpsPort;
  let httpsPort: number | null = null;
  if (httpsPortRaw !== undefined && httpsPortRaw !== null && String(httpsPortRaw).trim() !== "") {
    const parsed = typeof httpsPortRaw === "number" ? httpsPortRaw : Number.parseInt(String(httpsPortRaw), 10);
    // 443 is already what `https://<host>` means: writing it down would put `:443` into an address no
    // browser ever sends, which is the same bug in the other direction.
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
