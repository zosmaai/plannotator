/**
 * Settings → Remote devices → the sign-in door's card (components/WithAnAccount.tsx). What the card
 * shows for a door that was never set up, the set-up form, the switch, the accounts and the list of
 * addresses that may enter, with the routes stubbed — their own behaviour, and what they write to
 * config.json, is packages/server/inbox-auth-routes.test.ts's.
 * What this catches: the card reading the door before Settings is open (it opens nothing else); a card
 * that cannot be read rendering controls that would do nothing; the switch posting the wrong action or
 * taking the accounts with it; an account removed on one click; a second address added by replacing the
 * first; the set-up form opening the door before the first account exists; its button staying live and
 * posting twice while a write is in flight; a card that could not read the door leaving nothing to click;
 * a door whose settings come from the environment offering an edit the route would ignore.
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

const hasDom = typeof document !== 'undefined';
const { WithAnAccount } = (hasDom ? await import('./components/WithAnAccount') : {}) as typeof import('./components/WithAnAccount');

const HOST = 'arjun.tail3ff43a.ts.net';
const ME = 'arjun@zosma.ai';
const MIN_PASSWORD = 10;

/** What the routes would answer. The stub below applies each action the way the route does. */
interface Door {
  configured: boolean;
  on: boolean;
  host: string;
  port: number;
  allow: string[];
  accounts: { email: string; name: string; createdAt: string; lastSeenAt: string | null; allowed: boolean }[];
  error: string;
  /** The Inbox's environment sets the address or the list, as `PLANNOTATOR_INBOX_AUTH_HOST` / `_ALLOW` do. */
  pinnedByEnvironment: boolean;
  /** Set to a route's refusal: every request comes back with it, the way a door's own page is told off. */
  refusal?: { code: string; message: string };
}

let door: Door;
const calls: { action: string; body: Record<string, unknown> }[] = [];
/** Handed to the stub to hold the first write open, so a test can look at the card mid-write. */
let holdFirst: Promise<void> | null = null;
let root: Root | null = null;
let host: HTMLElement | null = null;
const realFetch = globalThis.fetch;

const freshDoor = (over: Partial<Door> = {}): Door => ({
  configured: false,
  on: false,
  host: '',
  port: 4352,
  allow: [],
  accounts: [],
  error: '',
  pinnedByEnvironment: false,
  ...over,
});

const account = (email: string, over: Partial<{ name: string; lastSeenAt: string | null; allowed: boolean }> = {}) => ({
  email,
  name: over.name ?? '',
  createdAt: '2026-11-14T00:00:00.000Z',
  lastSeenAt: over.lastSeenAt ?? null,
  allowed: over.allowed ?? true,
});

/** Every action the way its route applies it, so a re-read shows what the server now is. */
function apply(action: string, body: Record<string, unknown>): Door {
  switch (action) {
    case 'on':
      return { ...door, configured: true, on: true, host: String(body['host'] ?? ''), allow: (body['allow'] as string[]) ?? door.allow };
    case 'off':
      return { ...door, on: false };
    case 'allow':
      return { ...door, allow: (body['allow'] as string[]) ?? [] };
    case 'account': {
      const email = String(body['email'] ?? '').toLowerCase();
      return { ...door, accounts: [...door.accounts.filter((entry) => entry.email !== email), account(email)], allow: door.allow.includes(email) ? door.allow : [...door.allow, email] };
    }
    case 'account/remove':
      return { ...door, accounts: door.accounts.filter((entry) => entry.email !== String(body['email'] ?? '').toLowerCase()) };
    default:
      return door;
  }
}

const view = () => ({
  configured: door.configured,
  on: door.on,
  host: door.host,
  port: door.port,
  url: door.host ? `https://${door.host}/login` : '',
  allow: door.allow,
  error: door.error,
  minPasswordLength: MIN_PASSWORD,
  accounts: door.accounts,
  pinnedByEnvironment: door.pinnedByEnvironment,
});

const jsonResponse = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });

