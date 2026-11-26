/**
 * The sign-in page the auth door serves at `/login`.
 *
 * One small document, no bundle: it has to work before (and without) the
 * window's own assets, because a person who is not signed in never reaches
 * them. Its three parts are served by the door itself
 * (`AUTH_LOGIN_PATH`, `/auth.css`, `/auth.js`), so the page's CSP can name
 * `'self'` and nothing else.
 */

export const AUTH_CSP = [
  "default-src 'none'",
  "style-src 'self'",
  "script-src 'self'",
  "connect-src 'self'",
  "img-src 'self' data:",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
].join("; ");

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

export interface LoginPageOptions {
  /**
   * The Inbox this page belongs to, shown under the form: the name and the port this request arrived at,
   * e.g. `inbox.example.com` or `inbox.example.com:4255`. It is the address in the person's own address
   * bar, which is what the password works at.
   */
  address: string;
  /**
   * The address the passkeys belong to: `passkeyOrigin`, the name over https at the pinned port when one
   * is written down, and the bare name otherwise. The same address the door mints keys for, so the words
   * on the page and the origin a key comes back at cannot disagree.
   */
  passkeyAddress: string;
  /** Where to go after signing in: already through `safeNextPath`. */
  next: string;
  /** A line shown under the form on arrival (`?error=` in the URL, or a refused session). */
  error?: string | null;
}

/**
 * Passkeys at the door are managed on the door's own page, not in the Inbox's settings: a passkey is
 * another way through this door, and a person who is not signed in cannot reach the Inbox at all.
 */
export interface PasskeyPageOptions {
  /** The address the passkeys belong to (`passkeyOrigin`): the name at the pinned port, or with no port. */
  address: string;
  /** Where the page's own links go back to: already through `safeNextPath`. */
  next: string;
}

/**
 * Zosma AI's mark, the path zosma.ai draws in its own header, white on the brand
 * blue: this fork's door wears our logo, not Plannotator's (the owner, 2026-11-26).
 */
const ZOSMA_MARK_PATH =
  "M319.503,98.606l-27,180h106.207l12.426-75.715h239.363v40.577c-100.159,82.124-366.996,251.925-366.996,287.926v342l134.999,108h243l134.994-107.694v-352.094l-89.993-90h-171v90s117,0,117,0l45,45.788-.154,260.846-44.847,44.366h-225l-44.999-45v-260.212c25.314-28.22,319.28-227.784,348.107-256.396,27.198-26.996,52.714-189.005-24.724-203.393-44.384-8.246-386.383-9-386.383-9Z";

const ZOSMA_MARK_HTML = `<div class="auth-mark auth-mark-zosma" aria-hidden="true">
    <svg viewBox="275 90 530 900" height="22" width="13" fill="currentColor" focusable="false"><path d="${ZOSMA_MARK_PATH}"/></svg>
  </div>`;

const PASSKEY_ICON = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="9" cy="9" r="4"/><path d="M12 12l7 7"/><path d="M16 16l2-2"/></svg>';

