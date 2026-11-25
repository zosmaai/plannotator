import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "@plannotator/shared/config";
import { resolveInboxAuth } from "@plannotator/shared/inbox/auth-door";
import { checkServerSession, serverSessionMismatchBody, INBOX_SERVER_SESSION_MISMATCH_ERROR } from "@plannotator/shared/server-session";
import { AUTH_MIN_PASSWORD_LENGTH } from "./inbox-auth-instance";
import type { InboxAuthDoorState } from "./inbox-auth-door";
import { AUTH_ROUTE, createAuthRoutes } from "./inbox-auth-routes";

/**
 * The sign-in card's routes, in process. The data dir is handed to the route context; nothing here
 * touches `~/.plannotator`, and the door is a stub that answers from config.json — the settings it
 * would have restarted with — so what the card shows is measured against what is written.
 */

const SERVER_SESSION = "this-server";

let dir = "";
let server: ReturnType<typeof Bun.serve> | undefined;
let base = "";
let restarts = 0;
// What the door reports instead of its own reading, for the one case a real door can reach but a test
// cannot ask for: a port another program had already taken when it tried to start.
let doorOverride: Partial<InboxAuthDoorState> | null = null;
// config.json is read and written by `loadConfig`/`saveConfig`, which follow PLANNOTATOR_DATA_DIR. The
// test sandbox default is fine, but the assertions below want to know which file they are reading.
const savedDataDir = process.env["PLANNOTATOR_DATA_DIR"];

/** What a door says after `restart`: the settings it reads from config.json, or the failure it met. */
const doorState = (): InboxAuthDoorState => {
  const resolved = resolveInboxAuth(loadConfig(), process.env, () => false);
  const settings = resolved.settings;
  return {
    on: resolved.on,
    configured: resolved.configured,
    url: settings ? `https://${settings.host}/` : null,
    port: settings?.port ?? null,
    allow: settings?.allow ?? [],
    error: resolved.error,
    ...doorOverride,
  };
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "plannotator-auth-routes-"));
  process.env["PLANNOTATOR_DATA_DIR"] = dir;
  restarts = 0;
  doorOverride = null;
  const routes = createAuthRoutes({
    dataDir: dir,
    door: {
      restart: async () => {
        restarts++;
      },
      state: doorState,
    },
    json: (data, status = 200) => Response.json(data, { status }),
    readBody: async (req) => {
      try {
        const body = (await req.json()) as unknown;
        return body && typeof body === "object" ? (body as Record<string, unknown>) : null;
      } catch {
        return null;
      }
    },
    sessionMismatch: (body) =>
      checkServerSession(body, SERVER_SESSION) === "mismatch" ? Response.json(serverSessionMismatchBody(INBOX_SERVER_SESSION_MISMATCH_ERROR), { status: 409 }) : null,
  });
  server = Bun.serve({ port: 0, fetch: (req) => routes.handle(req, new URL(req.url).pathname) });
  base = `http://${server.hostname}:${server.port}`;
});

afterEach(() => {
  server?.stop();
  server = undefined;
  if (savedDataDir === undefined) delete process.env["PLANNOTATOR_DATA_DIR"];
  else process.env["PLANNOTATOR_DATA_DIR"] = savedDataDir;
  rmSync(dir, { recursive: true, force: true });
});

const read = async () => {
  const res = await fetch(`${base}${AUTH_ROUTE}`);
  return { status: res.status, body: (await res.json()) as Record<string, any> };
};

