/* Customer dashboard */

const $ = (s) => document.querySelector(s);

function animateMoney(el, target, symbol) {
  if (!el) return;
  const start = performance.now();
  const duration = 850;
  const from = 0;
  function frame(now) {
    const progress = Math.min(1, (now - start) / duration);
    const eased = 1 - Math.pow(1 - progress, 3);
    el.textContent = fmtMoney(from + (target - from) * eased, symbol);
    if (progress < 1) requestAnimationFrame(frame);
    else el.textContent = fmtMoney(target, symbol);
  }
  requestAnimationFrame(frame);
}

function statusPill(status) {
  return `<span class="status status-${esc(status)}">${esc(status)}</span>`;
}

(async function boot() {
  const user = await setupCustomerShell("overview", "Overview");
  if (!user) return;

  try {
    const [walletData, ordersData] = await Promise.all([api.get("/api/wallet"), api.get("/api/orders")]);
    render(walletData, ordersData.orders || [], user);
  } catch (error) {
    toast("Could not load your dashboard", "error", error.message);
  }
})();

function render(wallet, orders, user) {
  const summary = wallet.summary || {};
  const settings = wallet.settings || {};
  const sym = summary.symbol || settings.symbol || "$";
  const currency = summary.currency || settings.currency || "USD";

  animateMoney($("#balanceAmount"), summary.balance || 0, sym);
  $("#balanceSub").textContent =
    summary.pendingWithdrawals || summary.pendingTopups
      ? `${summary.pendingWithdrawals || 0} withdrawal(s) and ${summary.pendingTopups || 0} top-up(s) in review`
      : "Everything is settled. Ready to spend?";

  $("#footDeposited").textContent = fmtMoney(summary.deposited || 0, sym);
  $("#footWithdrawn").textContent = fmtMoney(summary.withdrawn || 0, sym);
  $("#footTx").textContent = summary.transactions || 0;
  $("#footPending").textContent = (summary.pendingWithdrawals || 0) + (summary.pendingTopups || 0);

  animateMoney($("#metricDeposited"), summary.deposited || 0, sym);
  animateMoney($("#metricWithdrawn"), summary.withdrawn || 0, sym);
  $("#metricPending").textContent = (summary.pendingWithdrawals || 0) + (summary.pendingTopups || 0);
  $("#metricPendingSub").textContent = summary.pendingWithdrawals
    ? `${summary.pendingWithdrawals} withdrawal(s) waiting`
    : summary.pendingTopups
      ? `${summary.pendingTopups} top-up(s) waiting`
      : "nothing waiting";
  $("#metricOrders").textContent = orders.length;

  $("#infoCurrency").textContent = `${currency} (${sym})`;
  $("#infoJoined").textContent = today(user.created_at);
  $("#infoContact").textContent = user.contact && user.contact.handle ? user.contact.handle : "—";
  $("#infoMin").textContent = fmtMoney(settings.minWithdraw || 0, sym);

  const series = wallet.series || [];
  ChartKit.area(
    $("#walletChart"),
    [
      { name: "Deposits", color: "#31e1c0", values: series.map((d) => d.deposits) },
      { name: "Withdrawals", color: "#7c5cff", values: series.map((d) => d.withdrawals) },
    ],
    series.map((d) => d.label)
  );

  renderNotifications(wallet.notifications || []);
  renderTransactions(wallet.transactions || [], sym);
  renderOrders(orders, sym);

  const mark = $("#dashMarkRead");
  if (mark) {
    mark.addEventListener("click", async () => {
      await api.post("/api/notifications/read", {});
      document.querySelectorAll(".notif.unread").forEach((el) => el.classList.remove("unread"));
      const badge = $("#notifBadge");
      if (badge) badge.hidden = true;
      mark.hidden = true;
      toast("Notifications marked as read", "success");
    });
  }
}

function renderNotifications(items) {
  const box = $("#dashNotifications");
  if (!box) return;
  if (!items.length) {
    box.innerHTML = `<div class="empty-state" style="padding:1.4rem"><span class="emoji">🔔</span><strong>No notifications yet</strong><p>We'll let you know about top-ups, withdrawals and messages.</p></div>`;
    return;
  }
  box.innerHTML = items
    .slice(0, 6)
    .map(
      (n) => `<div class="notif ${n.read ? "" : "unread"}">
        <span class="nicon">${notifIcon(n.type)}</span>
        <div><strong>${esc(n.title)}</strong>${n.body ? `<p>${esc(n.body)}</p>` : ""}<small>${timeAgo(n.createdAt)}</small></div>
      </div>`
    )
    .join("");
  const mark = $("#dashMarkRead");
  if (mark) mark.hidden = !items.some((n) => !n.read);
}

function renderTransactions(rows, sym) {
  const box = $("#recentTransactions");
  if (!rows.length) {
    box.innerHTML = `<div class="empty-state" style="padding:1.4rem"><span class="emoji">🧾</span><strong>No transactions yet</strong><p>Top up your balance to get started.</p></div>`;
    return;
  }
  box.innerHTML = rows
    .slice(0, 6)
    .map(
      (t) => `<div class="tx-row">
        <span class="txico ${t.direction === "credit" ? "in" : "out"}">${t.direction === "credit" ? "↓" : "↑"}</span>
        <span class="txmeta"><strong>${esc(t.label)}</strong><span>${today(t.createdAt)}${t.reference ? " · " + esc(t.reference) : ""}</span></span>
        <span class="txamount ${t.direction === "credit" ? "credit" : "debit"}">${t.direction === "credit" ? "+" : "−"}${fmtMoney(t.amount, t.symbol || sym)}<small>bal ${fmtMoney(t.balanceAfter, t.symbol || sym)}</small></span>
      </div>`
    )
    .join("");
}

function renderOrders(orders, sym) {
  const box = $("#recentOrders");
  if (!orders.length) {
    box.innerHTML = `<div class="empty-state" style="padding:1.4rem"><span class="emoji">🛍️</span><strong>No orders yet</strong><p><a href="/">Browse the store</a> and your first code lands instantly.</p></div>`;
    return;
  }
  box.innerHTML = orders
    .slice(0, 4)
    .map(
      (o) => `<a class="tx-row" href="/order.html?id=${encodeURIComponent(o.id)}" style="color:inherit;text-decoration:none">
        <span class="txico in">🧾</span>
        <span class="txmeta"><strong>${esc(o.id)}</strong><span>${today(o.createdAt)} · ${o.items.reduce((n, i) => n + i.qty, 0)} item(s)</span></span>
        <span class="txamount">${fmtMoney(o.total, sym)}<small>${esc(o.status)}</small></span>
      </a>`
    )
    .join("");
}
