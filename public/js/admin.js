/* Admin dashboard: customers, orders, products, messages, payments, emails */

const $ = (s) => document.querySelector(s);

const state = {
  user: null,
  customers: [],
  orders: [],
  products: [],
  categories: [],
  methods: [],
  binance: {},
  settings: {},
  conversations: [],
  activeUserId: null,
  tab: "dashboard",
  wallet: null,
  topups: [],
  withdrawals: [],
  withdrawStatus: "",
  profile: null,
  profileTab: "overview",
};

const PANELS = [
  "dashboard",
  "customers",
  "topups",
  "withdrawals",
  "orders",
  "messages",
  "products",
  "categories",
  "payments",
  "settings",
  "emails",
];

const TAB_TITLES = {
  dashboard: "Overview",
  customers: "Customers",
  topups: "Top-ups",
  withdrawals: "Withdrawals",
  orders: "Orders",
  messages: "Support inbox",
  products: "Products",
  categories: "Categories",
  payments: "Payments",
  settings: "Settings",
  emails: "Email log",
};

/* ---------------- boot ---------------- */
(async function boot() {
  try {
    const { user } = await api.get("/api/auth/me");
    if (!user) {
      window.location.href = "/login.html?next=/admin.html";
      return;
    }
    if (user.role !== "admin") {
      window.location.href = "/dashboard.html";
      return;
    }
    state.user = user;
    $("#adminBadge").innerHTML = `${avatarHTML(user, 34)}<div class="who"><strong>${esc(
      user.name || "Admin"
    )}</strong><span>${esc(user.email)}</span></div>`;

    await loadSite();
    await Promise.all([loadStats(), loadProducts(), loadCategories(), loadCustomers()]);
    bindEvents();
    bindWalletEvents();

    const hash = (window.location.hash || "").replace("#", "");
    if (hash && PANELS.includes(hash)) switchTab(hash);
  } catch (error) {
    console.error(error);
    document.body.insertAdjacentHTML(
      "afterbegin",
      `<p class="form-error" style="margin:1rem">${esc(error.message)}</p>`
    );
  }
})();

/* ---------------- stats ---------------- */
async function loadStats() {
  const stats = await api.get("/api/admin/stats");
  const w = stats.wallet || {};
  const symbol = w.symbol || "$";

  $("#statCustomers").textContent = stats.customers;
  $("#statBalances").textContent = fmtMoney(w.totalBalance || 0, symbol);
  $("#statDeposits").textContent = fmtMoney(w.totalDeposits || 0, symbol);
  $("#statWithdrawals").textContent = fmtMoney(w.totalWithdrawals || 0, symbol);
  $("#statPendingWithdrawals").textContent = w.pendingWithdrawals || 0;
  $("#statPendingWithdrawalsAmount").textContent = `${fmtMoney(
    w.pendingWithdrawalsAmount || 0,
    symbol
  )} waiting`;
  $("#statPendingTopups").textContent = w.pendingTopups || 0;
  $("#statPendingTopupsAmount").textContent = `${fmtMoney(
    w.pendingTopupsAmount || 0,
    symbol
  )} waiting`;
  $("#statRevenue").textContent = fmtMoney(stats.revenue || 0, symbol);
  $("#statOrders").textContent = `${stats.orders} orders · ${stats.pending} pending`;
  $("#statUnread").textContent = stats.unreadMessages;

  const badge = $("#msgTabBadge");
  badge.textContent = stats.unreadMessages;
  badge.hidden = !stats.unreadMessages;
  const topupBadge = $("#topupBadge");
  topupBadge.textContent = w.pendingTopups || 0;
  topupBadge.hidden = !w.pendingTopups;
  const withdrawBadge = $("#withdrawBadge");
  withdrawBadge.textContent = w.pendingWithdrawals || 0;
  withdrawBadge.hidden = !w.pendingWithdrawals;

  const series = w.series || [];
  ChartKit.area(
    $("#adminChart"),
    [
      { name: "Deposits", color: "#31e1c0", values: series.map((d) => d.deposits) },
      { name: "Withdrawals", color: "#7c5cff", values: series.map((d) => d.withdrawals) },
    ],
    series.map((d) => d.label)
  );

  await loadReviewList();
}

async function loadDashboard() {
  const data = await api.get("/api/admin/wallet");
  state.wallet = data;
  renderReviewList(data.withdrawals || [], data.topups || []);
  renderRecentTx(data.transactions || []);
}

async function loadReviewList() {
  try {
    const data = await api.get("/api/admin/wallet");
    state.wallet = data;
    renderReviewList(data.withdrawals || [], data.topups || []);
    renderRecentTx(data.transactions || []);
  } catch (error) {
    console.error(error);
  }
}

function renderReviewList(withdrawals, topups) {
  const box = $("#reviewList");
  if (!box) return;
  const items = [
    ...withdrawals.map((w) => ({
      kind: "withdrawal",
      title: `${w.customer || w.email} · ${fmtMoney(w.amount, w.symbol)}`,
      sub: `Withdrawal via ${w.methodLabel} · ${timeAgo(w.createdAt)}`,
      id: w.id,
    })),
    ...topups.map((t) => ({
      kind: "topup",
      title: `${t.customer || t.email} · ${fmtMoney(t.amount, t.symbol)}`,
      sub: `Top-up · ${timeAgo(t.createdAt)}`,
      id: t.id,
    })),
  ].slice(0, 6);

  if (!items.length) {
    box.innerHTML = `<div class="empty-state" style="padding:1.4rem"><span class="emoji">✨</span><strong>Nothing waiting</strong><p>All requests are handled.</p></div>`;
    return;
  }

  box.innerHTML = items
    .map(
      (item) => `
      <button class="tx-row" data-jump="${item.kind === "withdrawal" ? "withdrawals" : "topups"}"
        style="width:100%;text-align:left;background:none;border:1px solid transparent;cursor:pointer">
        <span class="txico out">${item.kind === "withdrawal" ? "↑" : "↓"}</span>
        <span class="txmeta"><strong>${esc(item.title)}</strong><span>${esc(item.sub)}</span></span>
        <span class="pill pill-pending">review</span>
      </button>`
    )
    .join("");
}

function renderRecentTx(rows) {
  const box = $("#recentTx");
  if (!box) return;
  if (!rows.length) {
    box.innerHTML = `<div class="empty-state" style="padding:1.4rem"><span class="emoji">🧾</span><strong>No transactions yet</strong><p>Approved top-ups and withdrawals appear here.</p></div>`;
    return;
  }
  box.innerHTML = rows
    .map(
      (tx) => `
      <div class="tx-row">
        <span class="txico ${tx.direction === "credit" ? "in" : "out"}">${tx.direction === "credit" ? "↓" : "↑"}</span>
        <span class="txmeta">
          <strong>${esc(tx.customer || tx.email)} · ${esc(tx.label)}</strong>
          <span>${today(tx.createdAt)}${tx.reference ? " · " + esc(tx.reference) : ""}</span>
        </span>
        <span class="txamount ${tx.direction === "credit" ? "credit" : "debit"}">
          ${tx.direction === "credit" ? "+" : "−"}${fmtMoney(tx.amount, tx.symbol)}
          <small>bal ${fmtMoney(tx.balanceAfter, tx.symbol)}</small>
        </span>
      </div>`
    )
    .join("");
}

