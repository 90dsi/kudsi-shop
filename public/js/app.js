/* ============================================================
   Kudsi Shop storefront
   Products, accounts, orders and payment methods come from the API.
   ============================================================ */

const CART_KEY = "nexuskeys_cart_v1";

let PRODUCTS = [];
let CATEGORIES = [];
let cart = loadCart();
let activeCategory = "All";
let searchTerm = "";
let sortMode = "featured";
let currentUser = null;
let config = { payments: { binance: false, sandbox: true }, store: { methods: [], codesVisible: true } };
let pollTimer = null;

const $ = (sel) => document.querySelector(sel);
const productById = (id) => PRODUCTS.find((p) => p.id === id);
const variantsOf = (p) => (p && p.variants) || [];
const variantFor = (p, label) => variantsOf(p).find((v) => v.label === label);
const priceFor = (p, label) => {
  const variant = variantFor(p, label);
  return variant ? variant.price : p ? p.price : 0;
};
const oldPriceFor = (p, label) => {
  const variant = variantFor(p, label);
  return variant ? variant.oldPrice : p ? p.oldPrice : null;
};
const lineKey = (line) => `${line.id}::${line.variant || ""}`;
const selectedVariants = {};
const cartCount = () => cart.reduce((sum, l) => sum + l.qty, 0);
const cartTotal = () =>
  cart.reduce((sum, l) => sum + l.qty * priceFor(productById(l.id), l.variant), 0);

function selectedVariant(p) {
  const list = variantsOf(p);
  if (!list.length) return "";
  const current = selectedVariants[p.id];
  if (current && list.some((v) => v.label === current)) return current;
  selectedVariants[p.id] = list[0].label;
  return list[0].label;
}

/* ---------------- cart storage ---------------- */
function loadCart() {
  try {
    const parsed = JSON.parse(localStorage.getItem(CART_KEY) || "[]");
    return Array.isArray(parsed) ? parsed.filter((l) => l && l.id) : [];
  } catch {
    return [];
  }
}

function saveCart() {
  try {
    localStorage.setItem(CART_KEY, JSON.stringify(cart));
  } catch {
    /* private mode: cart just won't persist */
  }
}

/* ---------------- products ---------------- */
function visibleProducts() {
  const q = searchTerm.trim().toLowerCase();
  let list = PRODUCTS.filter((p) => {
    const catOk = activeCategory === "All" || p.category === activeCategory;
    const searchOk =
      !q ||
      p.name.toLowerCase().includes(q) ||
      p.category.toLowerCase().includes(q) ||
      p.desc.toLowerCase().includes(q);
    return catOk && searchOk;
  });
  if (sortMode === "price-asc") list.sort((a, b) => a.price - b.price);
  if (sortMode === "price-desc") list.sort((a, b) => b.price - a.price);
  if (sortMode === "name") list.sort((a, b) => a.name.localeCompare(b.name));
  return list;
}

function renderProducts() {
  const list = visibleProducts();
  $("#productGrid").innerHTML = list
    .map((p) => {
      const list = variantsOf(p);
      const chosen = selectedVariant(p);
      const price = priceFor(p, chosen);
      const oldPrice = oldPriceFor(p, chosen);
      return `
      <article class="product">
        <div class="product-media" style="--art:${esc(p.art || "linear-gradient(150deg,#232a3b,#171b26)")}">
          ${
            p.image
              ? `<img class="product-img" src="${esc(p.image)}" alt="${esc(p.name)}" loading="lazy" />`
              : `<span aria-hidden="true">${esc(p.emoji)}</span>`
          }
          ${p.badge ? `<span class="badge">${esc(p.badge)}</span>` : ""}
          ${p.region ? `<span class="region-tag">${esc(p.region)}</span>` : ""}
        </div>
        <div class="product-body">
          <span class="product-cat">${esc(p.category)}</span>
          <h3 class="product-name">${esc(p.name)}</h3>
          <p class="product-desc">${esc(p.desc)}</p>
          ${
            list.length
              ? `<div class="variant-chips" role="group" aria-label="Duration for ${esc(p.name)}">
                   ${list
                     .map(
                       (v) => `<button class="variant-chip" type="button"
                         data-variant="${esc(v.label)}" data-product="${esc(p.id)}"
                         aria-pressed="${v.label === chosen}">${esc(v.label)}</button>`
                     )
                     .join("")}
                 </div>`
              : ""
          }
          <div class="product-foot">
            <div class="price">
              <strong>${money(price)}</strong>
              ${oldPrice ? `<del>${money(oldPrice)}</del>` : ""}
            </div>
            <button class="add-btn" type="button" data-add="${esc(p.id)}" data-variant="${esc(chosen)}">Add to cart</button>
          </div>
        </div>
      </article>`;
    })
    .join("");
  $("#emptyState").hidden = list.length > 0;
}

