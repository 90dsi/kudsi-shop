/* Customer account page: profile, avatars, connections, security, Discord */

const $ = (s) => document.querySelector(s);
let me = null;
let security = null;
let selectedAvatarFile = null;
let previewUrl = null;

const PROVIDER_LABEL = { password: "Password", google: "Google", discord: "Discord" };
const OAUTH_ERRORS = {
  not_configured: "That sign-in provider is not configured yet.",
  identity_in_use: "That social account is already linked to a different shop account.",
  email_exists: "An account already uses that email. Sign in with your password first.",
  state: "That link expired or was tampered with. Please try again.",
  provider: "The provider could not complete the request. Please try again.",
  denied: "The connection was cancelled.",
  rate: "Too many attempts. Wait a minute and try again.",
};

function displayName(user) {
  return (user && user.name) || "Customer";
}

function formatWhen(value) {
  if (!value) return "—";
  const date = new Date(value.includes("T") ? value : value.replace(" ", "T") + "Z");
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function orderRow(order) {
  const thumbs = order.items
    .map(
      (i) =>
        `<span class="mini-product">${
          i.image ? `<img src="${esc(i.image)}" alt="" />` : esc(i.emoji || "🎁")
        } ${esc(
          (i.name + (i.variant ? ` · ${i.variant}` : "")).length > 26
            ? (i.name + (i.variant ? ` · ${i.variant}` : "")).slice(0, 26) + "…"
            : i.name + (i.variant ? ` · ${i.variant}` : "")
        )} ×${i.qty}</span>`
    )
    .join("");
  return `
    <a class="order-card" href="/order.html?id=${encodeURIComponent(order.id)}" style="display:block">
      <div class="order-top">
        <div class="order-meta">
          <strong style="color: var(--text); font-size: 0.95rem">${esc(order.id)}</strong>
          <span>${today(order.createdAt)} · ${order.items.reduce((n, i) => n + i.qty, 0)} item(s)${
            order.codes && order.codes.length ? ` · ${order.codes.length} code(s) ready` : ""
          }</span>
        </div>
        <div style="display:flex; align-items:center; gap:0.8rem">
          <span class="pill pill-${esc(order.status)}">${esc(order.status)}</span>
          <strong>${money(order.total)}</strong>
        </div>
      </div>
      <div class="mini-products" style="margin-top: 0.7rem">${thumbs}</div>
    </a>`;
}

function renderProfile() {
  $("#avatarSlot").innerHTML = avatarHTML(me, 62);
  $("#avatarPreview").innerHTML = avatarHTML(me, 74);
  $("#profileName").textContent = displayName(me);
  $("#profileEmail").textContent = me.syntheticEmail
    ? `${PROVIDER_LABEL[me.googleConnected ? "google" : "discord"] || "Social"} account`
    : me.email;
  $("#profileRole").textContent = me.role;
  $("#profileRole").className = `pill pill-${me.role}`;
  $("#adminLink").hidden = me.role !== "admin";
  $("#removeAvatar").disabled = !me.hasCustomAvatar;
  $("#removeAvatar").title = me.hasCustomAvatar ? "" : "You do not have a custom photo saved.";
}

async function loadProfile() {
  const { user } = await api.get("/api/auth/me");
  if (!user) {
    window.location.href = "/login.html?next=/account.html";
    return false;
  }
  me = user;
  renderProfile();
  $("#nameInput").value = user.name || "";
  const contact = user.contact || {};
  $("#contactTypeInput").value = contact.type === "discord" ? "discord" : "telegram";
  $("#contactInput").value = contact.handle || "";
  const badge = $("#msgBadge");
  badge.textContent = user.unreadMessages || 0;
  badge.hidden = !user.unreadMessages;
  return true;
}

async function loadOrders() {
  const { orders } = await api.get("/api/orders");
  const box = $("#ordersList");
  if (!orders.length) {
    box.innerHTML = `<p class="empty-row">No orders yet. <a href="/" style="color: var(--accent-2)">Browse the store →</a></p>`;
    return;
  }
  box.innerHTML = orders.map(orderRow).join("");
}

/* ------------------------------------------------------------ connections */
function connectionCard(provider, data) {
  const connected = Boolean(data.connected);
  const label = PROVIDER_LABEL[provider];
  if (provider === "password") {
    return `
      <div class="connected-card">
        <div class="connected-head">
          <span class="provider-fallback" aria-hidden="true">✉</span>
          <div class="connected-title">
            <strong>Email &amp; password</strong>
            <span>${connected ? "Connected" : "Not set"}</span>
          </div>
          <span class="social-badge ${connected ? "ok" : "off"}">${connected ? "On" : "Off"}</span>
        </div>
        <div class="detail">${esc(me.syntheticEmail ? "No email is stored from your provider." : me.email)}</div>
        <div class="actions">
          <span class="small muted">${
            connected
              ? "Use the password form below to change it."
              : "Set a password below if you want another way to sign in."
          }</span>
        </div>
      </div>`;
  }

  const detail = connected
    ? provider === "google"
      ? esc(data.email || data.name || "Connected Google account")
      : esc(data.globalName || data.username ? `@${data.username || data.globalName}` : "Connected Discord account")
    : "Not connected yet.";
  const disconnectDisabled = !security || !security.connections.canDisconnect;
  const avatar = connected && data.avatar
    ? `<img class="provider-avatar" src="${esc(data.avatar)}" alt="" referrerpolicy="no-referrer" loading="lazy" onerror="this.remove()" />`
    : "";
  return `
    <div class="connected-card">
      <div class="connected-head">
        ${providerIcon(provider)}
        <div class="connected-title">
          <strong>${esc(label)}</strong>
          <span>${connected ? "Connected" : "Not connected"}</span>
        </div>
        <span class="social-badge ${connected ? "ok" : "off"}">${connected ? "On" : "Off"}</span>
      </div>
      <div style="display:flex;align-items:center;gap:0.55rem;min-width:0">
        ${avatar}
        <div class="detail" style="flex:1">${detail}</div>
      </div>
      <div class="actions">
        ${
          connected
            ? `<button class="btn btn-ghost btn-sm" type="button" data-disconnect="${provider}"
                 ${disconnectDisabled ? "disabled" : ""}
                 title="${disconnectDisabled ? "Connect another sign-in method first" : ""}">Disconnect</button>`
            : `<button class="btn btn-primary btn-sm" type="button" data-connect="${provider}">Connect</button>`
        }
      </div>
    </div>`;
}

function renderConnections(data) {
  $("#connectionCount").textContent =
    `${data.methodCount} sign-in method${data.methodCount === 1 ? "" : "s"}`;
  $("#connectedGrid").innerHTML =
    connectionCard("password", data.password) +
    connectionCard("google", data.google) +
    connectionCard("discord", data.discord);

  const note = $("#connectionNote");
  if (!data.canDisconnect) {
    note.className = "inline-note warn";
    note.textContent =
      "You only have one sign-in method. Connect Google or Discord before disconnecting anything.";
    note.hidden = false;
  } else if (data.discord.verified) {
    note.className = "inline-note ok";
    note.textContent = "Your Discord account is verified on the official server.";
    note.hidden = false;
  } else {
    note.hidden = true;
  }
}

/* -------------------------------------------------------------- security */
function renderPassword(connections) {
  const hasPassword = connections.password.connected;
  $("#currentPasswordField").hidden = !hasPassword;
  $("#newPasswordLabel").textContent = hasPassword ? "New password" : "Create a password";
  $("#savePassword").textContent = hasPassword ? "Update password" : "Set password";
  $("#passwordState").textContent = hasPassword
    ? "You can sign in with your email and password."
    : "You sign in with a social account. Adding a password is optional.";
}

function renderSessions(sessions) {
  const box = $("#sessionList");
  if (!sessions.length) {
    box.innerHTML = `<p class="empty-mini">No active sessions were found.</p>`;
    return;
  }
  box.innerHTML = sessions
    .map(
      (session) => `
      <div class="session-row ${session.current ? "current" : ""}">
        <span class="social-badge ${session.current ? "ok" : "off"}">${
          session.current ? "This browser" : esc(PROVIDER_LABEL[session.provider] || session.provider)
        }</span>
        <div class="meta">
          <strong>${esc(session.device)}</strong>
          <span>${esc(session.ip)} · started ${esc(formatWhen(session.createdAt))}</span>
        </div>
        <span class="when">${session.current ? "active now" : timeAgo(session.lastSeenAt || session.createdAt)}</span>
      </div>`
    )
    .join("");
}

function renderActivity(activity) {
  const box = $("#activityList");
  if (!activity.length) {
    box.innerHTML = `<p class="empty-mini">No sign-in history yet.</p>`;
    return;
  }
  box.innerHTML = activity
    .map((event) => {
      const ok = event.status === "success";
      const badgeClass = ok ? "ok" : event.status === "blocked" ? "warn" : "bad";
      return `
        <div class="activity-row">
          <span class="social-badge ${badgeClass}">${esc(event.status)}</span>
          <div class="meta">
            <strong>${esc(PROVIDER_LABEL[event.provider] || event.provider)} · ${esc(event.device)}</strong>
            <span>${esc(event.ip)} · ${esc(formatWhen(event.createdAt))}</span>
          </div>
        </div>`;
    })
    .join("");
}

async function loadSecurity() {
  security = await api.get("/api/account/security");
  renderConnections(security.connections);
  renderPassword(security.connections);
  renderSessions(security.sessions);
  renderActivity(security.activity);
}

/* ------------------------------------------------------- discord verification */
function renderDiscord(info) {
  const badge = $("#discordBadge");
  const box = $("#discordVerifyBody");
  if (!info.connected) {
    badge.className = "social-badge off";
    badge.textContent = "Not connected";
    box.innerHTML = `
      <div class="verify-box">
        <span class="provider-mark">${providerIcon("discord")}</span>
        <div class="verify-text">
          <strong>Connect Discord first</strong>
          <span>Link your Discord account, then come back to verify and get your role.</span>
        </div>
        <div class="verify-actions">
          <button class="btn btn-primary btn-sm" type="button" data-connect="discord">Connect Discord</button>
        </div>
      </div>`;
    return;
  }
  if (info.verified) {
    badge.className = "social-badge ok";
    badge.textContent = "Verified";
    box.innerHTML = `
      <div class="verify-box">
        ${providerIcon("discord")}
        <div class="verify-text">
          <strong>You are verified${info.username ? ` as @${esc(info.username)}` : ""}</strong>
          <span>Role added ${esc(formatWhen(info.verifiedAt))}. Verification is idempotent, so checking again is safe.</span>
        </div>
        <div class="verify-actions">
          <button class="btn btn-ghost btn-sm" type="button" data-verify="discord">Check again</button>
        </div>
      </div>`;
    return;
  }
  if (!info.configured) {
    badge.className = "social-badge warn";
    badge.textContent = "Setup needed";
    box.innerHTML = `
      <div class="verify-box">
        ${providerIcon("discord")}
        <div class="verify-text">
          <strong>Discord verification is not configured yet</strong>
          <span>The shop owner needs to add the bot token, server ID and verified role ID on the server.</span>
        </div>
      </div>`;
    return;
  }
  badge.className = "social-badge off";
  badge.textContent = "Not verified";
  box.innerHTML = `
    <div class="verify-box">
      ${providerIcon("discord")}
      <div class="verify-text">
        <strong>Join the official server, then verify</strong>
        <span>${
          info.lastCheckStatus === "not_member"
            ? "We could not find you on the server yet. Join it first."
            : "We check the server membership with the shop bot before assigning the role."
        }</span>
      </div>
      <div class="verify-actions">
        ${
          info.joinUrl
            ? `<a class="btn btn-ghost btn-sm" href="${esc(info.joinUrl)}" target="_blank" rel="noopener">Join server</a>`
            : ""
        }
        <button class="btn btn-primary btn-sm" type="button" data-verify="discord">Verify Discord &amp; get role</button>
      </div>
    </div>`;
}

async function loadDiscord() {
  const info = await api.get("/api/account/discord/verification");
  renderDiscord(info);
}

/* ------------------------------------------------------------------ actions */
$("#profileForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const status = $("#profileStatus");
  const button = $("#saveProfile");
  button.disabled = true;
  status.textContent = "Saving…";
  try {
    const name = $("#nameInput").value.trim();
    if (!name) throw new Error("Enter a display name.");
    if (name.length > 30) throw new Error("Display names can be at most 30 characters.");
    const { user } = await api.patch("/api/me", {
      name,
      contactType: $("#contactTypeInput").value,
      contact: $("#contactInput").value.trim(),
    });
    me = { ...me, ...user };
    renderProfile();
    status.textContent = "Saved ✓";
    toast("Profile saved", "success");
  } catch (error) {
    status.textContent = error.message;
  }
  button.disabled = false;
  setTimeout(() => (status.textContent = ""), 3500);
});