/* ---------------- tabs ---------------- */
function switchTab(tab, push = true) {
  if (!PANELS.includes(tab)) tab = "dashboard";
  state.tab = tab;
  document.querySelectorAll(".tab").forEach((btn) => {
    const active = btn.dataset.tab === tab;
    btn.setAttribute("aria-selected", String(active));
    btn.classList.toggle("active", active);
  });
  PANELS.forEach((name) => {
    const panel = $(`#panel-${name}`);
    if (panel) panel.hidden = name !== tab;
  });
  const title = $("#topbarTitle");
  if (title) title.textContent = TAB_TITLES[tab] || "Admin";
  if (push && window.location.hash !== `#${tab}`) {
    history.replaceState(null, "", `#${tab}`);
  }
  closeSidebar();

  if (tab === "dashboard") loadReviewList();
  if (tab === "customers") loadCustomers();
  if (tab === "topups") loadTopups();
  if (tab === "withdrawals") {
    loadWithdrawals();
    if (typeof loadWithdrawMin === "function") loadWithdrawMin();
  }
  if (tab === "orders") loadOrders();
  if (tab === "categories") loadCategories();
  if (tab === "messages") loadConversations();
  if (tab === "payments") loadMethods();
  if (tab === "settings") loadSettings();
  if (tab === "emails") loadOutbox();
}

function closeSidebar() {
  const side = $("#side");
  const scrim = $("#sideScrim");
  if (side) side.classList.remove("open");
  if (scrim) scrim.classList.remove("show");
}

/* ---------------- customers ---------------- */
async function loadCustomers() {
  const params = new URLSearchParams();
  const q = $("#customerSearch").value.trim();
  const product = $("#customerProduct").value;
  const role = $("#customerRole").value;
  if (q) params.set("q", q);
  if (product) params.set("product", product);
  if (role) params.set("role", role);

  const { customers } = await api.get(`/api/admin/customers?${params}`);
  state.customers = customers;
  renderCustomers();
}

function contactLine(c) {
  if (!c.contact_handle) return "";
  const label = c.contact_type === "discord" ? "Discord" : "Telegram";
  return `<span class="muted" style="font-size:0.72rem">${label}: ${esc(c.contact_handle)}</span>`;
}

function statusPill(status) {
  const value = String(status || "active").toLowerCase();
  return `<span class="status status-${value}">${esc(value)}</span>`;
}

function renderCustomers() {
  const body = $("#customersBody");
  const list = state.customers;
  $("#customerCount").textContent = `${list.length} account${list.length === 1 ? "" : "s"}`;

  if (!list.length) {
    body.innerHTML = `<tr><td colspan="9" class="empty-row">No customers match those filters yet.</td></tr>`;
    return;
  }

  const symbol = (window.SITE && window.SITE.wallet && window.SITE.wallet.symbol) || "$";
  body.innerHTML = list
    .map((c) => {
      const isMe = state.user && c.id === state.user.id;
      return `
        <tr>
          <td>
            <div class="person">
              ${avatarHTML(c, 36)}
              <div class="who">
                <strong>${esc(c.name || c.email.split("@")[0])}${isMe ? " (you)" : ""}</strong>
                <span>${esc(c.email)}</span>
                ${contactLine(c)}
              </div>
            </div>
          </td>
          <td class="mono muted hide-sm">#${c.id}</td>
          <td class="num"><strong>${fmtMoney(c.balance, symbol)}</strong></td>
          <td class="num muted hide-md">${fmtMoney(c.deposited, symbol)}</td>
          <td class="num muted hide-md">${fmtMoney(c.withdrawn, symbol)}</td>
          <td class="num">${c.order_count}<span class="hint"> · ${c.tx_count} tx</span></td>
          <td>${statusPill(c.status)}</td>
          <td class="muted hide-sm">${today(c.created_at)}</td>
          <td style="white-space:nowrap">
            <button class="icon-btn-sm" type="button" data-open-customer="${c.id}">Profile</button>
            <button class="icon-btn-sm" type="button" data-message-user="${c.id}">Message</button>
          </td>
        </tr>`;
    })
    .join("");
}

/* ---------------- orders ---------------- */
async function loadOrders() {
  const params = new URLSearchParams();
  const q = $("#orderSearch").value.trim();
  const status = $("#orderStatus").value;
  if (q) params.set("q", q);
  if (status) params.set("status", status);

  const { orders } = await api.get(`/api/admin/orders?${params}`);
  state.orders = orders;
  renderOrders();
}

function renderOrders() {
  const body = $("#ordersBody");
  const list = state.orders;
  $("#orderCount").textContent = `${list.length} order${list.length === 1 ? "" : "s"}`;

  if (!list.length) {
    body.innerHTML = `<tr><td colspan="8" class="empty-row">No orders yet.</td></tr>`;
    return;
  }

  body.innerHTML = list
    .map((o) => {
      const items = o.items
        .map(
          (i) =>
            `<span class="mini-product">${esc(i.emoji || "🎁")} ${esc(i.name)}${
              i.variant ? ` · ${esc(i.variant)}` : ""
            } ×${i.qty}</span>`
        )
        .join("");
      return `
        <tr>
          <td><strong>${esc(o.id)}</strong></td>
          <td>
            <div class="who" style="min-width:0">
              <span class="muted" style="font-size:0.8rem">${esc(o.email)}</span>
              ${o.contact && o.contact.handle ? `<span class="muted" style="display:block;font-size:0.72rem">${esc(o.contact.type === "discord" ? "Discord" : "Telegram")}: ${esc(o.contact.handle)}</span>` : `<span class="pill pill-expired" style="font-size:0.65rem">no contact</span>`}
            </div>
          </td>
          <td><div class="mini-products">${items}</div></td>
          <td class="num">${money(o.total)}</td>
          <td><span class="pill pill-${esc(o.status)}">${esc(o.status)}</span></td>
          <td class="muted">${esc(o.methodLabel || "—")}</td>
          <td class="muted">${today(o.createdAt)}</td>
          <td style="white-space:nowrap">
            <button class="icon-btn-sm" type="button" data-manage-order="${esc(o.id)}">Manage</button>
            <a class="icon-btn-sm" href="/order.html?id=${encodeURIComponent(o.id)}" target="_blank" rel="noopener">Open</a>
          </td>
        </tr>`;
    })
    .join("");
}

function payDetails(o) {
  if (!o.provider) return `<span class="muted">Not chosen yet</span>`;
  if (o.provider === "sandbox") return "Sandbox (test)";
  const parts = [esc(o.methodLabel || o.provider)];
  if (o.payAmount) parts.push(`${esc(o.payAmount)} ${esc(o.payAsset || "")}`);
  if (o.payAddress) parts.push(`<br /><code style="font-size:0.72rem">${esc(o.payAddress)}</code>`);
  if (o.txid) parts.push(`<br /><span class="muted" style="font-size:0.72rem">tx ${esc(o.txid)}</span>`);
  return parts.join(" ");
}

