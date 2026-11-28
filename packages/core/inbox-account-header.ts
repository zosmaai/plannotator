/**
 * The one seam out of a sign-in door that says who the door signed the request in as
 * (`adr/inbox-tenancy.md`, model A). The door sets it on the answers it proxies, and the window may
 * read it: one line, "signed in as ada@…".
 *
 * Strictly one-way — no client ever sends it. A page cannot name the account it wants to be, which is
 * why the door's session cookies can keep stopping at the door (`scrubAuthDoorHeaders`,
 * `withoutAuthCookies` in packages/shared/inbox/auth-door.ts): the window never needs a cookie to
 * know who it signed in as, only this header on the answer the door just made.
 */
export const INBOX_ACCOUNT_HEADER = "X-Plannotator-Account";