function renderChips() {
  const cats = ["All", ...CATEGORIES];
  $("#categoryChips").innerHTML = cats
    .map(
      (c) =>
        `<button class="chip" type="button" role="tab" data-cat="${esc(c)}" aria-selected="${c === activeCategory}">${esc(c)}</button>`
    )
    .join("");
}

/* ---------------- cart UI ---------------- */
function addToCart(id, variant = "") {
  const key = `${id}::${variant}`;
  const line = cart.find((l) => lineKey(l) === key);
  if (line) line.qty = Math.min(line.qty + 1, 20);
  else cart.push(variant ? { id, qty: 1, variant } : { id, qty: 1 });
  saveCart();
  renderCart();
  openCart();
}

function setQty(key, delta) {
  const line = cart.find((l) => lineKey(l) === key);
  if (!line) return;
  line.qty += delta;
  if (line.qty <= 0) cart = cart.filter((l) => lineKey(l) !== key);
  saveCart();
  renderCart();
  if (!cart.length) closeAll();
}

function removeLine(key) {
  cart = cart.filter((l) => lineKey(l) !== key);
  saveCart();
  renderCart();
  if (!cart.length) closeAll();
}

function renderCart() {
  const count = cartCount();
  const badge = $("#cartCount");
  badge.textContent = count;
  badge.hidden = count === 0;

  const body = $("#cartItems");
  if (!cart.length) {
    body.innerHTML = `<p class="cart-empty">Your cart is empty.<br />Add a game card to get started.</p>`;
  } else {
    body.innerHTML = cart
      .map((line) => {
        const p = productById(line.id);
        if (!p) return "";
        const key = lineKey(line);
        return `
        <div class="cart-item">
          <div class="cart-item-art" aria-hidden="true">
            ${p.image ? `<img src="${esc(p.image)}" alt="" />` : esc(p.emoji)}
          </div>
          <div class="cart-item-info">
            <div class="cart-item-name">${esc(p.name)}</div>
            ${line.variant ? `<div class="cart-item-variant">${esc(line.variant)}</div>` : ""}
            <div class="cart-item-price">${money(priceFor(p, line.variant))} · ${esc(p.region)}</div>
            <div class="qty">
              <button type="button" data-qty="${esc(key)}" data-delta="-1" aria-label="Decrease quantity">−</button>
              <span>${line.qty}</span>
              <button type="button" data-qty="${esc(key)}" data-delta="1" aria-label="Increase quantity">+</button>
            </div>
          </div>
          <button class="remove-btn" type="button" data-remove="${esc(key)}">Remove</button>
        </div>`;
      })
      .join("");
  }

  $("#cartSubtotal").textContent = money(cartTotal());
  $("#checkoutButton").disabled = cart.length === 0;
}

/* ---------------- drawer ---------------- */
function openCart() {
  $("#cartDrawer").classList.add("open");
  $("#cartDrawer").setAttribute("aria-hidden", "false");
  $("#overlay").hidden = false;
  requestAnimationFrame(() => $("#overlay").classList.add("show"));
  document.body.classList.add("no-scroll");
  $("#closeCart").focus();
}

