import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { doorAnswersHost, doorOffersPasskeys, doorOrigins, passkeyOrigin, passkeyOrigins, safeNextPath, withoutAuthCookies } from "@plannotator/shared/inbox/auth-door";
import { openInboxAuth } from "./inbox-auth-instance";
import { startInboxServer, type InboxServer } from "./inbox";

const HOST = "inbox.example.com";
const ME = "me@example.com";
const OTHER = "someone@example.com";
const PASSWORD = "correct horse battery staple";
const HTML = "<!doctype html><title>Inbox</title>";

let dataDir: string;
const servers: InboxServer[] = [];
const saved: Record<string, string | undefined> = {};
const ENV = ["PLANNOTATOR_DATA_DIR", "PLANNOTATOR_INBOX_AUTH"] as const;

beforeEach(() => {
  for (const key of ENV) saved[key] = process.env[key];
  dataDir = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-inbox-auth-")));
  process.env.PLANNOTATOR_DATA_DIR = dataDir;
  delete process.env.PLANNOTATOR_INBOX_AUTH;
});

afterEach(() => {
  for (const server of servers.splice(0)) server.stop();
  for (const key of ENV) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  rmSync(dataDir, { recursive: true, force: true });
});

function freePort(): number {
  const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response(null) });
  const port = probe.port as number;
  probe.stop(true);
  return port;
}

/** A request the way a tunnel forwards it: to the loopback port, with the public name in Host. */
function request(url: string, init: RequestInit = {}): Promise<Response> {
  return fetch(url, { ...init, headers: { Host: HOST, ...(init.headers as Record<string, string> | undefined) } });
}

async function waitForDoor(base: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      await request(`${base}/login`);
      return;
    } catch {
      await Bun.sleep(50);
    }
  }
  throw new Error(`the sign-in door at ${base} never opened`);
}

/** An Inbox with accounts on, and the address its door answers at. `httpsPort` is where a proxy ends TLS. */
async function startWithAccounts(options: { httpsPort?: number } = {}): Promise<{ inbox: InboxServer; base: string }> {
  const port = freePort();
  writeFileSync(
    join(dataDir, "config.json"),
    JSON.stringify({ inboxAuth: { on: true, host: HOST, allow: [ME], port, ...(options.httpsPort ? { httpsPort: options.httpsPort } : {}) } }),
  );
  const inbox = await startInboxServer({ dataDir, htmlContent: HTML });
  servers.push(inbox);
  const base = `http://127.0.0.1:${port}`;
  await waitForDoor(base);
  return { inbox, base };
}

/** The account the person makes at the terminal (`plannotator inbox auth add`). */
async function seed(email: string, password = PASSWORD): Promise<void> {
  const instance = await openInboxAuth({ dataDir, baseUrl: `https://${HOST}`, allow: [ME, OTHER] });
  try {
    await instance.set({ email, password });
  } finally {
    instance.close();
  }
}

let client = 0;
/** A distinct client address per sign-in: the rate limit buckets by address, as it does through a tunnel. */
function nextClient(): string {
  client += 1;
  return `198.51.100.${client % 250}`;
}

async function signIn(base: string, email: string, password = PASSWORD, ip = nextClient()): Promise<{ answer: Response; cookie: string | null }> {
  const answer = await request(`${base}/api/auth/sign-in/email`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": ip },
    body: JSON.stringify({ email, password }),
  });
  const cookie = answer.headers.get("set-cookie")?.split(";")[0] ?? null;
  return { answer, cookie };
}

