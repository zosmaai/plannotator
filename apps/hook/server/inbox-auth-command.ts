import { loadConfig, saveConfig } from "@plannotator/shared/config";
import { readInboxRegistry, type InboxRegistryEntry } from "@plannotator/shared/inbox/registry";
import {
  isAllowedAuthEmail,
  normalizeAuthEmail,
  parseAuthAllowList,
  parseInboxAuthSettings,
  PASSKEY_PAGE_PATH,
  resolveInboxAuth,
  storedInboxAuth,
} from "@plannotator/shared/inbox/auth-door";
import { AUTH_MIN_PASSWORD_LENGTH, openInboxAuth, type InboxAuthInstance } from "@plannotator/server/inbox-auth-instance";

export const INBOX_AUTH_USAGE = [
  "Usage:",
  "  plannotator inbox auth add <email> [--name <name>] [--password-stdin]",
  "  plannotator inbox auth list [--json]",
  "  plannotator inbox auth remove <email> [--yes]",
  "  plannotator inbox auth on --host <name> [--allow <email[,email]>] [--port <n>]",
  "  plannotator inbox auth off",
  "  plannotator inbox auth status [--json]",
  "",
  "Sign in to the Inbox with an account of its own, at a public address, without",
  "Cloudflare Access and without a tailnet. On this computer nothing asks for a",
  "password: the door is a second loopback listener, and the window's own port is",
  "untouched.",
  "",
  "add        makes an account (or sets another password), asked for twice and not echoed.",
  "           Only addresses on --allow may enter, so add it there too.",
  "on         opens the sign-in door at https://<host>. Point a tunnel or proxy at",
  "           127.0.0.1:<port> (printed, and 19501 unless --port says otherwise).",
  "off        closes it. Accounts and their sessions are kept for the next time.",
  "status     what is set up, and whether the door is open right now.",
].join("\n");

export interface InboxAuthCommandDeps {
  dataDir: string;
  json: boolean;
  ensureRunning: () => Promise<InboxRegistryEntry>;
  env?: NodeJS.ProcessEnv;
  out?: (line: string) => void;
  err?: (line: string) => void;
  /** The password, asked for; overridden in tests. */
  ask?: (question: string, hidden: boolean) => Promise<string>;
  /** A port to use for `on` when none is given. */
  pickPort?: () => number;
}

function flag(args: readonly string[], name: string): string | undefined {
  const at = args.indexOf(name);
  if (at < 0) return undefined;
  const value = args[at + 1];
  return value && !value.startsWith("--") ? value : "";
}

/** What is left after the flags: a flag's own value is not a positional. */
function positionals(args: readonly string[], valueFlags: readonly string[]): string[] {
  const found: string[] = [];
  for (let at = 0; at < args.length; at += 1) {
    const arg = args[at]!;
    if (valueFlags.includes(arg)) {
      at += 1;
      continue;
    }
    if (!arg.startsWith("--")) found.push(arg);
  }
  return found;
}

async function promptHidden(question: string): Promise<string> {
  const stdin = process.stdin;
  if (!stdin.isTTY) return "";
  process.stderr.write(question);
  stdin.setRawMode(true);
  stdin.resume();
  return new Promise((resolve) => {
    let value = "";
    const onData = (chunk: Buffer) => {
      for (const char of chunk.toString("utf8")) {
        if (char === "\r" || char === "\n" || char === "\u0004") {
          stdin.setRawMode(false);
          stdin.pause();
          stdin.off("data", onData);
          process.stderr.write("\n");
          resolve(value);
          return;
        }
        if (char === "\u0003") process.exit(130);
        value = char === "\u007f" ? value.slice(0, -1) : value + char;
      }
    };
    stdin.on("data", onData);
  });
}

async function promptVisible(question: string): Promise<string> {
  const stdin = process.stdin;
  if (!stdin.isTTY) return "";
  process.stderr.write(question);
  for await (const line of console) return line.trim();
  return "";
}

/** The accounts' instance for a command: the same file the door uses, opened for one call. */
async function withAccounts<T>(dataDir: string, baseUrl: string, allow: readonly string[], use: (instance: InboxAuthInstance) => Promise<T>): Promise<T> {
  const instance = await openInboxAuth({ dataDir, baseUrl, allow });
  try {
    return await use(instance);
  } finally {
    instance.close();
  }
}

