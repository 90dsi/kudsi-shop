/* Single order page: status, codes, contact and the payment step */

const $ = (s) => document.querySelector(s);
const orderId = new URLSearchParams(window.location.search).get("id");
let timer = null;
let config = { payments: { sandbox: true }, store: { methods: [], codesVisible: true, deliveryNote: "" } };
let current = null;

const methodIcon = (m) => {
  if (m.kind === "binance") return "🟡";
  if (m.kind === "sandbox") return "🧪";
  const map = { BTC: "₿", LTC: "Ł", ETH: "Ξ", USDT: "₮" };
  return map[(m.asset || "").toUpperCase()] || "🪙";
};

const copyField = (label, value) => `
  <div class="copy-field">
    <div style="flex:1;min-width:0">
      <span class="cf-label">${esc(label)}</span>
      <span class="cf-value">${esc(value)}</span>
    </div>
    <button type="button" data-copy="${esc(value)}">Copy</button>
  </div>`;

function contactBlock(order) {
  if (!order.contact || !order.contact.handle) return "";
  const label = order.contact.type === "discord" ? "Discord" : "Telegram";
  return `
    <div class="order-card" style="margin-bottom:1rem">
      <h2 style="font-size:1rem;margin-bottom:0.4rem">Your delivery contact</h2>
      <p class="small muted" style="margin-bottom:0.6rem">
        Send your order id on ${label} so the admin knows which payment is yours.
      </p>
      ${copyField(`${label} username`, order.contact.handle)}
      ${copyField("Order id", order.id)}
      <a class="btn btn-ghost btn-full" href="/messages.html" style="margin-top:0.7rem">Message the admin on this site</a>
    </div>`;
}

function codesBlock(order) {
  const codes = order.codes || [];
  if (order.status !== "paid") return "";
  if (!codes.length) {
    if (order.codeCount) {
      return `<p class="note">Your ${order.codeCount} code(s) are ready. The admin can send them to you on Telegram or Discord — message them with your order id.</p>`;
    }
    return `<p class="note">Your codes are being prepared and will appear here shortly.</p>`;
  }
  return `
    <div class="code-list">
      ${codes
        .map(
          (c) => `<div class="code-row">
            <div><code>${esc(c.code)}</code><span>${esc(c.name || "")}</span></div>
            <button type="button" data-copy="${esc(c.code)}">Copy</button>
          </div>`
        )
        .join("")}
    </div>`;
}