function orderModalBody(o) {
  const codes = o.codes || [];
  return `
    <div class="order-admin-grid">
      <div class="row"><span>Status</span><span><span class="pill pill-${esc(o.status)}">${esc(o.status)}</span></span></div>
      <div class="row"><span>Total</span><span>${money(o.total)}</span></div>
      <div class="row"><span>Customer</span><span>${esc(o.email)}</span></div>
      <div class="row"><span>Contact</span><span>${o.contact && o.contact.handle ? `${esc(o.contact.type === "discord" ? "Discord" : "Telegram")}: <strong>${esc(o.contact.handle)}</strong>` : `<span class="pay-warning">missing</span>`}</span></div>
      <div class="row"><span>Payment</span><span>${payDetails(o)}</span></div>
      <div class="row"><span>Placed</span><span>${today(o.createdAt)}</span></div>
      <div class="row"><span>Paid</span><span>${o.paidAt ? today(o.paidAt) : "—"}</span></div>
      <div class="row"><span>Delivered</span><span>${o.deliveredAt ? today(o.deliveredAt) : "—"}</span></div>
    </div>

    <div class="mini-products" style="margin:0.8rem 0">
      ${o.items
        .map(
          (i) =>
            `<span class="mini-product">${
              i.image ? `<img src="${esc(i.image)}" alt="" />` : esc(i.emoji || "🎁")
            } ${esc(i.name)}${i.variant ? ` · ${esc(i.variant)}` : ""} ×${i.qty}</span>`
        )
        .join("")}
    </div>

    ${
      codes.length
        ? `<div class="code-list">${codes
            .map(
              (c) => `<div class="code-row">
                <div><code>${esc(c.code)}</code><span>${esc(c.name || "")}</span></div>
                <button type="button" data-copy="${esc(c.code)}">Copy</button>
              </div>`
            )
            .join("")}</div>`
        : `<p class="small muted">No codes yet — they are generated when the order is marked as paid.</p>`
    }

    <div class="modal-actions" style="flex-wrap:wrap">
      ${
        o.status !== "paid"
          ? `<button class="btn btn-primary" type="button" data-order-action="verify">Verify payment</button>
             <button class="btn btn-ghost" type="button" data-order-action="markPaid">Mark as paid</button>`
          : `<button class="btn btn-primary" type="button" data-order-action="copyCodes">Copy all codes</button>
             <button class="btn btn-ghost" type="button" data-order-action="delivered">Mark delivered</button>`
      }
      <button class="btn btn-ghost" type="button" data-order-action="message">Message customer</button>
    </div>
    <p class="form-error" id="orderModalError" role="alert" hidden></p>`;
}

function openOrderManager(orderId) {
  const order = state.orders.find((o) => o.id === orderId);
  if (!order) return;

  const modal = document.createElement("div");
  modal.className = "modal";
  modal.id = "orderModal";
  modal.innerHTML = `
    <div class="modal-panel" role="dialog" aria-modal="true" style="width:min(640px,100%)">
      <h2 style="font-size:1.15rem">Order ${esc(order.id)}</h2>
      <p class="sub">Everything you need to check and deliver this order.</p>
      <div id="orderModalBody">${orderModalBody(order)}</div>
      <div class="modal-actions">
        <button class="btn btn-ghost" type="button" id="closeOrderModal">Close</button>
      </div>
    </div>`;
  document.body.appendChild(modal);

  const close = () => modal.remove();
  modal.addEventListener("click", (e) => {
    if (e.target === modal) close();
  });
  modal.querySelector("#closeOrderModal").addEventListener("click", close);

  modal.addEventListener("click", async (event) => {
    const copyBtn = event.target.closest("[data-copy]");
    if (copyBtn) {
      try {
        await copyText(copyBtn.dataset.copy);
        copyBtn.textContent = "Copied";
        setTimeout(() => (copyBtn.textContent = "Copy"), 1300);
      } catch {
        /* clipboard blocked */
      }
      return;
    }

    const action = event.target.closest("[data-order-action]");
    if (!action) return;

    const errorBox = modal.querySelector("#orderModalError");
    errorBox.hidden = true;
    const kind = action.dataset.orderAction;
    action.disabled = true;
    const original = action.textContent;

    try {
      if (kind === "message") {
        close();
        await openConversation(order.customerId || null, order.email);
        switchTab("messages");
        return;
      }
      if (kind === "copyCodes") {
        const lines = (order.codes || []).map((c) => `${c.code} — ${c.name || ""}`.trim());
        if (!lines.length) throw new Error("No codes on this order yet.");
        await copyText(lines.join("\n"));
        action.textContent = "Copied";
        action.disabled = false;
        setTimeout(() => (action.textContent = original), 1400);
        return;
      }
      let result;
      if (kind === "verify") {
        result = await api.post(`/api/admin/orders/${encodeURIComponent(order.id)}/verify`);
      } else if (kind === "markPaid") {
        result = await api.patch(`/api/admin/orders/${encodeURIComponent(order.id)}`, { markPaid: true });
      } else if (kind === "delivered") {
        result = await api.patch(`/api/admin/orders/${encodeURIComponent(order.id)}`, { delivered: true });
      }

      if (result && result.order) {
        const index = state.orders.findIndex((o) => o.id === result.order.id);
        if (index >= 0) state.orders[index] = result.order;
        modal.querySelector("#orderModalBody").innerHTML = orderModalBody(result.order);
      }
      await loadOrders();
      await loadStats();
    } catch (error) {
      errorBox.textContent = error.message;
      errorBox.hidden = false;
    }
    action.disabled = false;
    action.textContent = original;
  });
}

/* ---------------- products ---------------- */
async function loadProducts() {
  const { products } = await api.get("/api/admin/products");
  state.products = products;
  renderProducts();
  renderProductFilter();
}

function renderProducts() {
  const body = $("#productsBody");
  $("#productsBody").innerHTML = state.products
    .map(
      (p) => `
      <tr>
        <td>
          <div class="person">
            <span class="editor-preview" style="width:40px;height:40px;font-size:1.2rem">
              ${p.image ? `<img src="${esc(p.image)}" alt="" />` : esc(p.emoji)}
            </span>
            <div class="who">
              <strong>${esc(p.name)}</strong>
              <span>${esc(p.id)}</span>
            </div>
          </div>
        </td>
        <td class="muted">${esc(p.category)}</td>
        <td class="num">
          ${p.hasVariants ? `<span class="muted small">from</span> ${money(p.price)}` : money(p.price)}
          ${
            p.hasVariants
              ? `<div class="muted" style="font-size:0.7rem;white-space:nowrap">${p.variants
                  .map((v) => `${esc(v.label)} ${money(v.price)}`)
                  .join(" · ")}</div>`
              : ""
          }
        </td>
        <td><span class="pill ${p.active ? "pill-paid" : "pill-expired"}">${p.active ? "Live" : "Hidden"}</span></td>
        <td style="white-space:nowrap">
          <button class="icon-btn-sm" type="button" data-edit-product="${esc(p.id)}">Edit</button>
          <button class="icon-btn-sm" type="button" data-toggle-product="${esc(p.id)}">${p.active ? "Hide" : "Show"}</button>
        </td>
      </tr>`
    )
    .join("");
}

function renderProductFilter() {
  const select = $("#customerProduct");
  const current = select.value;
  select.innerHTML =
    `<option value="">All products</option>` +
    state.products
      .map((p) => `<option value="${esc(p.id)}">${esc(p.name)}</option>`)
      .join("");
  select.value = current;
}

/* ---------------- categories ---------------- */
async function loadCategories() {
  try {
    const { categories } = await api.get("/api/admin/categories");
    state.categories = categories || [];
    renderCategories();
  } catch (error) {
    const body = $("#categoriesBody");
    if (body) body.innerHTML = `<tr><td colspan="4" class="empty-row">${esc(error.message)}</td></tr>`;
  }
}

function categoryByName(name) {
  const wanted = String(name || "").toLowerCase();
  return state.categories.find((c) => c.name.toLowerCase() === wanted);
}