/** Ask the running Inbox to open or close the door now, and read back what it did. */
async function tellInbox(entry: InboxRegistryEntry | null): Promise<InboxRegistryEntry["inbox_auth"] | null> {
  if (!entry) return null;
  try {
    const response = await fetch(`http://127.0.0.1:${entry.port}/api/inbox/control/auth`, {
      method: "POST",
      headers: { Authorization: `Bearer ${entry.token}` },
      signal: AbortSignal.timeout(10_000),
    });
    const body = (await response.json().catch(() => null)) as { inbox_auth?: InboxRegistryEntry["inbox_auth"] } | null;
    return body?.inbox_auth ?? null;
  } catch {
    return null;
  }
}

function describe(record: NonNullable<InboxRegistryEntry["inbox_auth"]>): string {
  if (!record.url) return `not open: ${record.error ?? "unknown"}`;
  return `${record.url} (${record.allow.length} ${record.allow.length === 1 ? "address" : "addresses"} may enter)`;
}

export async function runInboxAuthCommand(args: readonly string[], deps: InboxAuthCommandDeps): Promise<number> {
  const out = deps.out ?? ((line: string) => process.stdout.write(`${line}\n`));
  const err = deps.err ?? ((line: string) => process.stderr.write(`${line}\n`));
  const ask = deps.ask ?? ((question: string, hidden: boolean) => (hidden ? promptHidden(question) : promptVisible(question)));
  const stored = storedInboxAuth(loadConfig());
  const resolved = resolveInboxAuth(loadConfig(), deps.env ?? process.env);
  const configBaseUrl = stored?.host ? `https://${stored.host}` : "http://127.0.0.1";
  const allow = parseAuthAllowList(stored?.allow);

  const [command, ...rest] = args;

  if (!command || command === "help" || command === "--help") {
    out(INBOX_AUTH_USAGE);
    return 0;
  }

  if (command === "add") {
    const email = positionals(rest, ["--name"])[0];
    if (!email) {
      err("auth add takes one address: plannotator inbox auth add you@example.com");
      return 1;
    }
    const normalized = normalizeAuthEmail(email);
    if (!normalized.includes("@")) {
      err(`"${email}" is not an e-mail address.`);
      return 1;
    }
    const name = flag(rest, "--name") || undefined;
    let password: string;
    if (rest.includes("--password-stdin")) {
      password = (await new Response(Bun.stdin.stream()).text()).trim();
    } else {
      password = await ask(`Password for ${normalized}: `, true);
      const again = await ask("Again: ", true);
      if (password !== again) {
        err("The two passwords differ. Nothing was changed.");
        return 1;
      }
    }
    if (password.length < AUTH_MIN_PASSWORD_LENGTH) {
      err(`The password must be at least ${AUTH_MIN_PASSWORD_LENGTH} characters.`);
      return 1;
    }
    const result = await withAccounts(deps.dataDir, configBaseUrl, allow, (instance) => instance.set({ email: normalized, password, ...(name ? { name } : {}) }));
    out(result.created ? `Account ${normalized} made.` : `Password for ${normalized} set; its sessions were ended.`);
    if (!isAllowedAuthEmail(allow, normalized)) out(`Not on the allowlist yet: add it with \`plannotator inbox auth on --allow ${[...allow, normalized].join(",")}\`.`);
    if (!resolved.on) out("The door is closed: `plannotator inbox auth on --host <name>` opens it.");
    return 0;
  }

  if (command === "list") {
    const accounts = await withAccounts(deps.dataDir, configBaseUrl, allow, (instance) => instance.list());
    if (deps.json) {
      out(JSON.stringify({ accounts, allow }, null, 2));
      return 0;
    }
    if (accounts.length === 0) {
      out("No accounts yet. `plannotator inbox auth add <email>` makes one.");
      return 0;
    }
    for (const account of accounts) {
      const seen = account.lastSeenAt ? `last seen ${account.lastSeenAt.slice(0, 16).replace("T", " ")}` : "never signed in";
      const allowed = isAllowedAuthEmail(allow, account.email) ? "" : "  (not on the allowlist)";
      out(`${account.email}  —  ${seen}${allowed}`);
    }
    return 0;
  }

  if (command === "remove") {
    const email = positionals(rest, [])[0];
    if (!email) {
      err("auth remove takes one address: plannotator inbox auth remove you@example.com");
      return 1;
    }
    const normalized = normalizeAuthEmail(email);
    if (!rest.includes("--yes")) {
      const answer = await ask(`Remove ${normalized} and end its sessions? [y/N] `, false);
      if (!/^y(es)?$/i.test(answer.trim())) {
        out("Nothing was changed.");
        return 1;
      }
    }
    const result = await withAccounts(deps.dataDir, configBaseUrl, allow, (instance) => instance.remove(normalized));
    out(result.removed ? `Account ${normalized} removed.` : `No account for ${normalized}.`);
    return result.removed ? 0 : 1;
  }

  const saveAuth = (value: { on?: boolean; host?: string; allow?: string[]; port?: number }): boolean =>
    saveConfig({ inboxAuth: { ...stored, ...value } });

  if (command === "on") {
    const host = (flag(rest, "--host") ?? "").trim().toLowerCase().replace(/\.$/, "");
    const allowFlag = flag(rest, "--allow");
    const portFlag = flag(rest, "--port");
    const next = {
      ...(stored ?? {}),
      on: true,
      ...(host ? { host } : {}),
      ...(allowFlag ? { allow: parseAuthAllowList(allowFlag) } : {}),
      ...(portFlag ? { port: Number.parseInt(portFlag, 10) } : {}),
    };
    if (!next.host) {
      err("auth on needs the public name people sign in at: --host inbox.example.com");
      return 1;
    }
    if (!next.allow || next.allow.length === 0) {
      err("auth on needs at least one address that may enter: --allow you@example.com");
      return 1;
    }
    const parsed = parseInboxAuthSettings(next, deps.env ?? process.env, () => false);
    if ("error" in parsed) {
      err(parsed.error);
      return 1;
    }
    if (!saveAuth({ on: true, host: next.host, allow: next.allow, port: next.port ?? parsed.port })) {
      err("Could not write config.json. Nothing was changed.");
      return 1;
    }
    const entry = readInboxRegistry(deps.dataDir);
    const door = await tellInbox(entry ?? (await deps.ensureRunning().catch(() => null)));
    out(door ? `Sign-in: ${describe(door)}` : `Saved. The door opens at the next start: https://${next.host}/ (listener 127.0.0.1:${parsed.port})`);
    const accounts = await withAccounts(deps.dataDir, `https://${next.host}`, next.allow, (instance) => instance.list());
    if (accounts.length === 0) out("No accounts yet: `plannotator inbox auth add <email>` makes the first one.");
    return 0;
  }

  if (command === "off") {
    if (!stored) {
      out("Sign-in was never set up. Nothing to close.");
      return 0;
    }
    if (!saveAuth({ on: false })) {
      err("Could not write config.json. Nothing was changed.");
      return 1;
    }
    const door = await tellInbox(readInboxRegistry(deps.dataDir));
    out(door ? `Sign-in: ${describe(door)}` : "Sign-in is off. The accounts are kept.");
    return 0;
  }

  if (command === "status") {
    const record = readInboxRegistry(deps.dataDir)?.inbox_auth ?? null;
    const where = stored?.host ? `https://${stored.host}/` : null;
    // Where the people who can sign in manage their passkeys: nothing else in the product links there.
    const passkeys = where ? `${where.replace(/\/$/, "")}${PASSKEY_PAGE_PATH}` : null;
    if (deps.json) {
      out(JSON.stringify({ configured: resolved.configured, on: resolved.on, url: where, passkeys, allow, open: record }, null, 2));
      return 0;
    }
    if (!resolved.configured) {
      out("Sign-in is not set up. `plannotator inbox auth on --host <name> --allow <email>` sets it up.");
      return 0;
    }
    out(`Sign-in: ${resolved.on ? "on" : "off"}${where ? ` at ${where}` : ""}`);
    if (resolved.error) out(`Not open: ${resolved.error}`);
    if (record) out(`Now: ${describe(record)}`);
    out(`Allowlist: ${allow.length > 0 ? allow.join(", ") : "nobody"}`);
    const accounts = await withAccounts(deps.dataDir, resolved.settings?.baseUrl ?? configBaseUrl, allow, (instance) => instance.list());
    out(`Accounts: ${accounts.length === 0 ? "none" : accounts.map((account) => account.email).join(", ")}`);
    if (passkeys) out(`Passkeys: ${passkeys} (sign in at the door to add one)`);
    return 0;
  }

  err(`Unknown auth command: ${command}`);
  err(INBOX_AUTH_USAGE);
  return 1;
}