beforeEach(() => {
  door = freshDoor();
  calls.length = 0;
  holdFirst = null;
  globalThis.fetch = (async (url: unknown, init?: { method?: string; body?: string }) => {
    const path = String(url);
    const action = path.includes('/sign-in/') ? path.split('/sign-in/')[1]! : '';
    const body = (init?.body ? JSON.parse(String(init.body)) : {}) as Record<string, unknown>;
    if (action) calls.push({ action, body });
    if (door.refusal) return jsonResponse({ error: door.refusal.message, code: door.refusal.code }, 403);
    if (!action) return jsonResponse(view());
    if (holdFirst) {
      await holdFirst;
      holdFirst = null;
    }
    if (!['on', 'off', 'allow', 'account', 'account/remove'].includes(action)) {
      return jsonResponse({ error: 'There is no such action.', code: 'unknown_action' }, 404);
    }
    door = apply(action, body);
    return jsonResponse(view());
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  if (!hasDom) return;
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

async function render(over: Partial<Door> = {}): Promise<HTMLElement> {
  door = freshDoor(over);
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(<WithAnAccount />);
  });
  return host;
}

const query = (selector: string) => host?.querySelector(selector) ?? null;
const all = (selector: string) => [...(host?.querySelectorAll(selector) ?? [])];
const button = (text: string) => all('button').find((node) => (node.textContent ?? '').trim() === text) as HTMLButtonElement | null;
/** Every submit button on the card — the ways a turn could post. */
const submits = () => all('button[type="submit"]') as HTMLButtonElement[];
/** A field by its id, its aria-label, or the words of the <label for> that names it. */
const field = (which: string) =>
  all('input').find(
    (node) =>
      node.id === which ||
      node.getAttribute('aria-label') === which ||
      (!!node.id && (host?.querySelector(`label[for="${node.id}"]`)?.textContent ?? '').trim() === which),
  ) as HTMLInputElement | undefined;

const click = (node: Element | null | undefined) =>
  act(async () => {
    (node as HTMLButtonElement | null)?.click();
  });

const type = (node: HTMLInputElement | undefined, value: string) =>
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    setter?.call(node, value);
    node?.dispatchEvent(new Event('input', { bubbles: true }));
  });

