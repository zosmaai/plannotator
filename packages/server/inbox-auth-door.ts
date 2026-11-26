/**
 * The Inbox's sign-in door: a loopback listener for people who want the Inbox
 * on a public address with accounts of its own, instead of Cloudflare Access
 * or Tailscale.
 *
 * It is the tailnet door's shape with a session in place of `Tailscale-User-Login`:
 * every request is checked here, and what passes is handed to the window
 * marked `tailnet`, exactly as the owner's own requests are (no `/mcp`, no
 * connection route, no device door).
 *
 * Order, on every request:
 *  1. The door's own paths: `/login` and its assets (`/auth.css`, `/auth.js`,
 *     `/passkeys.js`), and `/api/auth/*` (better-auth's own routes: sign-in,
 *     sign-out, session, and the passkey ceremonies).
 *  2. A session, read from the cookie this door set. None: a page is sent to
 *     `/login?next=…`, an API call answers `401 auth_required`.
 *  3. The session's address is on the allowlist. Not: `401 account_not_allowed`,
 *     and the page says whose Inbox this is.
 *  4. Passkeys, which need that session: the door's `/passkeys` page and the two
 *     calls behind it. They answer for the session's account and never hand a
 *     stored key back.
 *  5. The request, its own cookies dropped, to the window.
 *
 * A few paths are never handed on whatever the session: `/mcp` and the
 * connection routes are refused here, as they are at the tailnet's listener.
 */

import { loadConfig } from "@plannotator/shared/config";
import { isSameOriginOrNoOrigin } from "@plannotator/shared/request-origin";
import { updateOwnInboxRegistry, type InboxRegistryEntry } from "@plannotator/shared/inbox/registry";
import {
  AUTH_BASE_PATH,
  AUTH_LOGIN_PATH,
  doorAnswersHost,
  doorOffersPasskeys,
  doorOrigins,
  markFromAuthDoor,
  PASSKEY_API_PATH,
  PASSKEY_JS_PATH,
  PASSKEY_PAGE_PATH,
  passkeyOrigin,
  passkeyOrigins,
  resolveInboxAuth,
  safeNextPath,
  withoutAuthCookies,
  type InboxAuthSettings,
} from "@plannotator/shared/inbox/auth-door";
import { AUTH_CSS, AUTH_CSP, AUTH_JS, loginPageHtml, passkeyPageHtml, PASSKEY_JS } from "./inbox-auth-login";
import { openInboxAuth, sessionUser, type InboxAuthInstance } from "./inbox-auth-instance";

export interface InboxAuthDoorState {
  on: boolean;
  configured: boolean;
  url: string | null;
  port: number | null;
  allow: string[];
  error: string | null;
}

export interface InboxAuthDoorContext {
  dataDir: string;
  registry: () => InboxRegistryEntry;
  dispatch: (req: Request) => Promise<Response>;
  forbiddenPort: (port: number) => boolean;
  maxRequestBodySize?: number;
  log?: (line: string) => void;
  note?: (event: string, data: Record<string, unknown>) => void;
  /** A door made for a test: its own instance instead of the data folder's. */
  instance?: () => Promise<InboxAuthInstance>;
}

const HEADERS = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };
const HOP_BY_HOP = new Set(["connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade"]);
/** Never handed to the window from here, whatever the session. */
const CLOSED = [
  /^\/mcp(\/|$)/,
  /^\/api\/inbox\/bridge(\/|$)/,
  /^\/api\/inbox\/control(\/|$)/,
  // A launched session's permission hook (`inbox-launch-claude-permission.ts`): an agent's route, not a person's.
  /^\/api\/inbox\/launch\/[^/]+\/permission$/,
];

function jsonBody(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { ...HEADERS, "Content-Type": "application/json; charset=utf-8" },
  });
}

function jsonError(status: number, code: string, message: string): Response {
  return new Response(JSON.stringify({ error: message, code }), { status, headers: { ...HEADERS, "Content-Type": "application/json; charset=utf-8" } });
}

function textResponse(body: string, status: number, type: string, extra: Record<string, string> = {}): Response {
  return new Response(body, { status, headers: { ...HEADERS, "Content-Type": type, ...extra } });
}