export function loginPageHtml(options: LoginPageOptions): string {
  const error = options.error ? `<p class="auth-error" role="alert">${escapeHtml(options.error)}</p>` : `<p class="auth-error" role="alert" hidden></p>`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>Sign in · Zosma Inbox</title>
<link rel="stylesheet" href="/auth.css">
<script src="/auth.js" defer></script>
</head>
<body>
<main class="auth-card">
  ${ZOSMA_MARK_HTML}
  <h1>Sign in to Zosma Inbox</h1>
  <p class="auth-lede">This Inbox lives on <strong>${escapeHtml(options.address)}</strong>. Use the address it knows you by.</p>
  <form id="auth-form" method="post" action="/login" novalidate>
    <input type="hidden" name="next" value="${escapeHtml(options.next)}">
    <label for="email">E-mail</label>
    <input id="email" name="email" type="email" autocomplete="username" autocapitalize="none" spellcheck="false" required autofocus>
    <label for="password">Password</label>
    <input id="password" name="password" type="password" autocomplete="current-password" required>
    ${error}
    <button type="submit" id="auth-submit">Sign in</button>
  </form>
  <div class="auth-or"><span>or</span></div>
  <button type="button" id="auth-passkey" class="auth-alt">${PASSKEY_ICON}Sign in with a passkey</button>
  <p class="auth-foot" id="auth-passkey-note">Passkeys need <strong>${escapeHtml(options.passkeyAddress)}</strong>. The password works everywhere.</p>
  <p class="auth-error" id="auth-passkey-error" role="alert" hidden></p>
  <p class="auth-foot">Nobody else can open this Inbox. Your session lasts seven days, then asks again.</p>
  <noscript><p class="auth-error">This page needs JavaScript to sign in.</p></noscript>
</main>
</body>
</html>
`;
}

export function passkeyPageHtml(options: PasskeyPageOptions): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>Passkeys · Zosma Inbox</title>
<link rel="stylesheet" href="/auth.css">
<script src="/auth.js" defer></script>
<script src="/passkeys.js" defer></script>
</head>
<body>
<main class="auth-card auth-card-wide">
  ${ZOSMA_MARK_HTML}
  <h1>Passkeys for this Inbox</h1>
  <p class="auth-lede">A passkey signs you in to <strong>${escapeHtml(options.address)}</strong> with your fingerprint, your face or a security key, instead of your password.</p>
  <ul class="auth-list" id="passkey-list" aria-live="polite"></ul>
  <p class="auth-empty" id="passkey-empty" hidden>No passkeys yet. Add one from this device, then sign in with it next time.</p>
  <p class="auth-error" id="passkey-error" role="alert" hidden></p>
  <form id="passkey-add" class="auth-add">
    <label for="passkey-name">Name this passkey</label>
    <div class="auth-row">
      <input id="passkey-name" name="name" type="text" autocomplete="off" spellcheck="false" maxlength="64" placeholder="This laptop">
      <button type="submit" id="passkey-add-submit">Add a passkey</button>
    </div>
  </form>
  <p class="auth-foot">Losing the only passkey of an account with no password would lock it, so the door keeps the last one. Keep your password, or add a second passkey from another device.</p>
  <p class="auth-foot"><a id="passkey-back" href="${escapeHtml(options.next)}">Back to your Inbox</a></p>
</main>
</body>
</html>
`;
}

