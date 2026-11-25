import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { InboxAuthRefusal, postInboxAuth, readInboxAuth, type InboxAuthAccount, type InboxAuthView } from '../data/inboxAuth';
import { Icon } from '../icons';
import { AskTwiceButton } from './AskTwice';
import { Switch } from './SettingSwitch';

/**
 * Settings → Remote devices: signing in with an account of your own.
 *
 * The third way a phone reaches this Inbox — over the tailnet (`OverYourTailnet`), through Cloudflare
 * (`ThroughCloudflare`), and here: a sign-in page this Inbox serves itself, where an address asks for
 * a code and gets in. The card is the switch, the address it answers at, the list of addresses that
 * may enter, and the accounts — one row each, e-mail, when it was last seen, and a Remove that asks
 * twice like the phone list's.
 *
 * Nothing is asked until Settings opens: this reads `GET /api/inbox/sign-in` when it mounts, so an
 * Inbox that never opens Settings never opens the account file. A write re-renders from the answer the
 * server gives back, so what is on screen is what the door is now, not what the click meant to do.
 *
 * When the Inbox was opened at the door's own address, its requests carry that door's mark and every
 * route answers `local_only` — signing in at a door you can close is how an Inbox ends up with nobody
 * able to open it again. The card then says one line and offers nothing to click, which is how
 * `ThroughCloudflare` reads its own refusal.
 */

/** When the account was last seen, in words a person reads once. */
function seen(account: InboxAuthAccount): string {
  if (!account.allowed) return 'its address is not on the list, so it cannot sign in';
  if (!account.lastSeenAt) return 'has not signed in yet';
  const when = new Date(account.lastSeenAt);
  return Number.isNaN(when.getTime()) ? 'has not signed in yet' : `last seen ${when.toLocaleDateString()}`;
}

/**
 * What to show for a write that did not land: the server's own words when it refused, and one line for
 * a network that never answered.
 */
function messageOf(failure: unknown): string {
  return failure instanceof InboxAuthRefusal ? failure.message : 'Could not reach this Inbox.';
}

/** A copy of the address, so it can be typed on a phone once. Same button `ThroughCloudflare` uses. */
function CopyAddress({ url }: { url: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="ib-prow" data-signin-address="">
      <span className="ib-txt">
        <span className="ib-l">Sign-in address</span>
        <span className="ib-desc ib-mono">{url}</span>
      </span>
      <span className="ib-ctl">
        <button
          type="button"
          className="ib-btn ib-ghost"
          aria-label="Copy the sign-in address"
          onClick={() => {
            void navigator.clipboard?.writeText(url).then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            });
          }}
        >
          <Icon name={copied ? 'check' : 'copy'} size={13} />
          {copied ? 'Copied' : 'Copy'}
        </button>
      </span>
    </div>
  );
}

/**
 * One address that may sign in here, and the button that takes it off the list. Removing the last
 * one is refused by the route rather than asked for here: a door with no address on it shuts everyone
 * out, the person signing in included.
 */
function AllowRow({ address, last, pinned, onRemove }: { address: string; last: boolean; pinned: boolean; onRemove: () => Promise<void> }) {
  return (
    <div className="ib-prow" data-signin-allow={address}>
      <span className="ib-txt">
        <span className="ib-l">{address}</span>
        <span className="ib-desc">May sign in here. Anyone else who reaches the address is refused.</span>
      </span>
      <span className="ib-ctl">
        {pinned ? (
          <span className="ib-desc">From the environment</span>
        ) : last ? (
          <span className="ib-desc">The only address left</span>
        ) : (
          <AskTwiceButton
            onRemove={onRemove}
            text="Remove"
            label={`Remove ${address}`}
            confirmText="Remove? Click again"
            confirmLabel={`Remove ${address}: click again to take it off the list`}
          />
        )}
      </span>
    </div>
  );
}