/** The door's own cookies never reach the window, and neither does a hop-by-hop header. */
export function scrubAuthDoorHeaders(source: Headers): Headers {
  const headers = new Headers();
  source.forEach((value, name) => {
    const lower = name.toLowerCase();
    if (HOP_BY_HOP.has(lower)) return;
    if (lower === "cookie") {
      const kept = withoutAuthCookies(value);
      if (kept) headers.append(name, kept);
      return;
    }
    // Cloudflare's and Tailscale's own headers must not decide anything here: this door already did.
    if (lower.startsWith("cf-") || lower.startsWith("tailscale-")) return;
    headers.append(name, value);
  });
  headers.set("x-forwarded-proto", "https");
  return headers;
}

function rebuild(req: Request, headers: Headers): Request {
  const hasBody = req.method !== "GET" && req.method !== "HEAD";
  return new Request(req.url, {
    method: req.method,
    headers,
    body: hasBody ? req.body : null,
    signal: req.signal,
    redirect: "manual",
    ...(hasBody ? { duplex: "half" } : {}),
  } as RequestInit);
}

function wantsDocument(req: Request, path: string): boolean {
  const dest = req.headers.get("sec-fetch-dest")?.toLowerCase();
  if (dest === "document" || dest === "iframe") return true;
  if (dest !== undefined) return false;
  return req.method === "GET" && (path === "/" || !path.startsWith("/api/")) && (req.headers.get("accept") ?? "").includes("text/html");
}

