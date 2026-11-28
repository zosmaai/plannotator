/**
 * The one line a signed-in window shows: "signed in as ada@…", from the header the sign-in door sets
 * on the answers it proxies (`adr/inbox-tenancy.md` model A step 4, packages/inbox/signedInAs.ts).
 * What this catches: a window that came through the door not naming the account it is in; the line
 * staying wrong after a later answer named someone else; an answer with no header (a response that
 * did not come through the door) clearing or blanking what a door already said; the sidebar foot
 * showing nothing when no door said anything.
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

const hasDom = typeof document !== 'undefined';
const { Sidebar } = (hasDom ? await import('./components/Sidebar') : {}) as typeof import('./components/Sidebar');
const { SidebarProvider } = (hasDom ? await import('./shell/sidebar') : {}) as typeof import('./shell/sidebar');
const { learnSignedInAs, signedInAs, onSignedInAs, _resetSignedInAsForTests } = (hasDom
  ? await import('./signedInAs')
  : {}) as typeof import('./signedInAs');

let root: Root | null = null;

beforeEach(() => {
  _resetSignedInAsForTests();
});

afterEach(() => {
  root?.unmount();
  root = null;
  _resetSignedInAsForTests();
});

/** An answer like the door's: the header is the only way in; nothing here sends anything back. */
function doorAnswer(account: string): Response {
  return new Response(JSON.stringify({ ok: true }), { headers: { 'content-type': 'application/json', 'X-Plannotator-Account': account } });
}

function answerWithoutTheHeader(): Response {
  return new Response(JSON.stringify({ ok: true }), { headers: { 'content-type': 'application/json' } });
}

describe("the signed-in line", () => {
  test("learns the account from a door answer and tells its listeners", () => {
    if (!hasDom) return;
    expect(signedInAs()).toBeNull();
    const seen: (string | null)[] = [];
    const off = onSignedInAs((account) => seen.push(account));
    learnSignedInAs(doorAnswer('ada@example.com'));
    expect(signedInAs()).toBe('ada@example.com');
    expect(seen).toEqual(['ada@example.com']);

    // A later answer naming someone else wins — a shared machine, one after the other through the door.
    learnSignedInAs(doorAnswer('ada@zosma.ai'));
    expect(signedInAs()).toBe('ada@zosma.ai');
    expect(seen).toEqual(['ada@example.com', 'ada@zosma.ai']);

    // An answer with no header says nothing: it does not clear what a door said.
    learnSignedInAs(answerWithoutTheHeader());
    expect(signedInAs()).toBe('ada@zosma.ai');

    off();
    learnSignedInAs(doorAnswer('ada@example.com'));
    expect(seen).toEqual(['ada@example.com', 'ada@zosma.ai']);
  });

  test("the sidebar foot shows the one line, and shows nothing until a door names an account", async () => {
    if (!hasDom) return;
    const host = document.createElement('div');
    host.className = 'pn-inbox';
    document.body.appendChild(host);
    const project = { id: 'prj_q', key: 'quiet-abc123', name: 'quiet', root: '/tmp/quiet', created_at: '2026-10-11T10:00:00.000Z', threads: 1, unread: 0 };
    const noop = () => {};
    root = createRoot(host);
    await act(async () =>
      root!.render(
        <SidebarProvider>
          <Sidebar
            page="inbox"
            projectId={null}
            inboxCount={1}
            projects={[project] as never}
            projectCounts={new Map()}
            update={null}
            restarting={false}
            updated={null}
            onInbox={noop}
            onProject={noop}
            onSettings={noop}
            onUpdate={noop}
            onWhatsNew={noop}
          />
        </SidebarProvider>,
      ),
    );

    // Nothing said yet: no line. A local window with no door stays exactly as it was.
    expect(host.querySelector('[data-signed-in-as]')).toBeNull();

    // The door answers; the line appears, and it is one line naming the address.
    await act(async () => learnSignedInAs(doorAnswer('ada@example.com')));
    const line = host.querySelector('[data-signed-in-as]');
    expect(line?.textContent).toBe('signed in as ada@example.com');

    // A later door answer moves the line with it.
    await act(async () => learnSignedInAs(doorAnswer('ada@zosma.ai')));
    expect(host.querySelector('[data-signed-in-as]')?.textContent).toBe('signed in as ada@zosma.ai');
  });
});
