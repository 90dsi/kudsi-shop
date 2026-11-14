/* Customer <-> admin private messages */

const $ = (s) => document.querySelector(s);
let poll = null;
let lastCount = -1;

const bubble = (m) => {
  const mine = m.sender === "customer";
  const when = m.createdAt
    ? new Date(m.createdAt.includes("T") ? m.createdAt : m.createdAt.replace(" ", "T") + "Z")
    : null;
  const label = when && !Number.isNaN(when.getTime())
    ? when.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })
    : "";
  return `<div class="bubble ${mine ? "customer" : "admin"}">${esc(m.body)}<time>${esc(label)}</time></div>`;
};

function render(messages, forceScroll = false) {
  const box = $("#thread");
  const empty = $("#threadEmpty");
  if (!messages.length) {
    box.innerHTML = `<p class="chat-empty">No messages yet.<br />Ask us anything — payment help, order status, or a code that didn't arrive.</p>`;
    return;
  }
  if (empty) empty.remove();

  const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 80;
  box.innerHTML = messages.map(bubble).join("");
  if (forceScroll || atBottom || messages.length !== lastCount) {
    box.scrollTop = box.scrollHeight;
  }
  lastCount = messages.length;
}

async function load(forceScroll = false) {
  try {
    const { messages } = await api.get("/api/messages");
    render(messages || [], forceScroll);
  } catch (error) {
    if (error.status === 401) window.location.href = "/login.html?next=/messages.html";
  }
}

async function boot() {
  try {
    const { user } = await api.get("/api/auth/me");
    if (!user) {
      window.location.href = "/login.html?next=/messages.html";
      return;
    }
    if (user.role === "admin") {
      // Admins answer from the dashboard.
      window.location.href = "/admin.html";
      return;
    }
    $("#adminLink").hidden = true;
    await load(true);
    poll = setInterval(() => load(false), 6000);
  } catch (error) {
    $("#thread").innerHTML = `<p class="chat-empty">${esc(error.message)}</p>`;
  }
}

$("#chatForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const input = $("#chatInput");
  const button = $("#sendBtn");
  const body = input.value.trim();
  if (!body) return;

  button.disabled = true;
  try {
    await api.post("/api/messages", { body });
    input.value = "";
    await load(true);
  } catch (error) {
    const box = $("#chatError");
    box.textContent = error.message;
    box.hidden = false;
  }
  button.disabled = false;
});

$("#chatInput").addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    $("#chatForm").requestSubmit();
  }
});

$("#signOutBtn").addEventListener("click", signOut);
window.addEventListener("beforeunload", () => clearInterval(poll));
boot();