$("#avatarInput").addEventListener("change", (event) => {
  const file = event.target.files[0];
  const status = $("#profileStatus");
  selectedAvatarFile = null;
  if (previewUrl) {
    URL.revokeObjectURL(previewUrl);
    previewUrl = null;
  }
  if (!file) {
    $("#uploadAvatar").disabled = true;
    return;
  }
  const allowed = ["image/jpeg", "image/jpg", "image/png", "image/webp"];
  if (!allowed.includes(file.type)) {
    status.textContent = "Choose a JPG, PNG or WebP image.";
    event.target.value = "";
    $("#uploadAvatar").disabled = true;
    return;
  }
  if (file.size > 2 * 1024 * 1024) {
    status.textContent = "That photo is larger than 2 MB.";
    event.target.value = "";
    $("#uploadAvatar").disabled = true;
    return;
  }
  selectedAvatarFile = file;
  previewUrl = URL.createObjectURL(file);
  $("#avatarPreview").innerHTML = `<img src="${previewUrl}" alt="Photo preview" style="width:100%;height:100%;object-fit:cover" />`;
  $("#uploadAvatar").disabled = false;
  status.textContent = "Preview ready. Save the photo when it looks right.";
});

$("#uploadAvatar").addEventListener("click", async () => {
  if (!selectedAvatarFile) return;
  const status = $("#profileStatus");
  const button = $("#uploadAvatar");
  button.disabled = true;
  status.textContent = "Uploading photo…";
  try {
    const form = new FormData();
    form.append("avatar", selectedAvatarFile);
    const { user } = await api.upload("/api/me/avatar", form);
    me = { ...me, ...user };
    renderProfile();
    selectedAvatarFile = null;
    $("#avatarInput").value = "";
    if (previewUrl) {
      URL.revokeObjectURL(previewUrl);
      previewUrl = null;
    }
    status.textContent = "Photo updated ✓";
    toast("Profile photo updated", "success");
  } catch (error) {
    status.textContent = error.message;
    button.disabled = false;
  }
});

