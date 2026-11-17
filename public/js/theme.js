/* ============================================================
   Kudsi Shop — theme controller
   Runs in <head> so the stored theme is on <html> before the
   page paints, then injects the toggle into the page chrome.
   ============================================================ */
(function () {
  "use strict";

  var STORAGE_KEY = "kudsi-theme";
  var DARK_META = "#05070e";
  var LIGHT_META = "#f4f6fb";
  var root = document.documentElement;

  var SUN =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true">' +
    '<circle cx="12" cy="12" r="4.1"/>' +
    '<path d="M12 2.6v2.1M12 19.3v2.1M4.9 4.9l1.5 1.5M17.6 17.6l1.5 1.5M2.6 12h2.1M19.3 12h2.1M4.9 19.1l1.5-1.5M17.6 6.4l1.5-1.5"/>' +
    "</svg>";

  var MOON =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<path d="M20.6 14.4A8.6 8.6 0 0 1 9.6 3.4a8.6 8.6 0 1 0 11 11Z"/>' +
    "</svg>";

  function storedTheme() {
    try {
      var value = window.localStorage.getItem(STORAGE_KEY);
      return value === "light" ? "light" : "dark";
    } catch (error) {
      return "dark";
    }
  }

  var theme = storedTheme();

  function paintMeta() {
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute("content", theme === "light" ? LIGHT_META : DARK_META);
  }

  function paintButtons() {
    var buttons = document.querySelectorAll("[data-theme-toggle]");
    for (var i = 0; i < buttons.length; i++) {
      var button = buttons[i];
      var toLight = theme === "dark";
      button.innerHTML = toLight ? SUN : MOON;
      button.setAttribute("aria-label", toLight ? "Switch to light theme" : "Switch to dark theme");
      button.setAttribute("title", toLight ? "Switch to light theme" : "Switch to dark theme");
      button.setAttribute("aria-pressed", theme === "light" ? "true" : "false");
    }
  }

  function apply(next, persist) {
    theme = next === "light" ? "light" : "dark";
    root.setAttribute("data-theme", theme);
    root.style.colorScheme = theme === "light" ? "light" : "dark";
    paintMeta();
    paintButtons();
    if (persist) {
      try {
        window.localStorage.setItem(STORAGE_KEY, theme);
      } catch (error) {
        /* Private mode: the choice simply lasts for this page. */
      }
    }
  }

  function toggle() {
    apply(theme === "light" ? "dark" : "light", true);
  }

  function makeToggle() {
    var button = document.createElement("button");
    button.type = "button";
    button.className = "theme-toggle";
    button.setAttribute("data-theme-toggle", "");
    button.addEventListener("click", toggle);
    return button;
  }

  function mount() {
    if (document.querySelector("[data-theme-toggle]")) {
      paintButtons();
      return;
    }

    var button = makeToggle();
    var actions = document.querySelector(".site-header .header-actions") ||
      document.querySelector(".header-actions");

    if (actions) {
      var cart = actions.querySelector(".cart-button");
      if (cart) {
        actions.insertBefore(button, cart);
      } else {
        actions.appendChild(button);
      }
    } else {
      var topbar = document.querySelector(".topbar");
      if (topbar) {
        topbar.appendChild(button);
      } else {
        button.classList.add("theme-toggle-floating");
        document.body.appendChild(button);
      }
    }
    paintButtons();
  }

  /* Apply before the first paint. */
  apply(theme, false);

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", function () {
      paintMeta();
      mount();
    });
  } else {
    paintMeta();
    mount();
  }

  /* Keep other tabs in sync. */
  window.addEventListener("storage", function (event) {
    if (event.key === STORAGE_KEY) apply(storedTheme(), false);
  });

  window.KudsiTheme = {
    get: function () {
      return theme;
    },
    set: function (next) {
      apply(next, true);
    }
  };
})();