function closeAll() {
  $("#cartDrawer").classList.remove("open");
  $("#cartDrawer").setAttribute("aria-hidden", "true");
  $("#overlay").classList.remove("show");
  document.body.classList.remove("no-scroll");
  setTimeout(() => {
    if (!$("#cartDrawer").classList.contains("open")) $("#overlay").hidden = true;
  }, 220);
}

/* ---------------- checkout ---------------- */
function openCheckout() {
  if (!cart.length) return;

  const prefilledType = (currentUser && currentUser.contact && currentUser.contact.type) || "telegram";
  const prefilledHandle = (currentUser && currentUser.contact && currentUser.contact.handle) || "";

  const modal = document.createElement("div");
  modal.className = "modal";
  modal.id = "checkoutModal";
  modal.innerHTML = `
    <div class="modal-panel" role="dialog" aria-modal="true" aria-labelledby="checkoutTitle">
      <h2 id="checkoutTitle">Checkout</h2>
      <p class="sub">Codes are shown on your order page and in your dashboard the moment payment clears.</p>

      <div class="order-summary">
        ${cart
          .map((l) => {
            const p = productById(l.id);
            const label = l.variant ? ` <span class="muted">· ${esc(l.variant)}</span>` : "";
            return `<div class="row"><span>${esc(p.name)}${label} × ${l.qty}</span><span>${money(
              priceFor(p, l.variant) * l.qty
            )}</span></div>`;
          })
          .join("")}
        <div class="row total"><span>Total</span><span>${money(cartTotal())}</span></div>
      </div>

      ${
        currentUser
          ? `<p class="signed-in">Signed in as <strong>${esc(currentUser.email)}</strong>
               <button class="link-btn" type="button" id="switchAccount">Use another account</button></p>`
          : `<div class="field">
               <label for="buyerEmail">Email address</label>
               <input type="email" id="buyerEmail" autocomplete="email" placeholder="you@example.com" required />
             </div>
             <div class="field">
               <label for="buyerPassword">Password <span class="hint">(creates your account)</span></label>
               <input type="password" id="buyerPassword" autocomplete="new-password" placeholder="At least 8 characters" />
             </div>`
      }

      <div class="field">
        <label for="contactType">How should we reach you about this order?</label>
        <select id="contactType" style="height:44px;padding:0 .7rem;border-radius:10px;border:1px solid var(--border);background:var(--surface);color:var(--text);font:inherit">
          <option value="telegram" ${prefilledType === "telegram" ? "selected" : ""}>Telegram</option>
          <option value="discord" ${prefilledType === "discord" ? "selected" : ""}>Discord</option>
        </select>
      </div>
      <div class="field">
        <label for="contactHandle">Your <span id="contactLabel">${prefilledType === "discord" ? "Discord" : "Telegram"}</span> username</label>
        <input type="text" id="contactHandle" value="${esc(prefilledHandle)}" placeholder="@yourname" autocomplete="off" />
      </div>
      <p class="note">We use this to reach you and to match your payment to your order.</p>

      <div class="modal-actions">
        <button class="btn btn-ghost" type="button" id="cancelCheckout">Cancel</button>
        <button class="btn btn-primary" type="button" id="placeOrder">Continue to payment</button>
      </div>
      <p class="form-error" id="checkoutError" role="alert" hidden></p>
    </div>`;
  document.body.appendChild(modal);

  const contactType = modal.querySelector("#contactType");
  contactType.addEventListener("change", () => {
    modal.querySelector("#contactLabel").textContent = contactType.value === "discord" ? "Discord" : "Telegram";
  });

  const close = () => {
    clearInterval(pollTimer);
    modal.remove();
  };
  modal.addEventListener("click", (e) => {
    if (e.target === modal) close();
  });
  modal.querySelector("#cancelCheckout").addEventListener("click", close);
  const switchBtn = modal.querySelector("#switchAccount");
  if (switchBtn) switchBtn.addEventListener("click", () => signOut());
  modal.querySelector("#placeOrder").addEventListener("click", () => placeOrder(modal));

  const emailInput = modal.querySelector("#buyerEmail");
  (emailInput || modal.querySelector("#contactHandle")).focus();
}

