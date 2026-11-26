import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AUTH_JS } from "./inbox-auth-login";
import { openInboxAuth, type InboxAuthInstance } from "./inbox-auth-instance";
import { startInboxServer, type InboxServer } from "./inbox";
import { assertionResponse, makeFixtureKey, registrationResponse, type FixtureKey } from "./passkey-fixtures";

/**
 * Passkeys at the Inbox's sign-in door.
 *
 * `passkey-fixtures.ts` is a software authenticator, so the requests below carry the bytes a real
 * browser carries and better-auth's relying-party checks run for real: the rpId hash, the origin, the
 * challenge binding, the stored key's signature, the counter. What these tests guard is the door's
 * half of the deal — who may add a passkey and for whom, what the door hands a browser, what it
 * refuses to remove, and what a page that needs the door cannot be talked into.
 */

const HOST = "inbox.example.com";
const ORIGIN = `https://${HOST}`;
const ME = "me@example.com";
const OTHER = "someone@example.com";
const PASSWORD = "correct horse battery staple";
const HTML = "<!doctype html><title>Inbox</title>";

let dataDir: string;
const servers: InboxServer[] = [];
const saved: Record<string, string | undefined> = {};
const ENV = ["PLANNOTATOR_DATA_DIR", "PLANNOTATOR_INBOX_AUTH", "PLANNOTATOR_INBOX_AUTH_SECRET"] as const;

beforeEach(() => {
  for (const name of ENV) saved[name] = process.env[name];
  dataDir = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-passkey-")));
  process.env.PLANNOTATOR_DATA_DIR = dataDir;
  delete process.env.PLANNOTATOR_INBOX_AUTH;
  delete process.env.PLANNOTATOR_INBOX_AUTH_SECRET;
});

afterEach(async () => {
  for (const server of servers.splice(0)) server.stop();
  for (const name of ENV) {
    if (saved[name] === undefined) delete process.env[name];
    else process.env[name] = saved[name];
  }
  rmSync(dataDir, { recursive: true, force: true });
});

function freePort(): number {
  const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response(null) });
  const port = probe.port as number;
  probe.stop(true);
  return port;
}

/** A request the way a named tunnel forwards it: to the loopback port, with the public name in Host. */
function request(url: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("Host", HOST);
  return fetch(url, { ...init, headers });
}

/** The cookies the door set, kept the way a browser keeps them: a ceremony spans two requests. */
class Jar {
  private readonly pairs = new Map<string, string>();

  absorb(answer: Response): void {
    for (const line of answer.headers.getSetCookie?.() ?? []) {
      const [pair] = line.split(";");
      const at = pair.indexOf("=");
      this.pairs.set(pair.slice(0, at), pair.slice(at + 1));
    }
  }

  get header(): string {
    return [...this.pairs].map(([name, value]) => `${name}=${value}`).join("; ");
  }

  find(name: string): string {
    for (const [key, value] of this.pairs) if (key.includes(name)) return `${key}=${value}`;
    return "";
  }

  get session(): string {
    return this.find("session_token");
  }
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

/** An Inbox whose door is on, at a known port, with the address its door answers at. */
async function startWithAccounts(allow: readonly string[] = [ME]): Promise<{ base: string }> {
  const port = freePort();
  writeFileSync(join(dataDir, "config.json"), JSON.stringify({ inboxAuth: { on: true, host: HOST, allow: [...allow], port } }));
  const inbox = await startInboxServer({ dataDir, htmlContent: HTML });
  servers.push(inbox);
  const base = `http://127.0.0.1:${port}`;
  await waitForDoor(base);
  return { base };
}

/**
 * A door that serves passkeys needs to know where it is: an account made through the same address,
 * so its rows and its secret are the ones the running door reads.
 */
async function seed(email: string, password = PASSWORD): Promise<void> {
  const instance = await openInboxAuth({ dataDir, baseUrl: ORIGIN, allow: [ME, OTHER], webauthn: { rpID: HOST, origin: ORIGIN } });
  try {
    await instance.set({ email, password });
  } finally {
    instance.close();
  }
}

async function withInstance<T>(run: (instance: InboxAuthInstance) => Promise<T>): Promise<T> {
  const instance = await openInboxAuth({ dataDir, baseUrl: ORIGIN, allow: [ME, OTHER], webauthn: { rpID: HOST, origin: ORIGIN } });
  try {
    return await run(instance);
  } finally {
    instance.close();
  }
}

/** The `passkey` table itself, for what actually landed. */
async function passkeyRows(): Promise<Record<string, unknown>[]> {
  return withInstance(async (instance) => {
    const ctx = await instance.auth.$context;
    return (await ctx.adapter.findMany({ model: "passkey", where: [] })) as unknown as Record<string, unknown>[];
  });
}

const userIdOf = (email: string) =>
  withInstance(async (instance) => String((await instance.auth.$context).internalAdapter && (await (await instance.auth.$context).internalAdapter.findUserByEmail(email))!.id));

let client = 0;
/** A distinct client address per sign-in: the door's rate limit buckets by address, as it does through a tunnel. */
function nextClient(): string {
  client += 1;
  return `203.0.113.${client}`;
}

async function signInJar(base: string, email: string, password = PASSWORD): Promise<Jar> {
  const jar = new Jar();
  const answer = await request(`${base}/api/auth/sign-in/email`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: ORIGIN, "x-forwarded-for": nextClient() },
    body: JSON.stringify({ email, password }),
  });
  jar.absorb(answer);
  return jar;
}

