/**
 * Where the person wrote a message, as the Inbox that accepted it could tell from the request itself (never from what
 * the page says): another device over the tailnet, through Cloudflare Access, the Plannotator phone app, or a linked
 * computer (named as the Inbox names it), which may say it came to it from one of the first three. This computer's own
 * window records `here`, which no agent here is ever shown: only an agent on a linked computer reading the thread is
 * told it was written on this one (inbox-sent-from-reader.ts in the server). Anything the Inbox cannot tell (a
 * program, an older Inbox's message, a note the Inbox writes) records nothing.
 * The agent reads it as one line under the person's words (`inboxSentFromLine`); the window draws nothing.
 */

/** Where the person was, on a device other than the Inbox's computer. */
export type InboxSentFromPlace = "tailnet" | "cloudflare" | "phone";

/**
 * A person who signed in to this Inbox and signed the write in. The account this Inbox holds, not an account on
 * another computer: this Inbox can vouch for its own accounts only. `name` is what the account carries, null when
 * nothing does (a person who has never set one and an identity provider that sends none): the email is the name then.
 */
export interface InboxSessionAccount {
  email: string;
  name: string | null;
}

export type InboxSentFrom =
  /** The account is set only for a write this Inbox accepted from a signed-in web session of its own. */
  | { kind: InboxSentFromPlace; account?: InboxSessionAccount }
  /** This computer's own window. Never a line here: a linked computer's agent reading the thread reads it as written on this one. */
  | { kind: "here" }
  /** Forwarded by a linked computer: its name here, and where the person was when it was not that computer's own window. Never an account: that computer's accounts are not this Inbox's to name. */
  | { kind: "machine"; name: string; via?: InboxSentFromPlace };

/** The header a linked computer's Inbox sends with a forwarded write when the person was not at its own window. */
export const INBOX_SENT_FROM_HEADER = "X-Plannotator-Sent-From";

const PLACES: readonly InboxSentFromPlace[] = ["tailnet", "cloudflare", "phone"];
const NAME_MAX = 64;
/** The longest an email address can be (RFC 5321). Longer than that is not an address, so the record is not readable. */
const EMAIL_MAX = 254;

export function isInboxSentFromPlace(value: unknown): value is InboxSentFromPlace {
  return typeof value === "string" && (PLACES as readonly string[]).includes(value);
}

/** `INBOX_SENT_FROM_HEADER` as the door reads it: one of the places, else null. The door believes it from a linked computer only. */
export function inboxSentFromPlaceOf(header: string | null | undefined): InboxSentFromPlace | null {
  const value = header?.trim().toLowerCase() ?? "";
  return isInboxSentFromPlace(value) ? value : null;
}

/**
 * A machine's name for the line: one line, no controls, no backtick, at most 64 characters, cut between whole
 * characters as a person sees them (an emoji is never split). Empty when nothing is left. The server cleans a name
 * this way when it records it, and reads clean it again (a record an older Inbox wrote).
 */
export function inboxSentFromName(name: string): string {
  const line = cleanSentFromLine(name);
  if (line.length <= NAME_MAX) return line;
  let kept = "";
  for (const { segment } of new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(line)) {
    if (kept.length + segment.length > NAME_MAX - 1) break;
    kept += segment;
  }
  return `${kept.trimEnd()}…`;
}

/**
 * The line rules with no length cut: what `inboxSentFromName` does before its 64-character cap. An address is checked
 * with this rather than cleaned with the capped one — cutting an address to a name's length would lose a real address
 * (and an address is capped by `EMAIL_MAX`, not by a name's 64).
 */
export function cleanSentFromLine(value: string): string {
  return value
    // Every control and format character but the zero-width joiner, which holds an emoji like 👨‍👩‍👧 together.
    .replace(/(?!\u200D)[\p{Cc}\p{Cf}\u2028\u2029]/gu, " ")
    .replace(/`/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * A stored account read back: null for anything not of the shape. The name is cleaned the way a machine name is, and
 * an empty one reads back as none. An email that is empty, longer than an address can be, or not one whole line of
 * printable text makes the whole account unreadable rather than half of it: the line then reads exactly as it did
 * before accounts were recorded. An address is never rewritten to make it readable — an identity that changes on the
 * way to the agent is worse than no identity, and the door holds addresses lowercased and trimmed (`normalizeAuthEmail`).
 */
export function inboxSessionAccountOf(value: unknown): InboxSessionAccount | null {
  if (!value || typeof value !== "object") return null;
  const record = value as { email?: unknown; name?: unknown };
  if (typeof record.email !== "string") return null;
  const email = record.email.trim();
  if (!email || email.length > EMAIL_MAX) return null;
  // The address is user input like the name is (an identity provider sends what it sends). Cleaning would print a
  // different person than the door signed in, so an address that needs any is not an account this Inbox will name.
  if (cleanSentFromLine(email) !== email) return null;
  if (record.name === null || record.name === undefined) return { email, name: null };
  if (typeof record.name !== "string") return null;
  return { email, name: inboxSentFromName(record.name) || null };
}

/** The name to show a person or an agent for an account: the name it carries, else the email. Never empty. */
export function inboxAccountName(account: InboxSessionAccount): string {
  return inboxSentFromName(account.name ?? "") || inboxSentFromName(account.email);
}

/** A stored value read back: null for anything not of the shape (an older or newer Inbox wrote it, or nothing did). */
export function inboxSentFromOf(value: unknown): InboxSentFrom | null {
  if (!value || typeof value !== "object") return null;
  const record = value as { kind?: unknown; name?: unknown; via?: unknown; account?: unknown };
  if (isInboxSentFromPlace(record.kind)) {
    // A spread, so a record written before accounts reads back byte-identical to what it does today.
    const account = inboxSessionAccountOf(record.account);
    return { kind: record.kind, ...(account ? { account } : {}) };
  }
  if (record.kind === "here") return { kind: "here" };
  if (record.kind !== "machine" || typeof record.name !== "string") return null;
  const name = inboxSentFromName(record.name);
  if (!name) return null;
  return { kind: "machine", name, ...(isInboxSentFromPlace(record.via) ? { via: record.via } : {}) };
}

const PLACE_WORDS: Record<InboxSentFromPlace, string> = {
  tailnet: "another device over Tailscale",
  cloudflare: "another device through Cloudflare Access",
  phone: "the Plannotator phone app",
};

/**
 * The one line an agent reads for a message the person wrote away from this computer. Context only: who signed it in
 * where this Inbox holds the account, where they were, and the one fact that follows from it. Empty when the message
 * says nothing (this computer, `here`, or not known).
 */
export function inboxSentFromLine(message: { sent_from?: unknown }): string {
  const from = inboxSentFromOf(message.sent_from);
  // This computer's own window: nothing to say to an agent on this computer.
  if (!from || from.kind === "here") return "";
  const where =
    from.kind === "machine"
      ? from.via
        ? `${PLACE_WORDS[from.via]}, through their linked computer \`${from.name}\``
        : `their linked computer \`${from.name}\``
      : PLACE_WORDS[from.kind];
  // Only this Inbox's own accounts: a forwarded line stays named by the machine that forwarded it.
  const who = from.kind === "machine" || !from.account ? "" : ` ${inboxAccountName(from.account)}`;
  return `(They sent this${who} from ${where}, not from this computer: a localhost link would not open there.)`;
}