function showError(modal, message) {
  const box = modal.querySelector("#checkoutError") || modal.querySelector("#payError");
  if (box) {
    box.textContent = message;
    box.hidden = false;
  }
  return new Error(message);
}

async function ensureAccount(modal) {
  if (currentUser) return currentUser;
  const email = modal.querySelector("#buyerEmail").value.trim();
  const password = modal.querySelector("#buyerPassword").value;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) throw showError(modal, "Enter a valid email address.");
  if (password.length < 8) throw showError(modal, "Password must be at least 8 characters.");

  try {
    const res = await api.post("/api/auth/signup", { email, password });
    currentUser = res.user;
  } catch (error) {
    if (error.status !== 409) throw error;
    const res = await api.post("/api/auth/login", { email, password });
    currentUser = res.user;
  }
  return currentUser;
}

async function placeOrder(modal) {
  const button = modal.querySelector("#placeOrder");
  const contact = modal.querySelector("#contactHandle").value.trim();
  const contactType = modal.querySelector("#contactType").value;

  if (contact.replace(/^@/, "").length < 2) {
    return showError(modal, `Add your ${contactType === "discord" ? "Discord" : "Telegram"} username.`);
  }

  button.disabled = true;
  button.textContent = "Creating order…";
  try {
    await ensureAccount(modal);
    renderAccount();
    const { order } = await api.post("/api/orders", {
      items: cart.map((l) => ({ id: l.id, qty: l.qty, variant: l.variant || "" })),
      contactType,
      contact,
    });
    renderMethodStep(modal, order);
  } catch (error) {
    button.disabled = false;
    button.textContent = "Continue to payment";
    if (modal.querySelector("#checkoutError").hidden !== false) showError(modal, error.message);
  }
}

function methodIcon(method) {
  if (method.kind === "binance") return "🟡";
  if (method.kind === "sandbox") return "🧪";
  const map = { BTC: "₿", LTC: "Ł", ETH: "Ξ", USDT: "₮" };
  return map[(method.asset || "").toUpperCase()] || "🪙";
}

function renderMethodStep(modal, order) {
  const panel = modal.querySelector(".modal-panel");
  const methods = config.store.methods || [];
  const sandbox = config.payments.sandbox
    ? [{ id: "sandbox", label: "Sandbox (test)", kind: "sandbox", asset: "", network: "", instructions: "Test mode — no real money." }]
    : [];
  const list = [...methods, ...sandbox];

  panel.innerHTML = `
    <h2>Pay ${money(order.total)}</h2>
    <p class="sub">Order <strong>${esc(order.id)}</strong> · send your code on
      <strong>${esc(order.contact.type === "discord" ? "Discord" : "Telegram")}</strong>
      (<span>${esc(order.contact.handle)}</span>)</p>
    <p class="small muted" style="margin-bottom:.3rem">Choose how to pay:</p>
    <div class="method-grid" id="methodGrid">
      ${list
        .map(
          (m) => `
        <button class="method-card" type="button" data-method="${esc(m.id)}">
          <span class="mi" aria-hidden="true">${methodIcon(m)}</span>
          <span>
            <strong>${esc(m.label)}</strong>
            <span>${esc(m.kind === "crypto" ? `${m.asset} · ${m.network || "crypto"}` : m.kind === "binance" ? "Hosted checkout" : "Test payment")}</span>
          </span>
        </button>`
        )
        .join("")}
    </div>
    <p class="form-error" id="payError" role="alert" hidden></p>
    <p class="note" id="methodNote"></p>`;

  if (!list.length) {
    panel.querySelector("#methodGrid").innerHTML =
      `<p class="pay-warning">No payment method is available yet. Please contact support.</p>`;
    return;
  }

  panel.querySelector("#methodGrid").addEventListener("click", async (event) => {
    const card = event.target.closest("[data-method]");
    if (!card) return;
    panel.querySelectorAll(".method-card").forEach((el) => (el.disabled = true));
    card.disabled = true;
    try {
      const pay = await api.post(`/api/orders/${order.id}/pay`, { method: card.dataset.method });
      renderPayDetails(modal, order, pay);
    } catch (error) {
      showError(modal, error.message);
      panel.querySelectorAll(".method-card").forEach((el) => (el.disabled = false));
    }
  });
}

