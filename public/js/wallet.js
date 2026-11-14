/* Customer wallet: overview, top-ups, withdrawals and the ledger. */

const $ = (s) => document.querySelector(s);

const walletState = {
  data: null,
  topups: [],
  withdrawals: [],
  settings: {},
  summary: {},
  symbol: "$",
  topupMethod: "manual",
  withdrawMethod: "",
  tab: "overview",
  tx: { rows: [], total: 0, offset: 0, kind: "", loading: false },
};

/* ------------------------------------------------------------------- boot */
(async function boot() {
  const user = await setupCustomerShell("wallet", "Wallet");
  if (!user) return;
  bindTabs();
  bindTopup();
  bindWithdraw();
  bindTransactions();
  bindDelegates();
  await refresh();
  applyHash();
  window.addEventListener("hashchange", applyHash);
})();

async function refresh() {
  try {
    const [data, topupData, withdrawData] = await Promise.all([
      api.get("/api/wallet"),
      api.get("/api/wallet/topups"),
      api.get("/api/wallet/withdrawals"),
    ]);
    walletState.data = data;
    walletState.topups = topupData.topups || [];
    walletState.withdrawals = withdrawData.withdrawals || [];
    walletState.settings = data.settings || {};
    walletState.summary = data.summary || {};
    walletState.symbol = walletState.summary.symbol || walletState.settings.symbol || "$";
    renderSummary();
    renderTopupMethods();
    renderWithdrawMethods();
    renderTopupHistory();
    renderWithdrawHistory();
    renderOverview();
    await loadTransactions(true);
  } catch (error) {
    toast("Could not load your wallet", "error", error.message);
  }
}

/* --------------------------------------------------------------- rendering */
function renderSummary() {
  const s = walletState.summary;
  const sym = walletState.symbol;
  $("#balanceAmount").textContent = fmtMoney(s.balance || 0, sym);
  $("#balanceSub").textContent =
    s.pendingWithdrawals || s.pendingTopups
      ? `${s.pendingWithdrawals || 0} withdrawal(s) and ${s.pendingTopups || 0} top-up(s) in review`
      : "Everything is settled. Ready to top up?";
  $("#footDeposited").textContent = fmtMoney(s.deposited || 0, sym);
  $("#footWithdrawn").textContent = fmtMoney(s.withdrawn || 0, sym);
  $("#footPendingW").textContent = s.pendingWithdrawals || 0;
  $("#footPendingT").textContent = s.pendingTopups || 0;
  $("#footTx").textContent = s.transactions || 0;

  document.querySelectorAll("[data-symbol]").forEach((el) => (el.textContent = sym));
  $("#withdrawAvailable").textContent = fmtMoney(s.balance || 0, sym);

  const minTopup = Number(walletState.settings.minTopup || 0);
  const minWithdraw = Number(walletState.settings.minWithdraw || 0);
  $("#topupMinHint").textContent = minTopup ? `Minimum ${fmtMoney(minTopup, sym)}` : "";
  $("#withdrawMinHint").textContent = minWithdraw ? `Minimum ${fmtMoney(minWithdraw, sym)}` : "";
  $("#withdrawMinNote").textContent = fmtMoney(minWithdraw, sym);

  renderQuickAmounts("topupQuick", [5, 10, 25, 50, 100, 200].filter((v) => v >= minTopup), "topupAmount");
  renderQuickAmounts(
    "withdrawQuick",
    [minWithdraw || 2, 10, 25, 50, 100].filter((v, i, a) => v >= (minWithdraw || 0) && a.indexOf(v) === i),
    "withdrawAmount"
  );

  const balanceCents = Math.round((s.balance || 0) * 100);
  $("#withdrawSubmit").disabled = balanceCents <= 0;
}

function renderQuickAmounts(containerId, values, inputId) {
  const box = $(`#${containerId}`);
  if (!box) return;
  const sym = walletState.symbol;
  box.innerHTML = values
    .map((v) => `<button type="button" data-quick="${v}" data-target="${inputId}">${fmtMoney(v, sym)}</button>`)
    .join("");
}

