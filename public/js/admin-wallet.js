/* ======================================================================
   Admin money operations: top-ups, withdrawals, settings, profiles.
   Loaded after admin.js — shares its globals (state, api, switchTab…).
   ====================================================================== */

function symbol() {
  return (window.SITE && window.SITE.wallet && window.SITE.wallet.symbol) || "$";
}

function customerCell(row) {
  return `<div class="who" style="min-width:0">
    <strong>${esc(row.customer || row.email || "Customer")}</strong>
    <span class="hint">${esc(row.email || "")} · #${row.userId}</span>
  </div>`;
}

/* ------------------------------- top-ups ------------------------------- */
async function loadTopups() {
  const params = new URLSearchParams();
  const q = $("#topupSearch").value.trim();
  const status = $("#topupStatus").value;
  if (q) params.set("q", q);
  if (status) params.set("status", status);
  const { topups } = await api.get(`/api/admin/topups?${params}`);
  state.topups = topups;
  renderTopups();
}

function renderTopups() {
  const body = $("#topupsBody");
  const list = state.topups;
  $("#topupCount").textContent = `${list.length} request${list.length === 1 ? "" : "s"}`;
  if (!list.length) {
    body.innerHTML = `<tr><td colspan="8" class="empty-row">
      <div class="empty-state" style="border:0;padding:1.6rem"><span class="emoji">🪙</span><strong>No top-up requests</strong><p>They will appear here the moment a customer asks to top up.</p></div>
    </td></tr>`;
    return;
  }
  body.innerHTML = list
    .map((t) => {
      const actionable = t.status === "pending";
      return `<tr>
        <td class="mono">${esc(t.id)}</td>
        <td>${customerCell(t)}</td>
        <td class="num"><strong>${fmtMoney(t.amount, t.symbol || symbol())}</strong></td>
        <td class="hide-sm">${esc(t.method || "manual")}${t.asset ? `<span class="hint"> · ${esc(t.asset)}</span>` : ""}</td>
        <td class="muted">${today(t.createdAt)}<span class="hint" style="display:block">${timeAgo(t.createdAt)}</span></td>
        <td><span class="status status-${esc(t.status)}">${esc(t.status)}</span></td>
        <td class="muted hide-md" style="max-width:200px">${esc(t.adminNote || t.customerNote || "—")}</td>
        <td style="white-space:nowrap">
          <button class="icon-btn-sm" type="button" data-review-topup="${esc(t.id)}">${actionable ? "Review" : "Details"}</button>
        </td>
      </tr>`;
    })
    .join("");
}

function openTopupReview(id) {
  const topup = state.topups.find((t) => t.id === id);
  if (!topup) return;
  const pending = topup.status === "pending";
  const body = `
    <div class="stack" style="gap:0.8rem">
      <div class="copy-field"><code>${esc(topup.id)}</code><button class="icon-btn-sm" type="button" data-copy="${esc(topup.id)}">Copy</button></div>
      <div class="grid-3">
        <div class="mini-stat"><span>Amount</span><strong>${fmtMoney(topup.amount, topup.symbol || symbol())}</strong></div>
        <div class="mini-stat"><span>Method</span><strong>${esc(topup.method || "manual")}</strong></div>
        <div class="mini-stat"><span>Status</span><strong>${esc(topup.status)}</strong></div>
      </div>
      <div class="glass" style="padding:0.8rem;border-radius:12px">
        <p class="hint">Customer</p>
        <p>${esc(topup.customer || topup.email)} · ID #${topup.userId}</p>
        <p class="hint" style="margin-top:0.4rem">Requested</p>
        <p>${today(topup.createdAt)} · ${timeAgo(topup.createdAt)}</p>
        ${topup.customerNote ? `<p class="hint" style="margin-top:0.4rem">Customer note</p><p>${esc(topup.customerNote)}</p>` : ""}
        ${topup.txid ? `<p class="hint" style="margin-top:0.4rem">Transaction</p><p class="mono" style="font-size:0.8rem;word-break:break-all">${esc(topup.txid)}</p>` : ""}
      </div>
      ${
        pending
          ? `<div class="field"><label for="reviewNote">Internal note <span class="hint">(optional)</span></label>
               <textarea id="reviewNote" placeholder="Paid via bank transfer, ref 883…"></textarea></div>
             <p class="form-error" id="reviewError" hidden></p>
             <div class="row">
               <button class="btn btn-primary" type="button" data-decide-topup="approve" data-topup-id="${esc(topup.id)}">Approve &amp; credit ${fmtMoney(topup.amount, topup.symbol || symbol())}</button>
               <button class="btn btn-danger" type="button" data-decide-topup="reject" data-topup-id="${esc(topup.id)}">Reject</button>
             </div>`
          : `<p class="hint">This request is already ${esc(topup.status)}. No further action is possible.</p>`
      }
    </div>`;
  openDialog(`Top-up ${topup.id}`, body);
}

