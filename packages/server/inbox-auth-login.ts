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
  /** The Inbox this page belongs to, shown under the form. */
  host: string;
  /** Where to go after signing in: already through `safeNextPath`. */
  next: string;
  /** A line shown under the form on arrival (`?error=` in the URL, or a refused session). */
  error?: string | null;
}

export function loginPageHtml(options: LoginPageOptions): string {
  const error = options.error ? `<p class="auth-error" role="alert">${escapeHtml(options.error)}</p>` : `<p class="auth-error" role="alert" hidden></p>`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>Sign in · Plannotator</title>
<link rel="stylesheet" href="/auth.css">
<script src="/auth.js" defer></script>
</head>
<body>
<main class="auth-card">
  <div class="auth-mark" aria-hidden="true">
    <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H18a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H9l-5 4z"/><path d="M8.5 8.5h7"/><path d="M8.5 12h4.5"/></svg>
  </div>
  <h1>Sign in to your Inbox</h1>
  <p class="auth-lede">This Inbox lives on <strong>${escapeHtml(options.host)}</strong>. Use the address it knows you by.</p>
  <form id="auth-form" method="post" action="/login" novalidate>
    <input type="hidden" name="next" value="${escapeHtml(options.next)}">
    <label for="email">E-mail</label>
    <input id="email" name="email" type="email" autocomplete="username" autocapitalize="none" spellcheck="false" required autofocus>
    <label for="password">Password</label>
    <input id="password" name="password" type="password" autocomplete="current-password" required>
    ${error}
    <button type="submit" id="auth-submit">Sign in</button>
  </form>
  <p class="auth-foot">Nobody else can open this Inbox. Your session lasts seven days, then asks again.</p>
  <noscript><p class="auth-error">This page needs JavaScript to sign in.</p></noscript>
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
`;

export const AUTH_JS = `(function () {
  var form = document.getElementById("auth-form");
  if (!form) return;
  var email = document.getElementById("email");
  var password = document.getElementById("password");
  var next = form.querySelector('input[name="next"]');
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
    fetch("/api/auth/sign-in/email", {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: email.value.trim(), password: password.value }),
    })
      .then(function (res) {
        return res.json().catch(function () { return {}; }).then(function (body) { return { res: res, body: body }; });
      })
      .then(function (answer) {
        if (answer.res.ok) {
          location.replace(next && next.value ? next.value : "/");
          return;
        }
        var code = answer.body && (answer.body.code || answer.body.message);
        show(code === "INVALID_EMAIL_OR_PASSWORD" ? "That e-mail and password do not match." : code === "EMAIL_NOT_VERIFIED" ? "That e-mail is not verified yet. Ask the Inbox's owner to verify it." : "Could not sign in. Try again in a moment.");
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