function renderTopupMethods() {
  const box = $("#topupMethods");
  const methods = (walletState.settings.topupMethods || []).filter(Boolean);
  if (!methods.length) {
    box.innerHTML = `<p class="hint">No payment methods are configured. Contact support.</p>`;
    walletState.topupMethod = "manual";
    return;
  }
  if (!methods.some((m) => m.id === walletState.topupMethod)) {
    walletState.topupMethod = methods[0].id;
  }
  box.innerHTML = methods
    .map((m) => {
      const sub = m.kind === "manual" ? "Reviewed by an admin" : [m.asset, m.network].filter(Boolean).join(" · ") || m.kind;
      return `<button class="method-option ${m.id === walletState.topupMethod ? "selected" : ""}" type="button" data-topup-method="${esc(m.id)}">
        <span class="dotmark"></span>
        <span style="min-width:0"><strong style="display:block;font-size:0.84rem">${esc(m.label)}</strong><span class="hint">${esc(sub)}</span></span>
      </button>`;
    })
    .join("");
}

function renderWithdrawMethods() {
  const box = $("#withdrawMethods");
  const methods = walletState.settings.methods || [];
  if (!methods.length) {
    box.innerHTML = `<p class="hint">Withdrawals are not available right now. Contact support.</p>`;
    walletState.withdrawMethod = "";
    return;
  }
  if (!methods.some((m) => m.id === walletState.withdrawMethod)) {
    walletState.withdrawMethod = methods[0].id;
  }
  box.innerHTML = methods
    .map(
      (m) => `<button class="method-option ${m.id === walletState.withdrawMethod ? "selected" : ""}" type="button" data-withdraw-method="${esc(m.id)}">
        <span class="dotmark"></span>
        <span style="min-width:0"><strong style="display:block;font-size:0.84rem">${esc(m.label)}</strong><span class="hint">${esc(m.detailsLabel)}</span></span>
      </button>`
    )
    .join("");
  updateDetailsLabel();
}

function updateDetailsLabel() {
  const method = (walletState.settings.methods || []).find((m) => m.id === walletState.withdrawMethod);
  const label = $("#withdrawDetailsLabel");
  const input = $("#withdrawDetails");
  if (!method) return;
  label.textContent = method.detailsLabel || "Payout details";
  input.placeholder = method.instructions || `Your ${(method.detailsLabel || "payout details").toLowerCase()}`;
}

function renderOverview() {
  const sym = walletState.symbol;
  const topups = walletState.topups.slice(0, 4);
  const withdrawals = walletState.withdrawals.slice(0, 4);

  $("#overviewTopups").innerHTML = topups.length
    ? topups.map((t) => topupRow(t, true)).join("")
    : `<div class="empty-state" style="padding:1.3rem"><span class="emoji">🪙</span><strong>No top-ups yet</strong><p>Add funds to start shopping.</p></div>`;

  $("#overviewWithdrawals").innerHTML = withdrawals.length
    ? withdrawals.map((w) => withdrawalRow(w, true)).join("")
    : `<div class="empty-state" style="padding:1.3rem"><span class="emoji">💸</span><strong>No withdrawals yet</strong><p>Your payout requests will show up here.</p></div>`;

  const txs = (walletState.data && walletState.data.transactions) || [];
  $("#overviewTx").innerHTML = txs.length
    ? txs.map((t) => txRow(t)).join("")
    : `<div class="empty-state" style="padding:1.3rem"><span class="emoji">🧾</span><strong>No transactions yet</strong><p>Every credit and debit will be listed here.</p></div>`;

  renderContacts();
}