export const AUTH_CSS = `:root {
  color-scheme: dark light;
  --bg: oklch(0.15 0.02 260);
  --fg: oklch(0.90 0.01 260);
  --muted: oklch(0.72 0.02 260);
  --card: oklch(0.22 0.02 260);
  --border: oklch(0.35 0.02 260);
  --input: oklch(0.26 0.02 260);
  --primary: oklch(0.75 0.18 280);
  --primary-fg: oklch(0.15 0.02 260);
  --destructive: oklch(0.65 0.20 25);
  --radius: 0.625rem;
  --sans: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Inter, sans-serif;
}
@media (prefers-color-scheme: light) {
  :root {
    --bg: oklch(0.97 0.005 260);
    --fg: oklch(0.18 0.02 260);
    --muted: oklch(0.45 0.02 260);
    --card: oklch(1 0 0);
    --border: oklch(0.89 0.01 260);
    --input: oklch(0.96 0.005 260);
    --primary: oklch(0.55 0.18 280);
    --primary-fg: oklch(0.99 0 0);
    --destructive: oklch(0.55 0.20 25);
  }
}
* { box-sizing: border-box; }
body {
  margin: 0;
  min-height: 100dvh;
  display: grid;
  place-items: center;
  padding: 24px;
  background: radial-gradient(120% 120% at 50% 0%, color-mix(in oklch, var(--primary) 12%, var(--bg)) 0%, var(--bg) 55%);
  color: var(--fg);
  font-family: var(--sans);
  -webkit-font-smoothing: antialiased;
}
.auth-card {
  width: 100%;
  max-width: 380px;
  background: var(--card);
  border: 1px solid var(--border);
  border-radius: calc(var(--radius) * 1.6);
  padding: 28px 26px 22px;
  box-shadow: 0 24px 60px -30px oklch(0 0 0 / 0.55);
  animation: rise 220ms ease-out both;
}
@keyframes rise { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: none; } }
@media (prefers-reduced-motion: reduce) { .auth-card { animation: none; } }
.auth-mark {
  width: 36px; height: 36px;
  display: grid; place-items: center;
  border-radius: 10px;
  background: color-mix(in oklch, var(--primary) 18%, transparent);
  color: var(--primary);
  margin-bottom: 16px;
}
/* The brand tile: the Zosma mark keeps the brand blue and a white glyph in both themes. */
.auth-mark-zosma { background: #017cf3; color: #fff; }
h1 { font-size: 1.0625rem; line-height: 1.35; margin: 0 0 6px; letter-spacing: -0.01em; font-weight: 600; }
.auth-lede { margin: 0 0 20px; font-size: 0.8125rem; line-height: 1.5; color: var(--muted); }
.auth-lede strong { color: var(--fg); font-weight: 500; }
form { display: grid; gap: 8px; }
label { font-size: 0.75rem; font-weight: 500; color: var(--muted); }
input[type="email"], input[type="password"] {
  width: 100%;
  padding: 10px 12px;
  font: inherit;
  font-size: 0.875rem;
  color: var(--fg);
  background: var(--input);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  outline: none;
  transition: border-color 120ms, box-shadow 120ms;
}
input[type="email"]:focus-visible, input[type="password"]:focus-visible {
  border-color: var(--primary);
  box-shadow: 0 0 0 3px color-mix(in oklch, var(--primary) 25%, transparent);
}
button {
  margin-top: 10px;
  padding: 10px 14px;
  font: inherit;
  font-size: 0.875rem;
  font-weight: 550;
  color: var(--primary-fg);
  background: var(--primary);
  border: 0;
  border-radius: var(--radius);
  cursor: pointer;
  transition: filter 120ms, opacity 120ms;
}
button:hover:not(:disabled) { filter: brightness(1.06); }
button:focus-visible { outline: 2px solid var(--primary); outline-offset: 2px; }
button:disabled { opacity: 0.6; cursor: progress; }
.auth-error { margin: 4px 0 0; font-size: 0.8125rem; line-height: 1.45; color: var(--destructive); }
.auth-foot { margin: 18px 0 0; font-size: 0.6875rem; line-height: 1.5; color: var(--muted); }
.auth-foot a { color: var(--primary); text-decoration: none; }
.auth-foot a:hover { text-decoration: underline; }
.auth-or { display: flex; align-items: center; gap: 10px; margin: 16px 0 12px; color: var(--muted); font-size: 0.6875rem; text-transform: uppercase; letter-spacing: 0.08em; }
.auth-or::before, .auth-or::after { content: ""; flex: 1; height: 1px; background: var(--border); }
button.auth-alt {
  margin-top: 0;
  display: inline-flex; align-items: center; justify-content: center; gap: 8px;
  width: 100%;
  color: var(--fg);
  background: transparent;
  border: 1px solid var(--border);
}
button.auth-alt:hover:not(:disabled) { filter: none; background: var(--input); }
button.auth-alt svg { flex: none; opacity: 0.8; }
.auth-card-wide { max-width: 460px; }
.auth-list { list-style: none; margin: 16px 0 0; padding: 0; display: grid; gap: 8px; }
.auth-list li {
  display: flex; align-items: center; justify-content: space-between; gap: 12px;
  padding: 10px 12px;
  background: var(--input);
  border: 1px solid var(--border);
  border-radius: var(--radius);
}
.auth-list .auth-key-name { font-size: 0.875rem; }
.auth-list .auth-key-meta { display: block; margin-top: 2px; font-size: 0.6875rem; color: var(--muted); }
button.auth-remove {
  margin: 0; padding: 6px 10px;
  font-size: 0.75rem;
  color: var(--destructive);
  background: transparent;
  border: 1px solid color-mix(in oklch, var(--destructive) 45%, transparent);
}
button.auth-remove:hover:not(:disabled) { filter: none; background: color-mix(in oklch, var(--destructive) 12%, transparent); }
.auth-empty { margin: 16px 0 0; font-size: 0.8125rem; line-height: 1.5; color: var(--muted); }
.auth-add { margin-top: 16px; }
.auth-row { display: flex; gap: 8px; }
.auth-row input { flex: 1; min-width: 0; }
.auth-row button { margin-top: 0; white-space: nowrap; }
input[type="text"] {
  width: 100%;
  padding: 10px 12px;
  font: inherit;
  font-size: 0.875rem;
  color: var(--fg);
  background: var(--input);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  outline: none;
}
input[type="text"]:focus-visible { border-color: var(--primary); box-shadow: 0 0 0 3px color-mix(in oklch, var(--primary) 25%, transparent); }
`;