async function decideTopup(id, approve) {
  const note = ($("#reviewNote") && $("#reviewNote").value.trim()) || "";
  const buttons = document.querySelectorAll("[data-decide-topup]");
  buttons.forEach((b) => (b.disabled = true));
  try {
    await api.post(`/api/admin/topups/${encodeURIComponent(id)}/decide`, { approve, note });
    toast(approve ? "Top-up approved" : "Top-up rejected", approve ? "success" : "info", "The customer has been notified.");
    closeDialog();
    await Promise.all([loadTopups(), loadStats()]);
  } catch (error) {
    const box = $("#reviewError");
    if (box) {
      box.textContent = error.message;
      box.hidden = false;
    } else {
      toast("Could not update top-up", "error", error.message);
    }
    buttons.forEach((b) => (b.disabled = false));
  }
}

/* ----------------------------- withdrawals ----------------------------- */
async function loadWithdrawals() {
  const params = new URLSearchParams();
  const q = $("#withdrawSearch").value.trim();
  if (q) params.set("q", q);
  if (state.withdrawStatus) params.set("status", state.withdrawStatus);
  const data = await api.get(`/api/admin/withdrawals?${params}`);
  state.withdrawals = data.withdrawals;
  const counts = data.counts || {};
  const map = {
    pending: "wCountPending",
    approved: "wCountApproved",
    processing: "wCountProcessing",
    completed: "wCountCompleted",
    rejected: "wCountRejected",
  };
  Object.entries(map).forEach(([key, elId]) => {
    const el = $(`#${elId}`);
    if (el) el.textContent = counts[key] ? `(${counts[key]})` : "";
  });
  renderWithdrawals();
}

function renderWithdrawals() {
  const body = $("#withdrawalsBody");
  const list = state.withdrawals;
  $("#withdrawCount").textContent = `${list.length} request${list.length === 1 ? "" : "s"}`;
  if (!list.length) {
    body.innerHTML = `<tr><td colspan="9" class="empty-row">
      <div class="empty-state" style="border:0;padding:1.6rem"><span class="emoji">💸</span><strong>No withdrawal requests</strong><p>Requests matching this filter will show up here.</p></div>
    </td></tr>`;
    return;
  }
  body.innerHTML = list
    .map(
      (w) => `<tr>
        <td class="mono">${esc(w.id)}</td>
        <td>${customerCell(w)}</td>
        <td class="num"><strong>${fmtMoney(w.amount, w.symbol || symbol())}</strong></td>
        <td class="hide-sm">${esc(w.methodLabel || w.method)}</td>
        <td class="muted hide-md" style="max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(w.details)}">${esc(w.details)}</td>
        <td class="muted">${today(w.createdAt)}<span class="hint" style="display:block">${timeAgo(w.createdAt)}</span></td>
        <td><span class="status status-${esc(w.status)}">${esc(w.status)}</span></td>
        <td class="num muted hide-md">${w.balance === null ? "—" : fmtMoney(w.balance, w.symbol || symbol())}</td>
        <td style="white-space:nowrap">
          <button class="icon-btn-sm" type="button" data-review-withdrawal="${esc(w.id)}">Manage</button>
        </td>
      </tr>`
    )
    .join("");
}