/** One more address that may enter. */
function AddAddressRow({ current, busy, onAdd, onRefusal }: { current: string[]; busy: boolean; onAdd: (view: InboxAuthView) => void; onRefusal: (message: string) => void }) {
  const [address, setAddress] = useState('');
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const trimmed = address.trim();
    if (trimmed === '' || current.includes(trimmed)) return;
    setAddress('');
    try {
      // The route replaces the whole list, so the new address goes onto the ones already there.
      onAdd(await postInboxAuth('allow', { allow: [...current, trimmed] }));
    } catch (failure) {
      onRefusal(messageOf(failure));
    }
  };
  return (
    <form className="ib-prow" onSubmit={(event) => void submit(event)} data-signin-add-address="">
      <span className="ib-txt">
        <span className="ib-l">Add an address</span>
        <span className="ib-desc">It joins the list; the account with that address still has to exist.</span>
      </span>
      <span className="ib-ctl ib-vkeyctl">
        <input className="ib-vkey" type="email" autoComplete="off" spellCheck={false} aria-label="The address to let in" placeholder="you@example.com" value={address} onChange={(event) => setAddress(event.target.value)} />
        <button type="submit" className="ib-btn" disabled={busy || address.trim() === ''}>
          Add
        </button>
      </span>
    </form>
  );
}

/**
 * The first account and the door's settings, asked for once. Turning the door on is two posts — the
 * account first, so a password too short refuses before the door has a host name and nobody is left
 * outside a half-built door.
 */
function SetUpForm({ minPasswordLength, pinned, onDone, onCancel }: { minPasswordLength: number; pinned: boolean; onDone: (view: InboxAuthView) => void; onCancel: () => void }) {
  const [host, setHost] = useState('');
  const [allow, setAllow] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const address = email.trim();
      await postInboxAuth('account', { email: address, password });
      const list = allow
        .split(/[\n,]/)
        .map((entry) => entry.trim())
        .filter((entry) => entry !== '');
      onDone(await postInboxAuth('on', { host: host.trim(), allow: list.length > 0 ? list : [address] }));
    } catch (failure) {
      setError(messageOf(failure));
      setBusy(false);
    }
  };

  return (
    <form className="ib-flow" onSubmit={(event) => void submit(event)} data-signin-form="">
      <div className="ib-flow-head">
        <h3>Sign in with an account</h3>
      </div>
      <div className="ib-flow-body">
        <p className="ib-lead">The address is where your phone types this Inbox: a tailnet box already has one, <span className="ib-mono">&lt;name&gt;.&lt;tailnet&gt;.ts.net</span>.</p>
        {pinned && (
          <p className="ib-desc" data-signin-pinned="setup">
            This Inbox's environment sets the address and the list, so both are fixed here.
          </p>
        )}
        <div className="ib-card">
          <div className="ib-prow">
            <span className="ib-txt">
              <label className="ib-l" htmlFor="ib-signin-host">
                Address this Inbox answers at
              </label>
              <span className="ib-desc">Without it the door has nothing to open on, so turning it on refuses.</span>
            </span>
            <span className="ib-ctl ib-vkeyctl">
              <input id="ib-signin-host" className="ib-vkey" type="text" autoComplete="off" spellCheck={false} disabled={pinned} placeholder="boson.tail9.ts.net" value={host} onChange={(event) => setHost(event.target.value)} />
            </span>
          </div>
          <div className="ib-prow">
            <span className="ib-txt">
              <label className="ib-l" htmlFor="ib-signin-allow">
                Addresses that may enter
              </label>
              <span className="ib-desc">Commas separate them. Left empty, the account below is the only one.</span>
            </span>
            <span className="ib-ctl ib-vkeyctl">
              <input id="ib-signin-allow" className="ib-vkey" type="text" autoComplete="off" spellCheck={false} disabled={pinned} placeholder="arjun@zosma.ai" value={allow} onChange={(event) => setAllow(event.target.value)} />
            </span>
          </div>
          <div className="ib-prow">
            <span className="ib-txt">
              <label className="ib-l" htmlFor="ib-signin-email">
                First account
              </label>
              <span className="ib-desc">It signs in with the password typed below, and only if its address is on the list above. The password is hashed, never mailed.</span>
              <label className="ib-desc" htmlFor="ib-signin-password">
                Password
              </label>
            </span>
            <span className="ib-ctl ib-vkeyctl">
              <input id="ib-signin-email" className="ib-vkey" type="email" autoComplete="off" spellCheck={false} placeholder="you@example.com" value={email} onChange={(event) => setEmail(event.target.value)} />
              <input
                id="ib-signin-password"
                className="ib-vkey"
                type="password"
                autoComplete="new-password"
                spellCheck={false}
                placeholder={`password, ${minPasswordLength} characters or more`}
                value={password}
                onChange={(event) => setPassword(event.target.value)}
              />
            </span>
          </div>
        </div>
        {error && (
          <div className="ib-callout ib-err" role="alert" data-signin-form-error="">
            <Icon name="xCircle" />
            <span>{error}</span>
          </div>
        )}
        <div className="ib-flow-f">
          <button type="submit" className="ib-btn ib-pri" disabled={busy || !host.trim() || !email.trim() || password.length < minPasswordLength} data-signin-turn-on="">
            {busy ? 'Opening…' : 'Turn on'}
          </button>
          <button type="button" className="ib-btn ib-ghost" onClick={onCancel}>
            Cancel
          </button>
        </div>
      </div>
    </form>
  );
}

