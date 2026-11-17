/* Sign in / create account / forgot password */

const params = new URLSearchParams(window.location.search);
const redirectTo = params.get("next");
let mode = params.get("mode") === "signup" ? "signup" : "login";

const $ = (s) => document.querySelector(s);

const OAUTH_ERRORS = {
  not_configured: "That sign-in provider is not configured yet. Use email and password, or contact support.",
  email_exists:
    "An account already uses that email. Sign in with your password, then connect the provider from Account settings.",
  identity_in_use: "That social account is already linked to a different shop account.",
  suspended: "This account is suspended. Contact support and we'll help.",
  denied: "Sign-in was cancelled.",
  state: "That sign-in link expired or was tampered with. Please try again.",
  provider: "The sign-in provider could not complete the request. Please try again.",
  rate: "Too many attempts. Wait a minute and try again.",
};

function showOAuthMessage() {
  const code = params.get("oauth_error");
  const provider = (params.get("provider") || "Social").replace(/^\w/, (c) => c.toUpperCase());
  if (!code) return;
  const box = $("#authError");
  const text = OAUTH_ERRORS[code] || "That sign-in could not be completed. Please try again.";
  box.textContent = code === "email_exists" || code === "not_configured" ? text : `${provider}: ${text}`;
  box.hidden = false;
  box.classList.remove("ok");
}

function oauthHref(provider) {
  const next = redirectTo && redirectTo.startsWith("/") && !redirectTo.startsWith("//") ? redirectTo : "";
  return `/auth/${provider}/start${next ? `?next=${encodeURIComponent(next)}` : ""}`;
}

function setMode(next) {
  mode = next;
  const signup = mode === "signup";
  const forgot = mode === "forgot";

  $("#authTitle").textContent = signup
    ? "Create your account"
    : forgot
      ? "Reset your password"
      : "Welcome back";
  $("#authSub").textContent = signup
    ? "Pick a display name, then track orders, top up and get codes instantly."
    : forgot
      ? "Enter your email and we'll send a secure, single-use reset link."
      : "Sign in to see your orders, balance and codes.";

  $("#submitBtn").textContent = signup ? "Create account" : forgot ? "Send reset link" : "Sign in";
  $("#nameField").hidden = !signup;
  $("#nameHint").hidden = !signup;
  $("#name").required = signup;
  $("#password").closest(".field").hidden = forgot;
  $("#forgotRow").hidden = forgot;
  $("#password").autocomplete = signup ? "new-password" : "current-password";
  $("#password").placeholder = signup ? "At least 8 characters" : "Your password";
  $("#passwordHint").hidden = !signup;
  $("#altText").textContent = signup ? "Already have an account?" : "New here?";
  $("#altLink").textContent = signup ? "Login!" : "Create an account";
  $("#authError").hidden = true;
  $("#authError").classList.remove("ok");
  $("#suspendedNote").hidden = !params.get("suspended");
  showOAuthMessage();
  if (!forgot) setTimeout(() => (signup ? $("#name") : $("#email")).focus(), 60);
  setModeParam(signup ? "signup" : "login");
}

$("#altLink").addEventListener("click", (e) => {
  e.preventDefault();
  setMode(mode === "login" ? "signup" : "login");
});

$("#forgotLink").addEventListener("click", (e) => {
  e.preventDefault();
  setMode(mode === "forgot" ? "login" : "forgot");
});

