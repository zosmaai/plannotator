/**
 * Who signed a line in, as the agent reads it (`inboxSentFromLine`, `inboxSentFromOf`, `inboxSessionAccountOf` in
 * ./inbox-sent-from.ts). What regresses: a signed-in line reaching an agent with no name, or with the word
 * `undefined`; a record stored before accounts, or by a door that holds none, reading or printing any differently than
 * it did; a linked computer's line or a terminal line gaining a name; an account made of nothing (no address, an
 * address longer than an address can be, a name that is only spaces) counting as somebody. The door that records an
 * account is in ../server/inbox-auth-door.test.ts; the reads that carry the line are in
 * ../server/inbox-sent-from.test.ts.
 */
import { describe, expect, test } from "bun:test";
import {
  inboxAccountName,
  inboxSentFromLine,
  inboxSentFromOf,
  inboxSessionAccountOf,
  type InboxSentFrom,
} from "./inbox-sent-from";

const ARJUN = { email: "arjun@zosma.ai", name: "Arjun Ernvattam" };
const TAILNET = "(They sent this from another device over Tailscale, not from this computer: a localhost link would not open there.)";
const CLOUDFLARE = "(They sent this from another device through Cloudflare Access, not from this computer: a localhost link would not open there.)";

describe("the account on a line, as the reader sees it", () => {
  test("a line written by a signed-in account says who wrote it", () => {
    const sent_from: InboxSentFrom = { kind: "tailnet", account: ARJUN };
    expect(inboxSentFromLine({ sent_from })).toBe(
      "(They sent this Arjun Ernvattam from another device over Tailscale, not from this computer: a localhost link would not open there.)",
    );
  });

  test("an account with nothing for a name says its address, and never the word undefined", () => {
    for (const name of [null, "", "   ", "\n\t"]) {
      const line = inboxSentFromLine({ sent_from: { kind: "cloudflare", account: { email: ARJUN.email, name } } });
      expect(line).toBe(`(They sent this ${ARJUN.email} from another device through Cloudflare Access, not from this computer: a localhost link would not open there.)`);
      expect(line).not.toContain("undefined");
      expect(line).not.toBe(CLOUDFLARE);
    }
  });

  test("a record stored without an account reads back and prints exactly as it did", () => {
    const lines: Record<string, string> = { tailnet: TAILNET, cloudflare: CLOUDFLARE, phone: "(They sent this from the Plannotator phone app, not from this computer: a localhost link would not open there.)" };
    for (const kind of ["tailnet", "cloudflare", "phone"] as const) {
      const stored = { kind };
      expect(inboxSentFromOf(stored)).toEqual(stored);
      // The same bytes out as in: a read that adds a name would change what a host has already stored.
      expect(JSON.stringify(inboxSentFromOf(stored))).toBe(JSON.stringify(stored));
      expect(inboxSentFromLine({ sent_from: stored })).toBe(lines[kind]);
    }
  });

  test("a linked computer's line is named by that computer and never by an account, and a terminal line says nothing", () => {
    // A machine record is not given an account by this Inbox. Handed one anyway, the reader ignores it.
    const forwarded = { kind: "machine", name: "Ada's MacBook", via: "tailnet", account: ARJUN };
    const line = inboxSentFromLine({ sent_from: forwarded });
    expect(line).toBe("(They sent this from another device over Tailscale, through their linked computer `Ada's MacBook`, not from this computer: a localhost link would not open there.)");
    expect(line).not.toContain(ARJUN.email);
    expect(line).not.toContain(ARJUN.name);
    for (const sent_from of [undefined, null, "tailnet", {}, { kind: "localhost" }, { kind: "here" }, { kind: "here", account: ARJUN }]) {
      expect(inboxSentFromLine({ sent_from })).toBe("");
    }
  });

  test("an account is read back whole or not at all", () => {
    expect(inboxSessionAccountOf(ARJUN)).toEqual(ARJUN);
    // The address is kept as the door holds it, spaces either side trimmed.
    expect(inboxSessionAccountOf({ email: " Arjun@Zosma.AI ", name: null })).toEqual({ email: "Arjun@Zosma.AI", name: null });
    // Nothing for a name: an account with no name, which is what an identity provider that sends none leaves.
    expect(inboxSessionAccountOf({ email: ARJUN.email })).toEqual({ email: ARJUN.email, name: null });
    expect(inboxSessionAccountOf({ email: ARJUN.email, name: null })).toEqual({ email: ARJUN.email, name: null });
    // A name that is only spaces is no name.
    expect(inboxSessionAccountOf({ email: ARJUN.email, name: " ​ " })).toEqual({ email: ARJUN.email, name: null });
    // Not an account: no address, an address longer than one can be, an address or a name that is not a string.
    for (const value of [null, undefined, 7, "arjun@zosma.ai", [], { name: "Bob" }, { email: "", name: "Bob" }, { email: "   " }, { email: `${"x".repeat(250)}@example.com` }, { email: 7 }, { email: ARJUN.email, name: 7 }]) {
      expect(inboxSessionAccountOf(value)).toBeNull();
    }
    // Exactly 254 is the longest an address can be, and is read.
    const longest = `${"a".repeat(242)}@example.com`;
    expect(longest.length).toBe(254);
    expect(inboxSessionAccountOf({ email: longest })).toEqual({ email: longest, name: null });
  });

  test("the name an account is printed by is its own if it has one, its address if not, and never empty", () => {
    expect(inboxAccountName(ARJUN)).toBe("Arjun Ernvattam");
    expect(inboxAccountName({ email: ARJUN.email, name: null })).toBe(ARJUN.email);
    expect(inboxAccountName({ email: ARJUN.email, name: " \t " })).toBe(ARJUN.email);
  });

  test("a name prints as one line, cut between whole characters, and the record reads back what was written", () => {
    const cleaned = inboxSessionAccountOf({ email: "ada@example.com", name: "Ada`\n‮evil" });
    expect(cleaned).toEqual({ email: "ada@example.com", name: "Ada' evil" });
    const long = inboxSessionAccountOf({ email: "ada@example.com", name: "x".repeat(500) })!;
    expect(long.name).toHaveLength(64);
    expect(inboxSentFromOf({ kind: "tailnet", account: long })).toEqual({ kind: "tailnet", account: long });
    const line = inboxSentFromLine({ sent_from: { kind: "tailnet", account: long } });
    expect(line.split("\n")).toHaveLength(1);
    expect(line).toContain(String(long.name));
    // The name cannot open a quote or a new line in the words an agent is given.
    expect(line).not.toContain("`");
  });

  test("an account that is not of the shape leaves the line exactly as an account-less one", () => {
    const stored = { kind: "tailnet", account: { email: "", name: "Ghost" } };
    expect(inboxSentFromOf(stored)).toEqual({ kind: "tailnet" });
    expect(inboxSentFromLine({ sent_from: stored })).toBe(TAILNET);
  });

  test("an address is never rewritten for the agent: an address that is not one clean line drops the whole account", () => {
    // An address is what an identity provider sends. Cleaning it would tell the agent about a person the door never
    // signed in, so an address needing any cleaning is no account at all, and the line reads as it did before.
    for (const email of ["ada\n@example.com", "ada\r\n@example.com", "ada`@example.com", "ada\u202E@example.com", "ada@example.com\u0000"]) {
      expect(inboxSessionAccountOf({ email, name: "Ada" })).toBeNull();
      expect(inboxSentFromLine({ sent_from: { kind: "tailnet", account: { email, name: "Ada" } } })).toBe(TAILNET);
    }
    // An address that is clean but longer than the 64-character name cap is still an address: it is not cut.
    const long = `${"a".repeat(240)}@example.com`;
    expect(long.length).toBeLessThanOrEqual(254);
    expect(inboxSessionAccountOf({ email: long, name: null })).toEqual({ email: long, name: null });
  });
});