export const AUTH_JS = `(function () {
  // The door's own script. Nothing is bundled and nothing comes from a CDN — the page's CSP names
  // 'self' only — so the conversions a WebAuthn answer needs are written out here: base64url strings,
  // which better-auth speaks, and the ArrayBuffers a browser hands back.
  var door = {};

  function toBuffer(value) {
    var text = String(value).replace(/-/g, "+").replace(/_/g, "/");
    while (text.length % 4) text += "=";
    var raw = atob(text);
    var bytes = new Uint8Array(raw.length);
    for (var i = 0; i < raw.length; i += 1) bytes[i] = raw.charCodeAt(i);
    return bytes.buffer;
  }

  function toBase64url(buffer) {
    var bytes = new Uint8Array(buffer);
    var text = "";
    for (var i = 0; i < bytes.length; i += 1) text += String.fromCharCode(bytes[i]);
    return btoa(text).replace(/\\+/g, "-").replace(/\\//g, "_").replace(/=+$/, "");
  }

  function failure(body) {
    var code = body && (body.code || body.message);
    var error = new Error(code || "request_failed");
    error.name = code || "request_failed";
    return error;
  }

  function ask(path) {
    return fetch(path, { credentials: "same-origin" }).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (body) {
        if (!res.ok) throw failure(body);
        return body;
      });
    });
  }

  function post(path, body) {
    return fetch(path, {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (parsed) { return { res: res, body: parsed }; });
    });
  }

  function allowed(list) {
    if (!list || !list.length) return undefined;
    return list.map(function (entry) {
      return { type: entry.type || "public-key", id: toBuffer(entry.id), transports: entry.transports };
    });
  }

  function registration(credential) {
    var answer = credential.response;
    return {
      id: credential.id,
      rawId: toBase64url(credential.rawId),
      type: credential.type,
      authenticatorAttachment: credential.authenticatorAttachment || undefined,
      clientExtensionResults: credential.getClientExtensionResults ? credential.getClientExtensionResults() : {},
      response: {
        clientDataJSON: toBase64url(answer.clientDataJSON),
        attestationObject: toBase64url(answer.attestationObject),
        transports: answer.getTransports ? answer.getTransports() : undefined,
      },
    };
  }

  function assertion(credential) {
    var answer = credential.response;
    return {
      id: credential.id,
      rawId: toBase64url(credential.rawId),
      type: credential.type,
      authenticatorAttachment: credential.authenticatorAttachment || undefined,
      clientExtensionResults: credential.getClientExtensionResults ? credential.getClientExtensionResults() : {},
      response: {
        clientDataJSON: toBase64url(answer.clientDataJSON),
        authenticatorData: toBase64url(answer.authenticatorData),
        signature: toBase64url(answer.signature),
        userHandle: answer.userHandle ? toBase64url(answer.userHandle) : undefined,
      },
    };
  }

  /** A passkey sign-in: the options better-auth hands out, the browser's own prompt, the answer back. */
  door.signIn = function () {
    return ask("/api/auth/passkey/generate-authenticate-options")
      .then(function (options) {
        return navigator.credentials.get({
          publicKey: {
            challenge: toBuffer(options.challenge),
            rpId: options.rpId,
            timeout: options.timeout,
            userVerification: options.userVerification,
            allowCredentials: allowed(options.allowCredentials),
          },
        });
      })
      .then(function (credential) {
        return post("/api/auth/passkey/verify-authentication", { response: assertion(credential) });
      });
  };

  /** A new passkey for the session's own account: the same three steps, in the other direction. */
  door.add = function (name) {
    return ask("/api/auth/passkey/generate-register-options")
      .then(function (options) {
        return navigator.credentials.create({
          publicKey: {
            challenge: toBuffer(options.challenge),
            rp: options.rp,
            user: { id: toBuffer(options.user.id), name: options.user.name, displayName: options.user.displayName || options.user.name },
            pubKeyCredParams: options.pubKeyCredParams,
            timeout: options.timeout,
            attestation: options.attestation,
            authenticatorSelection: options.authenticatorSelection,
            excludeCredentials: allowed(options.excludeCredentials),
            extensions: options.extensions,
          },
        });
      })
      .then(function (credential) {
        return post("/api/auth/passkey/verify-registration", { response: registration(credential), name: name });
      });
  };

  door.list = function () {
    return ask("/api/inbox/auth/passkeys");
  };

  door.remove = function (id) {
    return post("/api/inbox/auth/passkeys/remove", { id: id });
  };

  /** Whether this origin can run a passkey ceremony at all: WebAuthn is secure-context only, so on a
   *  plain http address navigator.credentials is not there and the button would throw instead. */
  function noWebauthn() {
    return window.isSecureContext === false || !navigator.credentials;
  }

  function passkeyNeedsHttps() {
    return "Passkeys need https://" + location.hostname + ". The password works everywhere.";
  }

  /** What to tell the person when a ceremony does not finish. */
  door.explain = function (error) {
    var name = (error && (error.name || error.message)) || "";
    if (name === "NotAllowedError") return "No passkey was used. Try again, or sign in with your password.";
    if (name === "InvalidStateError") return "This device already holds a passkey for this Inbox.";
    if (name === "SecurityError") return "This browser will not use passkeys on this address.";
    if (name === "UNAUTHORIZED" || name === "AUTHENTICATION_FAILED") return "That passkey was not accepted here.";
    if (name === "SESSION_NOT_FRESH") return "Sign in again, then add your passkey.";
    if (name === "not_here" || name === "last_way_in") return String(error.message || "That passkey cannot be removed.");
    // A TypeError here is usually a browser without WebAuthn, not a broken connection: the ceremony
    // never started, so there is nothing to retry.
    if (name === "TypeError" && noWebauthn()) return passkeyNeedsHttps();
    if (name === "request_failed" || name === "TypeError") return "Could not reach the Inbox. Check your connection and try again.";
    return "Something went wrong: " + (name || "unknown error") + ".";
  };

  window.PlannotatorDoor = door;

  // The sign-in page: the password form, and the passkey button beside it. A passkey is offered
  // beside the password rather than instead of it — an account with no passkey, on a device that
  // cannot make one, still signs in.
  var form = document.getElementById("auth-form");
  var passkeyButton = document.getElementById("auth-passkey");
  var passkeyError = document.getElementById("auth-passkey-error");
  var next = document.querySelector('input[name="next"]');
  var target = function () { return next && next.value ? next.value : "/"; };

  if (passkeyButton) {
    passkeyButton.addEventListener("click", function () {
      // Nothing to ask for on an address that cannot run a passkey: say why instead of throwing.
      if (noWebauthn()) {
        if (passkeyError) { passkeyError.textContent = passkeyNeedsHttps(); passkeyError.hidden = false; }
        return;
      }
      passkeyButton.disabled = true;
      if (passkeyError) { passkeyError.textContent = ""; passkeyError.hidden = true; }
      door.signIn()
        .then(function (answer) {
          if (answer && answer.res && answer.res.ok) { location.replace(target()); return; }
          var code = answer && answer.body ? answer.body.code || answer.body.message : "";
          if (passkeyError) {
            passkeyError.textContent = code === "UNAUTHORIZED" || code === "AUTHENTICATION_FAILED" ? "That passkey was not accepted here." : "Could not sign in with a passkey. Try again, or use your password.";
            passkeyError.hidden = false;
          }
          passkeyButton.disabled = false;
        })
        .catch(function (error) {
          if (passkeyError) { passkeyError.textContent = door.explain(error); passkeyError.hidden = false; }
          passkeyButton.disabled = false;
        });
    });
  }

  if (!form) return;
  var email = document.getElementById("email");
  var password = document.getElementById("password");
  var submit = document.getElementById("auth-submit");
  var line = form.querySelector(".auth-error");
  var label = submit ? submit.textContent : "Sign in";

  function show(message) {
    if (!line) return;
    line.textContent = message;
    line.hidden = !message;
  }

  form.addEventListener("submit", function (event) {
    event.preventDefault();
    show("");
    if (!email.value.trim() || !password.value) {
      show("Enter your e-mail and password.");
      return;
    }
    if (submit) { submit.disabled = true; submit.textContent = "Signing in…"; }
    post("/api/auth/sign-in/email", { email: email.value.trim(), password: password.value })
      .then(function (answer) {
        if (answer.res.ok) {
          location.replace(target());
          return;
        }
        var code = answer.body && (answer.body.code || answer.body.message);
        var tooMany = answer.res.status === 429 || code === "TOO_MANY_REQUESTS" || code === "RATE_LIMITED";
        show(code === "INVALID_EMAIL_OR_PASSWORD" ? "That e-mail and password do not match." : tooMany ? "Too many tries. Wait a few minutes, then try again." : code === "EMAIL_NOT_VERIFIED" ? "That e-mail is not verified yet. Ask the Inbox's owner to verify it." : "Could not sign in. Try again in a moment.");
        if (submit) { submit.disabled = false; submit.textContent = label; }
        password.value = "";
        password.focus();
      })
      .catch(function () {
        show("Could not reach the Inbox. Check your connection and try again.");
        if (submit) { submit.disabled = false; submit.textContent = label; }
      });
  });
})();
`;