export function createInboxAuthDoor(context: InboxAuthDoorContext) {
  const log = context.log ?? ((line: string) => process.stderr.write(line));
  let listener: ReturnType<typeof Bun.serve> | null = null;
  let settings: InboxAuthSettings | null = null;
  let instance: InboxAuthInstance | null = null;
  /** Bumped by every start and stop: an open() that lands after either is discarded, not served. */
  let generation = 0;
  const state = { on: false, configured: false, url: null as string | null, error: null as string | null };

  const record = (): InboxRegistryEntry["inbox_auth"] | undefined =>
    state.on && state.url
      ? { url: state.url, error: state.error, ...(listener ? { port: listener.port as number } : {}), allow: settings ? [...settings.allow] : [] }
      : undefined;

  const save = () => {
    const value = record();
    const apply = (target: InboxRegistryEntry) => {
      if (value) target.inbox_auth = value;
      else delete target.inbox_auth;
    };
    apply(context.registry());
    updateOwnInboxRegistry(context.dataDir, context.registry().serverSession, apply);
  };

  const fail = (error: string) => {
    state.url = null;
    state.error = error;
    save();
    log(`[plannotator] Sign-in: not open. ${error} The Inbox runs on this computer as usual.\n`);
  };

  /**
   * What a page calls this Inbox: the name and the port this very request arrived at, which is the
   * address in the person's address bar. A request that carried no `Host` at all (a local health check)
   * falls back to the address from the settings. Passkeys are aimed elsewhere — at `passkeyOrigin`, the
   * name with the pinned port when one is written down — and the page says so on its own line.
   */
  const doorAddress = (active: InboxAuthSettings, req: Request) => req.headers.get("host")?.trim() || new URL(active.baseUrl).host;

  const handler = (active: InboxAuthSettings, auth: InboxAuthInstance) => async (req: Request): Promise<Response> => {
    let url: URL;
    try {
      url = new URL(req.url, "http://127.0.0.1");
    } catch {
      return jsonError(400, "bad_request", "Bad request.");
    }
    const path = url.pathname;

    // 0. Its own name only. A proxy in front passes the public Host through — name and the port TLS ended
    // on, whatever that port is — and anything else reaching this port (another name pointed here, the
    // loopback address itself) is not the door's business: never a session, never a form. The port is not
    // part of the name check, because the door is never told which port it is published at and signing
    // people in must not depend on being told — see `doorAnswersHost`.
    if (!doorAnswersHost(req.headers.get("host"), active)) return jsonError(403, "forbidden_host", "This door answers only its own name.");

    // 1. The door's own paths.
    if (path === AUTH_LOGIN_PATH || path === `${AUTH_LOGIN_PATH}/`) {
      if (req.method !== "GET" && req.method !== "HEAD") return jsonError(405, "method_not_allowed", "Sign in with the form.");
      const signed = await sessionUser(auth, req.headers, active.allow);
      const next = safeNextPath(url.searchParams.get("next"));
      // Already signed in: go where they were going.
      if (signed) return new Response(null, { status: 303, headers: { ...HEADERS, Location: next } });
      const error = url.searchParams.get("error") === "account"
        ? "That account is not allowed into this Inbox."
        : url.searchParams.get("error") === "session"
          ? "Your session ended. Sign in again."
          : null;
      const page = loginPageHtml({ address: doorAddress(active, req), passkeyAddress: passkeyOrigin(active), next, error });
      return textResponse(req.method === "HEAD" ? "" : page, 200, "text/html; charset=utf-8", { "Content-Security-Policy": AUTH_CSP, "Referrer-Policy": "no-referrer" });
    }
    if (path === "/auth.css") return textResponse(AUTH_CSS, 200, "text/css; charset=utf-8");
    if (path === "/auth.js") return textResponse(AUTH_JS, 200, "text/javascript; charset=utf-8");
    if (path === PASSKEY_JS_PATH) return textResponse(PASSKEY_JS, 200, "text/javascript; charset=utf-8");
    if (path === AUTH_BASE_PATH || path.startsWith(`${AUTH_BASE_PATH}/`)) {
      // Whether a sign-in comes from this door's own page is the door's question, not better-auth's. Its
      // `trustedOrigins` names the same addresses but it only consults them for some requests — a sign-in
      // POST that carries no cookie skips the check — so relying on it makes the property depend on which
      // paths better-auth decides to validate, and on the environment it runs in. Asked here, the answer
      // is the same one on every path and wherever the door runs.
      //
      // An absent `Origin` is still allowed: a CLI, the window on loopback and every other program that was
      // never on a page sends none, and a program cannot aim somebody else's page at us. A page always
      // sends one, and a browser says `cross-site` when it is another site's, so a request that came from
      // a page has to name an address this door answers at — the one it arrived at, or that name at the
      // port https implies (`doorOrigins`), which is exactly what the door's own form sends.
      const origin = req.headers.get("origin");
      if (origin) {
        let named: string | null = null;
        try {
          named = new URL(origin).origin;
        } catch {
          named = null;
        }
        if (!named || !doorOrigins(req.headers.get("host"), active).includes(named)) {
          return jsonError(403, "forbidden_origin", "That sign-in did not come from this Inbox's own page.");
        }
      }
      // The browser computes this from the page that sent the request and no script can set it, so it is
      // worth the check even though an absent `Origin` is allowed above: the door's own page never says
      // `cross-site`.
      if (req.headers.get("sec-fetch-site")?.trim().toLowerCase() === "cross-site") {
        return jsonError(403, "forbidden_origin", "That sign-in did not come from this Inbox's own page.");
      }
      // A passkey ceremony needs a page the browser considers secure, and it can only run at an address
      // the key belongs to: `passkeyOrigin`, the name at the pinned port when one is written down, at
      // `:443`, or with no port at all. Started anywhere else it would fail WebAuthn's own origin check,
      // so the door refuses it here and lets its own line say what to use instead.
      // Password sign-in at any port is unaffected.
      if (path.startsWith(`${AUTH_BASE_PATH}/passkey`) && !doorOffersPasskeys(req.headers, active)) {
        return jsonError(403, "insecure_connection", `Passkeys need ${passkeyOrigin(active)}. Sign in with the password here, or use that address.`);
      }
      const answer = await auth.auth.handler(req);
      const out = new Headers(answer.headers);
      out.set("Cache-Control", "no-store");
      out.set("X-Content-Type-Options", "nosniff");
      return new Response(answer.body, { status: answer.status, headers: out });
    }

    // 2. A session.
    const signed = await sessionUser(auth, req.headers, active.allow);
    if (!signed) {
      const anySession = await auth.auth.api.getSession({ headers: req.headers }).catch(() => null);
      if (wantsDocument(req, path)) {
        const next = `${path}${url.search}`;
        const query = anySession ? "?error=account" : "";
        return new Response(null, {
          status: 303,
          headers: { ...HEADERS, Location: `${AUTH_LOGIN_PATH}${query}${query ? "&" : "?"}next=${encodeURIComponent(next)}` },
        });
      }
      if (path.startsWith("/api/") || path === "/mcp" || path.startsWith("/api/inbox/")) {
        return jsonError(401, anySession ? "account_not_allowed" : "auth_required", anySession ? "That account is not allowed into this Inbox." : "Sign in to this Inbox.");
      }
      return textResponse(anySession ? "That account is not allowed into this Inbox.\n" : "Sign in to this Inbox.\n", anySession ? 403 : 401, "text/plain; charset=utf-8");
    }

    // 3. Passkeys, after the session: the door's own page and the two calls it makes. They answer for
    // the session's account by reading the session and nothing from the request, so a call cannot name
    // whose passkeys it wants, and they never hand a stored key back — only a name, a date and the
    // door's own row id.
    //
    // A passkey ceremony needs a page the browser considers secure, and only the addresses the key
    // belongs to have that claim: `passkeyOrigin`, the name at the pinned port when one is written down,
    // at `:443`, or with no port at all. At any other port the ceremony would fail WebAuthn's own origin
    // check, and on an arrival a proxy reports as plain HTTP it would fail inside
    // `navigator.credentials` — so the passkey paths answer here rather than rendering a page whose
    // button cannot work. The message names `passkeyOrigin`, because that is where the keys live. The
    // password sign-in above is untouched, and so is the window below: a proxy may forward its own
    // loopback hop as `http` and still be serving the person TLS, and only a ceremony needs the page to
    // be secure.
    const isPasskeyPath = path === PASSKEY_PAGE_PATH || path.startsWith(`${PASSKEY_PAGE_PATH}/`) || path === PASSKEY_API_PATH || path.startsWith(`${PASSKEY_API_PATH}/`);
    if (isPasskeyPath && !doorOffersPasskeys(req.headers, active)) {
      return jsonError(403, "insecure_connection", `Passkeys need ${passkeyOrigin(active)}. Sign in with the password here, or use that address.`);
    }
    if (path === PASSKEY_PAGE_PATH || path === `${PASSKEY_PAGE_PATH}/`) {
      if (req.method !== "GET" && req.method !== "HEAD") return jsonError(405, "method_not_allowed", "Passkeys are managed from their page.");
      const page = passkeyPageHtml({ address: passkeyOrigin(active), next: safeNextPath(url.searchParams.get("next")) });
      return textResponse(req.method === "HEAD" ? "" : page, 200, "text/html; charset=utf-8", { "Content-Security-Policy": AUTH_CSP, "Referrer-Policy": "no-referrer" });
    }
    if (path === PASSKEY_API_PATH) {
      if (req.method !== "GET" && req.method !== "HEAD") return jsonError(405, "method_not_allowed", "Read the list with GET.");
      return jsonBody({ passkeys: await auth.passkeys(signed.id) });
    }
    if (path === `${PASSKEY_API_PATH}/remove`) {
      if (req.method !== "POST") return jsonError(405, "method_not_allowed", "Remove a passkey with POST.");
      // The first thing at this door that changes state, so the first that has to say where it came
      // from: another page must not be able to take a passkey off an account it cannot reach itself.
      if (!isSameOriginOrNoOrigin(req.headers.get("origin"), req.headers.get("host") ?? "", req.headers.get("sec-fetch-site"))) {
        return jsonError(403, "forbidden_origin", "That request did not come from this page.");
      }
      const asked = (await req.json().catch(() => null)) as { id?: unknown } | null;
      const id = typeof asked?.id === "string" ? asked.id : "";
      if (!id) return jsonError(400, "bad_request", "Say which passkey to remove.");
      const answer = await auth.removePasskey(signed.id, id);
      if (!answer.removed) return jsonError(answer.code === "last_way_in" ? 409 : 404, answer.code ?? "not_here", answer.message ?? "That passkey is not on your account.");
      return jsonBody({ removed: true });
    }

    // 4. What the door never hands on.
    if (CLOSED.some((pattern) => pattern.test(path))) return jsonError(403, "local_only", "That route is for this computer only.");

    // 5. The window. Marked on the object handed on, because nothing about the request says where it
    // came from by then: its door headers are scrubbed and its address is this machine's own loopback.
    // The sign-in settings are answered on every route, and this is what lets the Inbox refuse to let
    // someone who signed in at the door change that door.
    context.note?.("auth_door_request", { path: path.split("/").slice(0, 3).join("/") });
    const forward = rebuild(req, scrubAuthDoorHeaders(req.headers));
    // The account is marked with the request, from the session this door verified and from nothing the request said.
    markFromAuthDoor(forward, { email: signed.email, name: signed.name });
    return context.dispatch(forward);
  };

  const start = () => {
    if (listener) return;
    const resolved = resolveInboxAuth(loadConfig(), process.env, context.forbiddenPort);
    state.on = resolved.on;
    state.configured = resolved.configured;
    if (!resolved.on) {
      const was = settings !== null || context.registry().inbox_auth !== undefined;
      state.url = null;
      state.error = null;
      settings = null;
      if (was) save();
      return;
    }
    if (!resolved.settings) return fail(resolved.error);
    const active = resolved.settings;
    const mine = ++generation;

    // better-auth builds its tables and secret before a request is taken, so a broken database refuses the door
    // rather than answering a sign-in page that can never work.
    void (async () => {
      let made: InboxAuthInstance;
      try {
        // A passkey is minted for the name the browser sees, and for that name alone: not the loopback
        // address behind it, and not a port in front of it. `host` is what lets a sign-in's `Origin` follow
        // the address the request arrived at, at any port, with nothing configured — see `doorOrigins`.
        made = context.instance
          ? await context.instance()
          : await openInboxAuth({
              dataDir: context.dataDir,
              baseUrl: active.baseUrl,
              host: active.host,
              allow: active.allow,
              webauthn: { rpID: active.host, origin: passkeyOrigins(active) },
            });
      } catch (error) {
        if (mine === generation) fail(`Could not open the accounts in ${context.dataDir}: ${error instanceof Error ? error.message : String(error)}`);
        return;
      }
      // Stopped, or started again with other settings, while the accounts were opening: this one is not served.
      if (mine !== generation) {
        made.close();
        return;
      }
      instance = made;
      try {
        listener = Bun.serve({
          hostname: "127.0.0.1",
          port: active.port,
          idleTimeout: 0,
          maxRequestBodySize: context.maxRequestBodySize,
          fetch: handler(active, made),
        } as Parameters<typeof Bun.serve>[0]);
      } catch (error) {
        made.close();
        instance = null;
        const code = (error as NodeJS.ErrnoException)?.code ?? "";
        const busy = /EADDRINUSE|in use/i.test(`${code} ${error instanceof Error ? error.message : String(error)}`);
        return fail(busy ? `Port ${active.port} is in use by another program.` : `Could not listen on 127.0.0.1:${active.port}.`);
      }
      settings = active;
      state.url = `${active.baseUrl}/`;
      state.error = null;
      save();
      log(`[plannotator] Sign-in: open at ${state.url} (${active.allow.length} ${active.allow.length === 1 ? "address" : "addresses"} may enter).\n`);
    })();
  };

  const stop = () => {
    generation += 1;
    const closing = listener;
    listener = null;
    settings = null;
    state.url = null;
    state.error = null;
    closing?.stop(true);
    instance?.close();
    instance = null;
    if (context.registry().inbox_auth) {
      delete context.registry().inbox_auth;
      updateOwnInboxRegistry(context.dataDir, context.registry().serverSession, (target) => {
        delete target.inbox_auth;
      });
    }
  };

  const restart = () => {
    stop();
    start();
  };

  const snapshot = (): InboxAuthDoorState => ({
    on: state.on,
    configured: state.configured,
    url: state.url,
    port: listener ? (listener.port as number) : null,
    allow: settings ? [...settings.allow] : [],
    error: state.error,
  });

  return { start, stop, restart, state: snapshot, listenerPort: () => (listener ? (listener.port as number) : null), instance: () => instance };
}

export type InboxAuthDoor = ReturnType<typeof createInboxAuthDoor>;