function renderCategories() {
  const body = $("#categoriesBody");
  if (!body) return;
  const list = state.categories;

  if (!list.length) {
    body.innerHTML = `<tr><td colspan="4" class="empty-row">No categories yet — add one above.</td></tr>`;
    return;
  }

  body.innerHTML = list
    .map(
      (c) => `
      <tr>
        <td><strong>${esc(c.name)}</strong></td>
        <td class="num">${c.productCount}</td>
        <td class="num">${c.sortOrder}</td>
        <td style="white-space:nowrap">
          <button class="icon-btn-sm" type="button" data-edit-category="${esc(c.name)}">Edit</button>
          <button class="icon-btn-sm" type="button" data-delete-category="${esc(c.name)}">Delete</button>
        </td>
      </tr>`
    )
    .join("");
}

function openCategoryEditor(category) {
  const isNew = !category;
  const c = category || {
    name: "",
    sortOrder: Math.max(0, ...state.categories.map((x) => x.sortOrder || 0)) + 10,
  };

  const modal = document.createElement("div");
  modal.className = "modal";
  modal.id = "categoryModal";
  modal.innerHTML = `
    <div class="modal-panel" role="dialog" aria-modal="true" style="width:min(420px,100%)">
      <h2 style="margin-bottom:1rem">${isNew ? "New category" : "Edit category"}</h2>
      <form id="categoryForm">
        <div class="field">
          <label for="cName">Name</label>
          <input id="cName" value="${esc(c.name)}" placeholder="Xbox" maxlength="40" required />
        </div>
        <div class="field">
          <label for="cSort">Sort order</label>
          <input id="cSort" type="number" value="${c.sortOrder ?? 100}" />
        </div>
        <p class="hint">
          ${isNew
            ? "New categories appear on the storefront as soon as a product uses them."
            : "Renaming a category updates every product that uses it."}
        </p>
        <div class="modal-actions">
          <button class="btn btn-ghost" type="button" id="cancelCategory">Cancel</button>
          <button class="btn btn-primary" type="submit">${isNew ? "Create category" : "Save changes"}</button>
        </div>
        <p class="form-error" id="categoryError" role="alert" hidden></p>
      </form>
    </div>`;

  document.body.appendChild(modal);
  const close = () => modal.remove();
  modal.addEventListener("click", (e) => e.target === modal && close());
  $("#cancelCategory").addEventListener("click", close);

  $("#categoryForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const errorBox = $("#categoryError");
    errorBox.hidden = true;
    const payload = {
      name: $("#cName").value.trim(),
      sortOrder: Number($("#cSort").value) || 0,
    };
    if (!payload.name) return show(errorBox, "Give the category a name.");

    try {
      if (isNew) {
        await api.post("/api/admin/categories", payload);
      } else {
        await api.patch(`/api/admin/categories/${encodeURIComponent(c.name)}`, payload);
      }
      close();
      await Promise.all([loadCategories(), loadProducts()]);
    } catch (error) {
      show(errorBox, error.message);
    }
  });

  $("#cName").focus();
}