function renderContacts() {
  const box = $("#topupContacts");
  if (!box) return;
  const c = (window.SITE && window.SITE.contact) || {};
  const tgLink = c.telegramLink || (c.telegramUsername ? `https://t.me/${c.telegramUsername.replace(/^@/, "")}` : "");
  const tgHandle = c.telegramUsername || (c.telegramLink ? c.telegramLink.replace(/^https?:\/\/t\.me\//, "@") : "");
  box.innerHTML = `
    ${tgLink ? `<a class="contact-card tg" href="${esc(tgLink)}" target="_blank" rel="noopener">
      <span class="cico"><svg viewBox="0 0 24 24" fill="currentColor"><path d="M21.94 4.6 19 19.2c-.22 1.06-.86 1.32-1.74.82l-4.8-3.54-2.32 2.23c-.26.26-.47.47-.96.47l.34-4.87 8.86-8c.39-.34-.08-.53-.6-.2L6.84 13.3l-4.7-1.47c-1.02-.32-1.04-1.02.21-1.51l18.36-7.07c.85-.31 1.6.2 1.23 1.35Z"/></svg></span>
      <span class="cinfo"><strong>Telegram</strong><span>${esc(tgHandle || "Chat with us")}</span></span>
      <span class="arrow">↗</span>
    </a>` : ""}
    ${c.discordLink ? `<a class="contact-card dc" href="${esc(c.discordLink)}" target="_blank" rel="noopener">
      <span class="cico"><svg viewBox="0 0 24 24" fill="currentColor"><path d="M20.32 4.57a19.8 19.8 0 0 0-4.93-1.52.07.07 0 0 0-.08.04c-.21.38-.45.87-.61 1.26a18.3 18.3 0 0 0-5.4 0 12.6 12.6 0 0 0-.62-1.26.08.08 0 0 0-.08-.04c-1.71.3-3.36.8-4.93 1.52a.07.07 0 0 0-.03.03C.53 9.04-.32 13.38.1 17.67a.08.08 0 0 0 .03.06 19.9 19.9 0 0 0 6.05 3.06.08.08 0 0 0 .09-.03c.47-.64.88-1.31 1.23-2.02a.08.08 0 0 0-.04-.11 13.1 13.1 0 0 1-1.87-.9.08.08 0 0 1 0-.13c.12-.1.25-.19.37-.29a.07.07 0 0 1 .08-.01c3.93 1.8 8.18 1.8 12.06 0a.07.07 0 0 1 .08.01c.12.1.25.2.37.3a.08.08 0 0 1 0 .12c-.6.35-1.22.65-1.88.9a.08.08 0 0 0-.04.11c.36.71.77 1.38 1.23 2.02a.08.08 0 0 0 .09.03 19.8 19.8 0 0 0 6.06-3.06.08.08 0 0 0 .03-.06c.5-4.96-.84-9.26-3.55-13.07a.06.06 0 0 0-.03-.03ZM8.02 15.04c-1.18 0-2.15-1.09-2.15-2.42s.95-2.42 2.15-2.42c1.21 0 2.17 1.1 2.15 2.42 0 1.33-.95 2.42-2.15 2.42Zm7.97 0c-1.18 0-2.15-1.09-2.15-2.42s.95-2.42 2.15-2.42c1.21 0 2.17 1.1 2.15 2.42 0 1.33-.94 2.42-2.15 2.42Z"/></svg></span>
      <span class="cinfo"><strong>Discord</strong><span>Join our server</span></span>
      <span class="arrow">↗</span>
    </a>` : ""}
    ${!tgLink && !c.discordLink ? `<p class="hint">Support contacts are not configured yet.</p>` : ""}`;
}

/* --------------------------------------------------------------- histories */
function topupRow(t, compact) {
  const sym = t.symbol || walletState.symbol;
  const pending = t.status === "pending";
  return `<div class="tx-row" style="padding:0.6rem 0.7rem">
    <span class="txico ${t.status === "approved" ? "in" : "out"}">${t.status === "approved" ? "↓" : t.status === "pending" ? "…" : "×"}</span>
    <span class="txmeta">
      <strong>${fmtMoney(t.amount, sym)} <span class="hint">· ${esc(t.method || "manual")}</span></strong>
      <span>${today(t.createdAt)}${t.asset ? " · " + esc(t.asset) : ""}</span>
      ${pending && !compact ? `<button class="icon-btn-sm" type="button" data-cancel-topup="${esc(t.id)}" style="margin-top:0.3rem">Cancel request</button>` : ""}
    </span>
    <span class="txamount"><span class="status status-${esc(t.status)}">${esc(t.status)}</span></span>
  </div>`;
}

function withdrawalRow(w, compact) {
  const sym = w.symbol || walletState.symbol;
  return `<div class="tx-row" style="padding:0.6rem 0.7rem">
    <span class="txico ${["rejected"].includes(w.status) ? "out" : "in"}">${w.status === "completed" ? "✓" : w.status === "rejected" ? "×" : "…"}</span>
    <span class="txmeta">
      <strong>${fmtMoney(w.amount, sym)} <span class="hint">· ${esc(w.methodLabel || w.method)}</span></strong>
      <span>${today(w.createdAt)}${compact ? "" : " · " + esc(w.details).slice(0, 60)}</span>
    </span>
    <span class="txamount"><span class="status status-${esc(w.status)}">${esc(w.status)}</span></span>
  </div>`;
}

function renderTopupHistory() {
  const box = $("#topupHistory");
  const list = walletState.topups;
  $("#topupCount").textContent = `${list.length} request${list.length === 1 ? "" : "s"}`;
  box.innerHTML = list.length
    ? list.map((t) => topupRow(t, false)).join("")
    : `<div class="empty-state" style="padding:1.4rem"><span class="emoji">🪙</span><strong>No top-ups yet</strong><p>Create your first top-up to add funds.</p></div>`;
}

function renderWithdrawHistory() {
  const box = $("#withdrawHistory");
  const list = walletState.withdrawals;
  $("#withdrawCount").textContent = `${list.length} request${list.length === 1 ? "" : "s"}`;
  box.innerHTML = list.length
    ? list.map((w) => withdrawalRow(w, false)).join("")
    : `<div class="empty-state" style="padding:1.4rem"><span class="emoji">💸</span><strong>No withdrawals yet</strong><p>Your payout requests will appear here.</p></div>`;
}

/* -------------------------------------------------------------- ledger */
function txRow(t) {
  const sym = t.symbol || walletState.symbol;
  const credit = t.direction === "credit";
  return `<div class="tx-row">
    <span class="txico ${credit ? "in" : "out"}">${credit ? "↓" : "↑"}</span>
    <span class="txmeta">
      <strong>${esc(t.label)}${t.status && t.status !== "completed" ? ` <span class="status status-${esc(t.status)}">${esc(t.status)}</span>` : ""}</strong>
      <span>${today(t.createdAt)}${t.reference ? " · " + esc(t.reference) : ""}${t.note ? " · " + esc(t.note) : ""}</span>
    </span>
    <span class="txamount ${credit ? "credit" : "debit"}">${credit ? "+" : "−"}${fmtMoney(t.amount, sym)}<small>bal ${fmtMoney(t.balanceAfter, sym)}</small></span>
  </div>`;
}

async function loadTransactions(reset = false) {
  const tx = walletState.tx;
  if (tx.loading && !reset) return;
  const seq = (tx.seq || 0) + 1;
  tx.seq = seq;
  if (reset) {
    tx.rows = [];
    tx.offset = 0;
    tx.total = 0;
    $("#txTable").innerHTML = `<div class="skeleton skeleton-row"></div><div class="skeleton skeleton-row"></div><div class="skeleton skeleton-row"></div>`;
  }
  tx.loading = true;
  const params = new URLSearchParams({ limit: "20", offset: String(tx.offset) });
  if (tx.kind) params.set("kind", tx.kind);
  try {
    const data = await api.get(`/api/wallet/transactions?${params}`);
    if (seq !== tx.seq) return;
    tx.rows = tx.rows.concat(data.transactions || []);
    tx.total = data.total || 0;
    tx.offset = tx.rows.length;
    renderTransactions();
  } catch (error) {
    if (seq === tx.seq) $("#txTable").innerHTML = `<p class="form-error">${esc(error.message)}</p>`;
  } finally {
    if (seq === tx.seq) tx.loading = false;
  }
}

function renderTransactions() {
  const tx = walletState.tx;
  const sym = walletState.symbol;
  $("#txTotal").textContent = `${tx.total} entr${tx.total === 1 ? "y" : "ies"}`;
  if (!tx.rows.length) {
    $("#txTable").innerHTML = `<div class="empty-state"><span class="emoji">🧾</span><strong>No transactions found</strong><p>Credits and debits will show up here.</p></div>`;
  } else {
    $("#txTable").innerHTML = `<div class="table-wrap"><table class="data-table ledger-table">
      <thead><tr><th>Type</th><th>Amount</th><th class="hide-md">Balance after</th><th>Date</th><th class="hide-sm">Reference</th><th>Status</th></tr></thead>
      <tbody>${tx.rows
        .map(
          (t) => `<tr>
            <td><strong>${esc(t.label)}</strong>${t.note ? `<span class="hint" style="display:block">${esc(t.note)}</span>` : ""}</td>
            <td class="num ${t.direction === "credit" ? "credit" : "debit"}">${t.direction === "credit" ? "+" : "−"}${fmtMoney(t.amount, sym)}</td>
            <td class="num muted hide-md">${fmtMoney(t.balanceAfter, sym)}</td>
            <td class="muted">${today(t.createdAt)}<span class="hint" style="display:block">${timeAgo(t.createdAt)}</span></td>
            <td class="mono muted hide-sm">${esc(t.reference || "—")}</td>
            <td><span class="status status-${esc(t.status || "completed")}">${esc(t.status || "completed")}</span></td>
          </tr>`
        )
        .join("")}</tbody>
    </table></div>`;
  }
  $("#txMore").hidden = tx.rows.length >= tx.total;
}

/* -------------------------------------------------------------- forms */
function bindTopup() {
  $("#topupForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const errorBox = $("#topupError");
    errorBox.hidden = true;
    const amount = Number($("#topupAmount").value);
    const min = Number(walletState.settings.minTopup || 0);
    if (!Number.isFinite(amount) || amount <= 0) return showError(errorBox, "Enter a top-up amount.");
    if (amount < min) return showError(errorBox, `Minimum top-up is ${fmtMoney(min, walletState.symbol)}.`);
    if (!walletState.topupMethod) return showError(errorBox, "Choose a payment method.");

    const button = $("#topupSubmit");
    button.disabled = true;
    button.textContent = "Creating…";
    try {
      const result = await api.post("/api/wallet/topups", {
        amount,
        method: walletState.topupMethod,
        note: $("#topupNote").value.trim(),
      });
      renderTopupResult(result);
      $("#topupAmount").value = "";
      $("#topupNote").value = "";
      toast("Top-up request created", "success", "Send the payment and we'll credit your balance after review.");
      await refresh();
    } catch (error) {
      showError(errorBox, error.message);
    } finally {
      button.disabled = false;
      button.textContent = "Create top-up request";
    }
  });

  $("#topupMethods").addEventListener("click", (event) => {
    const button = event.target.closest("[data-topup-method]");
    if (!button) return;
    walletState.topupMethod = button.dataset.topupMethod;
    renderTopupMethods();
  });
}

function isQrLink(value) {
  return /^https?:\/\//i.test((value || "").trim());
}

function fileToProof(file) {
  return new Promise((resolve, reject) => {
    if (!file) return resolve("");
    if (!/^image\//.test(file.type)) return reject(new Error("Pick an image file."));
    const image = new Image();
    const url = URL.createObjectURL(file);
    image.onload = () => {
      try {
        const scale = Math.min(1, 1400 / Math.max(image.width, image.height));
        const canvas = document.createElement("canvas");
        canvas.width = Math.round(image.width * scale) || 1;
        canvas.height = Math.round(image.height * scale) || 1;
        const ctx = canvas.getContext("2d");
        ctx.fillStyle = "#fff";
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
        let data = canvas.toDataURL("image/jpeg", 0.82);
        if (data.length > 380000) data = canvas.toDataURL("image/jpeg", 0.62);
        if (data.length > 500000) return reject(new Error("That screenshot is too large."));
        resolve(data);
      } catch {
        reject(new Error("Could not read that image."));
      } finally {
        URL.revokeObjectURL(url);
      }
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("Could not read that image."));
    };
    image.src = url;
  });
}

function renderTopupResult(result) {
  const box = $("#topupResult");
  const topup = result.topup || {};
  box.hidden = false;

  let body = `<div class="glass" style="padding:1rem;border-color:rgba(49,225,192,0.35);background:rgba(49,225,192,0.06)">
    <div class="row" style="justify-content:space-between;margin-bottom:0.5rem">
      <strong style="font-size:0.95rem">Top-up ${esc(topup.id || "")}</strong>
      <span class="status status-${esc(topup.status || "pending")}">${esc(topup.status || "pending")}</span>
    </div>
    <p class="hint">Requested amount</p>
    <p style="font-family:var(--display);font-size:1.4rem;font-weight:700">${fmtMoney(topup.amount || 0, topup.symbol || walletState.symbol)}</p>`;

  if (result.method === "crypto") {
    body += `
      <div class="divider"></div>
      <p class="hint">Send exactly</p>
      <p class="mono pay-amount-row" style="font-size:1rem">
        <span>${esc(result.amount || "")} ${esc(result.asset || "")}</span>
        ${result.image ? `<img class="pay-coin" src="${esc(result.image)}" alt="" loading="lazy" />` : ""}
      </p>
      <p class="hint" style="margin-top:0.5rem">Network</p>
      <p>${esc(result.network || "")}</p>
      <p class="hint" style="margin-top:0.5rem">Address</p>
      <div class="copy-field"><code>${esc(result.address || "")}</code><button class="icon-btn-sm" type="button" data-copy="${esc(result.address || "")}">Copy</button></div>
      ${
        topup.id
          ? `<img class="pay-qr" src="/api/wallet/topups/${encodeURIComponent(topup.id)}/qr.svg"
               alt="QR code to pay this top-up" width="190" height="190" loading="lazy" />
             <p class="pay-qr-label">Scan with your wallet app${
               result.asset === "BTC" || result.asset === "LTC" ? " — the address and exact amount are filled in" : ""
             }</p>`
          : ""
      }
      ${result.instructions ? `<p class="hint" style="margin-top:0.6rem">${esc(result.instructions)}</p>` : ""}
      <p class="hint" style="margin-top:0.7rem">${result.autoVerify ? "We check the blockchain automatically — credit usually lands within minutes." : "After paying, send the transaction hash to support so an admin can approve it."}</p>`;
  } else if (result.method === "binance" && result.manual) {
    const payId = (result.payId || "").trim();
    const amount = `${result.amount || ""} ${result.asset || "USDT"}`.trim();
    const qr = result.image
      ? `<img class="pay-binance-qr" src="${esc(result.image)}" alt="Binance Pay QR code" loading="lazy" />`
      : isQrLink(payId)
        ? `<img class="pay-qr" src="/api/wallet/topups/${encodeURIComponent(topup.id)}/qr.svg"
             alt="Binance Pay QR code for top-up ${esc(topup.id)}" width="190" height="190" loading="lazy" />`
        : "";
    body += `
      <div class="divider"></div>
      <p class="hint">Scan with the Binance app or send to the ID below, then submit the transaction ID. An admin credits your balance after checking it.</p>
      ${qr ? `${qr}<p class="pay-qr-label">Scan with the Binance app to pay</p>` : ""}
      ${
        payId && !isQrLink(payId)
          ? `<p class="hint" style="margin-top:0.6rem">Binance Pay ID</p>
             <div class="copy-field"><code>${esc(payId)}</code><button class="icon-btn-sm" type="button" data-copy="${esc(payId)}">Copy</button></div>`
          : ""
      }
      <p class="hint" style="margin-top:0.6rem">Send exactly ${esc(amount)} and add reference ${esc(topup.id || "")} in the note.</p>
      <div class="pay-txid">
        <label class="cf-label" for="binanceTxid">Binance transaction ID (TXID)</label>
        <input id="binanceTxid" type="text" autocomplete="off" spellcheck="false"
               placeholder="Paste the TXID from your Binance receipt" value="${esc(topup.txid || "")}" />
        <div class="proof-upload">
          <label class="cf-label" for="binanceProof">Payment screenshot <span class="muted">(optional)</span></label>
          <input id="binanceProof" type="file" accept="image/*" />
          <img class="proof-thumb" id="proofPreview" alt="Payment screenshot"
               ${topup.hasProof ? `src="/api/wallet/topups/${encodeURIComponent(topup.id)}/proof"` : "hidden"} />
        </div>
        <button class="btn btn-primary btn-full" type="button" id="submitTxid">Submit payment proof</button>
        <p class="pay-qr-label" id="txidNote">${
          topup.txid
            ? "TXID received. An admin will approve your top-up."
            : "Required — your top-up stays pending until the TXID is checked."
        }</p>
      </div>`;
  } else if (result.method === "binance") {
    body += `
      <div class="divider"></div>
      <p class="hint">Complete the payment on Binance Pay, then your balance is credited automatically.</p>
      ${
        result.checkoutUrl && topup.id
          ? `<img class="pay-qr" src="/api/wallet/topups/${encodeURIComponent(topup.id)}/qr.svg"
               alt="Binance Pay QR code for top-up ${esc(topup.id)}" width="190" height="190" loading="lazy" />
             <p class="pay-qr-label">Scan to open Binance Pay</p>`
          : ""
      }
      ${result.checkoutUrl ? `<a class="btn btn-primary btn-full" style="margin-top:0.8rem" href="${esc(result.checkoutUrl)}" target="_blank" rel="noopener">Open Binance Pay</a>` : `<p class="hint" style="margin-top:0.7rem">A Binance Pay link could not be created. Contact support with reference ${esc(topup.id || "")}.</p>`}`;
  } else {
    body += `
      <div class="divider"></div>
      <p class="hint">Send ${fmtMoney(topup.amount || 0, topup.symbol || walletState.symbol)} using your usual method, then send proof to support. An admin will approve it and credit your balance.</p>
      <div class="row" style="margin-top:0.7rem">
        <button class="icon-btn-sm" type="button" data-copy="${esc(topup.id || "")}">Copy reference</button>
        <a class="icon-btn-sm" href="/messages.html">Contact support</a>
      </div>`;
  }

  body += `</div>`;
  box.innerHTML = body;

  const submitTxid = $("#submitTxid");
  if (submitTxid) {
    const proofInput = $("#binanceProof");
    const preview = $("#proofPreview");
    if (proofInput && preview) {
      proofInput.addEventListener("change", () => {
        const file = proofInput.files && proofInput.files[0];
        if (!file) return;
        preview.src = URL.createObjectURL(file);
        preview.hidden = false;
      });
    }
    submitTxid.addEventListener("click", async () => {
      const value = ($("#binanceTxid").value || "").trim();
      const errorBox = $("#topupError");
      if (errorBox) errorBox.hidden = true;
      if (!value) {
        if (errorBox) showError(errorBox, "Paste the Binance transaction ID.");
        return;
      }
      submitTxid.disabled = true;
      submitTxid.textContent = "Submitting…";
      try {
        const proof = proofInput && proofInput.files[0] ? await fileToProof(proofInput.files[0]) : "";
        await api.post(`/api/wallet/topups/${encodeURIComponent(topup.id)}/txid`, { txid: value, proof });
        $("#txidNote").textContent = "TXID received. An admin will approve your top-up.";
        submitTxid.textContent = "TXID submitted";
      } catch (error) {
        if (errorBox) showError(errorBox, error.message);
        submitTxid.disabled = false;
        submitTxid.textContent = "Submit payment proof";
      }
    });
  }
}

function bindWithdraw() {
  $("#withdrawForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const errorBox = $("#withdrawError");
    errorBox.hidden = true;
    const amount = Number($("#withdrawAmount").value);
    const min = Number(walletState.settings.minWithdraw || 0);
    const balance = Number(walletState.summary.balance || 0);
    const details = $("#withdrawDetails").value.trim();

    if (!Number.isFinite(amount) || amount <= 0) return showError(errorBox, "Enter an amount to withdraw.");
    if (amount < min) return showError(errorBox, `Minimum withdrawal is ${fmtMoney(min, walletState.symbol)}.`);
    if (amount > balance) return showError(errorBox, `You only have ${fmtMoney(balance, walletState.symbol)} available.`);
    if (!walletState.withdrawMethod) return showError(errorBox, "Choose a payout method.");
    if (details.length < 4) return showError(errorBox, "Add your payout details so we can pay you.");
    if (!$("#withdrawConfirm").checked) return showError(errorBox, "Please confirm your payout details are correct.");

    const button = $("#withdrawSubmit");
    button.disabled = true;
    button.textContent = "Requesting…";
    try {
      await api.post("/api/wallet/withdrawals", {
        amount,
        method: walletState.withdrawMethod,
        details,
      });
      $("#withdrawAmount").value = "";
      $("#withdrawDetails").value = "";
      $("#withdrawConfirm").checked = false;
      toast("Withdrawal requested", "success", "The amount is reserved while an admin reviews it.");
      await refresh();
    } catch (error) {
      showError(errorBox, error.message);
    } finally {
      button.disabled = false;
      button.textContent = "Request withdrawal";
      if (Number(walletState.summary.balance || 0) <= 0) button.disabled = true;
    }
  });

  $("#withdrawMethods").addEventListener("click", (event) => {
    const button = event.target.closest("[data-withdraw-method]");
    if (!button) return;
    walletState.withdrawMethod = button.dataset.withdrawMethod;
    renderWithdrawMethods();
  });
}