const send = async (action: string, body?: unknown) => {
  const res = await fetch(`${base}${AUTH_ROUTE}/${action}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: body === undefined ? "" : JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as Record<string, any> };
};

/** What `saveConfig` left in config.json, or nothing when the write never happened. */
const saved = (): Record<string, any> | undefined => {
  try {
    return JSON.parse(readFileSync(join(dir, "config.json"), "utf8")) as Record<string, any>;
  } catch {
    return undefined;
  }
};

const HOST = "arjun.tail3ff43a.ts.net";
const ME = "arjun@zosma.ai";

describe("the sign-in card's routes", () => {
  test("a fresh Inbox answers that there is no door, and no account", async () => {
    const { status, body } = await read();
    expect(status).toBe(200);
    expect(body["configured"]).toBe(false);
    expect(body["on"]).toBe(false);
    expect(body["host"]).toBe("");
    expect(body["url"]).toBe("");
    expect(body["accounts"]).toEqual([]);
    expect(body["minPasswordLength"]).toBe(AUTH_MIN_PASSWORD_LENGTH);
    // Answering this must not create the database folder: an Inbox that never had an account is left
    // without a file, rather than with an empty one and a secret.
    expect(saved()).toBeUndefined();
  });

  test("turning it on writes config.json and restarts the door", async () => {
    await send("account", { email: ME, password: "correct horse battery" });
    const answer = await send("on", { host: HOST, allow: [ME] });
    expect(answer.status).toBe(200);
    expect(saved()?.inboxAuth).toEqual({ on: true, host: HOST, allow: [ME], port: 19501 });
    expect(restarts).toBe(1);
    expect(answer.body["on"]).toBe(true);
    expect(answer.body["configured"]).toBe(true);
    expect(answer.body["host"]).toBe(HOST);
    expect(answer.body["url"]).toBe(`https://${HOST}/login`);
    expect(answer.body["allow"]).toEqual([ME]);
  });

  test("refuses settings that would leave the door unusable, and writes nothing", async () => {
    await send("account", { email: ME, password: "correct horse battery" });
    for (const [body, code] of [
      [{ host: "", allow: [ME] }, "bad_host"],
      [{ host: `https://${HOST}`, allow: [ME] }, "bad_host"],
      [{ host: HOST, allow: [] }, "empty_allow"],
      [{ host: HOST, allow: ["not an address"] }, "bad_allow"],
    ] as const) {
      const answer = await send("on", body);
      expect(answer.status).toBe(400);
      expect(answer.body["code"]).toBe(code);
      expect(typeof answer.body["error"]).toBe("string");
      expect(answer.body["error"].length).toBeGreaterThan(0);
    }
    expect(saved()).toBeUndefined();
    expect(restarts).toBe(0);
    expect((await read()).body["on"]).toBe(false);
  });

  test("the switch closes the address and keeps the accounts", async () => {
    await send("account", { email: ME, password: "correct horse battery" });
    await send("on", { host: HOST, allow: [ME] });
    const added = await send("account", { email: ME, password: "correct horse battery" });
    expect(added.status).toBe(200);
    expect(added.body["accounts"].map((account: { email: string }) => account.email)).toEqual([ME]);

    const off = await send("off", {});
    expect(off.status).toBe(200);
    expect(off.body["on"]).toBe(false);
    expect(off.body["host"]).toBe(HOST);
    expect(off.body["accounts"].map((account: { email: string }) => account.email)).toEqual([ME]);
    expect(saved()?.inboxAuth?.on).toBe(false);
    expect(restarts).toBe(2);
  });

  test("add an account, see it in the list, take it away", async () => {
    await send("account", { email: ME, password: "correct horse battery" });
    await send("on", { host: HOST, allow: [ME] });

    const short = await send("account", { email: ME, password: "short" });
    expect(short.status).toBe(400);
    expect(short.body["code"]).toBe("short_password");
    expect((await read()).body["accounts"].length).toBe(1);

    const bad = await send("account", { email: "not-an-address", password: "correct horse battery" });
    expect(bad.status).toBe(400);
    expect(bad.body["code"]).toBe("bad_email");

    const added = await send("account", { email: "Zosma@Example.com ", password: "correct horse battery", name: "Zosma" });
    expect(added.status).toBe(200);
    const account = added.body["accounts"].find((row: { email: string }) => row.email === "zosma@example.com");
    expect(account["email"]).toBe("zosma@example.com");
    expect(account["name"]).toBe("Zosma");
    expect(typeof account["createdAt"]).toBe("string");
    // The card promises the new account's address goes on the list as well: an account off the list
    // could never sign in, so adding one would be a trap.
    expect(account["allowed"]).toBe(true);
    expect(added.body["allow"]).toEqual([ME, "zosma@example.com"]);
    expect(saved()?.inboxAuth?.allow).toEqual([ME, "zosma@example.com"]);
    expect(restarts).toBe(2);

    const removed = await send("account/remove", { email: "zosma@example.com" });
    expect(removed.status).toBe(200);
    expect(removed.body["accounts"].map((row: { email: string }) => row.email)).toEqual([ME]);
    expect((await read()).body["accounts"].map((row: { email: string }) => row.email)).toEqual([ME]);
  });

  test("the allow list replaces itself, and the account follows it", async () => {
    await send("account", { email: ME, password: "correct horse battery" });
    await send("on", { host: HOST, allow: [ME] });
    expect((await read()).body["accounts"][0]["allowed"]).toBe(true);

    const replaced = await send("allow", { allow: ["someone@else.example"] });
    expect(replaced.status).toBe(200);
    expect(replaced.body["allow"]).toEqual(["someone@else.example"]);
    expect(replaced.body["accounts"][0]["allowed"]).toBe(false);
    expect(restarts).toBe(2);

    // The last address cannot be taken off: a door with nothing on the list shuts the person out.
    const empty = await send("allow", { allow: [] });
    expect(empty.status).toBe(400);
    expect(empty.body["code"]).toBe("empty_allow");
    expect((await read()).body["allow"]).toEqual(["someone@else.example"]);
  });

  test("an unknown action is answered as one", async () => {
    const answer = await send("restart", {});
    expect(answer.status).toBe(404);
    expect(answer.body["code"]).toBe("unknown_action");
  });

  test("the switch shows what the door is doing, not what the settings ask for", async () => {
    await send("account", { email: ME, password: "correct horse battery" });
    await send("on", { host: HOST, allow: [ME] });
    expect((await read()).body["on"]).toBe(true);

    // A door that could not take its port: config.json says on, nothing is listening, and the card
    // must not show a switch on with nothing behind it.
    doorOverride = { on: false, error: "Port 19501 is in use by another program." };
    const broken = await read();
    expect(broken.body["on"]).toBe(false);
    expect(broken.body["error"]).toBe("Port 19501 is in use by another program.");
  });

  test("refuses to turn on a door nobody has an account for", async () => {
    const answer = await send("on", { host: HOST, allow: [ME] });
    expect(answer.status).toBe(400);
    expect(answer.body["code"]).toBe("no_account");
    expect(typeof answer.body["error"]).toBe("string");
    expect(saved()).toBeUndefined();
    expect(restarts).toBe(0);
  });

  test("says so when config.json could not be written", async () => {
    await send("account", { email: ME, password: "correct horse battery" });
    // `saveConfig` refuses to write over a config.json it cannot read (packages/shared/config.ts):
    // the write has to be reported as not done, not answered as if it had landed.
    writeFileSync(join(dir, "config.json"), "{ not json");

    const answer = await send("on", { host: HOST, allow: [ME] });
    expect(answer.status).toBe(500);
    expect(answer.body["code"]).toBe("not_saved");
    expect(readFileSync(join(dir, "config.json"), "utf8")).toBe("{ not json");
    expect(restarts).toBe(0);
  });

  test("a write from a window left open across a restart is refused", async () => {
    await send("account", { email: ME, password: "correct horse battery" });
    const answer = await send("on", { host: HOST, allow: [ME], serverSession: "the-server-before-this-one" });
    expect(answer.status).toBe(409);
    expect(answer.body["code"]).toBe("session_mismatch");
    expect(saved()).toBeUndefined();
    expect(restarts).toBe(0);

    // This server's own nonce, which is what the window sends when it is current.
    const current = await send("on", { host: HOST, allow: [ME], serverSession: SERVER_SESSION });
    expect(current.status).toBe(200);
    expect(restarts).toBe(1);
  });
});