function renderPayment(order) {
  if (order.status !== "pending") return "";

  if (!order.provider) {
    const methods = (config.store && config.store.methods) || [];
    const sandbox = config.payments && config.payments.sandbox
      ? [{ id: "sandbox", label: "Sandbox (test)", kind: "sandbox", asset: "", network: "", instructions: "Test mode — no real money." }]
      : [];
    const list = [...methods, ...sandbox];
    return `
      <div class="order-card" style="margin-bottom:1rem">
        <h2 style="font-size:1.05rem;margin-bottom:0.35rem">Choose how to pay ${money(order.total)}</h2>
        <p class="small muted">Send the exact amount shown on the next step — that's how your payment is matched to this order.</p>
        ${
          list.length
            ? `<div class="method-grid" id="methodGrid">
                 ${list
                   .map(
                     (m) => `<button class="method-card" type="button" data-method="${esc(m.id)}">
                       <span class="mi" aria-hidden="true">${methodIcon(m)}</span>
                       <span>
                         <strong>${esc(m.label)}</strong>
                         <span>${esc(m.kind === "crypto" ? `${m.asset} · ${m.network || "crypto"}` : m.kind === "binance" ? "Hosted checkout" : "Test payment")}</span>
                       </span>
                     </button>`
                   )
                   .join("")}
               </div>`
            : `<p class="pay-warning">No payment method is available right now. Please message the admin.</p>`
        }
        <p class="form-error" id="payError" role="alert" hidden></p>
      </div>`;
  }

  if (order.provider === "binance") {
    return `
      <div class="order-card" style="margin-bottom:1rem">
        <h2 style="font-size:1.05rem;margin-bottom:0.4rem">Waiting for Binance Pay</h2>
        <p class="small muted">Scan with your phone, or use the button below — Binance opens with this order ready.</p>
        ${
          order.checkoutUrl
            ? `<img class="pay-qr" src="/api/orders/${encodeURIComponent(order.id)}/qr.svg"
                 alt="Binance Pay QR code for order ${esc(order.id)}" width="190" height="190" loading="lazy" />
               <p class="pay-qr-label">Scan to open Binance Pay</p>`
            : ""
        }
        <div style="display:grid;gap:0.5rem;margin-top:0.9rem">
          ${order.checkoutUrl ? `<a class="btn btn-primary btn-full" href="${esc(order.checkoutUrl)}" target="_blank" rel="noopener">Open Binance Pay ↗</a>` : ""}
          <button class="btn btn-ghost btn-full" type="button" id="verifyBtn">Check payment status</button>
        </div>
        <p class="form-error" id="payError" role="alert" hidden></p>
      </div>`;
  }

  if (order.provider === "sandbox") {
    return `
      <div class="order-card" style="margin-bottom:1rem">
        <h2 style="font-size:1.05rem;margin-bottom:0.4rem">Sandbox payment</h2>
        <p class="small muted">No real money moves in sandbox mode.</p>
        <button class="btn btn-primary btn-full" type="button" id="simulateBtn" style="margin-top:0.9rem">
          Simulate successful payment
        </button>
        <p class="form-error" id="payError" role="alert" hidden></p>
      </div>`;
  }

  return `
    <div class="order-card" style="margin-bottom:1rem">
      <h2 style="font-size:1.05rem;margin-bottom:0.4rem">Send ${esc(order.payAmount || "")} ${esc(order.payAsset || "")}</h2>
      <p class="small muted">${esc(order.methodLabel || "")}${order.payNetwork ? ` · ${esc(order.payNetwork)} network` : ""}</p>
      <div class="pay-block">
        ${
          order.payInstructions
            ? `<p class="pay-note">${esc(order.payInstructions)}</p>`
            : `<p class="pay-note">Send exactly this amount on the ${esc(order.payNetwork || order.payAsset || "correct")} network.</p>`
        }
        ${order.payAmount ? copyField("Exact amount", `${order.payAmount} ${order.payAsset || ""}`.trim()) : ""}
        ${order.payAddress ? copyField("Address", order.payAddress) : ""}
        ${
          order.payAddress
            ? `<img class="pay-qr" src="/api/orders/${encodeURIComponent(order.id)}/qr.svg"
                 alt="QR code to pay ${esc(order.payAsset || "this order")}" width="190" height="190" loading="lazy" />
               <p class="pay-qr-label">Scan with your wallet app${
                 order.payAsset === "BTC" || order.payAsset === "LTC" ? " — the address and exact amount are filled in" : ""
               }</p>`
            : ""
        }
        ${order.payImage ? `<img class="pay-image" src="${esc(order.payImage)}" alt="Payment details" />` : ""}
        <p class="small muted">The unique amount is how your payment is matched. Send it exactly.</p>
        <button class="btn btn-primary btn-full" type="button" id="verifyBtn">I've paid — check now</button>
        ${
          order.autoVerify
            ? `<p class="note">We also check the blockchain automatically every minute.</p>`
            : `<p class="pay-warning">Automatic checking is off for this method — the admin will confirm it manually.</p>`
        }
      </div>
      <p class="form-error" id="payError" role="alert" hidden></p>
    </div>`;
}

function render(order) {
  current = order;
  document.title = `${order.id} — Kudsi Shop`;
  const paid = order.status === "paid";
  const closed = order.status === "expired" || order.status === "cancelled";

  $("#orderBox").innerHTML = `
    <div class="page-head" style="margin-bottom: 1rem">
      <div>
        <h1 style="font-size: 1.5rem">Order ${esc(order.id)}</h1>
        <p>${today(order.createdAt)} · ${esc(order.email)}</p>
      </div>
      <span class="pill pill-${esc(order.status)}" style="font-size: 0.78rem">${esc(order.status)}</span>
    </div>

    ${
      paid
        ? `<p class="delivery-note">Payment confirmed — your codes are ready below.</p>${
            config.store && config.store.deliveryNote
              ? `<p class="note">${esc(config.store.deliveryNote)}</p>`
              : ""
          }`
        : ""
    }
    ${
      closed
        ? `<p class="pay-warning" style="margin-bottom:1rem">This payment window closed. <a href="/" style="color:var(--accent-2)">Start a new order →</a></p>`
        : ""
    }

    ${paid ? codesBlock(order) : ""}

    <div class="order-card" style="margin-bottom:1rem">
      <div class="order-lines">
        ${order.items
          .map(
            (i) => `
          <div class="order-line">
            <span class="thumb">${i.image ? `<img src="${esc(i.image)}" alt="" />` : esc(i.emoji || "🎁")}</span>
            <div class="info">
              <strong>${esc(i.name)}${
                i.variant ? ` <span class="item-variant">${esc(i.variant)}</span>` : ""
              }</strong>
              <span>Qty ${i.qty} · ${money(i.unitPrice)} each</span>
            </div>
            <strong>${money(i.lineTotal)}</strong>
          </div>`
          )
          .join("")}
      </div>
      <div class="order-total">
        <span>Total</span>
        <strong>${money(order.total)}</strong>
      </div>
    </div>

    ${renderPayment(order)}
    ${contactBlock(order)}

    <p class="small muted" style="text-align:center">
      Questions about this order? <a href="/messages.html" style="color:var(--accent-2)">Message the admin</a>
      and include order id <strong>${esc(order.id)}</strong>.
    </p>`;

  bindActions(order);
  if (order.status === "pending") startPolling();
  else clearInterval(timer);
}