$("#removeAvatar").addEventListener("click", async () => {
  if (!me || !me.hasCustomAvatar) return;
  if (!window.confirm("Remove your custom photo and use your social picture or your initial?")) return;
  const status = $("#profileStatus");
  try {
    const { user } = await api.del("/api/me/avatar");
    me = { ...me, ...user };
    renderProfile();
    status.textContent = "Photo removed ✓";
    toast("Custom photo removed", "success");
  } catch (error) {
    status.textContent = error.message;
  }
});

$("#connectedGrid").addEventListener("click", async (event) => {
  const connect = event.target.closest("[data-connect]");
  if (connect) {
    window.location.href = `/auth/${connect.dataset.connect}/start?mode=link&next=/account.html`;
    return;
  }
  const disconnect = event.target.closest("[data-disconnect]");
  if (!disconnect) return;
  const provider = disconnect.dataset.disconnect;
  if (disconnect.disabled) return;
  if (!window.confirm(`Disconnect ${PROVIDER_LABEL[provider]} from this shop account?`)) return;
  disconnect.disabled = true;
  try {
    await api.post(`/api/account/connections/${provider}/disconnect`, {});
    toast(`${PROVIDER_LABEL[provider]} disconnected`, "success");
    await loadProfile();
    await Promise.all([loadSecurity(), loadDiscord()]);
  } catch (error) {
    toast(error.message, "error");
    disconnect.disabled = false;
  }
});