$("#authForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const email = $("#email").value.trim();
  const password = $("#password").value;
  const name = $("#name").value.trim().replace(/\s+/g, " ");
  const errorBox = $("#authError");
  const button = $("#submitBtn");

  errorBox.hidden = true;
  errorBox.classList.remove("ok");
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) {
    errorBox.textContent = "Enter a valid email address.";
    errorBox.hidden = false;
    return;
  }
  if (mode === "signup") {
    if (!name) {
      errorBox.textContent = "Enter a display name.";
      errorBox.hidden = false;
      return;
    }
    if (name.length > 30) {
      errorBox.textContent = "Display names can be at most 30 characters.";
      errorBox.hidden = false;
      return;
    }
  }
  if (mode !== "forgot" && password.length < 8) {
    errorBox.textContent = "Password must be at least 8 characters.";
    errorBox.hidden = false;
    return;
  }

  const original = button.textContent;
  button.disabled = true;
  button.textContent = mode === "forgot" ? "Sending…" : "Please wait…";
  try {
    if (mode === "forgot") {
      const result = await api.post("/api/auth/forgot", { email });
      errorBox.textContent = result.message || "If an account exists, a reset link is on its way.";
      errorBox.classList.add("ok");
      errorBox.hidden = false;
      button.disabled = false;
      button.textContent = original;
      return;
    }

    const path = mode === "signup" ? "/api/auth/signup" : "/api/auth/login";
    const payload = mode === "signup" ? { email, password, name } : { email, password };
    const { user } = await api.post(path, payload);
    const fallback = user.role === "admin" ? "/admin.html" : "/dashboard.html";
    window.location.href = redirectTo && redirectTo.startsWith("/") ? redirectTo : fallback;
  } catch (error) {
    const code = error.payload && error.payload.code;
    if (code === "no_account") {
      // No account with that email: move the visitor to the create-account form,
      // keeping their email so they only have to pick a password.
      setMode("signup");
      $("#email").value = email;
      errorBox.textContent = `No account exists for ${email} yet. Create one below — it takes a few seconds.`;
      errorBox.classList.add("ok");
      errorBox.hidden = false;
      button.disabled = false;
      return;
    }
    if (code === "account_exists") {
      // They tried to sign up with an address that is already registered.
      setMode("login");
      $("#email").value = email;
      errorBox.textContent = "That email already has an account. Enter your password to sign in.";
      errorBox.classList.add("ok");
      errorBox.hidden = false;
      button.disabled = false;
      return;
    }
    errorBox.textContent = error.message;
    errorBox.hidden = false;
    button.disabled = false;
    button.textContent = original;
  }
});

/** Keep the address bar in step with the visible form so Back/Refresh behave. */
function setModeParam(next) {
  const url = new URL(window.location.href);
  if (next === "signup") url.searchParams.set("mode", "signup");
  else url.searchParams.delete("mode");
  window.history.replaceState(null, "", url);
}

(async function init() {
  loadSite().then((site) => {
    const contact = (site && site.contact) || {};
    const tgLink = contact.telegramLink || "https://t.me/t4m31";
    const handle = contact.telegramUsername || "@t4m31";
    const telegramCard = $("#telegramCard");
    if (telegramCard) {
      telegramCard.href = tgLink;
      $("#telegramHandle").textContent = handle;
    }
    const discordCard = $("#discordCard");
    if (discordCard) {
      if (contact.discordLink) {
        discordCard.href = contact.discordLink;
        discordCard.hidden = false;
        $("#discordHandle").textContent = "Join now";
      } else {
        discordCard.hidden = true;
      }
    }
    const fallback = $("#contactFallback");
    if (fallback) fallback.hidden = Boolean(contact.telegramLink || contact.discordLink);
    const auth = (site && site.auth) || {};
    const googleBtn = $("#googleLogin");
    const discordBtn = $("#discordLogin");
    if (googleBtn) {
      googleBtn.href = oauthHref("google");
      if (!auth.google) {
        googleBtn.classList.add("is-unconfigured");
        googleBtn.title = "Google sign-in is not configured yet";
      }
    }
    if (discordBtn) {
      discordBtn.href = oauthHref("discord");
      if (!auth.discord) {
        discordBtn.classList.add("is-unconfigured");
        discordBtn.title = "Discord sign-in is not configured yet";
      }
    }
    if (site && site.app && site.app.name) document.title = `Sign in — ${site.app.name}`;
  });

  try {
    const { user } = await api.get("/api/auth/me");
    if (user) {
      window.location.href =
        redirectTo && redirectTo.startsWith("/")
          ? redirectTo
          : user.role === "admin"
            ? "/admin.html"
            : "/dashboard.html";
      return;
    }
  } catch {
    /* not signed in */
  }
  setMode(mode);
})();
