import { INBOX_ACCOUNT_HEADER } from '@plannotator/core/inbox-account-header';

/**
 * Who this page is signed in as, when it came in through the sign-in door
 * (`adr/inbox-tenancy.md`, model A step 4).
 *
 * It is read off one response header the door sets (`X-Plannotator-Account`,
 * packages/core/inbox-account-header.ts): the door names the account on the answers it proxies, and
 * this page may read that. It is one-way — nothing here ever sends the header — so a page cannot
 * claim to be an account, and the door's session cookies keep stopping at the door
 * (`withoutAuthCookies`, `adr/implementation/inbox-auth.md`). A window with no door never sees the
 * header and shows nothing: local installs stay as they were.
 */
let account: string | null = null;
const listeners = new Set<(account: string | null) => void>();

/** Take note of what a door answered, if it answered anything. Called with every API response. An
 * answer with no header says nothing: it neither clears nor changes what a door already said. */
export function learnSignedInAs(response: Response): void {
  const value = response.headers.get(INBOX_ACCOUNT_HEADER);
  if (value === null || value === account) return;
  account = value;
  for (const listener of [...listeners]) listener(account);
}

/** The address the door signed this page in as, or null — no door, or no answer seen yet. */
export function signedInAs(): string | null {
  return account;
}

/** Listen for the door naming an account. Returns the unsubscribe. */
export function onSignedInAs(listener: (account: string | null) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Only for tests: forget what the door said. */
export function _resetSignedInAsForTests(): void {
  account = null;
}