/* ---------------- product editor ---------------- */
function openEditor(product) {
  const isNew = !product;
  const p = product || {
    id: "",
    name: "",
    category: "Game Cards",
    price: 0,
    oldPrice: null,
    emoji: "🎁",
    image: null,
    region: "Global",
    badge: null,
    desc: "",
    variants: [],
    active: true,
    sortOrder: 100,
  };
  let imageData = p.image || "";
  let variantRows = (p.variants || []).map((v) => ({
    label: v.label,
    price: v.price,
    oldPrice: v.oldPrice ?? "",
  }));

  const categoryNames = state.categories.map((c) => c.name);
  if (p.category && !categoryByName(p.category)) categoryNames.push(p.category);
  const categoryOptions = categoryNames
    .map(
      (name) =>
        `<option value="${esc(name)}" ${
          name.toLowerCase() === String(p.category || "").toLowerCase() ? "selected" : ""
        }>${esc(name)}</option>`
    )
    .join("");

  const modal = document.createElement("div");
  modal.className = "modal";
  modal.id = "productModal";
  modal.innerHTML = `
    <div class="modal-panel" role="dialog" aria-modal="true" style="width:min(620px,100%)">
      <h2 style="margin-bottom:1rem">${isNew ? "New product" : "Edit product"}</h2>
      <form id="productForm">
        <div class="form-grid">
          <div class="field full" style="grid-column:1/-1">
            <label for="pName">Name</label>
            <input id="pName" value="${esc(p.name)}" placeholder="Steam Wallet Card $20" required />
          </div>
          ${isNew ? `<div class="field full" style="grid-column:1/-1">
            <label for="pId">URL id <span class="hint">(letters, numbers, dashes)</span></label>
            <input id="pId" value="" placeholder="steam-20" />
          </div>` : ""}
          <div class="field">
            <label for="pCategory">Category</label>
            <select id="pCategory">${categoryOptions}</select>
            <p class="hint" style="margin:0.2rem 0 0">Create and reorder categories in the Categories tab.</p>
          </div>
          <div class="field">
            <label for="pRegion">Region</label>
            <input id="pRegion" value="${esc(p.region)}" placeholder="Global / US / EU" />
          </div>
          <div class="field">
            <label for="pPrice">Price (USD)</label>
            <input id="pPrice" type="number" step="0.01" min="0.01" value="${p.price}" required />
          </div>
          <div class="field">
            <label for="pOldPrice">Compare-at price <span class="hint">(optional)</span></label>
            <input id="pOldPrice" type="number" step="0.01" min="0" value="${p.oldPrice || ""}" />
          </div>
          <div class="field" style="grid-column:1/-1">
            <label>Duration options</label>
            <label style="display:flex;align-items:center;gap:0.5rem;font-size:0.88rem;color:var(--text)">
              <input type="checkbox" id="pHasVariants" ${p.hasVariants ? "checked" : ""} style="width:auto;height:auto" />
              Sell several durations from one product card
            </label>
            <p class="hint" style="margin:0.15rem 0 0">
              The customer picks one on the card, e.g. 14 days, 1 month, 3 months. Each duration has its own price.
            </p>
            <div id="variantEditor" hidden style="margin-top:0.7rem">
              <div id="variantRows"></div>
              <button class="btn btn-ghost" type="button" id="addVariant" style="margin-top:0.45rem">+ Add duration</button>
            </div>
          </div>
          <div class="field">
            <label for="pEmoji">Emoji fallback</label>
            <input id="pEmoji" value="${esc(p.emoji)}" maxlength="4" />
          </div>
          <div class="field">
            <label for="pBadge">Badge <span class="hint">(optional)</span></label>
            <input id="pBadge" value="${esc(p.badge || "")}" placeholder="Sale / Best seller" />
          </div>
          <div class="field full" style="grid-column:1/-1">
            <label for="pImage">Product picture</label>
            <div style="display:flex; gap:0.8rem; align-items:center">
              <span class="editor-preview" id="imagePreview">
                ${imageData ? `<img src="${esc(imageData)}" alt="" />` : esc(p.emoji)}
              </span>
              <div style="flex:1; display:grid; gap:0.4rem">
                <input type="file" id="pImageFile" accept="image/*" />
                <input id="pImageUrl" placeholder="…or paste an image URL" value="${
                  imageData.startsWith("data:") ? "" : esc(imageData)
                }" />
              </div>
            </div>
          </div>
          <div class="field full" style="grid-column:1/-1">
            <label for="pDesc">Description</label>
            <textarea id="pDesc">${esc(p.desc)}</textarea>
          </div>
          <div class="field">
            <label for="pSort">Sort order</label>
            <input id="pSort" type="number" value="${p.sortOrder ?? 100}" />
          </div>
          <div class="field">
            <label>Visibility</label>
            <label style="display:flex; align-items:center; gap:0.5rem; font-size:0.88rem; color:var(--text)">
              <input type="checkbox" id="pActive" ${p.active ? "checked" : ""} style="width:auto;height:auto" />
              Show in the store
            </label>
          </div>
        </div>

        <div class="modal-actions">
          <button class="btn btn-ghost" type="button" id="cancelProduct">Cancel</button>
          <button class="btn btn-primary" type="submit">${isNew ? "Create product" : "Save changes"}</button>
        </div>
        <p class="form-error" id="productError" role="alert" hidden></p>
      </form>
    </div>`;

  document.body.appendChild(modal);
  const close = () => modal.remove();
  modal.addEventListener("click", (e) => e.target === modal && close());
  $("#cancelProduct").addEventListener("click", close);

  const hasVariants = $("#pHasVariants");
  const variantEditor = $("#variantEditor");
  const variantRowsBox = $("#variantRows");

  function renderVariantRows() {
    variantRowsBox.innerHTML = variantRows.length
      ? variantRows
          .map(
            (v, i) => `
        <div class="variant-row" data-variant-row="${i}">
          <input data-v-field="label" value="${esc(v.label ?? "")}" placeholder="14 days" aria-label="Duration name" />
          <input data-v-field="price" type="number" step="0.01" min="0.01" value="${esc(v.price ?? "")}" placeholder="Price" aria-label="Duration price" />
          <input data-v-field="oldPrice" type="number" step="0.01" min="0" value="${esc(v.oldPrice ?? "")}" placeholder="Compare-at" aria-label="Compare-at price" />
          <button class="variant-remove" type="button" data-v-remove="${i}" aria-label="Remove duration">✕</button>
        </div>`
          )
          .join("")
      : `<p class="hint">No durations yet — add one below.</p>`;
  }

  function syncVariantMode() {
    const on = hasVariants.checked;
    variantEditor.hidden = !on;
    $("#pPrice").disabled = on;
    $("#pOldPrice").disabled = on;
    $("#pPrice").required = !on;
  }

  hasVariants.addEventListener("change", () => {
    if (hasVariants.checked && !variantRows.length) {
      variantRows.push({ label: "", price: p.price || "", oldPrice: p.oldPrice || "" });
      renderVariantRows();
    }
    syncVariantMode();
  });

  $("#addVariant").addEventListener("click", () => {
    variantRows.push({ label: "", price: "", oldPrice: "" });
    renderVariantRows();
    const labels = variantRowsBox.querySelectorAll('[data-v-field="label"]');
    if (labels.length) labels[labels.length - 1].focus();
  });

  variantRowsBox.addEventListener("input", (event) => {
    const row = event.target.closest("[data-variant-row]");
    const field = event.target.dataset.vField;
    if (!row || !field) return;
    variantRows[Number(row.dataset.variantRow)][field] = event.target.value;
  });

  variantRowsBox.addEventListener("click", (event) => {
    const remove = event.target.closest("[data-v-remove]");
    if (!remove) return;
    variantRows.splice(Number(remove.dataset.vRemove), 1);
    renderVariantRows();
  });

  renderVariantRows();
  syncVariantMode();

  const preview = $("#imagePreview");
  const updatePreview = () => {
    preview.innerHTML = imageData
      ? `<img src="${esc(imageData)}" alt="" />`
      : esc($("#pEmoji").value || "🎁");
  };

  $("#pImageFile").addEventListener("change", async (event) => {
    const file = event.target.files[0];
    if (!file) return;
    try {
      imageData = await readAvatarFile(file, 480);
      $("#pImageUrl").value = "";
      updatePreview();
    } catch (error) {
      alert(error.message);
    }
  });

  $("#pImageUrl").addEventListener("input", (event) => {
    imageData = event.target.value.trim();
    updatePreview();
  });
  $("#pEmoji").addEventListener("input", updatePreview);

  $("#productForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const errorBox = $("#productError");
    errorBox.hidden = true;
    const useVariants = hasVariants.checked;
    const variants = useVariants
      ? variantRows.map((v) => ({
          label: String(v.label || "").trim(),
          price: v.price === "" ? 0 : Number(v.price),
          oldPrice: v.oldPrice === "" || v.oldPrice === null ? null : Number(v.oldPrice),
        }))
      : [];

    const payload = {
      name: $("#pName").value.trim(),
      category: $("#pCategory").value,
      emoji: $("#pEmoji").value || "🎁",
      image: imageData || null,
      region: $("#pRegion").value.trim() || "Global",
      badge: $("#pBadge").value.trim(),
      desc: $("#pDesc").value.trim(),
      active: $("#pActive").checked,
      sortOrder: Number($("#pSort").value) || 100,
      variants,
    };
    if (!useVariants) {
      payload.price = Number($("#pPrice").value);
      payload.oldPrice = $("#pOldPrice").value ? Number($("#pOldPrice").value) : null;
    }

    if (!payload.name) return show(errorBox, "Give the product a name.");
    if (!payload.category) return show(errorBox, "Choose a category for the product.");
    if (!useVariants && !(payload.price > 0)) {
      return show(errorBox, "Price must be greater than zero.");
    }
    if (useVariants) {
      if (!variants.length) {
        return show(errorBox, "Add at least one duration, or untick the duration option.");
      }
      if (variants.some((v) => !v.label)) return show(errorBox, "Give every duration a name.");
      if (variants.some((v) => !(v.price > 0))) {
        return show(errorBox, "Every duration needs a price above zero.");
      }
    }

    try {
      if (isNew) {
        payload.id = $("#pId").value.trim() || payload.name.toLowerCase().replace(/[^a-z0-9]+/g, "-");
        await api.post("/api/admin/products", payload);
      } else {
        await api.patch(`/api/admin/products/${encodeURIComponent(p.id)}`, payload);
      }
      close();
      await loadProducts();
      await loadStats();
    } catch (error) {
      show(errorBox, error.message);
    }
  });

  $("#pName").focus();
}

function show(box, message) {
  box.textContent = message;
  box.hidden = false;
}

/* ---------------- payment methods ---------------- */
async function loadMethods() {
  try {
    const data = await api.get("/api/admin/payment-methods");
    state.methods = data.methods || [];
    state.binance = data.binance || {};
    state.settings = data.settings || {};
    renderMethods();
    renderBinance();
    renderStoreSettings();
  } catch (error) {
    $("#methodsBody").innerHTML = `<tr><td colspan="6" class="empty-row">${esc(error.message)}</td></tr>`;
  }
}

function renderMethods() {
  const body = $("#methodsBody");
  const list = state.methods;
  $("#methodCount").textContent = `${list.length} method${list.length === 1 ? "" : "s"}`;

  if (!list.length) {
    body.innerHTML = `<tr><td colspan="6" class="empty-row">No payment methods yet.</td></tr>`;
    return;
  }

  body.innerHTML = list
    .map((m) => {
      const address = m.address
        ? `<code style="font-size:0.72rem;word-break:break-all">${esc(m.address)}</code>`
        : m.kind === "binance"
        ? `<span class="muted small">Handled by Binance Pay</span>`
        : `<span class="pay-warning">No address set</span>`;
      const status = m.available
        ? `<span class="pill pill-paid">Live</span>`
        : m.enabled
        ? `<span class="pill pill-pending">Needs setup</span>`
        : `<span class="pill pill-expired">Hidden</span>`;
      return `
        <tr>
          <td>
            <strong>${esc(m.label)}</strong>
            <div class="muted" style="font-size:0.72rem">${m.kind === "binance" ? "Binance Pay" : "On-chain"}</div>
          </td>
          <td class="muted">${esc(m.asset || "—")}${m.network ? ` · ${esc(m.network)}` : ""}</td>
          <td>${address}</td>
          <td>${m.autoVerify ? "Yes" : "Manual"}</td>
          <td>${status}</td>
          <td style="white-space:nowrap">
            <button class="icon-btn-sm" type="button" data-edit-method="${esc(m.id)}">Edit</button>
            <button class="icon-btn-sm" type="button" data-toggle-method="${esc(m.id)}">${m.enabled ? "Hide" : "Show"}</button>
          </td>
        </tr>`;
    })
    .join("");
}