if (hasDom) {
  describe('the sign-in card', () => {
    test('waits for the read, then says there is no door yet', async () => {
      let resolveRead: (value: Response) => void = () => {};
      globalThis.fetch = (async () => new Promise<Response>((resolve) => (resolveRead = resolve))) as unknown as typeof fetch;
      await render();
      // Nothing about a door nobody has set up is drawn until the answer arrives — and nothing was opened.
      expect(query('[data-settings-signin]')).toBeNull();

      await act(async () => resolveRead(jsonResponse(view())));
      expect(query('[data-settings-signin]')?.getAttribute('data-settings-signin')).toBe('off');
      expect(query('[data-signin-setup]')).not.toBeNull();
      // No switch, no address, no rows: a door that was never set up has none of those to offer.
      expect(query('[role="switch"]')).toBeNull();
      expect(query('[data-signin-account]')).toBeNull();
      expect(query('[data-signin-address]')).toBeNull();
    });

    test('set up: the first account first, then the door, then what it looks like', async () => {
      await render();
      await click(query('[data-signin-setup]'));
      expect(query('[data-settings-signin]')?.getAttribute('data-settings-signin')).toBe('setup');

      await type(field('Address this Inbox answers at'), HOST);
      await type(field('Addresses that may enter'), ME);
      await type(field('First account'), ME);
      await type(field('ib-signin-password'), 'correct horse battery');

      const turnOn = query('[data-signin-turn-on]') as HTMLButtonElement;
      expect(turnOn.disabled).toBe(false);

      // Hold the first write open and look at the card: one post in flight, and no second way to post.
      let release: () => void = () => {};
      holdFirst = new Promise<void>((resolve) => (release = resolve));
      await act(async () => {
        turnOn.click();
      });
      expect(calls.map((call) => call.action)).toEqual(['account']);
      expect(calls[0].body['email']).toBe(ME);
      expect(turnOn.disabled).toBe(true);
      expect(turnOn.textContent).toContain('Opening');
      expect(submits().filter((node) => !node.disabled).length).toBe(0);
      release();
      await act(async () => {});

      // The account exists before the door opens, so nobody can be left outside a half-built door.
      expect(calls.map((call) => call.action)).toEqual(['account', 'on']);
      expect(calls[1].body['host']).toBe(HOST);
      expect(calls[1].body['allow']).toEqual([ME]);
      expect(query('[data-settings-signin]')?.getAttribute('data-settings-signin')).toBe('on');
      expect(query('[data-signin-address]')?.textContent).toContain(`https://${HOST}/login`);
      expect(query('[role="switch"]')?.getAttribute('aria-checked')).toBe('true');
      expect(query('[data-signin-account]')?.getAttribute('data-signin-account')).toBe(ME);
    });

    test('a door that cannot be read says where to change it, and offers nothing to click', async () => {
      await render({ refusal: { code: 'local_only', message: 'The sign-in door cannot change itself.' } });
      expect(query('[data-settings-signin]')?.getAttribute('data-settings-signin')).toBe('elsewhere');
      expect(query('[data-settings-signin]')?.textContent).toContain('Change this on the computer itself or over your tailnet.');
      expect(all('button').length).toBe(0);
      expect(calls).toEqual([]); // the read is what found out; the card sent nothing to change it
    });

    test('removing an account asks twice, and the second click is what posts', async () => {
      await render({ configured: true, on: true, host: HOST, allow: [ME], accounts: [account(ME)] });
      const row = query('[data-signin-account]');
      expect(row?.getAttribute('data-signin-account')).toBe(ME);

      await click(row?.querySelector('button'));
      expect(calls.length).toBe(0);
      expect(row?.querySelector('button')?.textContent?.trim()).toBe('Remove? Click again');

      await click(row?.querySelector('button'));
      expect(calls.map((call) => call.action)).toEqual(['account/remove']);
      expect(calls[0].body['email']).toBe(ME);
      expect(query('[data-signin-account]')).toBeNull();
    });

    test('the switch closes the address and keeps the accounts', async () => {
      await render({ configured: true, on: true, host: HOST, allow: [ME], accounts: [account(ME)] });

      await click(query('[role="switch"]'));
      expect(calls.map((call) => call.action)).toEqual(['off']);
      expect(query('[data-settings-signin]')?.getAttribute('data-settings-signin')).toBe('paused');
      // The door is closed; the account and the list that would let it in are still there to open it again.
      expect(query('[data-signin-account]')?.getAttribute('data-signin-account')).toBe(ME);
      expect(query('[data-signin-allow]')?.getAttribute('data-signin-allow')).toBe(ME);
      expect(query('[data-signin-address]')).toBeNull();
    });

    test('an added address joins the ones already on the list', async () => {
      const other = 'zosma@example.com';
      await render({ configured: true, on: true, host: HOST, allow: [ME], accounts: [account(ME)] });

      await type(field('The address to let in'), other);
      await click(button('Add'));
      expect(calls.map((call) => call.action)).toEqual(['allow']);
      expect(calls[0].body['allow']).toEqual([ME, other]);
      expect(all('[data-signin-allow]').map((node) => node.getAttribute('data-signin-allow'))).toEqual([ME, other]);
    });

    test('a door the environment pins says so, and offers no way to edit the list', async () => {
      await render({ configured: true, on: true, host: HOST, allow: [ME], accounts: [account(ME)], pinnedByEnvironment: true });

      expect(query('[data-signin-pinned]')?.textContent).toContain('environment sets the address and the list');
      // The list is the environment's, so there is nothing here to add to it or to take off it.
      expect(query('[data-signin-add-address]')).toBeNull();
      expect(query('[data-signin-allow]')?.textContent).toContain('From the environment');
      expect(button(`Remove ${ME}`)).toBeUndefined();
      // Turning the door on and off is still the person's: only the address and the list are pinned.
      expect(query('[role="switch"]')).not.toBeNull();
    });

    test('a door that could not be read says so, and can be read again', async () => {
      let failing = true;
      globalThis.fetch = (async () => {
        if (!failing) return jsonResponse(view());
        return jsonResponse({ error: 'Could not read the door.', code: 'failed' }, 500);
      }) as unknown as typeof fetch;

      await render();
      expect(query('[data-settings-signin]')?.getAttribute('data-settings-signin')).toBe('unread');
      expect(query('[data-signin-load-error]')?.textContent).toContain('Could not read the door.');
      expect(query('[role="switch"]')).toBeNull();

      failing = false;
      await click(query('[data-signin-retry]'));
      expect(query('[data-signin-load-error]')).toBeNull();
      expect(query('[data-settings-signin]')?.getAttribute('data-settings-signin')).toBe('off');
    });
  });
}