function copyField(label, value) {
  return `
    <div class="copy-field">
      <div style="flex:1;min-width:0">
        <span class="cf-label">${esc(label)}</span>
        <span class="cf-value">${esc(value)}</span>
      </div>
      <button type="button" data-copy="${esc(value)}">Copy</button>
    </div>`;
}

function renderPayDetails(modal, order, pay) {
  const panel = modal.querySelector(".modal-panel");

  if (pay.provider === "binance") {
    panel.innerHTML = `
      <h2>Pay ${esc(pay.amount)} ${esc(pay.currency)}</h2>
      <p class="sub">Order <strong>${esc(order.id)}</strong> · Binance Pay</p>
      <div class="pay-block">
        <a class="btn btn-primary btn-full" href="${esc(pay.checkoutUrl)}" target="_blank" rel="noopener">
          Open Binance Pay ↗
        </a>
        <p class="note">This page updates automatically once the payment is confirmed.</p>
        <button class="btn btn-ghost btn-full" type="button" id="checkPayment">Check payment status</button>
      </div>
      <p class="form-error" id="payError" role="alert" hidden></p>`;
    panel.querySelector("#checkPayment").addEventListener("click", () => verifyPayment(order.id, modal));
    startPolling(order.id, modal);
    return;
  }

  if (pay.sandbox) {
    panel.innerHTML = `
      <h2>Sandbox payment</h2>
      <p class="sub">Order <strong>${esc(order.id)}</strong> · no real money moves.</p>
      <div class="pay-block">
        <button class="btn btn-primary btn-full" type="button" id="simulatePay">Simulate successful payment</button>
      </div>
      <p class="form-error" id="payError" role="alert" hidden></p>`;
    panel.querySelector("#simulatePay").addEventListener("click", async () => {
      await api.post(`/api/dev/pay/${order.id}`);
      finishOrder(order.id, modal);
    });
    return;
  }

  panel.innerHTML = `
    <h2>Pay ${esc(pay.amount)} ${esc(pay.asset)}</h2>
    <p class="sub">Order <strong>${esc(order.id)}</strong> · ${esc(pay.label)}</p>
    <div class="pay-block">
      ${
        pay.instructions
          ? `<p class="pay-note">${esc(pay.instructions)}</p>`
          : `<p class="pay-note">Send exactly this amount on the ${esc(pay.network || pay.asset)} network.</p>`
      }
      ${copyField("Amount", pay.amount)}
      ${copyField("Address", pay.address)}
      ${pay.image ? `<img class="pay-image" src="${esc(pay.image)}" alt="Payment details" />` : ""}
      <p class="small muted">Send <strong>exactly</strong> ${esc(pay.amount)} ${esc(pay.asset)} — the unique amount is how your payment is matched.</p>
      <button class="btn btn-ghost btn-full" type="button" id="checkPayment">I've paid — check now</button>
      ${pay.autoVerify ? `<p class="note">We also check the blockchain automatically every minute.</p>` : `<p class="pay-warning">Automatic checking is off for this method — the admin will confirm manually.</p>`}
    </div>
    <p class="form-error" id="payError" role="alert" hidden></p>`;
  panel.querySelector("#checkPayment").addEventListener("click", () => verifyPayment(order.id, modal));
  startPolling(order.id, modal);
}

function startPolling(orderId, modal) {
  clearInterval(pollTimer);
  pollTimer = setInterval(async () => {
    try {
      const { status } = await api.get(`/api/orders/${orderId}/status`);
      if (status === "paid") {
        clearInterval(pollTimer);
        finishOrder(orderId, modal);
      } else if (status === "expired" || status === "cancelled") {
        clearInterval(pollTimer);
        const box = modal.querySelector("#payError");
        if (box) {
          box.textContent = "This payment window closed. Close this and start a new order.";
          box.hidden = false;
        }
      }
    } catch {
      /* keep polling */
    }
  }, 5000);
}

