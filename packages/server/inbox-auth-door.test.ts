import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { arrivedOverTls, doorAnswersHost, safeNextPath, withoutAuthCookies } from "@plannotator/shared/inbox/auth-door";
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

  test("answers the name with the port its proxy ends TLS at", async () => {
    // `tailscale serve --https=4255` forwards `Host: inbox.example.com:4255`. A door that only answers the
    // bare name turns away the one address it is published at, and the sign-in page never loads.
    const { base, inbox } = await startWithAccounts({ httpsPort: 4255 });
    const at = await fetch(`${base}/login`, { headers: { Host: `${HOST}:4255` } });
    expect(at.status).toBe(200);
    // The name alone and the name at 443 are the same address, so they still answer.
    expect((await fetch(`${base}/login`, { headers: { Host: HOST } })).status).toBe(200);
    expect((await fetch(`${base}/login`, { headers: { Host: `${HOST}:443` } })).status).toBe(200);
    // A port the door was never given is somebody else's, even under the same name: the address the
    // Origin check and every passkey are matched against comes from the settings, not from the header.
    const other = await fetch(`${base}/login`, { headers: { Host: `${HOST}:9999` } });
    expect(other.status).toBe(403);
    expect(((await other.json()) as { code: string }).code).toBe("forbidden_host");
    // And the address people were told to open carries the port.
    expect(inbox.registry.inbox_auth?.url).toBe(`https://${HOST}:4255/`);
  }, 30_000);

  test("says its address with the port, so passkeys are aimed at the right one", async () => {
    const { base } = await startWithAccounts({ httpsPort: 4255 });
    const page = await fetch(`${base}/login`, { headers: { Host: `${HOST}:4255` } });
    const body = await page.text();
    expect(body).toContain(`This Inbox lives on <strong>${HOST}:4255</strong>`);
    expect(body).toContain(`Passkeys need <strong>https://${HOST}:4255</strong>.`);
  }, 30_000);

  test("refuses a passkey ceremony that arrived over plain HTTP", async () => {
    // The door listens on loopback HTTP; the proxy in front says what the browser saw. On `http://…` a
    // passkey cannot be minted at all, so the door says so instead of showing a page whose button fails.
    const { base } = await startWithAccounts({ httpsPort: 4255 });
    const insecure = { "x-forwarded-proto": "http", "x-forwarded-host": `${HOST}:4255` };
    await seed(ME);
    const signed = await fetch(`${base}/api/auth/sign-in/email`, {
      method: "POST",
      headers: { Host: `${HOST}:4255`, "content-type": "application/json", origin: `https://${HOST}:4255`, ...insecure },
      body: JSON.stringify({ email: ME, password: PASSWORD }),
    });
    // The password path is untouched: it works over either arrival.
    expect(signed.status).toBe(200);
    const cookie = signed.headers.get("set-cookie")?.split(";")[0] ?? "";

    const page = await fetch(`${base}/passkeys`, { headers: { Host: `${HOST}:4255`, cookie, ...insecure } });
    expect(page.status).toBe(403);
    expect(((await page.json()) as { code: string; error: string }).code).toBe("insecure_connection");

    const listed = await fetch(`${base}/api/inbox/auth/passkeys`, { headers: { Host: `${HOST}:4255`, cookie, ...insecure } });
    expect(listed.status).toBe(403);
    expect(((await listed.json()) as { code: string }).code).toBe("insecure_connection");

    // better-auth's own ceremony routes, before it has anything to say.
    const ceremony = await fetch(`${base}/api/auth/passkey/generate-register-options`, {
      method: "GET",
      headers: { Host: `${HOST}:4255`, origin: `https://${HOST}:4255`, ...insecure },
    });
    expect(ceremony.status).toBe(403);
    expect(((await ceremony.json()) as { code: string; error: string }).code).toBe("insecure_connection");

    // The window is not held to this: a proxy may forward its own loopback hop as `http` while serving the
    // person TLS, and only a ceremony needs a secure page.
    const window = await fetch(`${base}/api/inbox/state`, { headers: { Host: `${HOST}:4255`, origin: `https://${HOST}:4255`, cookie, ...insecure } });
    expect(await window.text()).not.toContain("insecure_connection");

    // And the same passkey routes answer normally when the proxy says the browser was on HTTPS.
    const secure = await fetch(`${base}/passkeys`, {
      headers: { Host: `${HOST}:4255`, "x-forwarded-proto": "https", cookie },
    });
    expect(secure.status).toBe(200);
    expect(await secure.text()).toContain("A passkey signs you in to");
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

  test("which Host names this door, and which arrivals may mint a passkey", () => {
    const at4255 = { host: HOST, httpsPort: 4255 };
    expect(doorAnswersHost(`${HOST}:4255`, at4255)).toBe(true);
    expect(doorAnswersHost(HOST, at4255)).toBe(true);
    expect(doorAnswersHost(`${HOST}:443`, at4255)).toBe(true);
    expect(doorAnswersHost(`${HOST}:4256`, at4255)).toBe(false);
    // A door published at 443 answers no port but 443 — the old "strip any port" rule let a made-up one in.
    expect(doorAnswersHost(`${HOST}:8443`, { host: HOST, httpsPort: null })).toBe(false);
    expect(doorAnswersHost(`${HOST}:443`, { host: HOST, httpsPort: null })).toBe(true);
    expect(doorAnswersHost("evil.example.net", at4255)).toBe(false);
    expect(doorAnswersHost(null, at4255)).toBe(true);

    expect(arrivedOverTls(new Headers())).toBe(true);
    expect(arrivedOverTls(new Headers({ "x-forwarded-proto": "https" }))).toBe(true);
    expect(arrivedOverTls(new Headers({ "x-forwarded-proto": "http" }))).toBe(false);
    // The first hop of a chain is what the browser saw.
    expect(arrivedOverTls(new Headers({ "x-forwarded-proto": "http, https" }))).toBe(false);
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
