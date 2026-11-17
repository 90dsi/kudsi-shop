/* Account completion after Google / Discord sign-in */

const $ = (s) => document.querySelector(s);

function providerLabel(provider) {
  return provider === "discord" ? "Discord" : "Google";
}

(async function init() {
  try {
    await loadSite();
  } catch {
    /* branding is optional */
  }

  let pending = null;
  try {
    const result = await api.get("/api/auth/oauth/pending");
    pending = result.pending;
  } catch (error) {
    $("#completeError").textContent =
      error.status === 404
        ? "There is no sign-in waiting to be completed. Start again from the sign-in page."
        : error.message;
    $("#completeError").hidden = false;
    $("#completeBtn").disabled = true;
    return;
  }

  document.title = `Finish your account — ${(window.SITE && window.SITE.app && window.SITE.app.name) || "Kudsi Shop"}`;
  const label = providerLabel(pending.provider);
  $("#completeTitle").textContent = "Finish your account";
  $("#completeSub").textContent = `Your ${label} account is verified. Pick the display name you want on Kudsi Shop.`;

  const box = $("#providerBox");
  box.hidden = false;
  $("#providerAvatar").innerHTML = avatarHTML(
    { name: pending.name || pending.username, avatar: pending.avatar || null },
    48
  );
  $("#providerName").textContent = pending.name || pending.username || `${label} account`;
  $("#providerDetail").textContent = pending.email || (pending.username ? `@${pending.username}` : label);

  const input = $("#displayName");
  input.value = (pending.name || "").slice(0, 30);
  input.focus();
  input.select();

  $("#completeForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const errorBox = $("#completeError");
    const button = $("#completeBtn");
    const name = input.value.trim().replace(/\s+/g, " ");
    errorBox.hidden = true;
    if (!name) {
      errorBox.textContent = "Enter a display name.";
      errorBox.hidden = false;
      return;
    }
    if (name.length > 30) {
      errorBox.textContent = "Display names can be at most 30 characters.";
      errorBox.hidden = false;
      return;
    }
    button.disabled = true;
    button.textContent = "Creating your account…";
    try {
      const { user } = await api.post("/api/auth/oauth/complete", { name });
      window.location.href = user.role === "admin" ? "/admin.html" : "/dashboard.html";
    } catch (error) {
      errorBox.textContent = error.message;
      errorBox.hidden = false;
      button.disabled = false;
      button.textContent = "Create my account";
    }
  });

  $("#cancelLink").addEventListener("click", async (event) => {
    event.preventDefault();
    try {
      await api.post("/api/auth/oauth/cancel", {});
    } catch {
      /* ignore */
    }
    window.location.href = "/login.html";
  });
})();