const signIn = async (base: string, email: string, password = PASSWORD): Promise<string> => (await signInJar(base, email, password)).session;

/**
 * better-auth's routes as the door's page calls them: same origin, the page's cookies. A ceremony
 * spans two requests, so anything the answer sets is kept in the jar the way a browser keeps it.
 */
async function authFetch(base: string, path: string, init: RequestInit, jar: Jar): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("origin", ORIGIN);
  if (jar.header) headers.set("cookie", jar.header);
  const answer = await request(`${base}${path}`, { ...init, headers });
  jar.absorb(answer);
  return answer;
}

async function registerPasskey(base: string, jar: Jar, key: FixtureKey, name?: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const started = await authFetch(base, "/api/auth/passkey/generate-register-options", { method: "GET" }, jar);
  const options = (await started.json()) as Record<string, unknown>;
  if (started.status !== 200) return { status: started.status, body: options };
  const challenge = String(options.challenge ?? "");
  expect(challenge.length > 16).toBe(true);

  const answer = await authFetch(
    base,
    "/api/auth/passkey/verify-registration",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ response: JSON.parse(registrationResponse({ key, rpId: HOST, origin: ORIGIN, challenge })), name }),
    },
    jar,
  );
  return { status: answer.status, body: (await answer.json()) as Record<string, unknown> };
}

async function signInWithPasskey(base: string, key: FixtureKey, credentialId: string, counter: number, rpId = HOST, origin = ORIGIN): Promise<Response> {
  const jar = new Jar();
  const started = await authFetch(base, "/api/auth/passkey/generate-authenticate-options", { method: "GET" }, jar);
  expect(started.status).toBe(200);
  const options = (await started.json()) as Record<string, unknown>;
  const challenge = String(options.challenge ?? "");
  expect(challenge.length > 16).toBe(true);
  return authFetch(
    base,
    "/api/auth/passkey/verify-authentication",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ response: JSON.parse(assertionResponse({ key, rpId, origin, challenge, credentialId, counter })) }),
    },
    jar,
  );
}

async function jsonOf(answer: Promise<Response> | Response): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await answer;
  return { status: response.status, body: (await response.json().catch(() => ({}))) as Record<string, unknown> };
}

const listPasskeys = (base: string, cookie: string) => jsonOf(request(`${base}/api/inbox/auth/passkeys`, { headers: { cookie, origin: ORIGIN } }));

const removePasskey = (base: string, cookie: string, id: string) =>
  jsonOf(
    request(`${base}/api/inbox/auth/passkeys/remove`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie, origin: ORIGIN },
      body: JSON.stringify({ id }),
    }),
  );

const listed = (body: Record<string, unknown>): Record<string, unknown>[] => (body.passkeys ?? []) as Record<string, unknown>[];

