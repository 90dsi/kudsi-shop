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
  async upload(url, formData) {
    const headers = {};
    const token = csrfToken();
    if (token) headers["X-CSRF-Token"] = token;
    const res = await fetch(url, {
      method: "POST",
      headers,
      credentials: "same-origin",
      body: formData,
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

async function copyText(text) {
  if (navigator.clipboard && window.isSecureContext) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch {
      /* fall back to the textarea method */
    }
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

/** Avatar markup: uploaded/social picture with a letter fallback behind it. */
function avatarHTML(user, size = 40) {
  const src = user && (user.avatar || null);
  const letter = initials(user && (user.name || user.email));
  const fallback = `<span class="avatar avatar-letter" style="width:${size}px;height:${size}px;font-size:${Math.round(
    size * 0.42
  )}px">${esc(letter)}</span>`;
  if (!src) return fallback;
  return `<span class="avatar-frame" style="width:${size}px;height:${size}px">${fallback}<img class="avatar" src="${esc(
    src
  )}" alt="" width="${size}" height="${size}" loading="lazy" referrerpolicy="no-referrer" onerror="this.remove()" /></span>`;
}

/** Small SVG marks used by the connected-accounts screen. */
function providerIcon(provider) {
  if (provider === "google") {
    return `<svg class="provider-mark" viewBox="0 0 24 24" aria-hidden="true">
      <path fill="#4285F4" d="M23.5 12.3c0-.8-.1-1.6-.2-2.3H12v4.5h6.5a5.6 5.6 0 0 1-2.4 3.6v3h3.9c2.3-2.1 3.5-5.2 3.5-8.8Z"/>
      <path fill="#34A853" d="M12 24c3.2 0 5.9-1.1 7.9-2.9l-3.9-3c-1.1.7-2.4 1.2-4 1.2-3.1 0-5.7-2.1-6.7-4.9H1.3v3.1A12 12 0 0 0 12 24Z"/>
      <path fill="#FBBC05" d="M5.3 14.4a7.2 7.2 0 0 1 0-4.6V6.7H1.3a12 12 0 0 0 0 10.7l4-3Z"/>
      <path fill="#EA4335" d="M12 4.8c1.8 0 3.3.6 4.6 1.8l3.4-3.4A11.5 11.5 0 0 0 12 0 12 12 0 0 0 1.3 6.7l4 3.1C6.3 6.9 8.9 4.8 12 4.8Z"/>
    </svg>`;
  }
  if (provider === "discord") {
    return `<svg class="provider-mark" viewBox="0 0 24 24" aria-hidden="true">
      <path fill="#5865F2" d="M20.32 4.57a19.8 19.8 0 0 0-4.93-1.52.07.07 0 0 0-.08.04c-.21.38-.45.87-.61 1.26a18.3 18.3 0 0 0-5.4 0 12.6 12.6 0 0 0-.62-1.26.08.08 0 0 0-.08-.04c-1.71.3-3.36.8-4.93 1.52a.07.07 0 0 0-.03.03C.53 9.04-.32 13.38.1 17.67a.08.08 0 0 0 .03.06 19.9 19.9 0 0 0 6.05 3.06.08.08 0 0 0 .09-.03c.47-.64.88-1.31 1.23-2.02a.08.08 0 0 0-.04-.11 13.1 13.1 0 0 1-1.87-.9.08.08 0 0 1 0-.13c.12-.1.25-.19.37-.29a.07.07 0 0 1 .08-.01c3.93 1.8 8.18 1.8 12.06 0a.07.07 0 0 1 .08.01c.12.1.25.2.37.3a.08.08 0 0 1 0 .12c-.6.35-1.22.65-1.88.9a.08.08 0 0 0-.04.11c.36.71.77 1.38 1.23 2.02a.08.08 0 0 0 .09.03 19.8 19.8 0 0 0 6.06-3.06.08.08 0 0 0 .03-.06c.5-4.96-.84-9.26-3.55-13.07a.06.06 0 0 0-.03-.03ZM8.02 15.04c-1.18 0-2.15-1.09-2.15-2.42s.95-2.42 2.15-2.42c1.21 0 2.17 1.1 2.15 2.42 0 1.33-.95 2.42-2.15 2.42Zm7.97 0c-1.18 0-2.15-1.09-2.15-2.42s.95-2.42 2.15-2.42c1.21 0 2.17 1.1 2.15 2.42 0 1.33-.94 2.42-2.15 2.42Z"/>
    </svg>`;
  }
  return "";
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