function bindTransactions() {
  $("#txFilters").addEventListener("click", (event) => {
    const button = event.target.closest("[data-tx-kind]");
    if (!button) return;
    walletState.tx.kind = button.dataset.txKind;
    document.querySelectorAll("[data-tx-kind]").forEach((b) => b.setAttribute("aria-selected", String(b === button)));
    loadTransactions(true);
  });
  $("#txMore").addEventListener("click", () => loadTransactions(false));
}

function bindDelegates() {
  document.addEventListener("click", async (event) => {
    const copy = event.target.closest("[data-copy]");
    if (copy) {
      await copyText(copy.dataset.copy);
      toast("Copied", "success");
      return;
    }

    const quick = event.target.closest("[data-quick]");
    if (quick) {
      const input = $(`#${quick.dataset.target}`);
      if (input) {
        input.value = quick.dataset.quick;
        input.focus();
      }
      return;
    }

    const cancel = event.target.closest("[data-cancel-topup]");
    if (cancel) {
      if (!confirm("Cancel this top-up request?")) return;
      cancel.disabled = true;
      try {
        await api.post(`/api/wallet/topups/${encodeURIComponent(cancel.dataset.cancelTopup)}/cancel`, {});
        toast("Top-up cancelled", "info");
        await refresh();
      } catch (error) {
        toast("Could not cancel", "error", error.message);
        cancel.disabled = false;
      }
    }
  });
}

