/* Customer shell: auth guard, sidebar, notifications, sign out. */

async function setupCustomerShell(active, title) {
  const $ = (s) => document.querySelector(s);
  await loadSite();

  let user = null;
  try {
    const result = await api.get("/api/auth/me");
    user = result.user;
  } catch {
    user = null;
  }
  if (!user) {
    window.location.href = `/login.html?next=${encodeURIComponent(location.pathname)}`;
    return null;
  }
  if (user.role === "admin" && !new URLSearchParams(location.search).has("asCustomer")) {
    window.location.href = "/admin.html";
    return null;
  }

  const name = user.name || user.email.split("@")[0];
  document.querySelectorAll("[data-me-name]").forEach((el) => (el.textContent = name));
  document.querySelectorAll("[data-me-email]").forEach((el) => (el.textContent = user.email));
  document.querySelectorAll("[data-me-avatar]").forEach((el) => {
    el.innerHTML = avatarHTML(user, 34);
  });
  document.querySelectorAll("[data-me-avatar-lg]").forEach((el) => {
    el.innerHTML = avatarHTML(user, 52);
  });
  document.querySelectorAll("[data-wallet-balance]").forEach((el) => {
    const balance = (user.wallet && user.wallet.balance) || 0;
    el.textContent = fmtMoney(balance, (user.wallet && user.wallet.symbol) || (window.SITE.wallet && window.SITE.wallet.symbol));
  });

  const pageTitle = $("#topbarTitle");
  if (pageTitle && title) pageTitle.textContent = title;
  document.querySelectorAll(".side-link").forEach((link) => {
    if (link.dataset.nav === active) link.classList.add("active");
  });

  const side = $("#side");
  const scrim = $("#sideScrim");
  const toggle = $("#sideToggle");
  if (toggle) {
    toggle.addEventListener("click", () => {
      side.classList.add("open");
      scrim.classList.add("show");
    });
  }
  if (scrim) {
    scrim.addEventListener("click", () => {
      side.classList.remove("open");
      scrim.classList.remove("show");
    });
  }

  const signOutBtn = $("#signOutBtn");
  if (signOutBtn) signOutBtn.addEventListener("click", signOut);

  const badge = $("#notifBadge");
  if (badge) {
    badge.hidden = !user.notifications;
    badge.textContent = user.notifications > 9 ? "9+" : user.notifications;
  }

  wireNotifications();
  return user;
}

/* ------------------------- notification centre ------------------------- */
function wireNotifications() {
  const $ = (s) => document.querySelector(s);
  const bell = $("#notifBtn");
  const panel = $("#notifPanel");
  if (!bell || !panel) return;

  let loaded = false;
  async function load() {
    try {
      const { notifications, unread } = await api.get("/api/notifications");
      const list = $("#notifList");
      if (!list) return;
      if (!notifications.length) {
        list.innerHTML = `<div class="empty-state" style="padding:1.6rem"><span class="emoji">🔔</span><strong>You're all caught up</strong><p>Notifications about your balance and orders land here.</p></div>`;
      } else {
        list.innerHTML = notifications
          .map(
            (n) => `<div class="notif ${n.read ? "" : "unread"}">
              <span class="nicon">${notifIcon(n.type)}</span>
              <div>
                <strong>${esc(n.title)}</strong>
                ${n.body ? `<p>${esc(n.body)}</p>` : ""}
                <small>${timeAgo(n.createdAt)}</small>
              </div>
            </div>`
          )
          .join("");
      }
      const badge = $("#notifBadge");
      if (badge) {
        badge.hidden = !unread;
        badge.textContent = unread > 9 ? "9+" : unread;
      }
      const mark = $("#markRead");
      if (mark) mark.hidden = !unread;
      loaded = true;
    } catch (error) {
      console.error(error);
    }
  }

  bell.addEventListener("click", async (event) => {
    event.stopPropagation();
    panel.hidden = !panel.hidden;
    if (!panel.hidden && !loaded) await load();
    if (!panel.hidden) {
      // Refresh unread count quietly.
      load();
    }
  });

  document.addEventListener("click", (event) => {
    if (!panel.hidden && !panel.contains(event.target) && !bell.contains(event.target)) panel.hidden = true;
  });

  const mark = $("#markRead");
  if (mark) {
    mark.addEventListener("click", async () => {
      await api.post("/api/notifications/read", {});
      await load();
      toast("Notifications marked as read", "success");
    });
  }
}

function notifIcon(type) {
  if (type === "topup") return "↓";
  if (type === "withdrawal") return "↑";
  if (type === "message") return "✉";
  if (type === "security" || type === "account") return "🛡";
  return "•";
}
