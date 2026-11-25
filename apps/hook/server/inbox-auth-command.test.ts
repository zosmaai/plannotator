import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInboxAuthCommand } from "./inbox-auth-command";

const PASSWORD = "correct horse battery staple";
const ME = "me@example.com";
const OTHER = "someone@example.com";

let dataDir: string;
let out: string[] = [];
let err: string[] = [];
const saved: Record<string, string | undefined> = {};
const ENV = ["PLANNOTATOR_DATA_DIR", "PLANNOTATOR_INBOX_AUTH", "PLANNOTATOR_INBOX_AUTH_HOST", "PLANNOTATOR_AUTH_SECRET"] as const;

beforeEach(() => {
  for (const key of ENV) saved[key] = process.env[key];
  dataDir = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-inbox-auth-cli-")));
  process.env.PLANNOTATOR_DATA_DIR = dataDir;
  for (const key of ENV.slice(1)) delete process.env[key];
  out = [];
  err = [];
});

afterEach(() => {
  for (const key of ENV) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  rmSync(dataDir, { recursive: true, force: true });
});

/** Run a command with the answers the person would type. */
async function run(args: string[], answers: string[] = [], json = false): Promise<number> {
  const queue = [...answers];
  return runInboxAuthCommand(args, {
    dataDir,
    json,
    ensureRunning: async () => {
      throw new Error("no Inbox running");
    },
    ask: async () => queue.shift() ?? "",
    out: (line) => out.push(line),
    err: (line) => err.push(line),
  });
}

const config = (): Record<string, any> => JSON.parse(readFileSync(join(dataDir, "config.json"), "utf8"));

describe("plannotator inbox auth", () => {
  test("set up an address and an allowlist, then keep them in config.json", async () => {
    expect(await run(["on", "--host", "inbox.example.com", "--allow", `${ME}, ${OTHER}`])).toBe(0);
    expect(config().inboxAuth).toMatchObject({ on: true, host: "inbox.example.com", allow: [ME, OTHER] });
    expect(out.join("\n")).toContain("No accounts yet");
  }, 30_000);

  test("refuses to open without a name or an allowlist, and says what is missing", async () => {
    expect(await run(["on", "--allow", ME])).toBe(1);
    expect(err.join("\n")).toContain("--host inbox.example.com");
    err = [];
    expect(await run(["on", "--host", "inbox.example.com"])).toBe(1);
    expect(err.join("\n")).toContain("--allow you@example.com");
  }, 30_000);

  test("makes an account, where a twice-typed password is needed", async () => {
    await run(["on", "--host", "inbox.example.com", "--allow", ME]);

    out = [];
    err = [];
    expect(await run(["add", ME], [PASSWORD, "something else"])).toBe(1);
    expect(err.join("\n")).toContain("differ");
    expect(out.join("\n")).toBe("");

    expect(await run(["add", ME], ["short", "short"])).toBe(1);
    expect(err.join("\n")).toContain("at least 12 characters");

    expect(await run(["add", ME], [PASSWORD, PASSWORD])).toBe(0);
    expect(out.join("\n")).toContain(`Account ${ME} made`);

    out = [];
    expect(await run(["list"])).toBe(0);
    expect(out.join("\n")).toContain(ME);
    expect(out.join("\n")).toContain("never signed in");
  }, 60_000);

  test("says when an account is not on the allowlist, and removing it ends the sessions", async () => {
    await run(["on", "--host", "inbox.example.com", "--allow", ME]);
    expect(await run(["add", OTHER], [PASSWORD, PASSWORD])).toBe(0);
    expect(out.join("\n")).toContain(`auth on --allow ${ME},${OTHER}`);

    out = [];
    expect(await run(["list"])).toBe(0);
    expect(out.join("\n")).toContain("not on the allowlist");

    out = [];
    expect(await run(["remove", OTHER], ["n"])).toBe(1);
    expect(out.join("\n")).toContain("Nothing was changed");

    out = [];
    expect(await run(["remove", OTHER, "--yes"])).toBe(0);
    expect(out.join("\n")).toContain(`Account ${OTHER} removed`);
  }, 60_000);

  test("off keeps the accounts, and status reports what is set up", async () => {
    expect(await run(["status"])).toBe(0);
    expect(out.join("\n")).toContain("Sign-in is not set up");

    await run(["on", "--host", "inbox.example.com", "--allow", ME]);
    await run(["add", ME], [PASSWORD, PASSWORD]);

    out = [];
    expect(await run(["off"])).toBe(0);
    expect(config().inboxAuth.on).toBe(false);
    expect(out.join("\n")).toContain("off");

    out = [];
    expect(await run(["status"])).toBe(0);
    expect(out.join("\n")).toContain("Sign-in: off at https://inbox.example.com/");
    expect(out.join("\n")).toContain(`Accounts: ${ME}`);
    // The passkeys page is only reachable by signing in at the door, and nothing else links to it.
    expect(out.join("\n")).toContain("Passkeys: https://inbox.example.com/passkeys");
  }, 60_000);

  test("--json is for a program", async () => {
    await run(["on", "--host", "inbox.example.com", "--allow", ME]);
    await run(["add", ME], [PASSWORD, PASSWORD]);

    out = [];
    expect(await run(["list"], [], true)).toBe(0);
    const list = JSON.parse(out.join("\n")) as { accounts: { email: string }[]; allow: string[] };
    expect(list.accounts.map((account) => account.email)).toEqual([ME]);
    expect(list.allow).toEqual([ME]);

    out = [];
    expect(await run(["status"], [], true)).toBe(0);
    const status = JSON.parse(out.join("\n")) as { on: boolean; url: string; passkeys: string; configured: boolean };
    expect(status).toMatchObject({ configured: true, on: true, url: "https://inbox.example.com/", passkeys: "https://inbox.example.com/passkeys" });
  }, 60_000);
});