export const PASSKEY_JS = `(function () {
  // The passkeys page: what this account holds, adding one from this device, removing one. Every call
  // goes to the door's own endpoints, which answer for the session's account and nobody else's.
  var door = window.PlannotatorDoor;
  if (!door) return;
  var list = document.getElementById("passkey-list");
  var empty = document.getElementById("passkey-empty");
  var line = document.getElementById("passkey-error");
  var form = document.getElementById("passkey-add");
  var name = document.getElementById("passkey-name");
  var addButton = document.getElementById("passkey-add-submit");

  function show(message) {
    if (!line) return;
    line.textContent = message;
    line.hidden = !message;
  }

  function meta(key) {
    var parts = [];
    var when = key.createdAt ? new Date(key.createdAt) : null;
    if (when && !isNaN(when.getTime())) parts.push("added " + when.toLocaleDateString());
    parts.push(key.backedUp ? "synced across your devices" : "on this device");
    return parts.join(" · ");
  }

  function row(key) {
    var item = document.createElement("li");
    var box = document.createElement("div");
    var label = document.createElement("span");
    label.className = "auth-key-name";
    label.textContent = key.name || "Passkey";
    var sub = document.createElement("span");
    sub.className = "auth-key-meta";
    sub.textContent = meta(key);
    box.appendChild(label);
    box.appendChild(sub);
    var remove = document.createElement("button");
    remove.type = "button";
    remove.className = "auth-remove";
    remove.textContent = "Remove";
    remove.addEventListener("click", function () {
      remove.disabled = true;
      show("");
      door.remove(key.id)
        .then(function (answer) {
          if (answer && answer.res && answer.res.ok) { load(); return; }
          show(answer && answer.body && answer.body.error ? answer.body.error : "Could not remove that passkey.");
          remove.disabled = false;
        })
        .catch(function (error) { show(door.explain(error)); remove.disabled = false; });
    });
    item.appendChild(box);
    item.appendChild(remove);
    return item;
  }

  function load() {
    door.list()
      .then(function (body) {
        var keys = (body && body.passkeys) || [];
        if (list) {
          list.textContent = "";
          keys.forEach(function (key) { list.appendChild(row(key)); });
        }
        if (empty) empty.hidden = keys.length > 0;
      })
      .catch(function (error) { show(door.explain(error)); });
  }

  if (form) {
    form.addEventListener("submit", function (event) {
      event.preventDefault();
      show("");
      if (addButton) addButton.disabled = true;
      door.add(name && name.value.trim() ? name.value.trim() : undefined)
        .then(function (answer) {
          if (answer && answer.res && answer.res.ok) {
            if (name) name.value = "";
            load();
          } else {
            var failed = (answer && answer.body) || {};
            // The plugin's own refusal, which has an answer: sign in again and the ceremony works.
            if (failed.code === "SESSION_NOT_FRESH") show(door.explain({ name: failed.code }));
            else show(failed.error || "Could not add that passkey.");
          }
          if (addButton) addButton.disabled = false;
        })
        .catch(function (error) {
          show(door.explain(error));
          if (addButton) addButton.disabled = false;
        });
    });
  }

  load();
})();
`;
