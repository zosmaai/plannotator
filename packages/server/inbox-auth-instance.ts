/**
 * The Inbox's own accounts, on better-auth.
 *
 * One SQLite file in the data folder holds better-auth's four tables
 * (`user`, `session`, `account`, `verification`), and one secret in the same
 * folder signs the session cookies. Nothing here is read unless the auth door
 * is on (`inboxAuth` in config.json), and the file is opened lazily, so an
 * Inbox that never publishes itself pays nothing for it.
 *
 * Signing up is off: accounts are made by the person who owns this computer
 * (`plannotator inbox auth add <email>`), and only an address on the door's
 * allowlist gets past the gate.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { betterAuth } from "better-auth";
import { getMigrations } from "better-auth/db/migration";
import { hashPassword } from "better-auth/crypto";
import { passkey } from "@better-auth/passkey";
import { AUTH_COOKIE_PREFIX, INBOX_AUTH_SECRET_ENV, doorOrigins, isAllowedAuthEmail, normalizeAuthEmail } from "@plannotator/shared/inbox/auth-door";

/** Seven days, the page's own promise. */
export const AUTH_SESSION_SECONDS = 7 * 24 * 60 * 60;
/** Shorter than better-auth's default of 8: this is one person's Inbox, not a public sign-up service. */
export const AUTH_MIN_PASSWORD_LENGTH = 12;
const SECRET_FILE = "auth-secret";
const DATABASE_FILE = "auth.sqlite";

/**
 * Where the accounts live. Asked for before opening them, so that reading the list on an Inbox that
 * has none does not create the file and the secret with it.
 */
export function inboxAuthDatabaseFile(dataDir: string): string {
  return join(dataDir, DATABASE_FILE);
}

export interface InboxAuthInstanceOptions {
  dataDir: string;
  /** The public address people sign in at (`https://inbox.example.com`). */
  baseUrl: string;
  /** Read from the data folder when omitted. */
  secret?: string;
  /** Who may enter: `list` names only these (the door refuses the rest anyway). */
  allow?: readonly string[];
  /** For tests and the door's own note: how many sign-in attempts an hour, per address. */
  databaseFile?: string;
  /**
   * The name this door answers (`inboxAuth.host`). It is what decides which `Origin` a sign-in may come
   * from: the name at whatever port the request's own `Host` header arrived at, which is how a door
   * published at an arbitrary port signs people in with nothing written down. Defaults to the host in
   * `baseUrl`.
   */
  host?: string;
  /**
   * What the browser is asked to sign for: the site a passkey is minted for. Both default to the bare
   * *name* — never a port: a passkey belongs to `https://<host>` whatever port the door is published at,
   * and the browser refuses it anywhere else.
   */
  webauthn?: { rpID?: string; origin?: string };
}

export interface InboxAuth { email: string; name: string; createdAt: string; lastSeenAt: string | null }

/**
 * A passkey as the door's page sees it: what to show and what to remove. Not the key, not the
 * credential id — the page has no use for either, and a browser should not be handed a stored
 * credential to present as if its authenticator held it.
 */
export interface InboxPasskey { id: string; name: string; createdAt: string; deviceType: string; backedUp: boolean }

export interface InboxAuthAccount {
  email: string;
  password: string;
  name?: string;
}

export interface InboxAuthInstance {
  /** better-auth's own handler and API; the door mounts it at AUTH_BASE_PATH. */
  auth: ReturnType<typeof betterAuth>;
  /** The file and the folder, for the person's own reading. */
  databaseFile: string;
  secretFile: string;
  /** Every account on this Inbox, newest last. */
  list: () => Promise<InboxAuth[]>;
  /** Make an account, or replace the password of one that exists. */
  set: (account: InboxAuthAccount) => Promise<{ created: boolean }>;
  remove: (email: string) => Promise<{ removed: boolean }>;
  /** The sessions of an address, ended: used when its account leaves or its password changes. */
  revokeSessions: (email: string) => Promise<number>;
  /** A user's passkeys, oldest first. */
  passkeys: (userId: string) => Promise<InboxPasskey[]>;
  /**
   * Remove one of a user's passkeys. Refuses the last one of an account that has no password: the
   * door would otherwise be the way an account locks its own owner out.
   */
  removePasskey: (userId: string, id: string) => Promise<{ removed: boolean; code?: string; message?: string }>;
  close: () => void;
}

/**
 * The `Host` header off whatever better-auth handed a function `trustedOrigins` — a `Request` per
 * request, nothing at all while the instance is being built. Anything else is treated as no host.
 */
function hostHeaderOf(source: unknown): string | null {
  if (typeof source !== "object" || source === null || !("headers" in source)) return null;
  const headers = (source as { headers: unknown }).headers;
  if (typeof headers !== "object" || headers === null || !("get" in headers)) return null;
  const value = (headers as { get: (name: string) => unknown }).get("host");
  return typeof value === "string" ? value : null;
}