function renderBinance() {
  const b = state.binance || {};
  const status = $("#binanceStatus");
  if (b.enabled) {
    status.innerHTML = `Connected — Binance Pay is live, orders are verified automatically. Key ending <code>${esc(b.keyHint || "……")}</code>.`;
  } else {
    status.innerHTML = `Not connected — the store is in <strong>sandbox mode</strong> (test payments only). Paste your merchant API key and secret to go live.`;
  }
  $("#binanceMode").textContent = b.enabled ? `Live · ${b.currency || "USDT"}` : "Sandbox";
  $("#binanceKey").value = "";
  $("#binanceSecret").value = "";
  $("#binanceCert").value = "";
}

function renderStoreSettings() {
  const s = state.settings || {};
  $("#codesVisible").checked = s.codesVisible !== false;
  $("#deliveryNote").value = s.deliveryNote || "";
  $("#supportContact").value = s.supportContact || "";
}

function openMethodEditor(method) {
  const isNew = !method;
  const m = method || {
    id: "",
    label: "",
    asset: "USDT",
    network: "",
    kind: "crypto",
    address: "",
    instructions: "",
    image: null,
    rateUsd: null,
    autoVerify: true,
    enabled: true,
    sortOrder: 100,
  };
  let imageData = m.image || "";

  const modal = document.createElement("div");
  modal.className = "modal";
  modal.id = "methodModal";
  modal.innerHTML = `
    <div class="modal-panel" role="dialog" aria-modal="true" style="width:min(600px,100%)">
      <h2 style="margin-bottom:1rem">${isNew ? "New payment method" : "Edit payment method"}</h2>
      <form id="methodForm">
        <div class="form-grid">
          <div class="field">
            <label for="mLabel">Name</label>
            <input id="mLabel" value="${esc(m.label)}" placeholder="Litecoin (LTC)" required />
          </div>
          ${isNew ? `<div class="field">
            <label for="mId">Id</label>
            <input id="mId" value="" placeholder="ltc" />
          </div>` : ""}
          <div class="field">
            <label for="mKind">Type</label>
            <select id="mKind" style="height:44px;border-radius:10px;border:1px solid var(--border);background:var(--surface);color:var(--text);font:inherit;padding:0 .6rem">
              <option value="crypto" ${m.kind === "crypto" ? "selected" : ""}>Direct crypto (I give an address)</option>
              <option value="binance" ${m.kind === "binance" ? "selected" : ""}>Binance Pay checkout</option>
            </select>
          </div>
          <div class="field">
            <label for="mAsset">Asset</label>
            <input id="mAsset" value="${esc(m.asset)}" placeholder="BTC / LTC / ETH / USDT" />
          </div>
          <div class="field">
            <label for="mNetwork">Network</label>
            <input id="mNetwork" value="${esc(m.network || "")}" placeholder="Bitcoin / TRON / Ethereum" />
          </div>
          <div class="field" style="grid-column:1/-1" id="addressField">
            <label for="mAddress" id="mAddressLabel">Receiving address</label>
            <input id="mAddress" value="${esc(m.address || "")}" placeholder="Paste your wallet address" />
            <span class="hint" id="mAddressHint">Customers only see this after they choose the method. Leave blank to hide the method.</span>
          </div>
          <div class="field" style="grid-column:1/-1">
            <label for="mInstructions">Instructions <span class="hint">(optional)</span></label>
            <textarea id="mInstructions" placeholder="Send the exact amount on the correct network.">${esc(m.instructions || "")}</textarea>
          </div>
          <div class="field">
            <label for="mRate">Manual USD rate <span class="hint">(optional)</span></label>
            <input id="mRate" type="number" step="0.0001" min="0" value="${m.rateUsd || ""}" placeholder="Leave blank for live rate" />
          </div>
          <div class="field">
            <label for="mSort">Sort order</label>
            <input id="mSort" type="number" value="${m.sortOrder ?? 100}" />
          </div>
          <div class="field" style="grid-column:1/-1">
            <label>Payment picture <span class="hint">(shown while paying)</span></label>
            <div style="display:flex;gap:0.8rem;align-items:center">
              <span class="editor-preview" id="methodPreview">
                ${imageData ? `<img src="${esc(imageData)}" alt="" />` : "🪙"}
              </span>
              <div style="flex:1;display:grid;gap:0.4rem">
                <input type="file" id="mImageFile" accept="image/*" />
                <input id="mImageUrl" placeholder="…or paste an image URL" value="${imageData.startsWith("data:") ? "" : esc(imageData)}" />
              </div>
            </div>
          </div>
          <div class="field">
            <label>Automatic checking</label>
            <label style="display:flex;align-items:center;gap:0.5rem;font-size:0.88rem;color:var(--text)">
              <input type="checkbox" id="mAuto" ${m.autoVerify ? "checked" : ""} style="width:auto;height:auto" />
              <span id="mAutoLabel">Verify payments from the blockchain</span>
            </label>
          </div>
          <div class="field">
            <label>Visibility</label>
            <label style="display:flex;align-items:center;gap:0.5rem;font-size:0.88rem;color:var(--text)">
              <input type="checkbox" id="mEnabled" ${m.enabled ? "checked" : ""} style="width:auto;height:auto" />
              Show this method at checkout
            </label>
          </div>
        </div>
        <div class="modal-actions">
          <button class="btn btn-ghost" type="button" id="cancelMethod">Cancel</button>
          <button class="btn btn-primary" type="submit">${isNew ? "Add method" : "Save changes"}</button>
        </div>
        <p class="form-error" id="methodError" role="alert" hidden></p>
      </form>
    </div>`;

  document.body.appendChild(modal);
  const close = () => modal.remove();
  modal.addEventListener("click", (e) => e.target === modal && close());
  $("#cancelMethod").addEventListener("click", close);

  const kind = $("#mKind");
  const addressField = $("#addressField");
  const syncKind = (reset = false) => {
    const binance = kind.value === "binance";
    addressField.hidden = false;
    $("#mAddressLabel").textContent = binance ? "Binance Pay ID or QR link" : "Receiving address";
    $("#mAddress").placeholder = binance
      ? "e.g. 1026195358 or https://app.binance.com/uni-qr/…"
      : "Paste your wallet address";
    $("#mAddressHint").textContent = binance
      ? "The customer sees this on the payment step. Use a Pay ID, or paste the link from your Binance Pay QR so we can draw the QR."
      : "Customers only see this after they choose the method. Leave blank to hide the method.";
    $("#mAutoLabel").textContent = binance
      ? "Verify with the Binance merchant API (needs working keys)"
      : "Verify payments from the blockchain";
    if (reset) {
      $("#mAsset").value = binance ? "USDT" : $("#mAsset").value;
      $("#mNetwork").value = binance ? "Binance" : $("#mNetwork").value;
      $("#mAuto").checked = !binance;
    }
    $("#mAuto").disabled = false;
  };
  kind.addEventListener("change", () => syncKind(true));
  syncKind(false);

  const preview = $("#methodPreview");
  const updatePreview = () => {
    preview.innerHTML = imageData ? `<img src="${esc(imageData)}" alt="" />` : "🪙";
  };
  $("#mImageFile").addEventListener("change", async (event) => {
    const file = event.target.files[0];
    if (!file) return;
    try {
      imageData = await readAvatarFile(file, 420);
      $("#mImageUrl").value = "";
      updatePreview();
    } catch (error) {
      alert(error.message);
    }
  });
  $("#mImageUrl").addEventListener("input", (event) => {
    imageData = event.target.value.trim();
    updatePreview();
  });

  $("#methodForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const errorBox = $("#methodError");
    errorBox.hidden = true;

    const payload = {
      label: $("#mLabel").value.trim(),
      kind: kind.value,
      asset: $("#mAsset").value.trim().toUpperCase() || "USDT",
      network: $("#mNetwork").value.trim(),
      address: $("#mAddress").value.trim(),
      instructions: $("#mInstructions").value.trim(),
      image: imageData || null,
      rateUsd: $("#mRate").value ? Number($("#mRate").value) : null,
      autoVerify: $("#mAuto").checked,
      enabled: $("#mEnabled").checked,
      sortOrder: Number($("#mSort").value) || 100,
    };
    if (!payload.label) return show(errorBox, "Give the method a name.");
    if (payload.kind === "crypto" && !payload.address) return show(errorBox, "Add the receiving address.");
    if (payload.kind === "binance" && !payload.address && !payload.image) {
      return show(errorBox, "Add a Binance Pay ID, a QR link, or a QR picture.");
    }

    try {
      if (isNew) {
        payload.id = $("#mId").value.trim() || payload.label.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 40);
        await api.post("/api/admin/payment-methods", payload);
      } else {
        await api.patch(`/api/admin/payment-methods/${encodeURIComponent(m.id)}`, payload);
      }
      close();
      await loadMethods();
    } catch (error) {
      show(errorBox, error.message);
    }
  });

  $("#mLabel").focus();
}