describe("passkeys at the sign-in door", () => {
  test("a signed-in person can add a passkey, and a second one lands beside it", async () => {
    const { base } = await startWithAccounts();
    await seed(ME);
    const jar = await signInJar(base, ME);
    expect(jar.session).toContain(".");

    expect((await registerPasskey(base, jar, makeFixtureKey(), "Pixel laptop")).status).toBe(200);

    const first = await listPasskeys(base, jar.header);
    expect(first.status).toBe(200);
    expect(first.body.error).toBeUndefined();
    const keys = listed(first.body);
    expect(keys).toHaveLength(1);
    expect(String(keys[0].name)).toBe("Pixel laptop");
    expect(String(keys[0].id).length > 0).toBe(true);
    expect(String(keys[0].createdAt)).toContain("20");

    // Two passkeys are two rows: the plugin never overwrites a credential, so losing a phone or a
    // laptop is not losing the Inbox.
    expect((await registerPasskey(base, jar, makeFixtureKey(), "Yubikey")).status).toBe(200);
    const rows = await passkeyRows();
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((row) => String(row.credentialID))).size).toBe(2);
    expect(new Set(rows.map((row) => String(row.userId))).size).toBe(1);
    expect(listed((await listPasskeys(base, jar.header)).body)).toHaveLength(2);
  }, 60_000);

  test("the door's list names a passkey by its own id, and keeps the stored key to itself", async () => {
    const { base } = await startWithAccounts();
    await seed(ME);
    const jar = await signInJar(base, ME);
    const key = makeFixtureKey();
    expect((await registerPasskey(base, jar, key, "Pixel laptop")).status).toBe(200);

    const text = JSON.stringify((await listPasskeys(base, jar.header)).body);
    expect(text).not.toContain("publicKey");
    expect(text).not.toContain(key.publicKeySpki);
    // A ceremony is given credential ids by better-auth; a management list is not, and the door
    // addresses a passkey by its own row id. Nothing stored here is handed back as if it were held.
    expect(text).not.toContain("credentialID");
    expect(text).not.toContain("counter");

    const keys = listed((await listPasskeys(base, jar.header)).body);
    expect((await removePasskey(base, jar.header, String(keys[0].id))).status).toBe(200);
    expect(await passkeyRows()).toHaveLength(0);
  }, 60_000);

  test("a passkey signs in through the door, and that session opens the window", async () => {
    const { base } = await startWithAccounts();
    await seed(ME);
    const jar = await signInJar(base, ME);
    const key = makeFixtureKey();
    expect((await registerPasskey(base, jar, key, "Pixel laptop")).status).toBe(200);
    const credentialId = String((await passkeyRows())[0].credentialID);

    const answer = await signInWithPasskey(base, key, credentialId, 1);
    expect(answer.status).toBe(200);
    const session = new Jar();
    session.absorb(answer);
    expect(session.session).toContain(".");

    const page = await request(`${base}/`, { headers: { cookie: session.header }, redirect: "manual" });
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("<title>Inbox</title>");
  }, 60_000);

  test("the same assertion twice is refused: a captured passkey sign-in cannot be replayed", async () => {
    const { base } = await startWithAccounts();
    await seed(ME);
    const jar = await signInJar(base, ME);
    const key = makeFixtureKey();
    expect((await registerPasskey(base, jar, key, "Pixel laptop")).status).toBe(200);
    const credentialId = String((await passkeyRows())[0].credentialID);

    expect((await signInWithPasskey(base, key, credentialId, 7)).status).toBe(200);

    // The counter is what says “this signing happened after that one”. Sending the assertion the
    // person already used must not open the door a second time.
    const replay = await signInWithPasskey(base, key, credentialId, 7);
    expect(replay.status).toBe(400);
    expect(((await replay.json()) as { code: string }).code).toBe("AUTHENTICATION_FAILED");
    const held = new Jar();
    held.absorb(replay);
    expect(held.session).toBe("");
  }, 60_000);

  test("an assertion from a different key is refused", async () => {
    const { base } = await startWithAccounts();
    await seed(ME);
    const jar = await signInJar(base, ME);
    const key = makeFixtureKey();
    expect((await registerPasskey(base, jar, key, "Pixel laptop")).status).toBe(200);
    const credentialId = String((await passkeyRows())[0].credentialID);

    const refused = await signInWithPasskey(base, makeFixtureKey(), credentialId, 1);
    expect(refused.status).toBe(401);
    expect(((await refused.json()) as { code: string }).code).toBe("AUTHENTICATION_FAILED");
    const held = new Jar();
    held.absorb(refused);
    expect(held.session).toBe("");
  }, 60_000);

  test("a passkey made for another site cannot sign in here", async () => {
    const { base } = await startWithAccounts();
    await seed(ME);
    const jar = await signInJar(base, ME);
    const key = makeFixtureKey();
    expect((await registerPasskey(base, jar, key, "Pixel laptop")).status).toBe(200);
    const credentialId = String((await passkeyRows())[0].credentialID);

    // The relying party is a name, and the plugin checks it before anything else: “another site” is
    // refused by the rpId hash, the origin, or both, and never by the key itself.
    const wrongRpId = await signInWithPasskey(base, key, credentialId, 1, "somewhere-else.example");
    expect(wrongRpId.status).toBe(400);
    expect(((await wrongRpId.json()) as { code: string }).code).toBe("AUTHENTICATION_FAILED");

    const wrongOrigin = await signInWithPasskey(base, key, credentialId, 2, HOST, "https://somewhere-else.example");
    expect(wrongOrigin.status).toBe(400);
    expect(((await wrongOrigin.json()) as { code: string }).code).toBe("AUTHENTICATION_FAILED");
    const held = new Jar();
    held.absorb(wrongOrigin);
    expect(held.session).toBe("");

    // The one wrong origin that can genuinely reach this port: the loopback address the door listens on.
    // Its ceremony routes do answer — the `Host` is the door's own name, so the door lets the ceremony
    // through — which means the refusal has to come from the assertion. The expected origin stays the
    // pinned `passkeyOrigin`, and is never widened to whatever address the request arrived at.
    const fromTheListener = await signInWithPasskey(base, key, credentialId, 3, HOST, base);
    expect(fromTheListener.status).toBe(400);
    expect(((await fromTheListener.json()) as { code: string }).code).toBe("AUTHENTICATION_FAILED");
    const alsoHeld = new Jar();
    alsoHeld.absorb(fromTheListener);
    expect(alsoHeld.session).toBe("");
  }, 60_000);

  test("a passkey is only ever listed and removed for the signed-in account", async () => {
    const { base } = await startWithAccounts([ME, OTHER]);
    await seed(ME);
    await seed(OTHER);
    const mine = await signInJar(base, ME);
    const theirs = await signInJar(base, OTHER);
    expect((await registerPasskey(base, mine, makeFixtureKey(), "Pixel laptop")).status).toBe(200);
    const foreign = (await passkeyRows())[0];

    const listedTheirs = await listPasskeys(base, theirs.header);
    expect(listedTheirs.status).toBe(200);
    expect(listedTheirs.body.passkeys).toEqual([]);
    const stolen = await removePasskey(base, theirs.header, String(foreign.id));
    expect(stolen.status).toBe(404);
    expect(String(stolen.body.code)).toBe("not_here");
    expect(await passkeyRows()).toHaveLength(1);

    // With no session at all, neither endpoint answers.
    expect((await listPasskeys(base, "")).status).toBe(401);
    expect((await removePasskey(base, "", String(foreign.id))).status).toBe(401);
  }, 60_000);

  test("an account whose only way in is passkeys keeps its last one", async () => {
    // An account with a password can lose its passkey: there is still another way in.
    const { base } = await startWithAccounts([ME, "keys-only@example.com"]);
    await seed(ME);
    const jar = await signInJar(base, ME);
    expect((await registerPasskey(base, jar, makeFixtureKey(), "Pixel laptop")).status).toBe(200);
    const mine = listed((await listPasskeys(base, jar.header)).body);
    expect((await removePasskey(base, jar.header, String(mine[0].id))).status).toBe(200);
    expect(await passkeyRows()).toHaveLength(0);

    // An account whose only credential is a passkey keeps it. Its address is on the list, and it is
    // signed in the way it can be, so the request reaches the guard instead of the door turning it
    // away first: a refusal here has to come from `removePasskey`, not from the allowlist.
    const keysOnly = "keys-only@example.com";
    await seed(keysOnly);
    const owner = await signInJar(base, keysOnly);
    expect(owner.session).toContain(".");
    expect((await registerPasskey(base, owner, makeFixtureKey(), "Only key")).status).toBe(200);
    expect(await passkeyRows()).toHaveLength(1);

    // The password goes, leaving the passkey as the account's one way in.
    await withInstance(async (instance) => {
      const ctx = await instance.auth.$context;
      const found = await ctx.internalAdapter.findUserByEmail(keysOnly);
      await ctx.internalAdapter.deleteAccounts(found!.user.id);
    });

    const held = listed((await listPasskeys(base, owner.header)).body);
    expect(held).toHaveLength(1);
    const removed = await removePasskey(base, owner.header, String(held[0].id));
    expect(removed.status).toBe(409);
    expect(String(removed.body.code)).toBe("last_way_in");
    expect(await passkeyRows()).toHaveLength(1);
  }, 60_000);

  test("a passkey signs in only as far as the allowlist lets that address in", async () => {
    const { base } = await startWithAccounts();
    await seed(ME);
    await seed(OTHER);
    const jar = await signInJar(base, OTHER);
    const key = makeFixtureKey();
    expect((await registerPasskey(base, jar, key, "Pixel laptop")).status).toBe(200);
    const credentialId = String((await passkeyRows())[0].credentialID);

    // The ceremony itself is better-auth's, and it does not know about the door's allowlist: the
    // session it makes is real. What refuses it is the door, on the way to the window.
    const answer = await signInWithPasskey(base, key, credentialId, 1);
    expect(answer.status).toBe(200);
    const session = new Jar();
    session.absorb(answer);
    expect(session.session).toContain(".");

    const page = await request(`${base}/`, { headers: { cookie: session.header, accept: "text/html" }, redirect: "manual" });
    expect(page.status).toBe(303);
    expect(page.headers.get("location")).toContain("error=account");
    const call = await request(`${base}/api/inbox/state`, { headers: { cookie: session.header, origin: ORIGIN } });
    expect(call.status).toBe(401);
    expect((await call.json()).code).toBe("account_not_allowed");
  }, 60_000);

  test("removing a passkey is refused from another site", async () => {
    await seed(ME);
    const { base } = await startWithAccounts();
    const jar = await signInJar(base, ME);
    expect((await registerPasskey(base, jar, makeFixtureKey(), "Pixel laptop")).status).toBe(200);
    const [only] = listed((await listPasskeys(base, jar.header)).body);

    // A page on another site can make the browser send its cookies; it cannot make its Origin ours.
    const crossed = await request(`${base}/api/inbox/auth/passkeys/remove`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://evil.example.net", cookie: jar.header },
      body: JSON.stringify({ id: String(only.id) }),
    });
    expect(crossed.status).toBe(403);
    expect(((await crossed.json()) as { code: string }).code).toBe("forbidden_origin");
    expect(await passkeyRows()).toHaveLength(1);

    // The door's own page removes it, and its Origin is the door's.
    expect((await removePasskey(base, jar.header, String(only.id))).status).toBe(200);
  }, 60_000);

  test("a removed passkey stops signing in", async () => {
    const { base } = await startWithAccounts();
    await seed(ME);
    const jar = await signInJar(base, ME);
    const gone = makeFixtureKey();
    expect((await registerPasskey(base, jar, gone, "Old phone")).status).toBe(200);
    expect((await registerPasskey(base, jar, makeFixtureKey(), "Pixel laptop")).status).toBe(200);
    const rows = await passkeyRows();
    const doomed = rows.find((row) => String(row.name) === "Old phone");
    const doomedCredential = String(doomed?.credentialID ?? "");
    expect((await signInWithPasskey(base, gone, doomedCredential, 1)).status).toBe(200);

    const keys = listed((await listPasskeys(base, jar.header)).body);
    const target = keys.find((key) => String(key.name) === "Old phone");
    expect((await removePasskey(base, jar.header, String(target?.id ?? ""))).status).toBe(200);

    const refused = await signInWithPasskey(base, gone, doomedCredential, 2);
    expect(refused.status).toBe(401);
    expect(((await refused.json()) as { code: string }).code).toBe("PASSKEY_NOT_FOUND");
    const held = new Jar();
    held.absorb(refused);
    expect(held.session).toBe("");
  }, 60_000);

  test("the passkey page is behind the door, and its next stays on this site", async () => {
    const { base } = await startWithAccounts();
    await seed(ME);

    const anon = await request(`${base}/passkeys`, { headers: { accept: "text/html" }, redirect: "manual" });
    expect(anon.status).toBe(303);
    expect(anon.headers.get("location")).toBe(`/login?next=${encodeURIComponent("/passkeys")}`);

    const jar = await signInJar(base, ME);
    const page = await request(`${base}/passkeys`, { headers: { cookie: jar.header, accept: "text/html" }, redirect: "manual" });
    expect(page.status).toBe(200);
    expect(page.headers.get("content-type")).toContain("text/html");
    expect(page.headers.get("content-security-policy")).toContain("default-src 'none'");
    const body = await page.text();
    expect(body).toContain("asskey");
    // The page talks to the door only, is given no address to fetch, and is handed no stored credential.
    expect(body).not.toContain("http://");
    expect(body).not.toContain("publicKeySpki");

    const hijack = await request(`${base}/passkeys?next=${encodeURIComponent("//evil.example.net/x")}`, { headers: { cookie: jar.header, accept: "text/html" } });
    expect(await hijack.text()).not.toContain("evil.example.net");
  }, 60_000);

  test("the sign-in page offers a passkey, and the password form still works without one", async () => {
    const { base } = await startWithAccounts();
    await seed(ME);
    const body = await (await request(`${base}/login`)).text();
    expect(body).toContain("asskey");
    expect(body).toContain('name="email"');
    expect(body).toContain('name="password"');
    expect(body).toContain("auth-passkey");
    // What the button does is in the page's own script, which the CSP lets this page load from itself.
    const script = await (await request(`${base}/auth.js`)).text();
    expect(script).toContain("navigator.credentials");
    expect(script).toContain("/api/auth/passkey/verify-authentication");
    expect(await signIn(base, ME)).toContain(".");
  }, 60_000);

  test("the page's script turns a browser's answer into the request the plugin expects", async () => {
    // The ceremony's other half is the browser's, and what the page's script does with
    // `navigator.credentials` is the part that can silently rot: no other test runs it.
    const element = () => {
      const listeners = new Map<string, () => void>();
      return {
        disabled: false,
        hidden: true,
        textContent: "",
        value: "",
        addEventListener: (name: string, run: () => void) => listeners.set(name, run),
        click: () => listeners.get("click")?.(),
      };
    };
    const button = element();
    const line = element();
    const next = { value: "/inbox" };
    const document = {
      getElementById: (id: string) => (id === "auth-passkey" ? button : id === "auth-passkey-error" ? line : null),
      querySelector: (selector: string) => (selector === 'input[name="next"]' ? next : null),
    };

    const called: string[] = [];
    const posted: Record<string, unknown>[] = [];
    const fetch = async (url: string, init?: RequestInit) => {
      called.push(url);
      if (url.endsWith("/api/auth/passkey/generate-authenticate-options")) {
        return new Response(JSON.stringify({ challenge: "Y2hhbGxlbmdl", rpId: HOST, timeout: 60000, userVerification: "preferred" }), { status: 200 });
      }
      posted.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response(JSON.stringify({ token: "made" }), { status: 200 });
    };
    let ceremony: { challenge: ArrayBuffer; rpId: string } | null = null;
    const navigator = {
      credentials: {
        get: async (options: { publicKey: { challenge: ArrayBuffer; rpId: string } }) => {
          ceremony = options.publicKey;
          return {
            id: "AQL6",
            rawId: Uint8Array.from([1, 2, 250]).buffer,
            type: "public-key",
            authenticatorAttachment: "platform",
            getClientExtensionResults: () => ({}),
            response: {
              clientDataJSON: Uint8Array.from([4, 5]).buffer,
              authenticatorData: Uint8Array.from([6]).buffer,
              signature: Uint8Array.from([9, 8, 7]).buffer,
              userHandle: null,
            },
          };
        },
      },
    };
    const location = { gone: "", replace(to: string) { this.gone = to; } };

    // The script the door serves, given the globals a page in a browser would have.
    new Function("window", "document", "navigator", "fetch", "location", "atob", "btoa", AUTH_JS)(
      {},
      document,
      navigator,
      fetch,
      location,
      (value: string) => Buffer.from(value, "base64").toString("binary"),
      (value: string) => Buffer.from(value, "binary").toString("base64"),
    );

    button.click();
    await Bun.sleep(20);

    expect(called).toEqual(["/api/auth/passkey/generate-authenticate-options", "/api/auth/passkey/verify-authentication"]);
    // The challenge the plugin gave (base64url) reaches the browser decoded, and the browser's answer
    // reaches the plugin encoded the way it parses.
    expect(ceremony).not.toBeNull();
    expect(Buffer.from(ceremony!.challenge).toString("utf8")).toBe("challenge");
    expect(ceremony!.rpId).toBe(HOST);
    expect(posted).toHaveLength(1);
    expect(posted[0]).toMatchObject({
      response: { id: "AQL6", rawId: "AQL6", type: "public-key", response: { clientDataJSON: "BAU", authenticatorData: "Bg", signature: "CQgH" } },
    });
    expect(location.gone).toBe("/inbox");
  }, 30_000);

  test("a door published at a port keeps its passkeys on the bare name", async () => {
    // The owner's setup: `tailscale serve --https=4255` publishes the door at
    // `https://inbox.example.com:4255`, and nothing in config.json mentions 4255. Password sign-in
    // follows the request (pinned in `inbox-auth-door.test.ts`). Passkeys do not follow it, and the reason
    // is not a policy choice: WebAuthn checks a key against the exact origin it was minted for, so a key
    // made for `https://inbox.example.com:4255` could never come back at the bare name, and would be
    // stranded the moment the publisher picked a different port. The door mints for `https://<host>` and
    // says so at every other port, rather than starting a ceremony the browser would then refuse.
    const { base } = await startWithAccounts();
    await seed(ME);
    const at = `https://${HOST}:4255`;
    const headers = (extra: Record<string, string> = {}) => ({ Host: `${HOST}:4255`, origin: at, "x-forwarded-for": nextClient(), ...extra });

    // The password door is open at that address, and the session it mints works there.
    const jar = new Jar();
    const signed = await fetch(`${base}/api/auth/sign-in/email`, {
      method: "POST",
      headers: headers({ "content-type": "application/json" }),
      body: JSON.stringify({ email: ME, password: PASSWORD }),
    });
    jar.absorb(signed);
    expect(signed.status).toBe(200);

    // A passkey ceremony there is refused before better-auth sees it, because the address is the port and
    // not the name a key belongs to; `x-forwarded-proto` plays no part in the answer either way, so a
    // self-asserted `https` from the same request changes nothing.
    for (const extra of [{}, { "x-forwarded-proto": "https" }, { "x-forwarded-proto": "https", "x-forwarded-host": HOST }]) {
      const started = await fetch(`${base}/api/auth/passkey/generate-register-options`, { method: "GET", headers: headers({ cookie: jar.header, ...extra }) });
      expect(started.status).toBe(403);
      expect(((await started.json()) as { code: string }).code).toBe("insecure_connection");
    }
    expect(await passkeyRows()).toHaveLength(0);

    // At the address the keys belong to — the bare name — the same account runs the ceremony, and the key
    // it mints signs in there.
    const bare = await signInJar(base, ME);
    const key = makeFixtureKey();
    const registered = await registerPasskey(base, bare, key, "Pixel laptop");
    expect(registered.status).toBe(200);
    const rows = await passkeyRows();
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect((await signInWithPasskey(base, key, String(row.credentialID), 1)).status).toBe(200);

    // And that key is not offered at the port: the door answers the ceremony routes there with its own
    // refusal, which is what the person needs to see instead of a browser that fails mid-ceremony.
    const ported = await fetch(`${base}/api/auth/passkey/generate-authenticate-options`, { method: "GET", headers: headers() });
    expect(ported.status).toBe(403);
    expect(((await ported.json()) as { code: string }).code).toBe("insecure_connection");
  }, 60_000);

  test("a passkey cannot be added without a session", async () => {
    const { base } = await startWithAccounts();
    await seed(ME);
    const anon = await request(`${base}/api/auth/passkey/generate-register-options`, { method: "GET", headers: { origin: ORIGIN } });
    expect(anon.status).toBe(401);
    const page = await request(`${base}/api/inbox/auth/passkeys`, { headers: { origin: ORIGIN } });
    expect(page.status).toBe(401);
  }, 60_000);
});