function bindActions(order) {
  const grid = $("#methodGrid");
  if (grid) {
    grid.addEventListener("click", async (event) => {
      const card = event.target.closest("[data-method]");
      if (!card) return;
      grid.querySelectorAll(".method-card").forEach((el) => (el.disabled = true));
      try {
        await api.post(`/api/orders/${order.id}/pay`, { method: card.dataset.method });
        await refresh();
      } catch (error) {
        showPayError(error.message);
        grid.querySelectorAll(".method-card").forEach((el) => (el.disabled = false));
      }
    });
  }

  const verify = $("#verifyBtn");
  if (verify) {
    verify.addEventListener("click", async () => {
      verify.disabled = true;
      verify.textContent = "Checking…";
      try {
        const res = await api.get(`/api/orders/${order.id}/verify`);
        render(res.order);
        if (res.status !== "paid" && res.warning) showPayError(res.warning);
        else if (res.status !== "paid") showPayError("Not received yet. Give it a minute and check again.");
      } catch (error) {
        showPayError(error.message);
        verify.disabled = false;
        verify.textContent = "I've paid — check now";
      }
    });
  }

  const simulate = $("#simulateBtn");
  if (simulate) {
    simulate.addEventListener("click", async () => {
      simulate.disabled = true;
      try {
        const res = await api.post(`/api/dev/pay/${order.id}`);
        render(res.order);
      } catch (error) {
        showPayError(error.message);
        simulate.disabled = false;
      }
    });
  }
}

function showPayError(message) {
  const box = $("#payError");
  if (box) {
    box.textContent = message;
    box.hidden = false;
  }
}

async function refresh() {
  const { order } = await api.get(`/api/orders/${encodeURIComponent(orderId)}`);
  render(order);
}

function startPolling() {
  clearInterval(timer);
  timer = setInterval(async () => {
    try {
      const { status } = await api.get(`/api/orders/${encodeURIComponent(orderId)}/status`);
      if (status !== (current && current.status)) await refresh();
    } catch {
      /* keep polling */
    }
  }, 6000);
}

document.addEventListener("click", async (event) => {
  const copyBtn = event.target.closest("[data-copy]");
  if (!copyBtn) return;
  try {
    await copyText(copyBtn.dataset.copy);
    const previous = copyBtn.textContent;
    copyBtn.textContent = "Copied";
    setTimeout(() => (copyBtn.textContent = previous), 1300);
  } catch {
    /* clipboard blocked */
  }
});

(async function init() {
  if (!orderId) {
    $("#orderBox").innerHTML = `<p class="empty-row">No order selected. <a href="/account.html" style="color:var(--accent-2)">See your orders →</a></p>`;
    return;
  }
  try {
    try {
      config = await api.get("/api/config");
    } catch {
      /* defaults are fine */
    }
    await refresh();
    // returning from Binance Pay: ask the API to confirm immediately
    if (new URLSearchParams(window.location.search).get("verify") !== "0") {
      try {
        const res = await api.get(`/api/orders/${encodeURIComponent(orderId)}/verify`);
        render(res.order);
      } catch {
        /* webhooks will catch it */
      }
    }
  } catch (error) {
    $("#orderBox").innerHTML = `<p class="empty-row">${esc(error.message)}</p>`;
  }
})();