/** A second account, added to a door that is already open. */
function AddAccountRow({ minPasswordLength, onAdded, onRefusal, onCancel }: { minPasswordLength: number; onAdded: (view: InboxAuthView) => void; onRefusal: (message: string) => void; onCancel: () => void }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    try {
      onAdded(await postInboxAuth('account', { email: email.trim(), password }));
      setEmail('');
      setPassword('');
    } catch (failure) {
      onRefusal(messageOf(failure));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="ib-prow" onSubmit={(event) => void submit(event)} data-signin-add="">
      <span className="ib-txt">
        <span className="ib-l">Add an account</span>
        <span className="ib-desc">Its address goes on the list as well, or it could sign in and be refused.</span>
      </span>
      <span className="ib-ctl ib-vkeyctl">
        <input className="ib-vkey" type="email" autoComplete="off" spellCheck={false} placeholder="you@example.com" aria-label="The new account's address" value={email} onChange={(event) => setEmail(event.target.value)} />
        <input
          className="ib-vkey"
          type="password"
          autoComplete="new-password"
          spellCheck={false}
          aria-label="The new account's password"
          placeholder={`password, ${minPasswordLength} characters or more`}
          value={password}
          onChange={(event) => setPassword(event.target.value)}
        />
        <button type="submit" className="ib-btn" disabled={busy || !email.trim() || password.length < minPasswordLength}>
          Add
        </button>
        <button type="button" className="ib-btn ib-ghost" onClick={onCancel}>
          Cancel
        </button>
      </span>
    </form>
  );
}

