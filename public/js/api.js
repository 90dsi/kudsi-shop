/* Shared helpers for every page. */

function csrfToken() {
  const match = document.cookie.match(/(?:^|;\s*)kudsi_csrf=([^;]+)/);
  return match ? decodeURIComponent(match[1]) : "";
}

const api = {
  async request(method, url, data) {
    const headers = {};
    if (data) headers["Content-Type"] = "application/json";
    if (!["GET", "HEAD", "OPTIONS"].includes(method.toUpperCase())) {
      const token = csrfToken();
      if (token) headers["X-CSRF-Token"] = token;
    }
    const res = await fetch(url, {
      method,
      headers,
      credentials: "same-origin",
      body: data ? JSON.stringify(data) : undefined,
    });
    let payload = null;
    try {
      payload = await res.json();
    } catch {
      /* empty body */
    }
    if (!res.ok) {
      const error = new Error((payload && payload.error) || `Request failed (${res.status})`);
      error.status = res.status;
      error.payload = payload;
      throw error;
    }
    return payload || {};
  },
  get: (url) => api.request("GET", url),
  post: (url, data) => api.request("POST", url, data),
  patch: (url, data) => api.request("PATCH", url, data),
  del: (url) => api.request("DELETE", url),
};

const money = (n) => "$" + Number(n || 0).toFixed(2);

/** Currency formatting that follows the admin's chosen symbol. */
function fmtMoney(value, symbol) {
  const s = symbol || (window.SITE && window.SITE.wallet && window.SITE.wallet.symbol) || "$";
  return s + Number(value || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/* ------------------------------------------------------------------ toasts */
function toast(message, type = "info", detail = "") {
  let stack = document.querySelector(".toast-stack");
  if (!stack) {
    stack = document.createElement("div");
    stack.className = "toast-stack";
    document.body.appendChild(stack);
  }
  const icons = { success: "✓", error: "!", info: "i" };
  const el = document.createElement("div");
  el.className = `toast ${type}`;
  el.innerHTML = `<span class="ico">${icons[type] || "i"}</span><div><strong>${esc(message)}</strong>${
    detail ? `<p>${esc(detail)}</p>` : ""
  }</div>`;
  stack.appendChild(el);
  setTimeout(() => {
    el.classList.add("out");
    setTimeout(() => el.remove(), 260);
  }, 4200);
}

/* --------------------------------------------------------------- utilities */
function timeAgo(value) {
  if (!value) return "—";
  const d = new Date(value.includes("T") ? value : value.replace(" ", "T") + "Z");
  if (Number.isNaN(d.getTime())) return value;
  const diff = (Date.now() - d.getTime()) / 1000;
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  if (diff < 604800) return `${Math.floor(diff / 86400)}d ago`;
  return today(value);
}

function copyText(text) {
  if (navigator.clipboard && window.isSecureContext) {
    navigator.clipboard.writeText(text);
    return Promise.resolve();
  }
  const area = document.createElement("textarea");
  area.value = text;
  area.style.position = "fixed";
  area.style.opacity = "0";
  document.body.appendChild(area);
  area.select();
  try {
    document.execCommand("copy");
  } finally {
    area.remove();
  }
  return Promise.resolve();
}

/** Fetch public branding/contact/wallet config once per page. */
async function loadSite() {
  try {
    window.SITE = await api.get("/api/site");
  } catch {
    window.SITE = { app: { name: "Kudsi Shop", symbol: "$" }, contact: {}, wallet: { methods: [] } };
  }
  const name = (window.SITE.app && window.SITE.app.name) || "Kudsi Shop";
  document.querySelectorAll("[data-app-name]").forEach((el) => (el.textContent = name));
  const logo = (window.SITE.app && window.SITE.app.logo) || "K";
  document.querySelectorAll(".brand-mark").forEach((el) => (el.textContent = logo));
  const accent = window.SITE.app && window.SITE.app.accent;
  if (accent) document.documentElement.style.setProperty("--accent", accent);
  return window.SITE;
}

const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const initials = (emailOrName) => {
  const text = String(emailOrName || "?").trim();
  return text.slice(0, 1).toUpperCase();
};

/** Avatar markup: uploaded pic, remote image, or a letter bubble. */
function avatarHTML(user, size = 40) {
  const src = user && (user.avatar || null);
  if (src) {
    return `<img class="avatar" src="${esc(src)}" alt="" width="${size}" height="${size}" loading="lazy" />`;
  }
  return `<span class="avatar avatar-letter" style="width:${size}px;height:${size}px;font-size:${Math.round(size * 0.42)}px">${esc(
    initials(user && (user.name || user.email))
  )}</span>`;
}

/** Resize an uploaded image to a square data URL so avatars stay small. */
function readAvatarFile(file, size = 160) {
  return new Promise((resolve, reject) => {
    if (!file.type.startsWith("image/")) return reject(new Error("Pick an image file."));
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("Could not read that file."));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error("That image could not be loaded."));
      img.onload = () => {
        const canvas = document.createElement("canvas");
        canvas.width = canvas.height = size;
        const ctx = canvas.getContext("2d");
        const scale = Math.max(size / img.width, size / img.height);
        const w = img.width * scale;
        const h = img.height * scale;
        ctx.drawImage(img, (size - w) / 2, (size - h) / 2, w, h);
        resolve(canvas.toDataURL("image/jpeg", 0.85));
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

const today = (value) => {
  if (!value) return "—";
  const d = new Date(value.includes("T") ? value : value.replace(" ", "T") + "Z");
  if (Number.isNaN(d.getTime())) return value;
  return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
};

async function signOut() {
  await api.post("/api/auth/logout");
  window.location.href = "/";
}