function openWithdrawalReview(id) {
  const w = state.withdrawals.find((x) => x.id === id);
  if (!w) return;
  const done = ["completed", "rejected"].includes(w.status);
  const actions = [];
  if (!done) {
    if (w.status === "pending") {
      actions.push(`<button class="btn btn-ghost" type="button" data-set-withdrawal="approved" data-withdrawal-id="${esc(w.id)}">Approve</button>`);
    }
    if (w.status !== "processing") {
      actions.push(`<button class="btn btn-ghost" type="button" data-set-withdrawal="processing" data-withdrawal-id="${esc(w.id)}">Mark processing</button>`);
    }
    actions.push(`<button class="btn btn-primary" type="button" data-set-withdrawal="completed" data-withdrawal-id="${esc(w.id)}">Mark completed</button>`);
    actions.push(`<button class="btn btn-danger" type="button" data-set-withdrawal="rejected" data-withdrawal-id="${esc(w.id)}">Reject &amp; refund</button>`);
  }
  const body = `
    <div class="stack" style="gap:0.8rem">
      <div class="copy-field"><code>${esc(w.id)}</code><button class="icon-btn-sm" type="button" data-copy="${esc(w.id)}">Copy</button></div>
      <div class="grid-3">
        <div class="mini-stat"><span>Amount</span><strong>${fmtMoney(w.amount, w.symbol || symbol())}</strong></div>
        <div class="mini-stat"><span>Method</span><strong>${esc(w.methodLabel || w.method)}</strong></div>
        <div class="mini-stat"><span>Available balance</span><strong>${w.balance === null ? "—" : fmtMoney(w.balance, w.symbol || symbol())}</strong></div>
      </div>
      <div class="glass" style="padding:0.8rem;border-radius:12px">
        <p class="hint">Customer</p>
        <p>${esc(w.customer || w.email)} · <a href="#" data-open-customer="${w.userId}">ID #${w.userId}</a></p>
        <p class="hint" style="margin-top:0.4rem">Payout details</p>
        <p class="mono" style="font-size:0.82rem;word-break:break-word">${esc(w.details)}</p>
        <p class="hint" style="margin-top:0.4rem">Requested</p>
        <p>${today(w.createdAt)} · ${timeAgo(w.createdAt)}</p>
        ${w.adminNote ? `<p class="hint" style="margin-top:0.4rem">Internal note</p><p>${esc(w.adminNote)}</p>` : ""}
      </div>
      <p class="hint">The amount is already reserved from the customer's balance. Rejecting returns it automatically.</p>
      ${
        done
          ? `<p class="hint">This request is ${esc(w.status)} and can't be changed.</p>`
          : `<div class="field"><label for="reviewNote">Internal note <span class="hint">(optional)</span></label>
              <textarea id="reviewNote" placeholder="Sent via PayPal, transaction 4XJ…"></textarea></div>
             <p class="form-error" id="reviewError" hidden></p>
             <div class="row">${actions.join("")}</div>`
      }
      <button class="btn btn-ghost btn-sm" type="button" data-view-customer-tx="${w.userId}">View customer transactions</button>
    </div>`;
  openDialog(`Withdrawal ${w.id}`, body);
}

async function setWithdrawal(id, status) {
  const note = ($("#reviewNote") && $("#reviewNote").value.trim()) || "";
  const buttons = document.querySelectorAll("[data-set-withdrawal]");
  buttons.forEach((b) => (b.disabled = true));
  try {
    await api.patch(`/api/admin/withdrawals/${encodeURIComponent(id)}`, { status, adminNote: note });
    toast(
      `Withdrawal ${status}`,
      status === "rejected" ? "info" : "success",
      status === "rejected" ? "The reserved amount was returned." : "The customer has been notified."
    );
    closeDialog();
    await Promise.all([loadWithdrawals(), loadStats()]);
  } catch (error) {
    const box = $("#reviewError");
    if (box) {
      box.textContent = error.message;
      box.hidden = false;
    } else {
      toast("Could not update withdrawal", "error", error.message);
    }
    buttons.forEach((b) => (b.disabled = false));
  }
}

/* ------------------------------- settings ------------------------------ */
async function loadSettings() {
  const data = await api.get("/api/admin/settings");
  state.settingsData = data;
  $("#setMinWithdraw").value = Number(data.financial.minWithdraw).toFixed(2);
  fillWithdrawMin(data.financial);
  $("#setMinTopup").value = Number(data.financial.minTopup).toFixed(2);
  $("#setCurrency").value = data.financial.currency;
  $("#setSymbol").value = data.financial.symbol;
  $("#setManualApproval").checked = !!data.financial.manualTopupApproval;

  $("#setTelegramUsername").value = data.contact.telegramUsername || "";
  $("#setTelegramLink").value = data.contact.telegramLink || "";
  $("#setDiscordLink").value = data.contact.discordLink || "";
  $("#setSupportContact").value = data.contact.supportContact || "";

  $("#setChatId").value = data.notifications.telegramChatId || "";
  $("#setBotToken").value = "";
  $("#setWebhook").value = "";
  $("#botTokenState").textContent = data.notifications.telegramTokenSet
    ? "Token saved — leave blank to keep it"
    : "Not configured";
  $("#webhookState").textContent = data.notifications.discordWebhookSet
    ? "Webhook saved — leave blank to keep it"
    : "Not configured";

  $("#notifyEvents").innerHTML = Object.entries(data.notifications.eventLabels || {})
    .map(
      ([event, label]) => `<label class="check notif-check">
        <input type="checkbox" data-notify-event="${event}" ${data.notifications.events[event] ? "checked" : ""} />
        <span>${esc(label)}</span>
      </label>`
    )
    .join("");

  $("#setAppName").value = data.general.appName;
  $("#setLogo").value = data.general.logo;
  $("#setAccent").value = data.general.accent;
  $("#setMaintenance").checked = !!data.general.maintenance;
  $("#setResetHours").value = data.security.resetHours;

  renderWithdrawalMethods(data.withdrawalMethods || []);
  renderNotifyLog(data.log || []);
}

function fillWithdrawMin(financial) {
  if (!financial) return;
  const input = $("#wdMinWithdraw");
  if (input) input.value = Number(financial.minWithdraw).toFixed(2);
  const sym = $("#wdMinSymbol");
  if (sym) sym.textContent = financial.symbol || "$";
}

async function loadWithdrawMin() {
  try {
    const data = await api.get("/api/admin/settings");
    state.settingsData = data;
    fillWithdrawMin(data.financial);
  } catch {
    /* the list still works without the hint */
  }
}

function renderWithdrawalMethods(methods) {
  const box = $("#withdrawMethodsBody");
  if (!box) return;
  if (!methods.length) {
    box.innerHTML = `<div class="empty-state" style="padding:1.2rem"><span class="emoji">🏦</span><strong>No methods</strong><p>Add PayPal, USDT, bank transfer…</p></div>`;
    return;
  }
  box.innerHTML = methods
    .map(
      (m) => `<div class="method-row">
        <span class="dotmark ${m.enabled ? "on" : ""}"></span>
        <div class="who" style="flex:1;min-width:0">
          <strong>${esc(m.label)}</strong>
          <span class="hint">${esc(m.detailsLabel)} · min ${fmtMoney((m.minWithdrawCents || 0) / 100, symbol())}</span>
        </div>
        <button class="icon-btn-sm" type="button" data-toggle-wmethod="${esc(m.id)}" data-enabled="${m.enabled ? 1 : 0}">${m.enabled ? "Disable" : "Enable"}</button>
        <button class="icon-btn-sm" type="button" data-delete-wmethod="${esc(m.id)}">Delete</button>
      </div>`
    )
    .join("");
}

function renderNotifyLog(rows) {
  const box = $("#notifyLog");
  if (!box) return;
  if (!rows.length) {
    box.innerHTML = `<p class="hint">No notifications sent yet.</p>`;
    return;
  }
  box.innerHTML = rows
    .map(
      (r) => `<div class="tx-row" style="padding:0.5rem 0.7rem">
        <span class="txico ${r.ok ? "in" : "out"}">${r.ok ? "✓" : "!"}</span>
        <span class="txmeta"><strong>${esc(r.channel)} · ${esc(r.event)}</strong><span>${esc((r.detail || "").slice(0, 90))}</span></span>
        <span class="hint">${timeAgo(r.created_at)}</span>
      </div>`
    )
    .join("");
}

async function saveSettings(payload, noteEl) {
  if (noteEl) noteEl.textContent = "Saving…";
  try {
    const data = await api.post("/api/admin/settings", payload);
    state.settingsData = data;
    if (noteEl) noteEl.textContent = "Saved ✓";
    toast("Settings saved", "success");
    setTimeout(() => noteEl && (noteEl.textContent = ""), 3000);
    await loadSite();
    return true;
  } catch (error) {
    if (noteEl) noteEl.textContent = error.message;
    toast("Could not save", "error", error.message);
    return false;
  }
}

/* --------------------------- customer profile -------------------------- */
async function openCustomerProfile(userId) {
  state.profileTab = "overview";
  state.profile = null;
  const modal = $("#customerModal");
  modal.hidden = false;
  document.body.classList.add("no-scroll");
  $("#cmBody").innerHTML = `<div class="skeleton skeleton-row"></div><div class="skeleton skeleton-row"></div><div class="skeleton skeleton-row"></div>`;
  try {
    const { customer } = await api.get(`/api/admin/customers/${userId}`);
    state.profile = customer;
    renderProfileHead();
    renderProfileTab();
  } catch (error) {
    $("#cmBody").innerHTML = `<p class="form-error">${esc(error.message)}</p>`;
  }
}

function closeCustomerProfile() {
  $("#customerModal").hidden = true;
  document.body.classList.remove("no-scroll");
}

function renderProfileHead() {
  const c = state.profile;
  $("#cmHead").innerHTML = `${avatarHTML(c, 48)}
    <div class="who">
      <strong id="cmTitle">${esc(c.name || c.email.split("@")[0])}</strong>
      <span id="cmSub">${esc(c.email)} · ID #${c.id} · ${esc(c.status)}</span>
    </div>`;
}

function profileTabs() {
  document.querySelectorAll("[data-cm-tab]").forEach((btn) => {
    btn.setAttribute("aria-selected", String(btn.dataset.cmTab === state.profileTab));
  });
}

function renderProfileTab() {
  const c = state.profile;
  if (!c) return;
  profileTabs();
  const box = $("#cmBody");
  const s = c.wallet || {};
  const sym = s.symbol || symbol();

  if (state.profileTab === "overview") {
    box.innerHTML = `
      <div class="metric-grid" style="grid-template-columns:repeat(auto-fit,minmax(130px,1fr))">
        <div class="mini-stat"><span>Balance</span><strong>${fmtMoney(s.balance || 0, sym)}</strong></div>
        <div class="mini-stat"><span>Deposited</span><strong>${fmtMoney(s.deposited || 0, sym)}</strong></div>
        <div class="mini-stat"><span>Withdrawn</span><strong>${fmtMoney(s.withdrawn || 0, sym)}</strong></div>
        <div class="mini-stat"><span>Transactions</span><strong>${s.transactions || 0}</strong></div>
      </div>
      <div class="grid-2" style="margin-top:0.9rem">
        <div class="glass" style="padding:0.9rem">
          <h3 style="font-size:0.9rem;margin-bottom:0.6rem">Customer</h3>
          <p class="hint">Joined</p><p>${today(c.created_at)}</p>
          <p class="hint" style="margin-top:0.5rem">Last login</p><p>${c.last_login ? today(c.last_login) : "Never"}</p>
          <p class="hint" style="margin-top:0.5rem">Contact</p><p>${c.contact_handle ? `${esc(c.contact_type || "telegram")}: ${esc(c.contact_handle)}` : "—"}</p>
          <p class="hint" style="margin-top:0.5rem">Role</p><p>${esc(c.role)}</p>
        </div>
        <div class="glass" style="padding:0.9rem">
          <h3 style="font-size:0.9rem;margin-bottom:0.4rem">Recent transactions</h3>
          ${txList(c.recentTransactions || [])}
        </div>
      </div>`;
    return;
  }

  if (state.profileTab === "topups") {
    box.innerHTML = tableHTML(
      ["Reference", "Amount", "Method", "Date", "Status"],
      (c.recentTopups || []).length
        ? c.recentTopups
            .map(
              (t) => `<tr><td class="mono">${esc(t.id)}</td><td class="num">${fmtMoney(t.amount, t.symbol || sym)}</td>
                <td>${esc(t.method || "manual")}</td><td class="muted">${today(t.createdAt)}</td>
                <td><span class="status status-${esc(t.status)}">${esc(t.status)}</span></td></tr>`
            )
            .join("")
        : emptyRow(5, "No top-ups yet", "Approved top-ups will be listed here.")
    );
    return;
  }

  if (state.profileTab === "withdrawals") {
    box.innerHTML = tableHTML(
      ["Reference", "Amount", "Method", "Date", "Status"],
      (c.recentWithdrawals || []).length
        ? c.recentWithdrawals
            .map(
              (w) => `<tr><td class="mono">${esc(w.id)}</td><td class="num">${fmtMoney(w.amount, w.symbol || sym)}</td>
                <td>${esc(w.methodLabel || w.method)}</td><td class="muted">${today(w.createdAt)}</td>
                <td><span class="status status-${esc(w.status)}">${esc(w.status)}</span></td></tr>`
            )
            .join("")
        : emptyRow(5, "No withdrawals yet", "Customer payout requests appear here.")
    );
    return;
  }

  if (state.profileTab === "transactions") {
    box.innerHTML = `<div id="cmTx"><div class="skeleton skeleton-row"></div><div class="skeleton skeleton-row"></div></div>`;
    loadProfileTransactions(c.id);
    return;
  }

  if (state.profileTab === "account") {
    box.innerHTML = `
      <div class="grid-2">
        <form class="glass" style="padding:1rem" id="cmPasswordForm">
          <h3 style="font-size:0.92rem;margin-bottom:0.2rem">Change password</h3>
          <p class="hint" style="margin-bottom:0.8rem">Sets a new password immediately and invalidates every reset link.</p>
          <div class="field"><label for="cmPassword">New password</label><input type="password" id="cmPassword" autocomplete="new-password" placeholder="At least 8 characters" /></div>
          <button class="btn btn-primary btn-sm" type="submit">Update password</button>
          <span class="hint" id="cmPasswordState"></span>
        </form>

        <div class="glass" style="padding:1rem">
          <h3 style="font-size:0.92rem;margin-bottom:0.2rem">Password reset link</h3>
          <p class="hint" style="margin-bottom:0.8rem">Single use and time limited. Generating a new link revokes older ones.</p>
          <div class="row" style="margin-bottom:0.7rem">
            <button class="btn btn-primary btn-sm" type="button" data-new-reset="${c.id}">Generate link</button>
            <button class="btn btn-ghost btn-sm" type="button" data-new-reset-channel="${c.id}" data-channel="telegram">Send Telegram</button>
            <button class="btn btn-ghost btn-sm" type="button" data-new-reset-channel="${c.id}" data-channel="discord">Send Discord</button>
          </div>
          <div id="cmResetResult"></div>
          <div id="cmResetLinks">${resetLinksHTML(c.resetLinks || [])}</div>
        </div>
      </div>

      <div class="glass" style="padding:1rem;margin-top:0.9rem">
        <h3 style="font-size:0.92rem;margin-bottom:0.6rem">Account status</h3>
        <div class="row">
          <span class="status status-${esc(c.status)}">${esc(c.status)}</span>
          <button class="btn ${c.status === "active" ? "btn-danger" : "btn-primary"} btn-sm" type="button" data-toggle-status="${c.id}" data-next="${c.status === "active" ? "suspended" : "active"}">
            ${c.status === "active" ? "Suspend account" : "Reactivate account"}
          </button>
          <span class="spacer" style="flex:1"></span>
          <label class="hint" for="cmRole">Role</label>
          <select id="cmRole" data-role-user="${c.id}" style="max-width:150px">
            <option value="customer" ${c.role === "customer" ? "selected" : ""}>Customer</option>
            <option value="admin" ${c.role === "admin" ? "selected" : ""}>Admin</option>
          </select>
        </div>
      </div>`;
  }
}

function txList(rows) {
  if (!rows.length) return `<p class="hint">No transactions yet.</p>`;
  return rows
    .map(
      (t) => `<div class="tx-row" style="padding:0.45rem 0">
        <span class="txico ${t.direction === "credit" ? "in" : "out"}">${t.direction === "credit" ? "+" : "−"}</span>
        <span class="txmeta"><strong>${esc(t.label)}</strong><span>${today(t.createdAt)} · bal ${fmtMoney(t.balanceAfter, t.symbol)}</span></span>
        <span class="txamount ${t.direction === "credit" ? "credit" : "debit"}">${t.direction === "credit" ? "+" : "−"}${fmtMoney(t.amount, t.symbol)}</span>
      </div>`
    )
    .join("");
}

function resetLinksHTML(links) {
  if (!links.length) return `<p class="hint">No reset links generated yet.</p>`;
  return links
    .map(
      (l) => `<div class="link-row">
        <span class="status status-${l.state === "active" ? "pending" : l.state === "used" ? "completed" : "rejected"}">${esc(l.state)}</span>
        <span class="hint">${today(l.createdAt)}${l.channel ? " · " + esc(l.channel) : ""}</span>
      </div>`
    )
    .join("");
}

function tableHTML(headers, rows) {
  return `<div class="table-wrap"><table class="data-table"><thead><tr>${headers
    .map((h) => `<th>${esc(h)}</th>`)
    .join("")}</tr></thead><tbody>${rows}</tbody></table></div>`;
}

function emptyRow(cols, title, body) {
  return `<tr><td colspan="${cols}"><div class="empty-state" style="border:0"><span class="emoji">🗂️</span><strong>${esc(title)}</strong><p>${esc(body)}</p></div></td></tr>`;
}

async function loadProfileTransactions(userId) {
  try {
    const { transactions, total } = await api.get(`/api/admin/customers/${userId}/transactions?limit=100`);
    const box = $("#cmTx");
    if (!box) return;
    box.innerHTML = `<p class="hint" style="margin-bottom:0.4rem">${total} ledger entr${total === 1 ? "y" : "ies"}</p>` + tableHTML(
      ["Type", "Amount", "Before", "After", "Date", "Reference"],
      transactions.length
        ? transactions
            .map(
              (t) => `<tr>
                <td>${esc(t.label)}<span class="hint"> · ${esc(t.direction)}</span></td>
                <td class="num ${t.direction === "credit" ? "credit" : "debit"}">${t.direction === "credit" ? "+" : "−"}${fmtMoney(t.amount, t.symbol)}</td>
                <td class="num muted">${fmtMoney(t.balanceBefore, t.symbol)}</td>
                <td class="num muted">${fmtMoney(t.balanceAfter, t.symbol)}</td>
                <td class="muted">${today(t.createdAt)}</td>
                <td class="mono muted">${esc(t.reference || "—")}</td>
              </tr>`
            )
            .join("")
        : emptyRow(6, "No transactions", "This customer has no money movements yet.")
    );
  } catch (error) {
    const box = $("#cmTx");
    if (box) box.innerHTML = `<p class="form-error">${esc(error.message)}</p>`;
  }
}

async function generateResetLink(userId, channel) {
  try {
    const data = await api.post(`/api/admin/customers/${userId}/reset-link`, channel ? { channel } : {});
    const box = $("#cmResetResult");
    if (box) {
      box.innerHTML = `
        <div class="copy-field"><code>${esc(data.link)}</code>
          <button class="icon-btn-sm" type="button" data-copy="${esc(data.link)}">Copy</button></div>
        <p class="hint" style="margin-top:0.4rem">Expires ${new Date(data.expiresAt * 1000).toLocaleString()}${
          data.sent && data.sent.ok ? " · sent ✓" : data.sent && data.sent.error ? ` · ${esc(data.sent.error)}` : ""
        }</p>`;
    }
    if (state.profile && state.profile.id === userId) {
      state.profile.resetLinks = data.links;
      const linksBox = $("#cmResetLinks");
      if (linksBox) linksBox.innerHTML = resetLinksHTML(data.links || []);
    }
    if (data.sent && data.sent.ok) toast("Reset link sent", "success");
    else if (data.sent && data.sent.error) toast("Link generated", "info", data.sent.error);
    else toast("Reset link generated", "success", "Copy it and send it to the customer.");
  } catch (error) {
    toast("Could not create link", "error", error.message);
  }
}

/* ------------------------------ dialogs -------------------------------- */
function openDialog(title, html) {
  const modal = $("#dialogModal");
  $("#dialogTitle").textContent = title;
  $("#dialogBody").innerHTML = html;
  modal.hidden = false;
  document.body.classList.add("no-scroll");
}

function closeDialog() {
  const modal = $("#dialogModal");
  if (modal) modal.hidden = true;
  if ($("#customerModal") && !$("#customerModal").hidden) return;
  document.body.classList.remove("no-scroll");
}

/* ------------------------------ events --------------------------------- */
function bindWalletEvents() {
  const side = $("#side");
  const scrim = $("#sideScrim");
  const toggle = $("#sideToggle");
  if (toggle) {
    toggle.addEventListener("click", () => {
      side.classList.add("open");
      scrim.classList.add("show");
    });
  }
  if (scrim) scrim.addEventListener("click", closeSidebar);

  const refresh = $("#refreshBtn");
  if (refresh) {
    refresh.addEventListener("click", async () => {
      toast("Refreshing…", "info");
      await Promise.all([loadStats(), loadCustomers()]);
    });
  }

  document.querySelectorAll("[data-close-modal]").forEach((btn) =>
    btn.addEventListener("click", () => {
      closeDialog();
      closeCustomerProfile();
    })
  );
  ["#customerModal", "#dialogModal"].forEach((sel) => {
    const modal = $(sel);
    if (!modal) return;
    modal.addEventListener("click", (event) => {
      if (event.target !== modal) return;
      if (sel === "#customerModal") closeCustomerProfile();
      else closeDialog();
    });
  });

  const topupSearch = $("#topupSearch");
  if (topupSearch) {
    let topupTimer;
    topupSearch.addEventListener("input", () => {
      clearTimeout(topupTimer);
      topupTimer = setTimeout(loadTopups, 250);
    });
    $("#topupStatus").addEventListener("change", loadTopups);
  }

  const withdrawSearch = $("#withdrawSearch");
  if (withdrawSearch) {
    let withdrawTimer;
    withdrawSearch.addEventListener("input", () => {
      clearTimeout(withdrawTimer);
      withdrawTimer = setTimeout(loadWithdrawals, 250);
    });
    $("#withdrawTabs").addEventListener("click", (event) => {
      const button = event.target.closest("[data-wstatus]");
      if (!button) return;
      state.withdrawStatus = button.dataset.wstatus;
      document.querySelectorAll("[data-wstatus]").forEach((b) =>
        b.setAttribute("aria-selected", String(b === button))
      );
      loadWithdrawals();
    });
  }

  document.querySelectorAll("[data-jump]").forEach((el) =>
    el.addEventListener("click", (event) => {
      event.preventDefault();
      switchTab(el.dataset.jump);
    })
  );

  document.querySelectorAll("[data-cm-tab]").forEach((btn) =>
    btn.addEventListener("click", () => {
      state.profileTab = btn.dataset.cmTab;
      renderProfileTab();
    })
  );

  const financialForm = $("#financialForm");
  if (financialForm) {
    financialForm.addEventListener("submit", (event) => {
      event.preventDefault();
      saveSettings(
        {
          minWithdraw: $("#setMinWithdraw").value,
          minTopup: $("#setMinTopup").value,
          currency: $("#setCurrency").value,
          currencySymbol: $("#setSymbol").value,
          manualTopupApproval: $("#setManualApproval").checked,
        },
        $("#financialSaved")
      );
    });
  }

  const withdrawMinForm = $("#withdrawMinForm");
  if (withdrawMinForm) {
    withdrawMinForm.addEventListener("submit", async (event) => {
      event.preventDefault();
      const ok = await saveSettings(
        { minWithdraw: $("#wdMinWithdraw").value },
        $("#wdMinSaved")
      );
      if (ok && state.settingsData) {
        fillWithdrawMin(state.settingsData.financial);
        renderWithdrawalMethods(state.settingsData.withdrawalMethods || []);
        await loadWithdrawals();
      }
    });
  }

  const contactForm = $("#contactForm");
  if (contactForm) {
    contactForm.addEventListener("submit", (event) => {
      event.preventDefault();
      saveSettings(
        {
          telegramUsername: $("#setTelegramUsername").value,
          telegramLink: $("#setTelegramLink").value,
          discordLink: $("#setDiscordLink").value,
          supportContact: $("#setSupportContact").value,
        },
        $("#contactSaved")
      );
    });
  }

  const notifyForm = $("#notifyForm");
  if (notifyForm) {
    notifyForm.addEventListener("submit", (event) => {
      event.preventDefault();
      const payload = {
        telegramAdminChatId: $("#setChatId").value,
        telegramBotToken: $("#setBotToken").value,
        discordWebhookUrl: $("#setWebhook").value,
      };
      document.querySelectorAll("[data-notify-event]").forEach((input) => {
        payload[`notify_${input.dataset.notifyEvent}`] = input.checked;
      });
      saveSettings(payload, $("#notifySaved")).then(() => {
        $("#setBotToken").value = "";
        $("#setWebhook").value = "";
        loadSettings();
      });
    });
  }

  document.querySelectorAll("[data-test-notify]").forEach((btn) =>
    btn.addEventListener("click", async () => {
      const box = $("#notifyTestResult");
      box.textContent = "Sending…";
      try {
        const result = await api.post("/api/admin/settings/test", { channel: btn.dataset.testNotify });
        box.textContent = result.ok ? "Test delivered ✓" : `Failed: ${result.detail || "check the settings"}`;
        box.style.color = result.ok ? "var(--ok)" : "var(--danger)";
      } catch (error) {
        box.textContent = error.message;
        box.style.color = "var(--danger)";
      }
    })
  );

  const generalForm = $("#generalForm");
  if (generalForm) {
    generalForm.addEventListener("submit", (event) => {
      event.preventDefault();
      saveSettings(
        {
          appName: $("#setAppName").value,
          logo: $("#setLogo").value,
          accent: $("#setAccent").value,
          maintenance: $("#setMaintenance").checked,
          resetHours: $("#setResetHours").value,
        },
        $("#generalSaved")
      );
    });
  }

  const withdrawMethodForm = $("#withdrawMethodForm");
  if (withdrawMethodForm) {
    withdrawMethodForm.addEventListener("submit", async (event) => {
      event.preventDefault();
      const label = $("#wmLabel").value.trim();
      if (!label) return;
      try {
        await api.post("/api/admin/withdrawal-methods", {
          label,
          detailsLabel: $("#wmDetailsLabel").value.trim() || "Account details",
        });
        $("#wmLabel").value = "";
        $("#wmDetailsLabel").value = "";
        $("#wmSaved").textContent = "Added ✓";
        const data = await api.get("/api/admin/settings");
        renderWithdrawalMethods(data.withdrawalMethods || []);
        setTimeout(() => ($("#wmSaved").textContent = ""), 2500);
      } catch (error) {
        $("#wmSaved").textContent = error.message;
      }
    });
  }
}

/* -------------------- delegated clicks / submits ----------------------- */
document.addEventListener("click", async (event) => {
  const openCustomer = event.target.closest("[data-open-customer]");
  if (openCustomer) {
    event.preventDefault();
    openCustomerProfile(Number(openCustomer.dataset.openCustomer));
    return;
  }

  const reviewTopup = event.target.closest("[data-review-topup]");
  if (reviewTopup) {
    openTopupReview(reviewTopup.dataset.reviewTopup);
    return;
  }

  const decide = event.target.closest("[data-decide-topup]");
  if (decide) {
    await decideTopup(decide.dataset.topupId, decide.dataset.decideTopup === "approve");
    return;
  }

  const reviewWithdrawal = event.target.closest("[data-review-withdrawal]");
  if (reviewWithdrawal) {
    openWithdrawalReview(reviewWithdrawal.dataset.reviewWithdrawal);
    return;
  }

  const setW = event.target.closest("[data-set-withdrawal]");
  if (setW) {
    await setWithdrawal(setW.dataset.withdrawalId, setW.dataset.setWithdrawal);
    return;
  }

  const viewTx = event.target.closest("[data-view-customer-tx]");
  if (viewTx) {
    closeDialog();
    await openCustomerProfile(Number(viewTx.dataset.viewCustomerTx));
    state.profileTab = "transactions";
    renderProfileTab();
    return;
  }

  const newReset = event.target.closest("[data-new-reset]");
  if (newReset) {
    await generateResetLink(Number(newReset.dataset.newReset), null);
    return;
  }

  const newResetChannel = event.target.closest("[data-new-reset-channel]");
  if (newResetChannel) {
    await generateResetLink(Number(newResetChannel.dataset.newResetChannel), newResetChannel.dataset.channel);
    return;
  }

  const toggleStatus = event.target.closest("[data-toggle-status]");
  if (toggleStatus) {
    const id = Number(toggleStatus.dataset.toggleStatus);
    const next = toggleStatus.dataset.next;
    if (next === "suspended" && !confirm("Suspend this account? The customer is signed out and cannot sign in.")) return;
    toggleStatus.disabled = true;
    try {
      await api.patch(`/api/admin/customers/${id}/status`, { status: next });
      toast(next === "suspended" ? "Account suspended" : "Account reactivated", "success");
      await openCustomerProfile(id);
      await loadCustomers();
    } catch (error) {
      toast("Could not update account", "error", error.message);
      toggleStatus.disabled = false;
    }
    return;
  }

  const toggleW = event.target.closest("[data-toggle-wmethod]");
  if (toggleW) {
    toggleW.disabled = true;
    try {
      const row = toggleW.closest(".method-row");
      const label = row.querySelector("strong").textContent;
      const detailsLabel = row.querySelector(".hint").textContent.split(" · ")[0];
      await api.post("/api/admin/withdrawal-methods", {
        id: toggleW.dataset.toggleWmethod,
        label,
        detailsLabel,
        enabled: toggleW.dataset.enabled !== "1",
      });
      const data = await api.get("/api/admin/settings");
      renderWithdrawalMethods(data.withdrawalMethods || []);
    } catch (error) {
      toast("Could not update method", "error", error.message);
      toggleW.disabled = false;
    }
    return;
  }

  const deleteW = event.target.closest("[data-delete-wmethod]");
  if (deleteW) {
    if (!confirm("Disable this withdrawal method?")) return;
    deleteW.disabled = true;
    try {
      await api.del(`/api/admin/withdrawal-methods/${encodeURIComponent(deleteW.dataset.deleteWmethod)}`);
      const data = await api.get("/api/admin/settings");
      renderWithdrawalMethods(data.withdrawalMethods || []);
      toast("Method disabled", "success");
    } catch (error) {
      toast("Could not disable method", "error", error.message);
      deleteW.disabled = false;
    }
  }
});

document.addEventListener("submit", async (event) => {
  if (event.target.id !== "cmPasswordForm") return;
  event.preventDefault();
  const id = state.profile.id;
  const password = $("#cmPassword").value;
  const stateEl = $("#cmPasswordState");
  if (password.length < 8) {
    stateEl.textContent = "Use at least 8 characters.";
    stateEl.style.color = "var(--danger)";
    return;
  }
  stateEl.textContent = "Saving…";
  stateEl.style.color = "var(--muted)";
  try {
    await api.post(`/api/admin/customers/${id}/password`, { password });
    stateEl.textContent = "Password updated ✓";
    stateEl.style.color = "var(--ok)";
    $("#cmPassword").value = "";
    toast("Password changed", "success", "Every reset link was invalidated.");
  } catch (error) {
    stateEl.textContent = error.message;
    stateEl.style.color = "var(--danger)";
  }
});

document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  if ($("#customerModal") && !$("#customerModal").hidden) closeCustomerProfile();
  if ($("#dialogModal") && !$("#dialogModal").hidden) closeDialog();
});