export function WithAnAccount() {
  const [view, setView] = useState<InboxAuthView | null>(null);
  const [refused, setRefused] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [settingUp, setSettingUp] = useState(false);
  const [addingAccount, setAddingAccount] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoadError(null);
    try {
      setView(await readInboxAuth());
    } catch (failure) {
      if (failure instanceof InboxAuthRefusal && failure.code === 'local_only') setRefused(true);
      // Anything else is a card that could not read the door: it says so and offers the read again,
      // rather than disappearing out of Settings with nothing to click.
      else setLoadError(messageOf(failure));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (refused) {
    return (
      <section className="ib-sgroup" data-settings-signin="elsewhere" aria-labelledby="ib-g-signin">
        <h2 id="ib-g-signin">Sign in with an account</h2>
        <p>Change this on the computer itself or over your tailnet.</p>
      </section>
    );
  }
  if (!view) {
    if (loadError === null) return null;
    return (
      <section className="ib-sgroup" data-settings-signin="unread" aria-labelledby="ib-g-signin">
        <h2 id="ib-g-signin">Sign in with an account</h2>
        <div className="ib-callout ib-err" role="alert" data-signin-load-error="">
          <Icon name="xCircle" />
          <span>{loadError}</span>
        </div>
        <button type="button" className="ib-btn ib-ghost" onClick={() => void load()} data-signin-retry="">
          Try again
        </button>
      </section>
    );
  }

  const send = async (action: 'on' | 'off' | 'allow' | 'account' | 'account/remove', body: Record<string, unknown>) => {
    setBusy(true);
    setError(null);
    try {
      setView(await postInboxAuth(action, body));
    } catch (failure) {
      setError(messageOf(failure));
    } finally {
      setBusy(false);
    }
  };

  const state = settingUp ? 'setup' : !view.configured ? 'off' : view.on ? 'on' : 'paused';
  return (
    <section className="ib-sgroup" data-settings-signin={state} aria-labelledby="ib-g-signin">
      <h2 id="ib-g-signin">Sign in with an account</h2>
      <p>
        A sign-in page of this Inbox's own: an e-mail and a password, so a device that is not on your tailnet and has no Cloudflare can still open it. Anyone who can reach the address can try a
        password, so the list of addresses that may enter stays short.
      </p>
      {!settingUp && view.pinnedByEnvironment && (
        <p data-signin-pinned="">
          This Inbox's environment sets the address and the list, so both are fixed here.
        </p>
      )}
      {settingUp ? (
        <SetUpForm
          minPasswordLength={view.minPasswordLength}
          pinned={view.pinnedByEnvironment}
          onDone={(next) => {
            setView(next);
            setSettingUp(false);
          }}
          onCancel={() => setSettingUp(false)}
        />
      ) : (
        <div className="ib-card">
          <div className="ib-prow">
            <span className="ib-tile">
              <Icon name="lock" size={20} />
            </span>
            <span className="ib-txt">
              <span className="ib-l">
                <span id="ib-signin-label">Sign in with an account</span>
                {view.error && <span className="ib-chip ib-chip-err">Not working</span>}
              </span>
              <span className="ib-desc" data-signin-count={view.accounts.length}>
                {view.on ? 'On' : 'Off'} · {view.accounts.length === 1 ? '1 account' : `${view.accounts.length} accounts`} · {view.allow.length === 0 ? 'nobody may enter' : view.allow.join(', ')}
              </span>
            </span>
            <span className="ib-ctl">
              {view.configured ? (
                <Switch on={view.on} labelledBy="ib-signin-label" disabled={busy} onClick={() => void send(view.on ? 'off' : 'on', {})} />
              ) : (
                <button type="button" className="ib-btn ib-pri" onClick={() => setSettingUp(true)} data-signin-setup="">
                  Set up
                </button>
              )}
            </span>
          </div>
          {view.error && (
            <div className="ib-callout ib-err ib-in-card" data-signin-problem="">
              <Icon name="xCircle" />
              <span>{view.error}</span>
            </div>
          )}
          {view.on && view.url && <CopyAddress url={view.url} />}
          {view.allow.map((address) => (
            <AllowRow
              key={address}
              address={address}
              last={view.allow.length === 1}
              pinned={view.pinnedByEnvironment}
              onRemove={() => send('allow', { allow: view.allow.filter((entry) => entry !== address) })}
            />
          ))}
          {view.configured && !view.pinnedByEnvironment && <AddAddressRow current={view.allow} busy={busy} onAdd={(next) => setView(next)} onRefusal={setError} />}
          {view.accounts.map((account) => (
            <div className="ib-prow" key={account.email} data-signin-account={account.email}>
              <span className="ib-txt">
                <span className="ib-l">{account.name.trim() === '' ? account.email : account.name}</span>
                <span className="ib-desc">
                  {account.name.trim() === '' ? '' : `${account.email} · `}
                  {seen(account)}
                </span>
              </span>
              <span className="ib-ctl">
                <AskTwiceButton
                  onRemove={() => send('account/remove', { email: account.email })}
                  text="Remove"
                  label={`Remove ${account.email}`}
                  confirmText="Remove? Click again"
                  confirmLabel={`Remove ${account.email}: click again to remove`}
                />
              </span>
            </div>
          ))}
          {view.configured &&
            (addingAccount ? (
              <AddAccountRow
                minPasswordLength={view.minPasswordLength}
                onAdded={(next) => {
                  setView(next);
                  setAddingAccount(false);
                }}
                onRefusal={setError}
                onCancel={() => setAddingAccount(false)}
              />
            ) : (
              <div className="ib-prow">
                <span className="ib-txt">
                  <span className="ib-l">Accounts</span>
                  <span className="ib-desc">The switch closes the address and keeps the accounts. Remove deletes one and signs it out.</span>
                </span>
                <span className="ib-ctl">
                  <button type="button" className="ib-btn ib-ghost" onClick={() => setAddingAccount(true)} data-signin-add-open="" disabled={busy}>
                    Add an account
                  </button>
                </span>
              </div>
            ))}
          {error && (
            <div className="ib-callout ib-err ib-in-card" role="alert" data-signin-error="">
              <Icon name="xCircle" />
              <span>{error}</span>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
