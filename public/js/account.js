/* Customer account page */

const $ = (s) => document.querySelector(s);
let me = null;

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

async function loadProfile() {
  const { user } = await api.get("/api/auth/me");
  if (!user) {
    window.location.href = "/login.html?next=/account.html";
    return;
  }
  me = user;

  $("#avatarSlot").innerHTML = avatarHTML(user, 62);
  $("#profileName").textContent = user.name || user.email.split("@")[0];
  $("#profileEmail").textContent = user.email;
  $("#profileRole").textContent = user.role;
  $("#profileRole").className = `pill pill-${user.role}`;
  $("#nameInput").value = user.name || "";
  $("#adminLink").hidden = user.role !== "admin";
  const contact = user.contact || {};
  $("#contactTypeInput").value = contact.type === "discord" ? "discord" : "telegram";
  $("#contactInput").value = contact.handle || "";
  const badge = $("#msgBadge");
  badge.textContent = user.unreadMessages || 0;
  badge.hidden = !user.unreadMessages;
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

$("#profileForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const status = $("#profileStatus");
  const button = $("#saveProfile");
  button.disabled = true;
  status.textContent = "Saving…";
  try {
    const { user } = await api.patch("/api/me", {
      name: $("#nameInput").value.trim(),
      contactType: $("#contactTypeInput").value,
      contact: $("#contactInput").value.trim(),
    });
    me = user;
    $("#profileName").textContent = user.name || user.email.split("@")[0];
    status.textContent = "Saved ✓";
  } catch (error) {
    status.textContent = error.message;
  }
  button.disabled = false;
  setTimeout(() => (status.textContent = ""), 3000);
});

$("#avatarInput").addEventListener("change", async (event) => {
  const file = event.target.files[0];
  if (!file) return;
  const status = $("#profileStatus");
  status.textContent = "Uploading photo…";
  try {
    const avatar = await readAvatarFile(file, 160);
    const { user } = await api.patch("/api/me", { avatar });
    me = user;
    $("#avatarSlot").innerHTML = avatarHTML(user, 62);
    status.textContent = "Photo updated ✓";
  } catch (error) {
    status.textContent = error.message;
  }
  setTimeout(() => (status.textContent = ""), 3500);
});

$("#signOutBtn").addEventListener("click", signOut);

(async function init() {
  try {
    await loadProfile();
    await loadOrders();
  } catch (error) {
    $("#ordersList").innerHTML = `<p class="empty-row">${esc(error.message)}</p>`;
  }
})();