$("#passwordForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const status = $("#passwordStatus");
  const button = $("#savePassword");
  const currentPassword = $("#currentPassword").value;
  const newPassword = $("#newPassword").value;
  status.textContent = "";
  if (newPassword.length < 8) {
    status.textContent = "Use at least 8 characters.";
    return;
  }
  button.disabled = true;
  status.textContent = "Updating…";
  try {
    await api.post("/api/account/password", { currentPassword, newPassword });
    $("#currentPassword").value = "";
    $("#newPassword").value = "";
    status.textContent = "Password updated ✓";
    toast("Password updated", "success", "Other sessions were signed out.");
    await loadSecurity();
  } catch (error) {
    status.textContent = error.message;
  }
  button.disabled = false;
  setTimeout(() => (status.textContent = ""), 4000);
});

$("#revokeOthers").addEventListener("click", async () => {
  const status = $("#sessionStatus");
  if (!window.confirm("Sign out every other browser signed in to this account?")) return;
  $("#revokeOthers").disabled = true;
  status.textContent = "Signing out…";
  try {
    const result = await api.post("/api/account/sessions/revoke-others", {});
    renderSessions(result.sessions || []);
    status.textContent = `${result.revoked} other session${result.revoked === 1 ? "" : "s"} signed out.`;
    toast("Other sessions signed out", "success");
  } catch (error) {
    status.textContent = error.message;
  }
  $("#revokeOthers").disabled = false;
});