function readSecret(dataDir: string): string {
  const file = join(dataDir, SECRET_FILE);
  if (existsSync(file)) {
    const value = readFileSync(file, "utf8").trim();
    if (value.length >= 32) return value;
  }
  const secret = randomBytes(32).toString("hex");
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  writeFileSync(file, `${secret}\n`, { mode: 0o600 });
  return secret;
}

export async function openInboxAuth(options: InboxAuthInstanceOptions): Promise<InboxAuthInstance> {
  // Bun's own driver: the Inbox is Bun-only, and this keeps the schema in one file the person can copy.
  const { Database } = await import("bun:sqlite");
  mkdirSync(options.dataDir, { recursive: true, mode: 0o700 });
  const databaseFile = options.databaseFile ?? join(options.dataDir, DATABASE_FILE);
  const db = new Database(databaseFile, { create: true });
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
  const secret = options.secret ?? (process.env[INBOX_AUTH_SECRET_ENV]?.trim() || readSecret(options.dataDir));

  const doorHost = options.host?.trim().toLowerCase().replace(/\.$/, "") || new URL(options.baseUrl).hostname;
  const rpID = options.webauthn?.rpID || doorHost;
  // A passkey belongs to the name, not to a port: minting one for `https://<host>:4255` would strand it
  // the moment the publisher picked another port, and a key minted for the bare host can never be
  // offered at a ported one. The strictness is the point, so the door keeps `origin` explicit.
  const passkeyOrigin = options.webauthn?.origin ?? `https://${doorHost}`;

  /**
   * Which `Origin` a sign-in may come from: the address the request arrived at (`https://<host>`, plus
   * `https://<host>:<port>` when its `Host` header carried one). Same-origin and nothing else — the door
   * refuses a `Host` that is not this name before better-auth sees it, so the port can only ever be a
   * port after the door's own name. better-auth calls a function `trustedOrigins` per request, which is
   * what makes a door behind a proxy on an arbitrary port work with no setting at all.
   */
  const trustedOrigins = (source: unknown): string[] => doorOrigins(hostHeaderOf(source), { host: doorHost });

  const auth = betterAuth({
    database: db,
    baseURL: options.baseUrl,
    secret,
    trustedOrigins,
    emailAndPassword: { enabled: true, disableSignUp: true, minPasswordLength: AUTH_MIN_PASSWORD_LENGTH },
    session: { expiresIn: AUTH_SESSION_SECONDS, updateAge: 24 * 60 * 60 },
    /**
     * Guessing a password is the one thing a public door invites: ten tries per address per five minutes, and a
     * quieter ceiling on the rest of the auth paths. The client's address comes from the tunnel in front of this
     * door (`cf-connecting-ip` from Cloudflare, else the first `x-forwarded-for` hop); with neither, better-auth
     * keeps one bucket for everyone, which is why the headers are named here rather than left to its default.
     */
    rateLimit: {
      enabled: true,
      window: 60,
      max: 60,
      customRules: { "/sign-in/email": { window: 300, max: 10 } },
    },
    advanced: {
      cookiePrefix: AUTH_COOKIE_PREFIX,
      useSecureCookies: true,
      defaultCookieAttributes: { httpOnly: true, sameSite: "lax", secure: true, path: "/" },
      ipAddress: { ipAddressHeaders: ["cf-connecting-ip", "x-forwarded-for"] },
    },
    // Passkeys live on the same account and the same session as the password, so a passkey sign-in
    // gets the door's session by the same door and the allowlist refuses it the same way. Adding one
    // needs a session (`requireSession`, the plugin's default): an account is only given a passkey by
    // someone already through this door, and this plugin version has no password step of its own.
    plugins: [passkey({ rpID, rpName: "Plannotator Inbox", origin: passkeyOrigin })],
    telemetry: { enabled: false },
  } as Parameters<typeof betterAuth>[0]);

  // better-auth refuses a database it has not migrated (SCHEMA_MISMATCH), so the four tables are made here,
  // idempotently, the way `auth migrate` makes them.
  await (await getMigrations(auth.options)).runMigrations();

  const context = async () => auth.$context;

  /**
   * Every account, including one whose address the person has taken off the allowlist: it cannot get in —
   * `sessionUser` refuses it — but it must stay visible here to be removed, and `auth add` keeps it working
   * for the day the address is put back.
   */
  const list = async (): Promise<InboxAuth[]> => {
    const ctx = await context();
    const users = await ctx.internalAdapter.listUsers(1000, 0, { field: "createdAt", direction: "asc" });
    return Promise.all(
      users.map(async (user) => {
        // When a session last moved: the newest `updatedAt` over every session this account ever had.
        const sessions = await ctx.internalAdapter.listSessions(user.id, { onlyActiveSessions: false });
        const seen = sessions.reduce<number>((newest, session) => Math.max(newest, new Date(String(session.updatedAt ?? 0)).getTime()), 0);
        return {
          email: normalizeAuthEmail(String(user.email ?? "")),
          name: String(user.name ?? ""),
          createdAt: new Date(String(user.createdAt)).toISOString(),
          lastSeenAt: seen > 0 ? new Date(seen).toISOString() : null,
        };
      }),
    );
  };

  const findByEmail = async (email: string) => {
    const ctx = await context();
    const found = await ctx.internalAdapter.findUserByEmail(normalizeAuthEmail(email), { includeAccounts: true });
    return found ? { user: found.user, accounts: found.accounts } : null;
  };

  const revokeSessions = async (email: string): Promise<number> => {
    const found = await findByEmail(email);
    if (!found) return 0;
    const ctx = await context();
    const sessions = await ctx.internalAdapter.listSessions(found.user.id, { onlyActiveSessions: false });
    await ctx.internalAdapter.deleteUserSessions(found.user.id);
    return sessions.length;
  };

  const set = async (account: InboxAuthAccount): Promise<{ created: boolean }> => {
    const email = normalizeAuthEmail(account.email);
    const ctx = await context();
    const password = await hashPassword(account.password);
    const found = await findByEmail(email);
    if (found) {
      const credential = await ctx.internalAdapter.findCredentialAccount(found.user.id);
      if (credential) await ctx.internalAdapter.updateAccount(credential.id, { password });
      else await ctx.internalAdapter.linkAccount({ userId: found.user.id, providerId: "credential", accountId: found.user.id, password });
      await ctx.internalAdapter.deleteUserSessions(found.user.id);
      return { created: false };
    }
    const user = await ctx.internalAdapter.createUser(
      { email, name: account.name ?? email.split("@")[0], emailVerified: true },
      { method: "email-password" },
    );
    await ctx.internalAdapter.linkAccount({ userId: user.id, providerId: "credential", accountId: user.id, password });
    return { created: true };
  };

  /** Raw `passkey` rows of one account. The `id` is the door's own; `credentialID` is the browser's. */
  const passkeyRows = async (userId: string): Promise<Record<string, unknown>[]> => {
    const ctx = await context();
    const rows = (await ctx.adapter.findMany({
      model: "passkey",
      where: [{ field: "userId", value: userId }],
    })) as unknown as Record<string, unknown>[];
    return rows.sort((a, b) => String(a.createdAt ?? "").localeCompare(String(b.createdAt ?? "")));
  };

  const passkeys = async (userId: string): Promise<InboxPasskey[]> =>
    (await passkeyRows(userId)).map((row) => ({
      id: String(row.id ?? ""),
      name: String(row.name ?? "") || "Passkey",
      createdAt: new Date(String(row.createdAt ?? 0)).toISOString(),
      deviceType: String(row.deviceType ?? ""),
      backedUp: row.backedUp === true,
    }));

  /** Whether this account can still get in without a passkey: it has a password. */
  const hasPassword = async (userId: string): Promise<boolean> => {
    const ctx = await context();
    const credential = await ctx.internalAdapter.findCredentialAccount(userId);
    return Boolean(credential?.password);
  };

  const removePasskey = async (userId: string, id: string): Promise<{ removed: boolean; code?: string; message?: string }> => {
    const rows = await passkeyRows(userId);
    if (!rows.some((row) => String(row.id) === id)) return { removed: false, code: "not_here", message: "That passkey is not on your account." };
    if (rows.length === 1 && !(await hasPassword(userId))) {
      return { removed: false, code: "last_way_in", message: "That is the only way into this account. Add another way in first." };
    }
    const ctx = await context();
    await ctx.adapter.deleteMany({ model: "passkey", where: [{ field: "userId", value: userId }, { field: "id", value: id }] });
    return { removed: true };
  };

  const remove = async (email: string): Promise<{ removed: boolean }> => {
    const found = await findByEmail(email);
    if (!found) return { removed: false };
    const ctx = await context();
    await ctx.internalAdapter.deleteUserSessions(found.user.id);
    await ctx.internalAdapter.deleteAccounts(found.user.id);
    await ctx.internalAdapter.deleteUser(found.user.id);
    return { removed: true };
  };

  return {
    auth,
    databaseFile,
    secretFile: join(options.dataDir, SECRET_FILE),
    list,
    set,
    remove,
    revokeSessions,
    passkeys,
    removePasskey,
    close: () => {
      try {
        db.close();
      } catch {
        // already closed, or never opened: nothing to do
      }
    },
  };
}

/** A session's user, if the address is one this door lets in. */
export async function sessionUser(instance: InboxAuthInstance, headers: Headers, allow: readonly string[]): Promise<{ id: string; email: string; name: string } | null> {
  const session = await instance.auth.api.getSession({ headers }).catch(() => null);
  const user = session?.user;
  if (!user?.email || !isAllowedAuthEmail(allow, user.email)) return null;
  return { id: String(user.id), email: normalizeAuthEmail(user.email), name: String(user.name ?? "") };
}