async function verifyPayment(orderId, modal) {
  const button = modal.querySelector("#checkPayment");
  if (button) {
    button.disabled = true;
    button.textContent = "Checking…";
  }
  try {
    const res = await api.get(`/api/orders/${orderId}/verify`);
    if (res.status === "paid") {
      clearInterval(pollTimer);
      finishOrder(orderId, modal);
      return;
    }
    showError(modal, res.warning || "Not received yet. Give it a minute and check again.");
  } catch (error) {
    showError(modal, error.message);
  }
  if (button) {
    button.disabled = false;
    button.textContent = "I've paid — check now";
  }
}

async function finishOrder(orderId, modal) {
  clearInterval(pollTimer);
  cart = [];
  saveCart();
  renderCart();

  let order = null;
  try {
    order = (await api.get(`/api/orders/${orderId}`)).order;
  } catch {
    /* ignore */
  }

  const codes = order && order.codes ? order.codes : [];
  const contact = order && order.contact ? order.contact : { type: "telegram", handle: "" };

  modal.querySelector(".modal-panel").innerHTML = `
    <div class="success-icon" aria-hidden="true">✓</div>
    <h2>Payment received</h2>
    <p class="sub">Order <strong>${esc(orderId)}</strong> is paid. Your codes are on this page and in your dashboard.</p>

    ${
      codes.length
        ? `<div class="code-list">
             ${codes
               .map(
                 (c) => `<div class="code-row">
                   <div><code>${esc(c.code)}</code><span>${esc(c.name || "")}</span></div>
                   <button type="button" data-copy="${esc(c.code)}">Copy</button>
                 </div>`
               )
               .join("")}
           </div>`
        : `<p class="note">${
            order && order.codeCount
              ? `Your ${order.codeCount} code(s) are ready — open the order page to see them.`
              : `Your codes are being prepared and will appear on your order page.`
          } You can also open the order page.</p>`
    }

    <p class="note">Send this order ID to the admin on ${esc(contact.type === "discord" ? "Discord" : "Telegram")} so they know it's you.</p>

    <div class="modal-actions">
      <a class="btn btn-primary" href="/order.html?id=${encodeURIComponent(orderId)}">View order</a>
      <button class="btn btn-ghost" type="button" id="continueBtn">Keep shopping</button>
    </div>`;
  modal.querySelector("#continueBtn").addEventListener("click", () => {
    modal.remove();
    closeAll();
  });
}

/* ---------------- header / account ---------------- */
function renderAccount() {
  const link = $("#accountLink");
  const adminLink = $("#adminLink");
  const messagesLink = $("#messagesLink");
  const walletLink = $("#walletLink");
  const msgBadge = $("#msgBadge");

  if (currentUser) {
    link.innerHTML = `${avatarHTML(currentUser, 26)}<span>${esc(currentUser.name || currentUser.email)}</span>`;
    link.href = "/dashboard.html";
  } else {
    link.textContent = "Sign in";
    link.href = "/login.html";
  }

  if (walletLink) walletLink.hidden = !currentUser;
  if (messagesLink) messagesLink.hidden = !currentUser;
  if (msgBadge) {
    const unread = (currentUser && currentUser.unreadMessages) || 0;
    msgBadge.textContent = unread;
    msgBadge.hidden = !unread;
  }
  if (adminLink) adminLink.hidden = !(currentUser && currentUser.role === "admin");
}