describe("the sign-in door", () => {
  test("is off when config.json says nothing, and the window answers as before", async () => {
    const inbox = await startInboxServer({ dataDir, htmlContent: HTML });
    servers.push(inbox);
    const answer = await fetch(`http://127.0.0.1:${inbox.port}/`);
    expect(answer.status).toBe(200);
    expect(await answer.text()).toContain("<title>Inbox</title>");
    expect(inbox.registry.inbox_auth).toBeUndefined();
  }, 30_000);

  test("sends a page to /login and a program to 401 while there is no session", async () => {
    const { base } = await startWithAccounts();

    const page = await request(`${base}/threads/abc?x=1`, { headers: { accept: "text/html,application/xhtml+xml" }, redirect: "manual" });
    expect(page.status).toBe(303);
    expect(page.headers.get("location")).toBe(`/login?next=${encodeURIComponent("/threads/abc?x=1")}`);

    // A browser's own fetch keeps sec-fetch-dest off the navigation, so an API call is judged by its path.
    const api = await request(`${base}/api/inbox/state`, { headers: { "sec-fetch-dest": "empty" }, redirect: "manual" });
    expect(api.status).toBe(401);
    expect(((await api.json()) as { code: string }).code).toBe("auth_required");
  }, 30_000);

  test("signs in with the account the person made, and the session opens the window", async () => {
    const { base, inbox } = await startWithAccounts();
    await seed(ME);

    const refused = await signIn(base, ME, "not the password");
    expect(refused.answer.status).toBe(401);
    expect(((await refused.answer.json()) as { code: string }).code).toBe("INVALID_EMAIL_OR_PASSWORD");
    expect(refused.cookie).toBeNull();

    const signed = await signIn(base, ME);
    expect(signed.answer.status).toBe(200);
    expect(signed.cookie).toContain("session_token");

    const page = await request(`${base}/`, { headers: { cookie: signed.cookie! }, redirect: "manual" });
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("<title>Inbox</title>");
    // What the door writes for the window.
    expect(inbox.registry.inbox_auth?.url).toBe(`https://${HOST}/`);
    expect(inbox.registry.inbox_auth?.allow).toEqual([ME]);

    // A signed-in visit to /login goes where it was going, not to the form again.
    const again = await request(`${base}/login?next=%2Fcards`, { headers: { cookie: signed.cookie! }, redirect: "manual" });
    expect(again.status).toBe(303);
    expect(again.headers.get("location")).toBe("/cards");
  }, 30_000);

  test("refuses a session whose address is not on the allowlist", async () => {
    const { base } = await startWithAccounts();
    await seed(OTHER);

    const signed = await signIn(base, OTHER);
    expect(signed.answer.status).toBe(200);

    const api = await request(`${base}/api/inbox/state`, { headers: { cookie: signed.cookie!, "sec-fetch-dest": "empty" }, redirect: "manual" });
    expect(api.status).toBe(401);
    expect(((await api.json()) as { code: string }).code).toBe("account_not_allowed");

    const page = await request(`${base}/`, { headers: { cookie: signed.cookie!, accept: "text/html" }, redirect: "manual" });
    expect(page.status).toBe(303);
    expect(page.headers.get("location")).toContain("error=account");
  }, 30_000);

  test("names the signed-in account on the answers it proxies", async () => {
    const { base } = await startWithAccounts();
    await seed(ME);
    const signed = await signIn(base, ME);
    expect(signed.answer.status).toBe(200);

    const page = await request(`${base}/`, { headers: { cookie: signed.cookie! }, redirect: "manual" });
    expect(page.status).toBe(200);
    // The one seam out: the door names the account it just verified, on the answer it made. One-way —
    // the window may read this, and nothing it sends is consulted for it.
    expect(page.headers.get("X-Plannotator-Account")).toBe(ME);

    const api = await request(`${base}/api/inbox/health`, { headers: { cookie: signed.cookie!, accept: "application/json" }, redirect: "manual" });
    expect(api.headers.get("X-Plannotator-Account")).toBe(ME);

    // A request naming an account of its own is not listened to: the answer still names who the door
    // itself signed in, so a page cannot claim to be someone else.
    const forged = await request(`${base}/`, { headers: { cookie: signed.cookie!, "X-Plannotator-Account": "mallory@example.com" }, redirect: "manual" });
    expect(forged.status).toBe(200);
    expect(forged.headers.get("X-Plannotator-Account")).toBe(ME);
  }, 30_000);

  test("leaves a trail naming which account made which request, with no debug log on", async () => {
    // A normal install: nothing here sets the debug log. The door's note is wired either way, and its
    // trail on disk names who asked for what — a note, not a UI and not something to configure.
    const { base } = await startWithAccounts();
    await seed(ME);
    const signed = await signIn(base, ME);

    const answer = await request(`${base}/`, { headers: { cookie: signed.cookie! }, redirect: "manual" });
    expect(answer.status).toBe(200);

    const trail = readFileSync(join(dataDir, "inbox-auth", "door-trail.log"), "utf8");
    const entries = trail
      .split("\n")
      .filter((line) => line !== "")
      .map((line) => JSON.parse(line) as { event: string; method?: string; path?: string; account?: { address?: string } });
    const hit = entries.find((entry) => entry.event === "auth_door_request" && entry.method === "GET" && entry.path === "/");
    expect(hit?.account?.address).toBe(ME);
  }, 30_000);

  test("never hands on an agent's route, whatever the session", async () => {
    const { base } = await startWithAccounts();
    await seed(ME);
    const signed = await signIn(base, ME);
    expect(signed.answer.status).toBe(200);
    for (const path of ["/mcp", "/api/inbox/control/stop", "/api/inbox/bridge/poll", "/api/inbox/launch/abc/permission"]) {
      const answer = await request(`${base}${path}`, { headers: { cookie: signed.cookie! }, redirect: "manual" });
      expect({ path, status: answer.status, code: ((await answer.json()) as { code: string }).code }).toEqual({ path, status: 403, code: "local_only" });
    }
  }, 30_000);

  test("answers its own name only", async () => {
    const { base } = await startWithAccounts();
    const wrong = await fetch(`${base}/login`, { headers: { Host: "evil.example.net" } });
    expect(wrong.status).toBe(403);
    expect(((await wrong.json()) as { code: string }).code).toBe("forbidden_host");
    // The loopback address behind the tunnel is not a second way in: the door answers its public name and
    // nothing else, so a browser opened at `http://127.0.0.1:<port>` signs nobody in. The port is what the
    // Origin check and every passkey are matched against, so it is never taken from the header either.
    for (const home of ["127.0.0.1:19501", "127.0.0.1:4255", "localhost:4255"]) {
      const atHome = await fetch(`${base}/login`, { headers: { Host: home } });
      expect(atHome.status).toBe(403);
      expect(((await atHome.json()) as { code: string }).code).toBe("forbidden_host");
    }
  }, 30_000);

  test("answers its name at the port it is published at, with nothing configured", async () => {
    // The owner's setup, measured: the Inbox binds 127.0.0.1, `tailscale serve --https=4255` publishes it,
    // and config.json names only the host — this process is never told which port TLS ended on, and there
    // is no setting it has to discover first. So the name is the whole `Host` check, and the address
    // people actually open has to sign them in.
    const { base, inbox } = await startWithAccounts();
    await seed(ME);
    for (const host of [HOST, `${HOST}:443`, `${HOST}:4255`]) {
      expect((await fetch(`${base}/login`, { headers: { Host: host } })).status).toBe(200);
    }
    const body = await (await fetch(`${base}/login`, { headers: { Host: `${HOST}:4255` } })).text();
    // The page speaks of the address the person is standing on, and points passkeys at the one address they
    // belong to: the bare name, whatever port this door happens to answer.
    expect(body).toContain(`This Inbox lives on <strong>${HOST}:4255</strong>`);
    expect(body).toContain(`Passkeys need <strong>https://${HOST}</strong>. The password works everywhere.`);

    const signed = await fetch(`${base}/api/auth/sign-in/email`, {
      method: "POST",
      headers: { Host: `${HOST}:4255`, "content-type": "application/json", origin: `https://${HOST}:4255`, "x-forwarded-for": nextClient() },
      body: JSON.stringify({ email: ME, password: PASSWORD }),
    });
    expect(signed.status).toBe(200);
    const cookie = signed.headers.get("set-cookie")?.split(";")[0] ?? "";
    expect(cookie).toContain("session_token");
    // The session works at that address — the half that used to fail with better-auth's `INVALID_ORIGIN`.
    const window = await fetch(`${base}/`, { headers: { Host: `${HOST}:4255`, cookie, accept: "text/html" }, redirect: "manual" });
    expect(window.status).toBe(200);
    expect(await window.text()).toContain("<title>Inbox</title>");
    // What the door publishes about itself is still what the settings say: no port was invented.
    expect(inbox.registry.inbox_auth?.url).toBe(`https://${HOST}/`);
  }, 30_000);

  test("a sign-in at a published port is still same-origin", async () => {
    // Following the request's own port is not the same as trusting any origin: `Origin` must be this name
    // at the port the request arrived at, or this name at the port https implies.
    const { base } = await startWithAccounts();
    await seed(ME);
    // The code comes back with the status because both refusals are 403s: better-auth answers
    // `INVALID_ORIGIN` when it validates at all, and the door answers `forbidden_origin`. Asking for the
    // door's code is what proves the door itself refused, and it fails if its own check is ever removed.
    const at = async (origin: string) => {
      const answer = await fetch(`${base}/api/auth/sign-in/email`, {
        method: "POST",
        headers: { Host: `${HOST}:4255`, "content-type": "application/json", origin, "x-forwarded-for": nextClient() },
        body: JSON.stringify({ email: ME, password: PASSWORD }),
      });
      const body = (await answer.clone().json().catch(() => null)) as { code?: unknown } | null;
      return { status: answer.status, code: typeof body?.code === "string" ? body.code : null };
    };
    expect(await at("https://evil.example.com")).toEqual({ status: 403, code: "forbidden_origin" }); // another site aimed at this port
    expect(await at(`http://${HOST}:4255`)).toEqual({ status: 403, code: "forbidden_origin" }); // this name over http is a different origin
    expect(await at(`https://${HOST}:8443`)).toEqual({ status: 403, code: "forbidden_origin" }); // a port nobody is standing on
    expect(await at(`https://${HOST}`)).toEqual({ status: 200, code: null }); // this name at the port https implies, always its own
  }, 30_000);

  test("answers a port nobody named because the name matched — and that is all the name gives", async () => {
    // `Host: inbox.example.com:9999` is answered, because the `Host` check can only decide names and the
    // door is never told which ports exist in front of it. Say plainly what that hands over: the door's own
    // pages, and — for an address on the allowlist, with an `Origin` for that very port — a password
    // session for this Inbox. Not the window's owner-only routes (`local_only` still answers), not
    // passkeys, which belong to the bare name, and nothing at all to a request whose `Origin` is another
    // site. A made-up port is an oddity of the arrival, not a way in.
    const { base } = await startWithAccounts();
    await seed(ME);
    expect((await fetch(`${base}/login`, { headers: { Host: `${HOST}:9999` } })).status).toBe(200);
    const signed = await fetch(`${base}/api/auth/sign-in/email`, {
      method: "POST",
      headers: { Host: `${HOST}:9999`, "content-type": "application/json", origin: `https://${HOST}:9999`, "x-forwarded-for": nextClient() },
      body: JSON.stringify({ email: ME, password: PASSWORD }),
    });
    expect(signed.status).toBe(200);
    const cookie = signed.headers.get("set-cookie")?.split(";")[0] ?? "";
    const off = await fetch(`${base}/api/inbox/sign-in/off`, {
      method: "POST",
      headers: { Host: `${HOST}:9999`, cookie, "content-type": "application/json", origin: `https://${HOST}:9999` },
      body: JSON.stringify({}),
    });
    expect(((await off.json()) as { code: string }).code).toBe("local_only");
  }, 30_000);

  test("a pinned HTTPS port is where the passkeys live, and the bare name keeps taking them", async () => {
    // The owner's decision: make the keys follow the pinned port, so a passkey works at the address the
    // person actually signs in at. It decides the address the door *calls itself* — the registry URL, the
    // card, the CLI line, the line above the passkey button — and it opens the ceremony at that port as
    // well as at the bare name, one key for both (`passkeyOrigins`). It still does not narrow the `Host`
    // allowlist: every port of this name answers the pages, as before.
    const { base, inbox } = await startWithAccounts({ httpsPort: 4255 });
    await seed(ME);
    expect(inbox.registry.inbox_auth?.url).toBe(`https://${HOST}:4255/`);
    for (const host of [HOST, `${HOST}:443`, `${HOST}:4255`, `${HOST}:9999`]) {
      expect((await fetch(`${base}/login`, { headers: { Host: host } })).status).toBe(200);
    }
    // The page still speaks of where the person is standing, and points passkeys at the pinned port.
    const body = await (await fetch(`${base}/login`, { headers: { Host: `${HOST}:9999` } })).text();
    expect(body).toContain(`This Inbox lives on <strong>${HOST}:9999</strong>`);
    expect(body).toContain(`Passkeys need <strong>https://${HOST}:4255</strong>. The password works everywhere.`);

    // And the door agrees with its own words: the page it renders for the keys is the pinned address, and
    // `/passkeys` answers at that port instead of refusing the ceremony.
    const signed = await fetch(`${base}/api/auth/sign-in/email`, {
      method: "POST",
      headers: { Host: `${HOST}:4255`, "content-type": "application/json", origin: `https://${HOST}:4255`, "x-forwarded-for": nextClient() },
      body: JSON.stringify({ email: ME, password: PASSWORD }),
    });
    expect(signed.status).toBe(200);
    const cookie = signed.headers.get("set-cookie")?.split(";")[0] ?? "";
    const page = await fetch(`${base}/passkeys`, { headers: { Host: `${HOST}:4255`, cookie } });
    expect(page.status).toBe(200);
    expect(await page.text()).toContain(`A passkey signs you in to <strong>https://${HOST}:4255</strong>`);

    // A port nobody pinned is refused the ceremony by the same rule as ever, and the line names the port
    // a key would have to be made at.
    const elsewhere = await fetch(`${base}/passkeys`, { headers: { Host: `${HOST}:8443`, cookie } });
    expect(elsewhere.status).toBe(403);
    expect(((await elsewhere.json()) as { code: string }).code).toBe("insecure_connection");
  }, 30_000);

  test("offers the passkey page when a proxy under-reports TLS, and still refuses a published port", async () => {
    // The door listens on loopback HTTP and cannot see which proxy ended TLS. `x-forwarded-proto` was the
    // door's guess, and it guessed against the person: a proxy forwarding its own hop as `http` took the
    // page, the list of keys and the removal of one away from a browser that was on TLS. It reads the
    // header for nothing now — only the browser knows, and the page says the door's line itself when
    // `window.isSecureContext` is false. A name that is not this door's, and a port, still refuse.
    const { base } = await startWithAccounts();
    const insecure = { "x-forwarded-proto": "http" };
    await seed(ME);
    const signed = await fetch(`${base}/api/auth/sign-in/email`, {
      method: "POST",
      headers: { Host: HOST, "content-type": "application/json", origin: `https://${HOST}`, ...insecure },
      body: JSON.stringify({ email: ME, password: PASSWORD }),
    });
    expect(signed.status).toBe(200);
    const cookie = signed.headers.get("set-cookie")?.split(";")[0] ?? "";

    // The page, the list and the removal answer at the address the keys belong to, whatever the proxy says
    // about the scheme — the last of those is the one that can only ever make an account safer.
    const page = await fetch(`${base}/passkeys`, { headers: { Host: HOST, cookie, ...insecure } });
    expect(page.status).toBe(200);
    const management = await page.text();
    expect(management).toContain("A passkey signs you in to");
    // …and it names the bare address, because with no port pinned that is where the key lives.
    expect(management).toContain(`A passkey signs you in to <strong>${passkeyOrigin({ host: HOST })}</strong>`);

    const listed = await fetch(`${base}/api/inbox/auth/passkeys`, { headers: { Host: HOST, cookie, ...insecure } });
    expect(listed.status).toBe(200);

    // A port still refuses the ceremony — nothing is pinned here, so the keys live at the bare name only.
    // The door says its line instead of running a ceremony the browser could only fail.
    const ceremony = await fetch(`${base}/api/auth/passkey/generate-register-options`, {
      method: "GET",
      headers: { Host: `${HOST}:4255`, origin: `https://${HOST}:4255`, ...insecure },
    });
    expect(ceremony.status).toBe(403);
    expect(((await ceremony.json()) as { code: string; error: string }).code).toBe("insecure_connection");
    const atPort = await fetch(`${base}/passkeys`, { headers: { Host: `${HOST}:4255`, cookie, ...insecure } });
    expect(atPort.status).toBe(403);
    expect(((await atPort.json()) as { code: string; error: string }).code).toBe("insecure_connection");

    // The window is held to none of this, and never was: only a ceremony needs a secure page.
    const window = await fetch(`${base}/api/inbox/state`, { headers: { Host: HOST, origin: `https://${HOST}`, cookie, ...insecure } });
    expect(await window.text()).not.toContain("insecure_connection");
  }, 30_000);

  test("a request that came through the door cannot change the door", async () => {
    const { base } = await startWithAccounts();
    await seed(ME);
    const signed = await signIn(base, ME);
    expect(signed.answer.status).toBe(200);

    // The door marks what it hands the window (`markFromAuthDoor`), and the card's routes read that
    // mark: someone signed in at the door must not be able to close it behind the next person.
    const answer = await request(`${base}/api/inbox/sign-in/off`, {
      method: "POST",
      headers: { cookie: signed.cookie!, "content-type": "application/json", origin: `https://${HOST}` },
      body: JSON.stringify({}),
    });
    expect(answer.status).toBe(403);
    expect(await answer.json()).toEqual({
      error: "Only the Inbox's owner changes how you get in. Change this on the computer itself or over your tailnet.",
      code: "local_only",
    });
  }, 30_000);

  test("the sign-in page carries the form, the host, and a next that stays on this site", async () => {
    const { base } = await startWithAccounts();
    const page = await request(`${base}/login?next=${encodeURIComponent("//evil.example.net/x")}`);
    expect(page.status).toBe(200);
    expect(page.headers.get("content-security-policy")).toContain("default-src 'none'");
    const body = await page.text();
    expect(body).toContain('name="email"');
    expect(body).toContain('name="password"');
    expect(body).toContain(HOST);
    expect(body).toContain('name="next" value="/"');
    // The page says, before anyone clicks, where a passkey does and does not work.
    expect(body).toContain(`Passkeys need <strong>https://${HOST}</strong>. The password works everywhere.`);
  }, 30_000);

  test("the line says who signed in, and only this door's session decides that", async () => {
    // Location alone cannot tell two people on one allowlist apart, and the place says `tailnet` for both: the
    // account is the only thing that names who wrote it. It is read from the session this door verified and from
    // nothing the request said — the body's own `sent_from` is not a thing a caller can set anywhere.
    const { base, inbox } = await startWithAccounts();
    await seed(ME);
    const signed = await signIn(base, ME);
    expect(signed.cookie).toContain("session_token");

    const project = inbox.store.ensureProject({ name: "shop", root: join(dataDir, "shop") });
    const asked = inbox.store.sendMessage({
      project_id: project.id,
      author: { kind: "agent", host: "claude-code", session: "ses-door", name: "Claude Code" },
      body: "The preview is up.",
      idempotency_key: "door-ask",
    }).message;

    const answer = await request(`${base}/api/inbox/messages/${asked.id}/reply`, {
      method: "POST",
      headers: { cookie: signed.cookie!, "content-type": "application/json", "sec-fetch-dest": "empty" },
      body: JSON.stringify({ idempotency_key: "door-reply", words: "Send me the link.", questions: [] }),
      redirect: "manual",
    });
    expect(answer.status).toBe(200);
    const stored = inbox.store.message(((await answer.json()) as { reply: { id: string } }).reply.id)!;
    // The account the door signed in, name and all (better-auth gives the local part when no name was set).
    expect(stored.sent_from).toEqual({ kind: "tailnet", account: { email: ME, name: "me" } });
  }, 30_000);

  test("a session's cookies stop at the door", () => {
    // better-auth names it __Secure-plannotator.session_token on HTTPS.
    expect(withoutAuthCookies("__Secure-plannotator.session_token=abc; __Secure-plannotator.session_data=def; theme=dark")).toBe("theme=dark");
    expect(withoutAuthCookies("plannotator.session_token=abc")).toBe("");
    // A cookie that merely starts the same letters is the window's own, not the door's.
    expect(withoutAuthCookies("plannotator-sidebar=open; plannotatorx=1")).toBe("plannotator-sidebar=open; plannotatorx=1");
  });

  test("which Host names this door, which origins a sign-in may come from, and which arrivals may run a ceremony", () => {
    // The name is the whole check: whatever port the publisher put after it, this door answers, and a name
    // that is not this door's never does. A request with no `Host` at all answers as it always has — Bun
    // does hand those through (HTTP/1.0, which is what a local health check sends), it names nothing, and
    // it arrives with no `Origin` either, which is what better-auth needs to start a session.
    expect(doorAnswersHost(`${HOST}:4255`, { host: HOST })).toBe(true);
    expect(doorAnswersHost(`${HOST}:443`, { host: HOST })).toBe(true);
    expect(doorAnswersHost(`${HOST}:9999`, { host: HOST })).toBe(true);
    expect(doorAnswersHost(HOST, { host: HOST })).toBe(true);
    expect(doorAnswersHost(`${HOST}:notaport`, { host: HOST })).toBe(false);
    expect(doorAnswersHost("evil.example.net:4255", { host: HOST })).toBe(false);
    expect(doorAnswersHost("127.0.0.1:4255", { host: HOST })).toBe(false);
    expect(doorAnswersHost(null, { host: HOST })).toBe(true);

    // A sign-in's `Origin` follows the address the request arrived at: same-origin, plus this name at the
    // port https implies. A foreign name in `Host` contributes nothing — the door refused it already.
    expect(doorOrigins(`${HOST}:4255`, { host: HOST })).toEqual([`https://${HOST}`, `https://${HOST}:4255`]);
    expect(doorOrigins(HOST, { host: HOST })).toEqual([`https://${HOST}`]);
    expect(doorOrigins(`${HOST}:443`, { host: HOST })).toEqual([`https://${HOST}`]);
    expect(doorOrigins("evil.example.com:4255", { host: HOST })).toEqual([`https://${HOST}`]);
    expect(doorOrigins(null, { host: HOST })).toEqual([`https://${HOST}`]);

    // Passkeys follow the settings, and `rpID` is always the bare name: WebAuthn compares a credential
    // against the exact origin it was made at, so a key lives at `https://<host>` normally and at
    // `https://<host>:<httpsPort>` when the person pinned one — both addresses accept it, so a key made
    // at either works at the other.
    expect(passkeyOrigin({ host: HOST })).toBe(`https://${HOST}`);
    expect(passkeyOrigin({ host: HOST, httpsPort: null })).toBe(`https://${HOST}`);
    expect(passkeyOrigin({ host: HOST, httpsPort: 4255 })).toBe(`https://${HOST}:4255`);
    expect(passkeyOrigin({ host: "Inbox.Example.COM.", httpsPort: 4255 })).toBe(`https://${HOST}:4255`);
    expect(passkeyOrigins({ host: HOST })).toEqual([`https://${HOST}`]);
    expect(passkeyOrigins({ host: HOST, httpsPort: null })).toEqual([`https://${HOST}`]);
    expect(passkeyOrigins({ host: HOST, httpsPort: 4255 })).toEqual([`https://${HOST}`, `https://${HOST}:4255`]);
    expect(doorOffersPasskeys(new Headers({ host: HOST }), { host: HOST })).toBe(true);
    expect(doorOffersPasskeys(new Headers({ host: `${HOST}:443` }), { host: HOST })).toBe(true);
    expect(doorOffersPasskeys(new Headers({ host: HOST, "x-forwarded-proto": "https" }), { host: HOST })).toBe(true);
    // The header decides nothing, in either direction: a proxy that forwards its own loopback hop as `http`
    // while serving the person TLS made the door refuse the page, the list and the removal of a key, and
    // only the browser knows whether the page it rendered is secure. A wrong name or a port still refuses.
    expect(doorOffersPasskeys(new Headers({ host: HOST, "x-forwarded-proto": "http" }), { host: HOST })).toBe(true);
    expect(doorOffersPasskeys(new Headers({ host: `${HOST}:443`, "x-forwarded-proto": "http, https" }), { host: HOST })).toBe(true);
    expect(doorOffersPasskeys(new Headers({ host: `${HOST}:4255`, "x-forwarded-proto": "https" }), { host: HOST })).toBe(false);
    expect(doorOffersPasskeys(new Headers({ host: `${HOST}:9999` }), { host: HOST })).toBe(false);
    expect(doorOffersPasskeys(new Headers({ host: "evil.example.com", "x-forwarded-proto": "https" }), { host: HOST })).toBe(false);
    // With a port pinned, that port joins the bare name and `:443` — and nothing else does. A key made at
    // one pinned port does not work at another, which is what a pin means.
    expect(doorOffersPasskeys(new Headers({ host: HOST }), { host: HOST, httpsPort: 4255 })).toBe(true);
    expect(doorOffersPasskeys(new Headers({ host: `${HOST}:443` }), { host: HOST, httpsPort: 4255 })).toBe(true);
    expect(doorOffersPasskeys(new Headers({ host: `${HOST}:4255` }), { host: HOST, httpsPort: 4255 })).toBe(true);
    expect(doorOffersPasskeys(new Headers({ host: `${HOST}:8443` }), { host: HOST, httpsPort: 4255 })).toBe(false);
    expect(doorOffersPasskeys(new Headers({ host: `${HOST}:8443`, "x-forwarded-proto": "https" }), { host: HOST, httpsPort: 4255 })).toBe(false);
    expect(doorOffersPasskeys(new Headers({ host: "evil.example.net:4255" }), { host: HOST, httpsPort: 4255 })).toBe(false);
    expect(doorOffersPasskeys(new Headers(), { host: HOST, httpsPort: 4255 })).toBe(false);
    // Loopback is a secure context in every browser, so http there may run one. The settings refuse a
    // loopback name today (`isPublicDnsName`), so this is pinned for whoever lifts that — it is the door's
    // own arrival when it does, not somebody else's header.
    expect(doorOffersPasskeys(new Headers({ host: "127.0.0.1:19501" }), { host: HOST })).toBe(true);
    expect(doorOffersPasskeys(new Headers({ host: "localhost" }), { host: HOST })).toBe(true);
    // And the one proof that is real, for the day the door ends TLS itself instead of a proxy doing it.
    expect(doorOffersPasskeys(new Headers({ host: `${HOST}:4255` }), { host: HOST }, { tls: true })).toBe(true);
  });

  test("next stays on this site", () => {
    expect(safeNextPath("/threads/abc?x=1")).toBe("/threads/abc?x=1");
    expect(safeNextPath("//evil.example.net")).toBe("/");
    expect(safeNextPath("https://evil.example.net/")).toBe("/");
    expect(safeNextPath("/\\evil")).toBe("/");
    expect(safeNextPath("/login?next=/x")).toBe("/");
    expect(safeNextPath("/api/auth/session")).toBe("/");
    expect(safeNextPath(null)).toBe("/");
  });
});