/* ---------------- messages ---------------- */
async function loadConversations(silent = false) {
  try {
    const { conversations } = await api.get("/api/admin/conversations");
    state.conversations = conversations || [];
    renderConversations();
    if (!silent) await loadStats();
  } catch (error) {
    if (!silent) $("#convList").innerHTML = `<p class="chat-empty">${esc(error.message)}</p>`;
  }
}

function renderConversations() {
  const box = $("#convList");
  const list = state.conversations;
  if (!list.length) {
    box.innerHTML = `<p class="chat-empty">No conversations yet.<br />Customers start them from their Messages page.</p>`;
    return;
  }
  box.innerHTML = list
    .map(
      (c) => `
      <button class="conv ${c.id === state.activeUserId ? "active" : ""}" type="button" data-conv="${c.id}">
        ${avatarHTML(c, 34)}
        <span class="who">
          <strong>${esc(c.name || c.email.split("@")[0])}</strong>
          <span>${esc(c.last_body || "No messages yet")}</span>
        </span>
        ${c.unread ? `<span class="dot" title="${c.unread} unread"></span>` : ""}
      </button>`
    )
    .join("");
}

function messageBubble(m, adminView) {
  const mine = m.sender === "admin";
  const cls = adminView ? (mine ? "customer" : "admin") : m.sender === "customer" ? "customer" : "admin";
  const when = m.createdAt
    ? new Date(m.createdAt.includes("T") ? m.createdAt : m.createdAt.replace(" ", "T") + "Z")
    : null;
  const label = when && !Number.isNaN(when.getTime())
    ? when.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })
    : "";
  return `<div class="bubble ${cls}">${esc(m.body)}<time>${esc(label)}</time></div>`;
}

async function openConversation(userId, email) {
  let id = userId;
  if (!id && email) {
    const match = state.customers.find((c) => c.email.toLowerCase() === email.toLowerCase());
    if (match) id = match.id;
  }
  if (!id) {
    switchTab("messages");
    return;
  }

  switchTab("messages");
  state.activeUserId = Number(id);
  renderConversations();
  $("#adminChatEmpty").hidden = true;
  $("#adminChatBody").hidden = false;
  $("#adminThread").innerHTML = `<p class="chat-empty">Loading…</p>`;
  $("#adminChatError").hidden = true;

  try {
    const data = await api.get(`/api/admin/conversations/${id}`);
    const user = data.user;
    $("#adminChatHead").innerHTML = `
      ${avatarHTML(user, 34)}
      <div style="flex:1;min-width:0">
        <strong>${esc(user.name || user.email.split("@")[0])}</strong>
        <span>${esc(user.email)}${user.contact_handle ? ` · ${esc(user.contact_type === "discord" ? "Discord" : "Telegram")}: ${esc(user.contact_handle)}` : ""}</span>
      </div>`;
    $("#adminThread").innerHTML = data.messages.length
      ? data.messages.map((m) => messageBubble(m, true)).join("")
      : `<p class="chat-empty">No messages in this thread yet. Say hello.</p>`;
    const thread = $("#adminThread");
    thread.scrollTop = thread.scrollHeight;
    await loadConversations(true);
    await loadStats();
  } catch (error) {
    $("#adminThread").innerHTML = `<p class="chat-empty">${esc(error.message)}</p>`;
  }
}

/* ---------------- emails ---------------- */
async function loadOutbox() {
  try {
    const data = await api.get("/api/admin/outbox");
    const stateBox = $("#smtpState");
    stateBox.textContent = data.smtpConfigured
      ? "SMTP is configured — password reset emails are sent for real."
      : "SMTP is not configured — password reset emails are saved here so you can copy the link by hand. Add SMTP settings to .env to send them automatically.";
    const box = $("#outboxList");
    const emails = data.emails || [];
    if (!emails.length) {
      box.innerHTML = `<p class="empty-row">No emails yet. Password reset links appear here when someone requests one.</p>`;
      return;
    }
    box.innerHTML = emails
      .map(
        (e) => `
      <div class="outbox-item">
        <div style="display:flex;gap:0.6rem;align-items:center;flex-wrap:wrap">
          <span class="pill ${e.status === "sent" ? "pill-paid" : e.status === "failed" ? "pill-cancelled" : "pill-pending"}">${esc(e.status)}</span>
          <strong style="flex:1;min-width:120px">${esc(e.subject)}</strong>
          <span class="muted">${esc(e.to_email)}</span>
          <span class="muted">${today(e.created_at)}</span>
        </div>
        ${e.error ? `<p class="pay-warning" style="margin:0.35rem 0 0">${esc(e.error)}</p>` : ""}
        <pre>${esc(e.body)}</pre>
      </div>`
      )
      .join("");
  } catch (error) {
    $("#outboxList").innerHTML = `<p class="empty-row">${esc(error.message)}</p>`;
  }
}