/* ---------------- events ---------------- */
document.addEventListener("click", async (e) => {
  const copyBtn = e.target.closest("[data-copy]");
  if (copyBtn) {
    const value = copyBtn.dataset.copy;
    try {
      await copyText(value);
      const previous = copyBtn.textContent;
      copyBtn.textContent = "Copied";
      setTimeout(() => (copyBtn.textContent = previous), 1400);
    } catch {
      copyBtn.textContent = value;
    }
    return;
  }

  const chip = e.target.closest(".variant-chip");
  if (chip) {
    const p = productById(chip.dataset.product);
    if (!p) return;
    const label = chip.dataset.variant;
    selectedVariants[p.id] = label;
    const card = chip.closest(".product");
    card.querySelectorAll(".variant-chip").forEach((el) => {
      el.setAttribute("aria-pressed", String(el === chip));
    });
    const oldPrice = oldPriceFor(p, label);
    card.querySelector(".price").innerHTML = `<strong>${money(priceFor(p, label))}</strong>${
      oldPrice ? `<del>${money(oldPrice)}</del>` : ""
    }`;
    const addBtn = card.querySelector("[data-add]");
    if (addBtn) addBtn.dataset.variant = label;
    return;
  }

  const add = e.target.closest("[data-add]");
  if (add) return addToCart(add.dataset.add, add.dataset.variant || "");

  const qty = e.target.closest("[data-qty]");
  if (qty) return setQty(qty.dataset.qty, Number(qty.dataset.delta));

  const rm = e.target.closest("[data-remove]");
  if (rm) return removeLine(rm.dataset.remove);

  const catChip = e.target.closest("[data-cat]");
  if (catChip) {
    activeCategory = catChip.dataset.cat;
    renderChips();
    renderProducts();
    return;
  }

  const jump = e.target.closest("[data-jump]");
  if (jump) {
    const cat = jump.dataset.jump;
    activeCategory = cat === "all" ? "All" : cat;
    renderChips();
    renderProducts();
  }
});

$("#cartButton").addEventListener("click", openCart);
$("#closeCart").addEventListener("click", closeAll);
$("#continueShopping").addEventListener("click", closeAll);
$("#overlay").addEventListener("click", closeAll);
$("#checkoutButton").addEventListener("click", openCheckout);

$("#searchInput").addEventListener("input", (e) => {
  searchTerm = e.target.value;
  renderProducts();
});

$("#sortSelect").addEventListener("change", (e) => {
  sortMode = e.target.value;
  renderProducts();
});

document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  const modal = $("#checkoutModal");
  if (modal) {
    clearInterval(pollTimer);
    return modal.remove();
  }
  closeAll();
});

$("#supportLink").addEventListener("click", (e) => {
  e.preventDefault();
  if (currentUser) window.location.href = "/messages.html";
  else window.location.href = "/login.html";
});

$("#year").textContent = new Date().getFullYear();

/* ---------------- boot ---------------- */
(async function init() {
  try {
    const [productsRes, categoriesRes, meRes, configRes] = await Promise.all([
      api.get("/api/products"),
      api.get("/api/categories"),
      api.get("/api/auth/me"),
      api.get("/api/config"),
    ]);
    PRODUCTS = productsRes.products || [];
    currentUser = meRes.user;
    config = configRes;

    // Admin-defined categories, in the admin's order. Empty categories stay hidden.
    CATEGORIES = (categoriesRes.categories || [])
      .filter((c) => c.productCount > 0)
      .map((c) => c.name);
    if (!CATEGORIES.length) CATEGORIES = [...new Set(PRODUCTS.map((p) => p.category))];
    if (activeCategory !== "All" && !CATEGORIES.includes(activeCategory)) {
      activeCategory = "All";
    }

    // Re-check saved carts: products/durations may have changed since they were added.
    cart = [];
    for (const line of loadCart()) {
      const p = productById(line.id);
      if (!p) continue;
      const list = variantsOf(p);
      let variant = line.variant && list.some((v) => v.label === line.variant) ? line.variant : "";
      if (list.length && !variant) variant = list[0].label;
      const key = `${p.id}::${variant}`;
      const existing = cart.find((l) => lineKey(l) === key);
      const qty = Math.min(Math.max(Number(line.qty) || 1, 1), 20);
      if (existing) existing.qty = Math.min(existing.qty + qty, 20);
      else cart.push(variant ? { id: p.id, qty, variant } : { id: p.id, qty });
    }
    saveCart();

    renderChips();
    renderProducts();
    renderCart();
    renderAccount();
  } catch (error) {
    $("#productGrid").innerHTML = `<p class="empty-state">Could not load products. Is the server running?</p>`;
    console.error(error);
  }
})();