$("#discordVerifyBody").addEventListener("click", async (event) => {
  const connect = event.target.closest("[data-connect]");
  if (connect) {
    window.location.href = `/auth/${connect.dataset.connect}/start?mode=link&next=/account.html`;
    return;
  }
  const button = event.target.closest("[data-verify]");
  if (!button) return;
  const original = button.textContent;
  button.disabled = true;
  button.textContent = "Checking Discord…";
  try {
    await api.post("/api/account/discord/verify", {});
    toast("Discord verified", "success", "Your role was added on the server.");
    await Promise.all([loadDiscord(), loadSecurity()]);
  } catch (error) {
    toast(error.message, "error");
    button.disabled = false;
    button.textContent = original;
    if (error.payload && error.payload.code === "not_member") await loadDiscord();
  }
});

$("#signOutBtn").addEventListener("click", signOut);

/* --------------------------------------------------------------------- boot */
(async function init() {
  try {
    const ready = await loadProfile();
    if (!ready) return;
    const params = new URLSearchParams(window.location.search);
    const linked = params.get("linked");
    if (linked && PROVIDER_LABEL[linked]) {
      toast(`${PROVIDER_LABEL[linked]} connected`, "success");
    }
    const oauthError = params.get("oauth_error");
    if (oauthError) {
      const note = $("#connectionNote");
      note.className = "inline-note warn";
      note.textContent =
        OAUTH_ERRORS[oauthError] ||
        "That connection could not be completed. Please try again.";
      note.hidden = false;
    }
    await Promise.all([loadSecurity(), loadDiscord(), loadOrders()]);
  } catch (error) {
    $("#ordersList").innerHTML = `<p class="empty-row">${esc(error.message)}</p>`;
  }
})();