function showError(box, message) {
  box.textContent = message;
  box.hidden = false;
}

/* --------------------------------------------------------------- tabs */
const TABS = ["overview", "topup", "withdraw", "transactions"];

function showTab(name, push = true) {
  const tab = TABS.includes(name) ? name : "overview";
  walletState.tab = tab;

  document.querySelectorAll("[data-wtab]").forEach((button) => {
    button.setAttribute("aria-selected", String(button.dataset.wtab === tab));
  });
  TABS.forEach((key) => {
    const panel = $(`#panel-${key}`);
    if (panel) panel.hidden = key !== tab;
  });
  document.querySelectorAll("[data-wtab-link]").forEach((el) => el.removeAttribute("aria-current"));
  const title = { overview: "Wallet", topup: "Top up", withdraw: "Withdraw", transactions: "Transactions" }[tab];
  $("#topbarTitle").textContent = title;
  document.title = `${title} — ${(window.SITE && window.SITE.app && window.SITE.app.name) || "Kudsi Shop"}`;

  if (tab === "transactions") loadTransactions(true);
  if (push && location.hash !== `#${tab}`) history.replaceState(null, "", `#${tab}`);
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function applyHash() {
  const name = (location.hash || "#overview").replace("#", "");
  showTab(name, false);
}

function bindTabs() {
  document.querySelectorAll("[data-wtab]").forEach((button) => {
    button.addEventListener("click", () => showTab(button.dataset.wtab));
  });
  document.querySelectorAll("[data-wtab-link]").forEach((el) => {
    el.addEventListener("click", (event) => {
      event.preventDefault();
      showTab(el.dataset.wtabLink);
    });
  });
}