/* ---------------- CSV ---------------- */
function exportCustomers() {
  const header = ["email", "name", "role", "contact_type", "contact_handle", "orders", "spent", "products", "joined"];
  const rows = state.customers.map((c) => [
    c.email,
    c.name,
    c.role,
    c.contact_type || "",
    c.contact_handle || "",
    c.order_count,
    c.spent,
    c.products.map((p) => `${p.name} x${p.qty}`).join(" | "),
    c.created_at,
  ]);
  const csv = [header, ...rows]
    .map((row) => row.map((cell) => `"${String(cell ?? "").replace(/"/g, '""')}"`).join(","))
    .join("\r\n");
  const blob = new Blob(["\ufeff" + csv], { type: "text/csv;charset=utf-8" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = `customers-${new Date().toISOString().slice(0, 10)}.csv`;
  link.click();
  URL.revokeObjectURL(link.href);
}

/* ---------------- events ---------------- */
function bindEvents() {
  $("#signOutBtn").addEventListener("click", signOut);
  $("#exportBtn").addEventListener("click", exportCustomers);
  $("#newProductBtn").addEventListener("click", () => openEditor(null));
  $("#newCategoryBtn").addEventListener("click", () => openCategoryEditor(null));
  $("#newMethodBtn").addEventListener("click", () => openMethodEditor(null));
  $("#refreshOutbox").addEventListener("click", loadOutbox);

  document.querySelectorAll(".tab").forEach((tab) => {
    tab.addEventListener("click", () => switchTab(tab.dataset.tab));
  });

  let customerTimer;
  $("#customerSearch").addEventListener("input", () => {
    clearTimeout(customerTimer);
    customerTimer = setTimeout(loadCustomers, 250);
  });
  $("#customerProduct").addEventListener("change", loadCustomers);
  $("#customerRole").addEventListener("change", loadCustomers);

  let orderTimer;
  $("#orderSearch").addEventListener("input", () => {
    clearTimeout(orderTimer);
    orderTimer = setTimeout(loadOrders, 250);
  });
  $("#orderStatus").addEventListener("change", loadOrders);

  $("#binanceForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const note = $("#binanceSaved");
    note.textContent = "Saving…";
    try {
      await api.post("/api/admin/payment-settings", {
        binanceKey: $("#binanceKey").value.trim(),
        binanceSecret: $("#binanceSecret").value.trim(),
        binanceCertSn: $("#binanceCert").value.trim(),
      });
      note.textContent = "Saved ✓";
      await loadMethods();
    } catch (error) {
      note.textContent = error.message;
    }
    setTimeout(() => (note.textContent = ""), 3500);
  });

  $("#clearBinance").addEventListener("click", async () => {
    if (!confirm("Remove the saved Binance keys? The store will go back to sandbox mode.")) return;
    try {
      await api.post("/api/admin/payment-settings", { clearBinance: true });
      await loadMethods();
    } catch (error) {
      alert(error.message);
    }
  });

  $("#storeForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const note = $("#storeSaved");
    note.textContent = "Saving…";
    try {
      const data = await api.post("/api/admin/payment-settings", {
        codesVisible: $("#codesVisible").checked,
        deliveryNote: $("#deliveryNote").value.trim(),
        supportContact: $("#supportContact").value.trim(),
      });
      state.settings = data.settings || state.settings;
      note.textContent = "Saved ✓";
    } catch (error) {
      note.textContent = error.message;
    }
    setTimeout(() => (note.textContent = ""), 3500);
  });

  $("#adminChatForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const input = $("#adminChatInput");
    const button = $("#adminSendBtn");
    const body = input.value.trim();
    if (!body || !state.activeUserId) return;

    button.disabled = true;
    try {
      await api.post(`/api/admin/conversations/${state.activeUserId}`, { body });
      input.value = "";
      await openConversation(state.activeUserId);
    } catch (error) {
      const box = $("#adminChatError");
      box.textContent = error.message;
      box.hidden = false;
    }
    button.disabled = false;
  });

  $("#adminChatInput").addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      $("#adminChatForm").requestSubmit();
    }
  });

  document.addEventListener("change", async (event) => {
    const select = event.target.closest("[data-role-user]");
    if (!select) return;
    const id = Number(select.dataset.roleUser);
    select.disabled = true;
    try {
      await api.patch(`/api/admin/customers/${id}`, { role: select.value });
      await loadCustomers();
      await loadStats();
    } catch (error) {
      alert(error.message);
      select.disabled = false;
      await loadCustomers();
    }
  });

  document.addEventListener("click", async (event) => {
    const copyBtn = event.target.closest("[data-copy]");
    if (copyBtn) {
      try {
        await copyText(copyBtn.dataset.copy);
        const previous = copyBtn.textContent;
        copyBtn.textContent = "Copied";
        setTimeout(() => (copyBtn.textContent = previous), 1300);
      } catch {
        /* clipboard blocked */
      }
      return;
    }

    const showOrders = event.target.closest("[data-show-orders]");
    if (showOrders) {
      $("#orderSearch").value = showOrders.dataset.showOrders;
      switchTab("orders");
      await loadOrders();
      return;
    }

    const messageUser = event.target.closest("[data-message-user]");
    if (messageUser) {
      await openConversation(Number(messageUser.dataset.messageUser));
      return;
    }

    const manage = event.target.closest("[data-manage-order]");
    if (manage) {
      openOrderManager(manage.dataset.manageOrder);
      return;
    }

    const conv = event.target.closest("[data-conv]");
    if (conv) {
      await openConversation(Number(conv.dataset.conv));
      return;
    }

    const editMethod = event.target.closest("[data-edit-method]");
    if (editMethod) {
      const method = state.methods.find((m) => m.id === editMethod.dataset.editMethod);
      if (method) openMethodEditor(method);
      return;
    }

    const toggleMethod = event.target.closest("[data-toggle-method]");
    if (toggleMethod) {
      const method = state.methods.find((m) => m.id === toggleMethod.dataset.toggleMethod);
      if (!method) return;
      toggleMethod.disabled = true;
      try {
        await api.patch(`/api/admin/payment-methods/${encodeURIComponent(method.id)}`, {
          enabled: !method.enabled,
        });
        await loadMethods();
      } catch (error) {
        alert(error.message);
        toggleMethod.disabled = false;
      }
      return;
    }

    const editCategory = event.target.closest("[data-edit-category]");
    if (editCategory) {
      const category = categoryByName(editCategory.dataset.editCategory);
      if (category) openCategoryEditor(category);
      return;
    }

    const deleteCategory = event.target.closest("[data-delete-category]");
    if (deleteCategory) {
      const category = categoryByName(deleteCategory.dataset.deleteCategory);
      if (!category) return;
      if (!confirm(`Delete the category “${category.name}”?`)) return;
      deleteCategory.disabled = true;
      try {
        await api.del(`/api/admin/categories/${encodeURIComponent(category.name)}`);
        await Promise.all([loadCategories(), loadProducts()]);
      } catch (error) {
        alert(error.message);
        deleteCategory.disabled = false;
      }
      return;
    }

    const edit = event.target.closest("[data-edit-product]");
    if (edit) {
      const product = state.products.find((p) => p.id === edit.dataset.editProduct);
      if (product) openEditor(product);
      return;
    }

    const toggle = event.target.closest("[data-toggle-product]");
    if (toggle) {
      const product = state.products.find((p) => p.id === toggle.dataset.toggleProduct);
      if (!product) return;
      toggle.disabled = true;
      try {
        await api.patch(`/api/admin/products/${encodeURIComponent(product.id)}`, {
          active: !product.active,
        });
        await loadProducts();
      } catch (error) {
        alert(error.message);
        toggle.disabled = false;
      }
    }
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      ["#productModal", "#categoryModal", "#orderModal", "#methodModal"].forEach((sel) => {
        const modal = $(sel);
        if (modal) modal.remove();
      });
    }
  });
}
