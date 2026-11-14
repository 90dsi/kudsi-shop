"""Kudsi Shop — storefront backend.

Run:  python app.py        (then open http://localhost:3000)
First visit: /setup creates your admin account.
"""

import json
import os
import re
import secrets
import threading
import time
from datetime import timedelta
from pathlib import Path

from flask import Flask, Response, g, jsonify, redirect, request, send_from_directory, session
from werkzeug.middleware.proxy_fix import ProxyFix

import auth
import crypto
import delivery
import mailer
import notify
import payments
import payqr
import wallet
from db import (
    DATA_DIR,
    execute,
    fetch_all,
    fetch_one,
    get_db,
    get_setting,
    init_db,
    money_db,
    set_setting,
    setting_bool,
)

APP_DIR = Path(__file__).resolve().parent
PUBLIC_DIR = APP_DIR / "public"
EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[a-zA-Z]{2,}$")


def load_env():
    """Tiny .env loader so we need no extra dependency."""
    path = APP_DIR / ".env"
    if not path.exists():
        return
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))


load_env()


def here() -> str:
    query = request.query_string.decode()
    return request.path + (f"?{query}" if query else "")


def _secret_key() -> str:
    key = os.environ.get("SECRET_KEY", "").strip()
    if key:
        return key
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    path = DATA_DIR / "secret.key"
    if path.exists():
        return path.read_text().strip()
    key = secrets.token_hex(32)
    path.write_text(key)
    return key


app = Flask(__name__, static_folder=str(PUBLIC_DIR), static_url_path="")
app.config.update(
    SECRET_KEY=_secret_key(),
    SESSION_COOKIE_HTTPONLY=True,
    SESSION_COOKIE_SAMESITE="Lax",
    SESSION_COOKIE_SECURE=os.environ.get("COOKIE_SECURE", "0") == "1",
    PERMANENT_SESSION_LIFETIME=timedelta(days=14),
    MAX_CONTENT_LENGTH=4 * 1024 * 1024,
)

if os.environ.get("TRUST_PROXY", "0") == "1":
    app.wsgi_app = ProxyFix(app.wsgi_app, x_for=1, x_proto=1, x_host=1)

init_db()


def base_url() -> str:
    """Public origin for links. Uses PUBLIC_BASE_URL, else the current request host."""
    configured = os.environ.get("PUBLIC_BASE_URL", "").strip().rstrip("/")
    if configured:
        return configured
    try:
        return request.url_root.rstrip("/")
    except RuntimeError:
        return "http://localhost:3000"


def app_name() -> str:
    return (get_setting("app_name") or "Kudsi Shop").strip()[:60] or "Kudsi Shop"


# --------------------------------------------------------------------- CSRF
# Double-submit cookie: the browser reads `kudsi_csrf` and mirrors it in the
# X-CSRF-Token header. A cross-site page can trigger a POST but cannot read the
# cookie, so it cannot produce a matching header.
CSRF_COOKIE = "kudsi_csrf"
CSRF_EXEMPT = {
    "/api/setup",
    "/api/auth/login",
    "/api/auth/signup",
    "/api/auth/forgot",
    "/api/auth/reset",
}
CSRF_EXEMPT_PREFIXES = ("/api/webhooks/",)


def csrf_token() -> str:
    token = session.get("csrf")
    if not token:
        token = secrets.token_urlsafe(32)
        session["csrf"] = token
    return token


@app.after_request
def attach_csrf_cookie(response):
    if not request.cookies.get(CSRF_COOKIE):
        response.set_cookie(
            CSRF_COOKIE,
            csrf_token(),
            max_age=60 * 60 * 24 * 30,
            samesite="Lax",
            httponly=False,
            secure=os.environ.get("COOKIE_SECURE", "0") == "1",
        )
    return response


@app.before_request
def csrf_guard():
    if request.method in {"GET", "HEAD", "OPTIONS"}:
        return None
    if not request.path.startswith("/api/"):
        return None
    if request.path in CSRF_EXEMPT or request.path.startswith(CSRF_EXEMPT_PREFIXES):
        return None
    sent = request.headers.get("X-CSRF-Token", "")
    cookie = request.cookies.get(CSRF_COOKIE, "")
    if not sent or not cookie or not secrets.compare_digest(sent, cookie):
        return jsonify(error="Your session expired. Refresh the page and try again."), 403
    return None


def apply_db_payment_settings():
    """Environment wins; keys saved in the dashboard fill the gaps."""
    pairs = (
        ("BINANCE_PAY_API_KEY", "binance_api_key"),
        ("BINANCE_PAY_SECRET", "binance_secret"),
        ("BINANCE_PAY_CERT_SN", "binance_cert_sn"),
    )
    for env_key, setting in pairs:
        if not os.environ.get(env_key):
            value = (get_setting(setting) or "").strip()
            if value:
                os.environ[env_key] = value


apply_db_payment_settings()


# -------------------------------------------------------------------- helpers
def body() -> dict:
    data = request.get_json(silent=True)
    return data if isinstance(data, dict) else {}


def err(message: str, status: int = 400):
    return jsonify(error=message), status


def clean(value, limit: int = 200) -> str:
    return str(value or "").strip()[:limit]


def is_email(value: str) -> bool:
    return bool(EMAIL_RE.match(value)) and len(value) <= 190


def product_variants(row: dict) -> list[dict]:
    """Parse the product's duration options (stored as JSON in `variants`)."""
    raw = row.get("variants")
    if not raw:
        return []
    try:
        data = json.loads(raw)
    except (TypeError, ValueError):
        return []
    if not isinstance(data, list):
        return []
    out = []
    for entry in data:
        if not isinstance(entry, dict):
            continue
        label = clean(entry.get("label"), 40)
        price_cents = entry.get("priceCents")
        if not label or not isinstance(price_cents, int) or price_cents <= 0:
            continue
        old_cents = entry.get("oldPriceCents")
        out.append(
            {
                "label": label,
                "priceCents": price_cents,
                "oldPriceCents": old_cents if isinstance(old_cents, int) and old_cents > price_cents else None,
            }
        )
    return out


def variants_payload(data) -> tuple[list[dict] | None, str | None]:
    """Validate admin input for duration options. Returns (variants, error)."""
    if data is None:
        return None, None
    if not isinstance(data, list):
        return None, "Duration options must be a list."
    if len(data) > 12:
        return None, "Keep it to 12 durations or fewer."

    out, seen = [], set()
    for entry in data:
        if not isinstance(entry, dict):
            continue
        label = clean(entry.get("label"), 40)
        if not label:
            return None, "Every duration needs a name (like “14 days”)."
        if label.lower() in seen:
            return None, f"“{label}” is listed twice — use a different name."
        seen.add(label.lower())
        try:
            if entry.get("priceCents") is not None:
                cents = int(entry["priceCents"])
            else:
                cents = int(round(float(entry.get("price", 0)) * 100))
        except (TypeError, ValueError):
            return None, f"The price for “{label}” must be a number."
        if cents <= 0:
            return None, f"The price for “{label}” must be greater than zero."
        old_cents = None
        if entry.get("oldPrice") not in (None, ""):
            try:
                old_cents = int(round(float(entry["oldPrice"]) * 100))
            except (TypeError, ValueError):
                return None, f"The compare-at price for “{label}” must be a number."
            if old_cents <= cents:
                old_cents = None
        out.append({"label": label, "priceCents": cents, "oldPriceCents": old_cents})
    return out, None


def product_json(row: dict) -> dict:
    variants = product_variants(row)
    return {
        "id": row["id"],
        "name": row["name"],
        "category": row["category"],
        "price": round(row["price_cents"] / 100, 2),
        "priceCents": row["price_cents"],
        "oldPrice": round(row["old_price_cents"] / 100, 2) if row["old_price_cents"] else None,
        "emoji": row["emoji"],
        "image": row["image"],
        "art": row["art"],
        "region": row["region"],
        "badge": row["badge"],
        "desc": row["description"],
        "variants": [
            {
                "label": v["label"],
                "price": round(v["priceCents"] / 100, 2),
                "priceCents": v["priceCents"],
                "oldPrice": round(v["oldPriceCents"] / 100, 2) if v["oldPriceCents"] else None,
            }
            for v in variants
        ],
        "hasVariants": bool(variants),
        "active": bool(row["active"]),
        "sortOrder": row["sort_order"],
    }


# ----------------------------------------------------------- payment methods
def method_available(method: dict) -> bool:
    if not method.get("enabled"):
        return False
    if method["kind"] == "binance":
        return payments.config()["binance_enabled"]
    return bool((method.get("address") or "").strip())


def available_methods() -> list[dict]:
    rows = fetch_all("SELECT * FROM payment_methods ORDER BY sort_order, label")
    return [m for m in rows if method_available(m)]


def method_json(method: dict, private: bool = False) -> dict:
    data = {
        "id": method["id"],
        "label": method["label"],
        "asset": method["asset"],
        "network": method["network"],
        "kind": method["kind"],
        "instructions": method["instructions"],
        "autoVerify": bool(method["auto_verify"]),
        "enabled": bool(method["enabled"]),
        "sortOrder": method["sort_order"],
        "rateUsd": method["rate_usd"],
        "hasAddress": bool((method["address"] or "").strip()),
        "image": method["image"],
        "available": method_available(method),
    }
    if private:
        data["address"] = method["address"]
    return data


# -------------------------------------------------------------------- orders
def order_json(order: dict, items: list[dict], include_codes: bool = False) -> dict:
    method = fetch_one("SELECT * FROM payment_methods WHERE id = ?", (order["provider"],)) \
        if order["provider"] else None
    data = {
        "id": order["id"],
        "customerId": order["user_id"],
        "email": order["email"],
        "status": order["status"],
        "total": round(order["total_cents"] / 100, 2),
        "currency": order["currency"],
        "provider": order["provider"],
        "methodLabel": method["label"] if method else (order["provider"] or None),
        "payKind": method["kind"] if method else None,
        "payNetwork": method["network"] if method else None,
        "payInstructions": method["instructions"] if method else None,
        "payImage": method["image"] if method else None,
        "autoVerify": bool(method["auto_verify"]) if method else False,
        "checkoutUrl": order["checkout_url"],
        "payAddress": order["pay_address"],
        "payAmount": order["pay_amount"],
        "payAsset": order["pay_asset"],
        "txid": order["txid"],
        "contact": {"type": order["contact_type"], "handle": order["contact_handle"]},
        "deliveredAt": order["delivered_at"],
        "createdAt": order["created_at"],
        "paidAt": order["paid_at"],
        "expiresAt": order["expires_at"],
        "items": [
            {
                "productId": i["product_id"],
                "name": i["name"],
                "variant": i.get("variant"),
                "emoji": i["emoji"],
                "image": i["image"],
                "qty": i["qty"],
                "unitPrice": round(i["unit_price_cents"] / 100, 2),
                "lineTotal": round(i["unit_price_cents"] * i["qty"] / 100, 2),
            }
            for i in items
        ],
    }
    if order["status"] == "paid":
        codes = delivery.order_codes(order["id"])
        data["codeCount"] = len(codes)
        if include_codes:
            data["codes"] = [
                {"code": c["code"], "name": delivery.code_label(c)} for c in codes
            ]
    return data


def load_order(order_id: str) -> tuple[dict | None, list[dict]]:
    order = fetch_one("SELECT * FROM orders WHERE id = ?", (order_id,))
    if not order:
        return None, []
    items = fetch_all("SELECT * FROM order_items WHERE order_id = ? ORDER BY id", (order_id,))
    return order, items


def can_view(order: dict) -> bool:
    user = auth.current_user()
    if not user:
        return False
    return user["role"] == "admin" or order["user_id"] == user["id"]


def order_is_expired(order: dict) -> bool:
    return (
        order["status"] == "pending"
        and order["expires_at"]
        and order["expires_at"] < int(time.time())
    )


def complete_order(order_id: str, txid: str | None = None) -> bool:
    """Mark paid (once), then generate codes on the site."""
    with get_db() as con:
        cur = con.execute(
            "UPDATE orders SET status = 'paid', "
            "paid_at = COALESCE(paid_at, datetime('now')), "
            "txid = COALESCE(?, txid) "
            "WHERE id = ? AND status != 'paid'",
            (txid, order_id),
        )
        changed = cur.rowcount > 0
    if changed:
        order = fetch_one("SELECT * FROM orders WHERE id = ?", (order_id,))
        if order and order.get("user_id"):
            notify.customer_notify(
                order["user_id"],
                "order",
                "Payment confirmed",
                f"Order {order_id} is paid. Your codes are ready.",
                order_id,
            )
        try:
            delivery.fulfil(order_id)
        except Exception as exc:  # noqa: BLE001 - never lose a paid order over a delivery bug
            print(f"[delivery] failed for {order_id}: {exc}")
    return changed


def check_crypto_order(order: dict) -> dict:
    method = fetch_one("SELECT * FROM payment_methods WHERE id = ?", (order["provider"],))
    if not method:
        return {"paid": False, "error": "Payment method no longer exists."}
    used = {r["txid"] for r in fetch_all("SELECT txid FROM orders WHERE txid IS NOT NULL")}
    result = crypto.check_payment(method, order, used)
    execute("UPDATE orders SET last_checked = ? WHERE id = ?", (int(time.time()), order["id"]))
    if result.get("paid"):
        complete_order(order["id"], result.get("txid"))
    return result


def admin_count() -> int:
    row = fetch_one("SELECT COUNT(*) AS n FROM users WHERE role = 'admin'")
    return row["n"] if row else 0


# ------------------------------------------------------------ brute-force guard
_attempts: dict[str, list[float]] = {}


def too_many(limit: int = 12, window: int = 60) -> bool:
    ip = request.headers.get("X-Forwarded-For", request.remote_addr or "?").split(",")[0].strip()
    now = time.time()
    hits = [t for t in _attempts.get(ip, []) if now - t < window]
    hits.append(now)
    _attempts[ip] = hits
    return len(hits) > limit


# ------------------------------------------------------------------ static pages
@app.get("/")
def index():
    if admin_count() == 0:
        return redirect("/setup.html")
    user = auth.current_user()
    if str(get_setting("maintenance_mode") or "0") == "1" and (not user or user["role"] != "admin"):
        return send_from_directory(PUBLIC_DIR, "maintenance.html"), 503
    return send_from_directory(PUBLIC_DIR, "index.html")


# ------------------------------------------------------------------------ auth
@app.get("/api/setup/status")
def setup_status():
    return jsonify(needsSetup=admin_count() == 0)


@app.post("/api/setup")
def setup():
    if admin_count() > 0:
        return err("Setup is already complete.", 403)
    data = body()
    email = clean(data.get("email"), 190).lower()
    password = str(data.get("password") or "")
    name = clean(data.get("name"), 80) or "Owner"

    if not is_email(email):
        return err("Enter a valid email address.")
    if len(password) < 8:
        return err("Password must be at least 8 characters.")

    uid = execute(
        "INSERT INTO users (email, name, password_hash, role) VALUES (?, ?, ?, 'admin')",
        (email, name, auth.hash_password(password)),
    )
    auth.login_user(uid)
    return jsonify(user=auth.public_user(auth.current_user()))


@app.post("/api/auth/signup")
def signup():
    if too_many():
        return err("Too many attempts. Try again in a minute.", 429)
    data = body()
    email = clean(data.get("email"), 190).lower()
    password = str(data.get("password") or "")
    name = clean(data.get("name"), 80)

    if not is_email(email):
        return err("Enter a valid email address.")
    if len(password) < 8:
        return err("Password must be at least 8 characters.")
    if fetch_one("SELECT id FROM users WHERE email = ?", (email,)):
        return jsonify(
            error="That email already has an account. Sign in instead.",
            code="account_exists",
        ), 409

    uid = execute(
        "INSERT INTO users (email, name, password_hash, role) VALUES (?, ?, ?, 'customer')",
        (email, name, auth.hash_password(password)),
    )
    auth.login_user(uid)
    return jsonify(user=auth.public_user(auth.current_user()))


@app.post("/api/auth/login")
def login():
    if too_many():
        return err("Too many attempts. Try again in a minute.", 429)
    data = body()
    email = clean(data.get("email"), 190).lower()
    password = str(data.get("password") or "")

    user = fetch_one("SELECT * FROM users WHERE email = ?", (email,))
    if not user:
        # The sign-in page uses this code to send the visitor to the create-account
        # form instead of leaving them stuck. Rate limiting still applies.
        return jsonify(error="No account found for that email.", code="no_account"), 404
    if not auth.verify_password(password, user["password_hash"]):
        return err("Wrong email or password.", 401)
    if user.get("status", "active") != "active":
        return err(
            "This account is suspended. Message us on Telegram or Discord and we'll help.",
            403,
        )

    execute("UPDATE users SET last_login = datetime('now') WHERE id = ?", (user["id"],))
    auth.login_user(user["id"])
    return jsonify(user=auth.public_user(auth.current_user()))


@app.post("/api/auth/logout")
def logout():
    auth.logout_user()
    return jsonify(ok=True)


# --------------------------------------------------------- password recovery
def _reset_email(user: dict) -> str:
    return user["email"]


@app.post("/api/auth/forgot")
def forgot_password():
    if too_many(8, 300):
        return err("Too many requests. Try again in a few minutes.", 429)
    data = body()
    email = clean(data.get("email"), 190).lower()
    if not is_email(email):
        return err("Enter a valid email address.")

    message = "If an account exists for that email, a reset link is on its way."
    user = fetch_one("SELECT * FROM users WHERE email = ?", (email,))
    if not user or user.get("status", "active") != "active":
        # Same answer either way: no account enumeration.
        return jsonify(ok=True, message=message)

    info = auth.create_reset_token(user["id"], None, "email")
    link = f"{base_url()}/reset-password.html?token={info['token']}"
    hours = info["hours"]
    try:
        mailer.send(
            _reset_email(user),
            f"Reset your {app_name()} password",
            f"Hi {user['name'] or 'there'},\n\n"
            f"Use this link to set a new password (it works once and expires in {hours} hours):\n\n"
            f"{link}\n\n"
            f"If you didn't ask for this, you can ignore this email.\n\n"
            f"— {app_name()}",
            f"""<!DOCTYPE html><html><body style="margin:0;background:#07080d;padding:30px;
                font-family:Inter,Arial,sans-serif;color:#eef1f7">
              <div style="max-width:520px;margin:auto;background:#101322;border:1px solid #232a3d;
                          border-radius:18px;padding:28px">
                <h2 style="margin:0 0 8px;font-size:20px">Reset your password</h2>
                <p style="color:#9aa4b8;font-size:14px;line-height:1.6;margin:0 0 20px">
                  Hi {user['name'] or 'there'}, click the button below to choose a new password.
                  This link works once and expires in {hours} hours.
                </p>
                <a href="{link}" style="display:inline-block;background:linear-gradient(135deg,#6c5ce7,#00d4a0);
                   color:#07080d;font-weight:700;text-decoration:none;padding:12px 22px;border-radius:12px">
                  Choose a new password
                </a>
                <p style="color:#6f7a90;font-size:12px;margin:20px 0 0">
                  Didn't request this? You can ignore this email — nothing changes.
                </p>
              </div></body></html>""",
        )
    except Exception as exc:  # noqa: BLE001 - never leak SMTP errors
        print(f"[auth] reset email failed: {exc}")

    notify.emit(
        "password_reset",
        "Password reset requested",
        [f"Customer: {user['name'] or user['email']}", f"Expires in {hours} hours"],
        customer=user["email"],
        status="link sent",
        url=link,
    )
    return jsonify(ok=True, message=message)


@app.get("/api/auth/reset/<path:token>")
def reset_info(token):
    row = auth.find_reset_token(token)
    if not row:
        return jsonify(valid=False, state="invalid"), 404
    state = auth.token_state(row)
    return jsonify(
        valid=state == "active",
        state=state,
        email=row["email"],
        name=row["name"],
        expiresAt=row["expires_at"],
    )


@app.post("/api/auth/reset")
def reset_password():
    if too_many(10, 300):
        return err("Too many attempts. Try again in a few minutes.", 429)
    data = body()
    token = clean(data.get("token"), 200)
    password = str(data.get("password") or "")
    if len(password) < 8:
        return err("Password must be at least 8 characters.")
    if len(password) > 200:
        return err("That password is too long.")
    try:
        result = auth.consume_reset_token(token, password)
    except ValueError as exc:
        return err(str(exc), 400)
    notify.customer_notify(
        result["userId"],
        "security",
        "Password changed",
        "Your password was reset with a recovery link.",
    )
    return jsonify(ok=True, email=result["email"])


def unread_messages(user_id: int) -> int:
    row = fetch_one(
        "SELECT COUNT(*) AS n FROM messages WHERE user_id = ? AND sender = 'admin' AND read_at IS NULL",
        (user_id,),
    )
    return row["n"] if row else 0


@app.get("/api/auth/me")
def me():
    user = auth.current_user()
    if not user:
        return jsonify(user=None)
    count = fetch_one("SELECT COUNT(*) AS n FROM orders WHERE user_id = ?", (user["id"],))["n"]
    data = auth.public_user(user, count)
    data["unreadMessages"] = unread_messages(user["id"])
    data["contact"] = {"type": user.get("contact_type"), "handle": user.get("contact_handle")}
    data["wallet"] = wallet.summary(user["id"])
    data["notifications"] = notify.unread_notifications(user["id"])
    data["csrfToken"] = csrf_token()
    return jsonify(user=data)


@app.patch("/api/me")
@auth.login_required
def update_me():
    data = body()
    user = auth.current_user()
    name = clean(data.get("name"), 80) or user["name"]
    avatar = data.get("avatar")
    contact_type = user.get("contact_type")
    contact_handle = user.get("contact_handle")

    if avatar is not None:
        avatar = str(avatar)
        if avatar and len(avatar) > 600_000:
            return err("That image is too large — pick something under 400 KB.")
        if avatar and not (avatar.startswith("data:image/") or avatar.startswith("http")):
            return err("Unsupported image format.")

    if "contactType" in data:
        contact_type = clean(data.get("contactType"), 12).lower()
        if contact_type not in {"telegram", "discord"}:
            return err("Contact type must be Telegram or Discord.")
    if "contact" in data:
        contact_handle = clean(data.get("contact"), 64) or None
        if contact_handle and len(re.sub(r"^@", "", contact_handle)) < 2:
            return err("That username looks too short.")

    execute(
        "UPDATE users SET name = ?, avatar = ?, contact_type = ?, contact_handle = ? WHERE id = ?",
        (
            name,
            avatar if avatar is not None else user["avatar"],
            contact_type,
            contact_handle,
            user["id"],
        ),
    )
    g.pop("user", None)
    return jsonify(user=auth.public_user(auth.current_user()))


# -------------------------------------------------------------------- products
def site_payload() -> dict:
    """Public, secret-free branding + contact + wallet rules."""
    cfg = wallet.money_settings()
    return {
        "app": {
            "name": app_name(),
            "logo": (get_setting("app_logo") or "K").strip()[:2] or "K",
            "accent": (get_setting("theme_accent") or "#6c5ce7").strip()[:9],
            "currency": cfg["currency"],
            "symbol": cfg["symbol"],
            "maintenance": str(get_setting("maintenance_mode") or "0") == "1",
        },
        "contact": {
            "telegramUsername": (get_setting("telegram_contact_username") or "").strip()[:64],
            "telegramLink": (get_setting("telegram_contact_link") or "").strip()[:300],
            "discordLink": (get_setting("discord_contact_link") or "").strip()[:300],
            "support": (get_setting("support_contact") or "").strip()[:120],
        },
        "wallet": {
            "currency": cfg["currency"],
            "symbol": cfg["symbol"],
            "minWithdraw": round(cfg["minWithdrawCents"] / 100, 2),
            "minTopup": round(cfg["minTopupCents"] / 100, 2),
            "methods": wallet.withdrawal_methods(public=True),
        },
        "auth": {"resetHours": auth.reset_hours()},
    }


@app.get("/api/site")
def site():
    return jsonify(site_payload())


@app.get("/api/health")
def health():
    """Liveness probe for hosting platforms and uptime monitors."""
    try:
        row = fetch_one("SELECT 1 AS ok")
        healthy = bool(row and row["ok"] == 1)
    except Exception:  # noqa: BLE001 - report unhealthy instead of crashing
        healthy = False
    return jsonify(ok=healthy, app="kudsi-shop", time=int(time.time())), (200 if healthy else 503)


@app.get("/api/config")
def config():
    cfg = payments.config()
    methods = available_methods()
    money = wallet.money_settings()
    return jsonify(
        currency=money["currency"],
        currencySymbol=money["symbol"],
        payCurrency=cfg["currency"],
        payments={"binance": cfg["binance_enabled"], "sandbox": cfg["sandbox"]},
        store={
            "codesVisible": setting_bool("codes_visible"),
            "deliveryNote": get_setting("delivery_note") or "",
            "supportContact": get_setting("support_contact") or "",
            "methods": [method_json(m) for m in methods],
        },
    )


@app.get("/api/products")
def products():
    rows = fetch_all("SELECT * FROM products WHERE active = 1 ORDER BY sort_order, name")
    return jsonify(products=[product_json(r) for r in rows])


@app.get("/api/categories")
def categories():
    """Storefront filters: admin-defined order, only categories with live products."""
    rows = fetch_all(
        """SELECT c.name, c.sort_order,
                  (SELECT COUNT(*) FROM products p
                    WHERE p.category = c.name COLLATE NOCASE AND p.active = 1) AS product_count
           FROM categories c
           ORDER BY c.sort_order, c.name"""
    )
    return jsonify(
        categories=[
            {
                "name": r["name"],
                "sortOrder": r["sort_order"],
                "productCount": r["product_count"],
            }
            for r in rows
        ]
    )


@app.get("/api/products/<product_id>")
def product(product_id):
    row = fetch_one("SELECT * FROM products WHERE id = ? AND active = 1", (product_id,))
    if not row:
        return err("Product not found.", 404)
    return jsonify(product=product_json(row))


# ---------------------------------------------------------------------- orders
@app.post("/api/orders")
@auth.login_required
def create_order():
    user = auth.current_user()
    data = body()
    raw_items = data.get("items")
    if not isinstance(raw_items, list) or not raw_items:
        return err("Your cart is empty.")

    contact_type = clean(data.get("contactType"), 12).lower()
    contact_handle = clean(data.get("contact"), 64)
    if contact_type not in {"telegram", "discord"}:
        return err("Choose where we should send your codes (Telegram or Discord).")
    if len(re.sub(r"^@", "", contact_handle)) < 2:
        return err("Add your Telegram or Discord username so we can reach you.")

    # A product bought in two durations is two cart lines, e.g.
    # ("gamepass-3m", "14 days") and ("gamepass-3m", "1 month").
    wanted: dict[tuple[str, str], int] = {}
    for item in raw_items[:50]:
        if not isinstance(item, dict):
            continue
        pid = clean(item.get("id"), 64)
        variant = clean(item.get("variant"), 40)
        try:
            qty = int(item.get("qty", 1))
        except (TypeError, ValueError):
            continue
        if pid and 1 <= qty <= 20:
            key = (pid, variant)
            wanted[key] = min(wanted.get(key, 0) + qty, 20)
    if not wanted:
        return err("Your cart is empty.")

    pids = tuple({pid for pid, _ in wanted})
    placeholders = ",".join("?" * len(pids))
    rows = fetch_all(
        f"SELECT * FROM products WHERE active = 1 AND id IN ({placeholders})", pids
    )
    if not rows:
        return err("Those products are no longer available.")

    by_id = {r["id"]: r for r in rows}
    lines = []
    for (pid, variant), qty in wanted.items():
        row = by_id.get(pid)
        if not row:
            continue
        variants = product_variants(row)
        chosen = None
        if variants:
            chosen = next(
                (v for v in variants if v["label"].lower() == variant.lower()), None
            )
            if not chosen:
                return err(f"Choose a duration for {row['name']}.")
            unit_cents = chosen["priceCents"]
            variant = chosen["label"]
        else:
            # A stale cart may still carry a duration that no longer exists.
            variant = None
            unit_cents = row["price_cents"]
        lines.append((row, qty, variant, unit_cents))
    if not lines:
        return err("Those products are no longer available.")

    total = sum(unit_cents * qty for _, qty, _, unit_cents in lines)
    order_id = "NX" + secrets.token_hex(4).upper()

    with get_db() as con:
        con.execute(
            """INSERT INTO orders
               (id, user_id, email, total_cents, currency, contact_type, contact_handle)
               VALUES (?, ?, ?, ?, 'USD', ?, ?)""",
            (order_id, user["id"], user["email"], total, contact_type, contact_handle),
        )
        con.executemany(
            """INSERT INTO order_items
               (order_id, product_id, name, variant, emoji, image, qty, unit_price_cents)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
            [
                (order_id, r["id"], r["name"], variant, r["emoji"], r["image"], qty, unit_cents)
                for r, qty, variant, unit_cents in lines
            ],
        )
        con.execute(
            "UPDATE users SET contact_type = ?, contact_handle = ? WHERE id = ?",
            (contact_type, contact_handle, user["id"]),
        )

    order, items = load_order(order_id)
    return jsonify(order=order_json(order, items, include_codes=False)), 201


@app.get("/api/orders")
@auth.login_required
def my_orders():
    user = auth.current_user()
    rows = fetch_all(
        "SELECT * FROM orders WHERE user_id = ? ORDER BY created_at DESC LIMIT 50", (user["id"],)
    )
    show_codes = setting_bool("codes_visible")
    out = []
    for row in rows:
        _, items = load_order(row["id"])
        out.append(order_json(row, items, include_codes=show_codes))
    return jsonify(orders=out)


@app.get("/api/orders/<order_id>")
@auth.login_required
def get_order(order_id):
    order, items = load_order(order_id)
    if not order or not can_view(order):
        return err("Order not found.", 404)
    user = auth.current_user()
    show_codes = user["role"] == "admin" or setting_bool("codes_visible")
    return jsonify(order=order_json(order, items, include_codes=show_codes))


@app.get("/api/orders/<order_id>/qr.svg")
@auth.login_required
def order_qr(order_id):
    order, _ = load_order(order_id)
    if not order or not can_view(order):
        return err("Order not found.", 404)
    text = payqr.order_payload(order)
    if not text:
        return err("No payment details to encode yet.", 404)
    return Response(
        payqr.svg(text),
        mimetype="image/svg+xml",
        headers={"Cache-Control": "no-store"},
    )


@app.get("/api/orders/<order_id>/status")
@auth.login_required
def order_status(order_id):
    order, items = load_order(order_id)
    if not order or not can_view(order):
        return err("Order not found.", 404)
    if order_is_expired(order):
        execute("UPDATE orders SET status = 'expired' WHERE id = ? AND status = 'pending'", (order_id,))
        order["status"] = "expired"
    user = auth.current_user()
    show_codes = user["role"] == "admin" or setting_bool("codes_visible")
    return jsonify(
        status=order["status"],
        paidAt=order["paid_at"],
        order=order_json(order, items, include_codes=show_codes),
    )


@app.post("/api/orders/<order_id>/pay")
@auth.login_required
def pay(order_id):
    order, items = load_order(order_id)
    if not order or not can_view(order):
        return err("Order not found.", 404)
    if order["status"] == "paid":
        return err("This order is already paid.")
    if order["status"] != "pending" or order_is_expired(order):
        execute("UPDATE orders SET status = 'expired' WHERE id = ? AND status = 'pending'", (order_id,))
        return err("This order has expired. Please start a new one.")

    cfg = payments.config()
    method_id = clean(body().get("method") or body().get("provider"), 40)
    if not method_id:
        method_id = "binance" if cfg["binance_enabled"] else "sandbox"

    if method_id == "sandbox":
        if not cfg["sandbox"]:
            return err("Sandbox payments are disabled.")
        execute("UPDATE orders SET provider = 'sandbox' WHERE id = ?", (order_id,))
        return jsonify(provider="sandbox", sandbox=True, amount=f"{order['total_cents'] / 100:.2f}")

    method = fetch_one("SELECT * FROM payment_methods WHERE id = ?", (method_id,))
    if not method:
        return err("Unknown payment method.")
    if not method_available(method):
        return err(f"{method['label']} is not available right now.")

    if method["kind"] == "binance":
        try:
            result = payments.create_binance_order(order, items)
        except payments.PaymentError as exc:
            return err(str(exc), 502)
        execute(
            "UPDATE orders SET provider = 'binance', provider_ref = ?, checkout_url = ?, expires_at = ? "
            "WHERE id = ?",
            (result["prepay_id"], result["checkout_url"], result["expire_time"], order_id),
        )
        return jsonify(
            provider="binance",
            kind="binance",
            label=method["label"],
            currency=cfg["currency"],
            amount=payments.amount_for_cents(order["total_cents"]),
            checkoutUrl=result["checkout_url"],
            deeplink=result["deeplink"],
            expiresAt=result["expire_time"],
        )

    # direct crypto
    try:
        amount = crypto.amount_for(order["total_cents"], method["asset"], method["rate_usd"])
    except crypto.RateError as exc:
        return err(str(exc), 502)

    expires = int(time.time()) + 3600
    execute(
        """UPDATE orders SET provider = ?, pay_address = ?, pay_amount = ?, pay_asset = ?,
           checkout_url = NULL, expires_at = ? WHERE id = ?""",
        (method["id"], method["address"], amount, method["asset"], expires, order_id),
    )
    return jsonify(
        provider=method["id"],
        kind="crypto",
        label=method["label"],
        asset=method["asset"],
        network=method["network"],
        address=method["address"],
        amount=amount,
        instructions=method["instructions"],
        image=method["image"],
        autoVerify=bool(method["auto_verify"]),
        expiresAt=expires,
    )


@app.get("/api/orders/<order_id>/verify")
@auth.login_required
def verify_order(order_id):
    order, items = load_order(order_id)
    if not order or not can_view(order):
        return err("Order not found.", 404)

    user = auth.current_user()
    show_codes = user["role"] == "admin" or setting_bool("codes_visible")

    if order["status"] == "paid":
        return jsonify(status="paid", order=order_json(order, items, include_codes=show_codes))

    if order["provider"] == "binance" and payments.config()["binance_enabled"]:
        try:
            data = payments.query_binance_order(order["id"])
        except payments.PaymentError as exc:
            return jsonify(
                status=order["status"], warning=str(exc),
                order=order_json(order, items, include_codes=show_codes),
            )
        state = str(data.get("orderStatus", "")).upper()
        if state in {"PAID", "PAY_SUCCESS", "SUCCESS"}:
            complete_order(order_id)
        elif state in {"CANCELED", "CANCELLED", "ERROR"}:
            execute("UPDATE orders SET status = 'cancelled' WHERE id = ? AND status = 'pending'", (order_id,))
        order, items = load_order(order_id)
        return jsonify(status=order["status"], order=order_json(order, items, include_codes=show_codes))

    if order["provider"] and order["provider"] not in {"binance", "sandbox"}:
        result = check_crypto_order(order)
        order, items = load_order(order_id)
        payload = {
            "status": order["status"],
            "order": order_json(order, items, include_codes=show_codes),
        }
        if result.get("message"):
            payload["warning"] = result["message"]
        if result.get("error"):
            payload["warning"] = result["error"]
        return jsonify(payload)

    return jsonify(status=order["status"], order=order_json(order, items, include_codes=show_codes))


@app.post("/api/dev/pay/<order_id>")
@auth.login_required
def sandbox_pay(order_id):
    if not payments.config()["sandbox"]:
        return err("Not available.", 403)
    order, _ = load_order(order_id)
    if not order or not can_view(order):
        return err("Order not found.", 404)
    if order["provider"] != "sandbox":
        return err("This order is not a sandbox order.")
    complete_order(order_id)
    order, items = load_order(order_id)
    return jsonify(status="paid", order=order_json(order, items, include_codes=True))


# -------------------------------------------------------------------- webhooks
@app.post("/api/webhooks/binance")
def binance_webhook():
    raw = request.get_data()
    ok = payments.verify_webhook(
        request.headers.get("BinancePay-Timestamp", ""),
        request.headers.get("BinancePay-Nonce", ""),
        request.headers.get("BinancePay-Signature", ""),
        raw,
    )
    if not ok:
        return jsonify(returnCode="FAIL", returnMessage="invalid signature"), 401

    payload = request.get_json(silent=True) or {}
    paid, trade_no = payments.webhook_is_paid(payload)
    if paid and trade_no:
        if trade_no.startswith("TP"):
            # Wallet top-up paid through Binance Pay.
            row = fetch_one("SELECT * FROM topups WHERE id = ?", (trade_no,))
            if row and row["status"] == "pending":
                try:
                    topup = wallet.decide_topup(trade_no, True, 1, "Paid with Binance Pay")
                    notify.customer_notify(
                        topup["userId"], "topup", "Top-up approved",
                        f"{wallet.fmt(topup['amountCents'])} was added to your balance.", topup["id"],
                    )
                except wallet.WalletError as exc:
                    print(f"[topup] webhook: {exc}")
        else:
            complete_order(trade_no)
    return jsonify(returnCode="SUCCESS", returnMessage=None)


# ---------------------------------------------------------------------- wallet
def wallet_payload(user_id: int) -> dict:
    cfg = wallet.money_settings()
    summary = wallet.summary(user_id)
    txs, total = wallet.transactions(user_id, limit=8)
    return {
        "summary": summary,
        "settings": {
            "currency": cfg["currency"],
            "symbol": cfg["symbol"],
            "minWithdraw": round(cfg["minWithdrawCents"] / 100, 2),
            "minTopup": round(cfg["minTopupCents"] / 100, 2),
            "manualApproval": cfg["manualApproval"],
            "methods": wallet.withdrawal_methods(public=True),
            "topupMethods": [
                {"id": "manual", "label": "Manual transfer", "kind": "manual",
                 "instructions": "Send the amount to our Telegram/Discord and an admin approves it."}
            ] + [
                {"id": m["id"], "label": m["label"], "asset": m["asset"], "network": m["network"],
                 "kind": m["kind"], "instructions": m["instructions"], "image": m["image"],
                 "address": m["address"]}
                for m in available_methods()
            ],
        },
        "transactions": txs,
        "transactionCount": total,
        "topups": [wallet.topup_json(t) for t in _user_topups(user_id, 6)],
        "withdrawals": wallet.list_withdrawals(limit=6, user_id=user_id),
        "series": wallet.daily_series(user_id, 14),
        "notifications": notify.notifications_for(user_id, 20),
        "notificationsUnread": notify.unread_notifications(user_id),
    }


def _user_topups(user_id: int, limit: int = 50) -> list[dict]:
    rows = fetch_all(
        "SELECT * FROM topups WHERE user_id = ? ORDER BY created_at DESC, id DESC LIMIT ?",
        (user_id, max(1, min(limit, 200))),
    )
    return rows


@app.get("/api/wallet")
@auth.login_required
def my_wallet():
    return jsonify(wallet_payload(auth.current_user()["id"]))


@app.get("/api/wallet/transactions")
@auth.login_required
def my_transactions():
    user = auth.current_user()
    try:
        limit = int(request.args.get("limit", 50))
        offset = int(request.args.get("offset", 0))
    except (TypeError, ValueError):
        return err("Bad pagination.")
    kinds = request.args.get("kind")
    kind_filter = tuple(k for k in (kinds or "").split(",") if k in wallet.KIND_LABELS) or None
    rows, total = wallet.transactions(user["id"], limit, offset, kind_filter)
    return jsonify(transactions=rows, total=total)


@app.get("/api/wallet/topups")
@auth.login_required
def my_topups():
    user = auth.current_user()
    rows = _user_topups(user["id"], 100)
    return jsonify(topups=[wallet.topup_json(r) for r in rows])


@app.post("/api/wallet/topups")
@auth.login_required
def create_topup():
    user = auth.current_user()
    data = body()
    try:
        cents = wallet.to_cents(data.get("amount"), field="Top-up amount")
    except wallet.WalletError as exc:
        return err(str(exc))
    method_id = clean(data.get("method"), 40) or "manual"
    note = clean(data.get("note"), 300)

    method = None
    if method_id != "manual":
        method = fetch_one("SELECT * FROM payment_methods WHERE id = ?", (method_id,))
        if not method or not method_available(method):
            return err("That payment method isn't available right now.")

    try:
        topup = wallet.create_topup(user["id"], cents, method_id, note)
    except wallet.WalletError as exc:
        return err(str(exc))

    notify.emit(
        "topup_request",
        "New top-up request",
        [
            f"Customer: {user['name'] or user['email']} (ID {user['id']})",
            f"Amount: {wallet.fmt(cents)}",
            f"Method: {method['label'] if method else 'Manual transfer'}",
        ],
        amount=wallet.fmt(cents),
        customer=user["email"],
        status="pending",
        url=f"{base_url()}/admin.html#topups",
    )
    notify.customer_notify(
        user["id"],
        "topup",
        "Top-up request received",
        f"We received your {wallet.fmt(cents)} top-up request. It is pending review.",
        topup["id"],
    )

    payload: dict = {"topup": topup, "method": "manual"}
    if method and method["kind"] == "binance":
        try:
            result = payments.create_binance_order(
                {"id": topup["id"], "total_cents": cents}, []
            )
        except payments.PaymentError as exc:
            return err(str(exc), 502)
        execute(
            "UPDATE topups SET reference = ?, pay_address = ?, pay_amount = ? WHERE id = ?",
            (result.get("prepay_id"), result.get("checkout_url"), payments.amount_for_cents(cents), topup["id"]),
        )
        payload = {
            "topup": wallet.topup_json(fetch_one("SELECT * FROM topups WHERE id = ?", (topup["id"],))),
            "method": "binance",
            "checkoutUrl": result.get("checkout_url"),
            "amount": payments.amount_for_cents(cents),
        }
    elif method:
        try:
            amount = crypto.amount_for(cents, method["asset"], method["rate_usd"])
        except crypto.RateError as exc:
            return err(str(exc), 502)
        execute(
            "UPDATE topups SET pay_address = ?, pay_amount = ?, asset = ?, network = ?, reference = ? "
            "WHERE id = ?",
            (method["address"], amount, method["asset"], method["network"], method["id"], topup["id"]),
        )
        payload = {
            "topup": wallet.topup_json(fetch_one("SELECT * FROM topups WHERE id = ?", (topup["id"],))),
            "method": "crypto",
            "asset": method["asset"],
            "network": method["network"],
            "address": method["address"],
            "amount": amount,
            "instructions": method["instructions"],
            "image": method["image"],
            "autoVerify": bool(method["auto_verify"]),
        }

    return jsonify(payload), 201


@app.get("/api/wallet/topups/<topup_id>/qr.svg")
@auth.login_required
def topup_qr(topup_id):
    user = auth.current_user()
    row = fetch_one("SELECT * FROM topups WHERE id = ?", (topup_id,))
    if not row or (row["user_id"] != user["id"] and user["role"] != "admin"):
        return err("Top-up not found.", 404)
    text = payqr.topup_payload(row)
    if not text:
        return err("No payment details to encode yet.", 404)
    return Response(
        payqr.svg(text),
        mimetype="image/svg+xml",
        headers={"Cache-Control": "no-store"},
    )


@app.post("/api/wallet/topups/<topup_id>/cancel")
@auth.login_required
def cancel_topup(topup_id):
    user = auth.current_user()
    row = fetch_one("SELECT * FROM topups WHERE id = ? AND user_id = ?", (topup_id, user["id"]))
    if not row:
        return err("Top-up not found.", 404)
    if row["status"] != "pending":
        return err("This top-up is already handled.")
    execute(
        "UPDATE topups SET status = 'expired', decided_at = datetime('now') "
        "WHERE id = ? AND status = 'pending'",
        (topup_id,),
    )
    return jsonify(ok=True)


@app.get("/api/wallet/withdrawals")
@auth.login_required
def my_withdrawals():
    user = auth.current_user()
    return jsonify(withdrawals=wallet.list_withdrawals(limit=100, user_id=user["id"]))


@app.post("/api/wallet/withdrawals")
@auth.login_required
def create_withdrawal():
    user = auth.current_user()
    data = body()
    try:
        cents = wallet.to_cents(data.get("amount"), field="Withdrawal amount")
        withdrawal = wallet.request_withdrawal(
            user["id"], cents, clean(data.get("method"), 40), str(data.get("details") or "")
        )
    except wallet.WalletError as exc:
        return err(str(exc))

    notify.emit(
        "withdrawal_request",
        "New withdrawal request",
        [
            f"Customer: {user['name'] or user['email']} (ID {user['id']})",
            f"Amount: {wallet.fmt(cents)}",
            f"Method: {withdrawal['methodLabel']}",
            f"Details: {withdrawal['details'][:160]}",
            f"Remaining balance: {wallet.fmt(wallet.summary(user['id'])['balanceCents'])}",
        ],
        amount=wallet.fmt(cents),
        customer=user["email"],
        status="pending",
        color=0xFFB020,
        url=f"{base_url()}/admin.html#withdrawals",
    )
    notify.customer_notify(
        user["id"],
        "withdrawal",
        "Withdrawal requested",
        f"Your {wallet.fmt(cents)} withdrawal via {withdrawal['methodLabel']} is pending review.",
        withdrawal["id"],
    )
    return jsonify(withdrawal=withdrawal), 201


@app.get("/api/notifications")
@auth.login_required
def my_notifications():
    user = auth.current_user()
    return jsonify(
        notifications=notify.notifications_for(user["id"], 50),
        unread=notify.unread_notifications(user["id"]),
    )


@app.post("/api/notifications/read")
@auth.login_required
def read_notifications():
    user = auth.current_user()
    notification_id = body().get("id")
    try:
        notification_id = int(notification_id) if notification_id else None
    except (TypeError, ValueError):
        notification_id = None
    notify.mark_notifications_read(user["id"], notification_id)
    return jsonify(ok=True, unread=notify.unread_notifications(user["id"]))


# ------------------------------------------------------------------- messages
@app.get("/api/messages")
@auth.login_required
def my_messages():
    user = auth.current_user()
    rows = fetch_all(
        "SELECT id, sender, body, created_at, read_at FROM messages WHERE user_id = ? ORDER BY id",
        (user["id"],),
    )
    execute(
        "UPDATE messages SET read_at = datetime('now') WHERE user_id = ? AND sender = 'admin' AND read_at IS NULL",
        (user["id"],),
    )
    return jsonify(
        messages=[
            {"id": r["id"], "sender": r["sender"], "body": r["body"], "createdAt": r["created_at"]}
            for r in rows
        ]
    )


@app.post("/api/messages")
@auth.login_required
def send_message():
    if too_many(30, 60):
        return err("Slow down a moment.", 429)
    user = auth.current_user()
    text = clean(body().get("body"), 2000)
    if len(text) < 1:
        return err("Write a message first.")
    execute(
        "INSERT INTO messages (user_id, sender, body) VALUES (?, 'customer', ?)", (user["id"], text)
    )
    notify.emit(
        "new_message",
        "New support message",
        [f"From: {user['name'] or user['email']} (ID {user['id']})", text[:300]],
        customer=user["email"],
        status="unread",
        url=f"{base_url()}/admin.html#messages",
    )
    return jsonify(ok=True), 201


# ----------------------------------------------------------------------- admin
@app.get("/api/admin/stats")
@auth.admin_required
def admin_stats():
    customers = fetch_one("SELECT COUNT(*) AS n FROM users WHERE role = 'customer'")["n"]
    orders = fetch_one("SELECT COUNT(*) AS n FROM orders")["n"]
    pending = fetch_one("SELECT COUNT(*) AS n FROM orders WHERE status = 'pending'")["n"]
    revenue = fetch_one(
        "SELECT COALESCE(SUM(total_cents), 0) AS c FROM orders WHERE status = 'paid'"
    )["c"]
    unread = fetch_one(
        "SELECT COUNT(*) AS n FROM messages WHERE sender = 'customer' AND read_at IS NULL"
    )["n"]
    money = wallet.admin_overview()
    return jsonify(
        customers=customers,
        admins=admin_count(),
        orders=orders,
        pending=pending,
        revenue=round(revenue / 100, 2),
        unreadMessages=unread,
        wallet=money,
    )


@app.get("/api/admin/wallet")
@auth.admin_required
def admin_wallet():
    return jsonify(
        overview=wallet.admin_overview(),
        transactions=wallet.recent_transactions(15),
        withdrawals=wallet.list_withdrawals(status="pending", limit=8),
        topups=wallet.list_topups(status="pending", limit=8),
    )


@app.get("/api/admin/transactions")
@auth.admin_required
def admin_transactions():
    q = clean(request.args.get("q"), 120)
    where, params = ["1 = 1"], []
    if q:
        like = f"%{q}%"
        where.append("(u.email LIKE ? OR u.name LIKE ? OR t.reference LIKE ?)")
        params += [like, like, like]
    rows = fetch_all(
        f"""SELECT t.*, u.email, u.name FROM wallet_transactions t
            JOIN users u ON u.id = t.user_id
            WHERE {' AND '.join(where)}
            ORDER BY t.id DESC LIMIT 200""",
        tuple(params),
    )
    out = []
    for row in rows:
        item = wallet.tx_json(row)
        item["customer"] = row["name"] or row["email"]
        item["email"] = row["email"]
        item["userId"] = row["user_id"]
        out.append(item)
    return jsonify(transactions=out)


# ------------------------------------------------------------------ top-ups
@app.get("/api/admin/topups")
@auth.admin_required
def admin_topups():
    status = clean(request.args.get("status"), 20)
    q = clean(request.args.get("q"), 120)
    return jsonify(topups=wallet.list_topups(status, q, 200))


@app.post("/api/admin/topups/<topup_id>/decide")
@auth.admin_required
def admin_decide_topup(topup_id):
    data = body()
    approve = bool(data.get("approve"))
    note = clean(data.get("note"), 300) or None
    try:
        topup = wallet.decide_topup(topup_id, approve, auth.current_user()["id"], note)
    except wallet.WalletError as exc:
        return err(str(exc))

    amount = wallet.fmt(topup["amountCents"])
    status = "approved" if approve else "rejected"
    notify.customer_notify(
        topup["userId"],
        "topup",
        f"Top-up {status}",
        f"Your {amount} top-up was {status}." + (f" Note: {note}" if note else ""),
        topup["id"],
    )
    notify.emit(
        "topup_decision",
        f"Top-up {status}",
        [
            f"Customer: {topup['customer'] or topup['email']} (ID {topup['userId']})",
            f"Amount: {amount}",
            f"Reference: {topup['id']}",
        ],
        amount=amount,
        customer=topup["email"],
        status=status,
        color=0x00D4A0 if approve else 0xFF5C7A,
        url=f"{base_url()}/admin.html#topups",
    )
    return jsonify(topup=topup)


# -------------------------------------------------------------- withdrawals
@app.get("/api/admin/withdrawals")
@auth.admin_required
def admin_withdrawals():
    status = clean(request.args.get("status"), 20)
    q = clean(request.args.get("q"), 120)
    return jsonify(
        withdrawals=wallet.list_withdrawals(status, q, 200),
        counts={
            s: fetch_one("SELECT COUNT(*) AS n FROM withdrawals WHERE status = ?", (s,))["n"]
            for s in wallet.WITHDRAWAL_STATUSES
        },
    )


@app.patch("/api/admin/withdrawals/<withdrawal_id>")
@auth.admin_required
def admin_update_withdrawal(withdrawal_id):
    data = body()
    status = clean(data.get("status"), 20)
    note = clean(data.get("adminNote"), 300) or None
    try:
        withdrawal = wallet.set_withdrawal_status(
            withdrawal_id, status, auth.current_user()["id"], note
        )
    except wallet.WalletError as exc:
        return err(str(exc))

    amount = wallet.fmt(withdrawal["amountCents"])
    label = withdrawal["status"]
    notify.customer_notify(
        withdrawal["userId"],
        "withdrawal",
        f"Withdrawal {label}",
        f"Your {amount} withdrawal via {withdrawal['methodLabel']} is now {label}."
        + (f" Note: {note}" if note else ""),
        withdrawal["id"],
    )
    notify.emit(
        "withdrawal_decision",
        f"Withdrawal {label}",
        [
            f"Customer: {withdrawal['customer'] or withdrawal['email']} (ID {withdrawal['userId']})",
            f"Amount: {amount}",
            f"Method: {withdrawal['methodLabel']}",
            f"Reference: {withdrawal['id']}",
        ],
        amount=amount,
        customer=withdrawal["email"],
        status=label,
        color=0x00D4A0 if withdrawal["status"] == "completed" else (
            0xFF5C7A if withdrawal["status"] == "rejected" else 0x6C5CE7
        ),
        url=f"{base_url()}/admin.html#withdrawals",
    )
    return jsonify(withdrawal=withdrawal)


@app.get("/api/admin/customers")
@auth.admin_required
def admin_customers():
    q = clean(request.args.get("q"), 190)
    role = clean(request.args.get("role"), 20)
    product_id = clean(request.args.get("product"), 64)

    where = ["1 = 1"]
    params: list = []
    if q:
        where.append(
            "(u.email LIKE ? OR u.name LIKE ? OR u.contact_handle LIKE ? "
            "OR CAST(u.id AS TEXT) = ?)"
        )
        params += [f"%{q}%", f"%{q}%", f"%{q}%", q]
    if role in {"customer", "admin"}:
        where.append("u.role = ?")
        params.append(role)
    if product_id:
        where.append(
            "EXISTS (SELECT 1 FROM orders o2 JOIN order_items i2 ON i2.order_id = o2.id "
            "WHERE o2.user_id = u.id AND i2.product_id = ?)"
        )
        params.append(product_id)

    sql = f"""
        SELECT u.id, u.email, u.name, u.role, u.avatar, u.contact_type, u.contact_handle,
               u.created_at, u.last_login, u.status,
               u.balance_cents, u.deposited_cents, u.withdrawn_cents,
               COUNT(DISTINCT o.id) AS order_count,
               COALESCE(SUM(CASE WHEN o.status = 'paid' THEN o.total_cents END), 0) AS spent_cents,
               MAX(o.created_at) AS last_order_at,
               (SELECT COUNT(*) FROM wallet_transactions t WHERE t.user_id = u.id) AS tx_count,
               (SELECT COUNT(*) FROM messages m WHERE m.user_id = u.id AND m.sender = 'customer'
                  AND m.read_at IS NULL) AS unread
        FROM users u
        LEFT JOIN orders o ON o.user_id = u.id
        WHERE {' AND '.join(where)}
        GROUP BY u.id
        ORDER BY u.created_at DESC
        LIMIT 500
    """
    rows = fetch_all(sql, tuple(params))

    if rows:
        ids = [r["id"] for r in rows]
        placeholders = ",".join("?" * len(ids))
        items = fetch_all(
            f"""SELECT o.user_id, i.product_id, i.name, i.emoji, i.image, SUM(i.qty) AS qty
                FROM orders o JOIN order_items i ON i.order_id = o.id
                WHERE o.status = 'paid' AND o.user_id IN ({placeholders})
                GROUP BY o.user_id, i.product_id
                ORDER BY MAX(o.created_at) DESC""",
            tuple(ids),
        )
        by_user: dict[int, list] = {uid: [] for uid in ids}
        for it in items:
            by_user[it["user_id"]].append(
                {
                    "id": it["product_id"],
                    "name": it["name"],
                    "emoji": it["emoji"],
                    "image": it["image"],
                    "qty": it["qty"],
                }
            )
        for r in rows:
            r["products"] = by_user.get(r["id"], [])

    for r in rows:
        r["spent"] = round(r["spent_cents"] / 100, 2)
        r["balance"] = round(r["balance_cents"] / 100, 2)
        r["deposited"] = round(r["deposited_cents"] / 100, 2)
        r["withdrawn"] = round(r["withdrawn_cents"] / 100, 2)
        del r["spent_cents"], r["balance_cents"], r["deposited_cents"], r["withdrawn_cents"]

    return jsonify(customers=rows)


def _customer_row(user_id: int) -> dict | None:
    return fetch_one(
        """SELECT id, email, name, role, avatar, contact_type, contact_handle, created_at,
                  last_login, status, suspended_reason, balance_cents, deposited_cents,
                  withdrawn_cents
           FROM users WHERE id = ?""",
        (user_id,),
    )


def _customer_json(row: dict) -> dict:
    data = dict(row)
    data["balance"] = round(row["balance_cents"] / 100, 2)
    data["deposited"] = round(row["deposited_cents"] / 100, 2)
    data["withdrawn"] = round(row["withdrawn_cents"] / 100, 2)
    del data["balance_cents"], data["deposited_cents"], data["withdrawn_cents"]
    data["wallet"] = wallet.summary(row["id"])
    data["orders"] = fetch_one(
        "SELECT COUNT(*) AS n FROM orders WHERE user_id = ?", (row["id"],)
    )["n"]
    return data


@app.get("/api/admin/customers/<int:user_id>")
@auth.admin_required
def admin_customer(user_id: int):
    row = _customer_row(user_id)
    if not row:
        return err("Customer not found.", 404)
    data = _customer_json(row)
    data["recentTransactions"] = wallet.transactions(user_id, limit=6)[0]
    data["recentTopups"] = [
        wallet.topup_json(t) for t in _user_topups(user_id, 6)
    ]
    data["recentWithdrawals"] = wallet.list_withdrawals(limit=6, user_id=user_id)
    data["resetLinks"] = _reset_links(user_id)
    data["stats"] = {
        "orders": data["orders"],
        "transactions": data["wallet"]["transactions"],
        "pendingWithdrawals": data["wallet"]["pendingWithdrawals"],
        "pendingTopups": data["wallet"]["pendingTopups"],
    }
    return jsonify(customer=data)


@app.get("/api/admin/customers/<int:user_id>/wallet")
@auth.admin_required
def admin_customer_wallet(user_id: int):
    if not _customer_row(user_id):
        return err("Customer not found.", 404)
    return jsonify(wallet_payload(user_id))


@app.get("/api/admin/customers/<int:user_id>/transactions")
@auth.admin_required
def admin_customer_transactions(user_id: int):
    if not _customer_row(user_id):
        return err("Customer not found.", 404)
    try:
        limit = int(request.args.get("limit", 50))
        offset = int(request.args.get("offset", 0))
    except (TypeError, ValueError):
        return err("Bad pagination.")
    kinds = request.args.get("kind")
    kind_filter = tuple(k for k in (kinds or "").split(",") if k in wallet.KIND_LABELS) or None
    rows, total = wallet.transactions(user_id, limit, offset, kind_filter)
    return jsonify(transactions=rows, total=total)


@app.post("/api/admin/customers/<int:user_id>/password")
@auth.admin_required
def admin_set_password(user_id: int):
    row = _customer_row(user_id)
    if not row:
        return err("Customer not found.", 404)
    password = str(body().get("password") or "")
    if len(password) < 8:
        return err("Password must be at least 8 characters.")
    if len(password) > 200:
        return err("That password is too long.")
    execute(
        "UPDATE users SET password_hash = ? WHERE id = ?",
        (auth.hash_password(password), user_id),
    )
    # A manual password change kills every outstanding reset link.
    execute(
        "UPDATE password_resets SET revoked_at = datetime('now') "
        "WHERE user_id = ? AND used_at IS NULL AND revoked_at IS NULL",
        (user_id,),
    )
    notify.customer_notify(
        user_id, "security", "Password updated", "An administrator set a new password for your account."
    )
    return jsonify(ok=True)


def _reset_links(user_id: int) -> list[dict]:
    rows = fetch_all(
        "SELECT id, created_at, expires_at, used_at, revoked_at, channel, sent_at "
        "FROM password_resets WHERE user_id = ? ORDER BY id DESC LIMIT 12",
        (user_id,),
    )
    out = []
    for row in rows:
        out.append(
            {
                "id": row["id"],
                "state": auth.token_state(row),
                "createdAt": row["created_at"],
                "expiresAt": row["expires_at"],
                "usedAt": row["used_at"],
                "revokedAt": row["revoked_at"],
                "channel": row["channel"],
                "sentAt": row["sent_at"],
            }
        )
    return out


@app.get("/api/admin/customers/<int:user_id>/reset-links")
@auth.admin_required
def admin_reset_links(user_id: int):
    if not _customer_row(user_id):
        return err("Customer not found.", 404)
    return jsonify(links=_reset_links(user_id))


@app.post("/api/admin/customers/<int:user_id>/reset-link")
@auth.admin_required
def admin_create_reset_link(user_id: int):
    row = _customer_row(user_id)
    if not row:
        return err("Customer not found.", 404)
    if row["status"] != "active":
        return err("Reactivate the account before sending a reset link.")

    data = body()
    channel = clean(data.get("channel"), 12).lower()
    info = auth.create_reset_token(user_id, auth.current_user()["id"], channel or None)
    link = f"{base_url()}/reset-password.html?token={info['token']}"
    result = {"ok": True, "detail": "Link generated. Copy it or send it."}

    if channel in {"telegram", "discord"}:
        sent = notify.send_reset_link(row, link, channel)
        result = {"ok": bool(sent.get("ok")), "error": sent.get("error"), "detail": sent.get("detail")}
        execute(
            "UPDATE password_resets SET sent_at = datetime('now') WHERE id = ?",
            (info["id"],),
        )
        notify.emit(
            "password_reset",
            "Reset link sent",
            [
                f"Customer: {row['name'] or row['email']} (ID {row['id']})",
                f"Channel: {channel}",
            ],
            customer=row["email"],
            status="sent" if result["ok"] else "failed",
            url=link,
        )

    return jsonify(
        link=link,
        token=info["token"],
        expiresAt=info["expiresAt"],
        hours=info["hours"],
        sent=result,
        links=_reset_links(user_id),
    )


@app.patch("/api/admin/customers/<int:user_id>/status")
@auth.admin_required
def admin_set_status(user_id: int):
    row = _customer_row(user_id)
    if not row:
        return err("Customer not found.", 404)
    data = body()
    status = clean(data.get("status"), 16).lower()
    if status not in {"active", "suspended"}:
        return err("Status must be active or suspended.")
    me = auth.current_user()
    if row["id"] == me["id"] and status == "suspended":
        return err("You cannot suspend your own account.")
    reason = clean(data.get("reason"), 200) or None
    execute(
        "UPDATE users SET status = ?, suspended_reason = ? WHERE id = ?",
        (status, reason if status == "suspended" else None, user_id),
    )
    notify.customer_notify(
        user_id,
        "account",
        "Account suspended" if status == "suspended" else "Account reactivated",
        reason or ("Your account was suspended. Contact support." if status == "suspended"
                  else "Your account is active again."),
    )
    return jsonify(ok=True, status=status)


@app.patch("/api/admin/customers/<int:user_id>")
@auth.admin_required
def admin_set_role(user_id: int):
    role = clean(body().get("role"), 20)
    if role not in {"customer", "admin"}:
        return err("Role must be 'customer' or 'admin'.")

    target = fetch_one("SELECT id, role FROM users WHERE id = ?", (user_id,))
    if not target:
        return err("Customer not found.", 404)

    me = auth.current_user()
    if target["id"] == me["id"] and role != "admin":
        return err("You cannot remove your own admin access.")
    if target["role"] == "admin" and role == "customer" and admin_count() <= 1:
        return err("There must be at least one admin.")

    execute("UPDATE users SET role = ? WHERE id = ?", (role, user_id))
    return jsonify(ok=True, role=role)


@app.get("/api/admin/orders")
@auth.admin_required
def admin_orders():
    q = clean(request.args.get("q"), 190)
    status = clean(request.args.get("status"), 20)

    where, params = ["1 = 1"], []
    if q:
        where.append("(o.id LIKE ? OR o.email LIKE ? OR o.contact_handle LIKE ?)")
        params += [f"%{q}%", f"%{q}%", f"%{q}%"]
    if status in {"pending", "paid", "expired", "cancelled"}:
        where.append("o.status = ?")
        params.append(status)

    rows = fetch_all(
        f"SELECT o.* FROM orders o WHERE {' AND '.join(where)} "
        "ORDER BY o.created_at DESC LIMIT 300",
        tuple(params),
    )
    out = []
    for row in rows:
        _, items = load_order(row["id"])
        out.append(order_json(row, items, include_codes=True))
    return jsonify(orders=out)


@app.patch("/api/admin/orders/<order_id>")
@auth.admin_required
def admin_update_order(order_id):
    order, items = load_order(order_id)
    if not order:
        return err("Order not found.", 404)
    data = body()

    if data.get("markPaid"):
        complete_order(order_id)
    if data.get("delivered"):
        execute("UPDATE orders SET delivered_at = datetime('now') WHERE id = ?", (order_id,))
    if data.get("status") in {"pending", "paid", "expired", "cancelled"}:
        if data["status"] == "paid":
            complete_order(order_id)
        else:
            execute("UPDATE orders SET status = ? WHERE id = ?", (data["status"], order_id))

    order, items = load_order(order_id)
    return jsonify(order=order_json(order, items, include_codes=True))


@app.post("/api/admin/orders/<order_id>/verify")
@auth.admin_required
def admin_verify_order(order_id):
    order, items = load_order(order_id)
    if not order:
        return err("Order not found.", 404)
    if order["status"] == "paid":
        return jsonify(status="paid", order=order_json(order, items, include_codes=True))

    result: dict = {}
    if order["provider"] == "binance" and payments.config()["binance_enabled"]:
        try:
            data = payments.query_binance_order(order["id"])
            state = str(data.get("orderStatus", "")).upper()
            if state in {"PAID", "PAY_SUCCESS", "SUCCESS"}:
                complete_order(order_id)
            result = {"status": state}
        except payments.PaymentError as exc:
            return err(str(exc), 502)
    elif order["provider"] and order["provider"] not in {"binance", "sandbox"}:
        result = check_crypto_order(order)

    order, items = load_order(order_id)
    return jsonify(
        status=order["status"],
        checked=result,
        order=order_json(order, items, include_codes=True),
    )


# ---------------------------------------------------------- admin: categories
def category_payload(name: str) -> dict:
    row = fetch_one(
        """SELECT c.name, c.sort_order,
                  (SELECT COUNT(*) FROM products p
                    WHERE p.category = c.name COLLATE NOCASE) AS product_count
           FROM categories c WHERE c.name = ? COLLATE NOCASE""",
        (name,),
    )
    return {
        "name": row["name"],
        "sortOrder": row["sort_order"],
        "productCount": row["product_count"],
    }


@app.get("/api/admin/categories")
@auth.admin_required
def admin_categories():
    rows = fetch_all(
        """SELECT c.name, c.sort_order,
                  (SELECT COUNT(*) FROM products p
                    WHERE p.category = c.name COLLATE NOCASE) AS product_count
           FROM categories c
           ORDER BY c.sort_order, c.name"""
    )
    return jsonify(
        categories=[
            {
                "name": r["name"],
                "sortOrder": r["sort_order"],
                "productCount": r["product_count"],
            }
            for r in rows
        ]
    )


@app.post("/api/admin/categories")
@auth.admin_required
def admin_create_category():
    data = body()
    name = clean(data.get("name"), 40)
    if not name:
        return err("Give the category a name.")
    if fetch_one("SELECT name FROM categories WHERE name = ? COLLATE NOCASE", (name,)):
        return err("That category already exists.")

    try:
        sort_order = int(data.get("sortOrder", 0) or 0)
    except (TypeError, ValueError):
        return err("Sort order must be a number.")
    if not sort_order:
        last = fetch_one("SELECT COALESCE(MAX(sort_order), 0) AS m FROM categories")
        sort_order = int(last["m"]) + 10

    execute(
        "INSERT INTO categories (name, sort_order) VALUES (?, ?)",
        (name, sort_order),
    )
    return jsonify(category=category_payload(name)), 201


@app.patch("/api/admin/categories/<path:name>")
@auth.admin_required
def admin_update_category(name):
    row = fetch_one("SELECT * FROM categories WHERE name = ? COLLATE NOCASE", (name,))
    if not row:
        return err("Category not found.", 404)

    data = body()
    new_name = clean(data.get("name"), 40) or row["name"]
    if new_name.lower() != row["name"].lower():
        if fetch_one("SELECT name FROM categories WHERE name = ? COLLATE NOCASE", (new_name,)):
            return err("That category already exists.")

    if "sortOrder" in data:
        try:
            sort_order = int(data.get("sortOrder") or 0)
        except (TypeError, ValueError):
            return err("Sort order must be a number.")
    else:
        sort_order = row["sort_order"]

    with get_db() as con:
        con.execute(
            "UPDATE categories SET name = ?, sort_order = ? WHERE name = ? COLLATE NOCASE",
            (new_name, sort_order, row["name"]),
        )
        if new_name != row["name"]:
            # Keep every product attached when a category is renamed.
            con.execute(
                "UPDATE products SET category = ? WHERE category = ? COLLATE NOCASE",
                (new_name, row["name"]),
            )

    return jsonify(category=category_payload(new_name))


@app.delete("/api/admin/categories/<path:name>")
@auth.admin_required
def admin_delete_category(name):
    row = fetch_one("SELECT * FROM categories WHERE name = ? COLLATE NOCASE", (name,))
    if not row:
        return err("Category not found.", 404)

    used = fetch_one(
        "SELECT COUNT(*) AS n FROM products WHERE category = ? COLLATE NOCASE",
        (row["name"],),
    )
    if used["n"]:
        count = used["n"]
        return err(
            f"{count} product{'s' if count != 1 else ''} still "
            f"{'uses' if count == 1 else 'use'} “{row['name']}”. "
            "Move them to another category first."
        )

    execute("DELETE FROM categories WHERE name = ? COLLATE NOCASE", (row["name"],))
    return jsonify(ok=True)


# ------------------------------------------------------------ admin: products
@app.get("/api/admin/products")
@auth.admin_required
def admin_products():
    rows = fetch_all("SELECT * FROM products ORDER BY sort_order, name")
    return jsonify(products=[product_json(r) for r in rows])


@app.post("/api/admin/products")
@auth.admin_required
def admin_create_product():
    data = body()
    pid = clean(data.get("id"), 64) or clean(data.get("name"), 40).lower().replace(" ", "-")
    pid = re.sub(r"[^a-z0-9-]", "", pid.lower())
    if not pid:
        return err("Give the product an id or a name.")

    variants, variant_error = variants_payload(data.get("variants"))
    if variant_error:
        return err(variant_error)

    category = clean(data.get("category"), 40) or "Game Cards"
    category_row = fetch_one(
        "SELECT name FROM categories WHERE name = ? COLLATE NOCASE", (category,)
    )
    if not category_row:
        return err("That category doesn't exist yet — create it in the Categories tab first.")

    try:
        price_cents = int(round(float(data.get("price", 0)) * 100))
        old_price_cents = int(round(float(data["oldPrice"]) * 100)) if data.get("oldPrice") else None
    except (TypeError, ValueError):
        return err("Price must be a number.")

    if variants:
        # The card shows the cheapest duration, but every option is priced individually.
        price_cents = min(v["priceCents"] for v in variants)
        old_price_cents = next(
            (v["oldPriceCents"] for v in variants if v["priceCents"] == price_cents), None
        )
    if price_cents <= 0:
        return err("Price must be greater than zero.")

    execute(
        """INSERT INTO products
           (id, name, category, price_cents, old_price_cents, emoji, image, art, region,
            badge, description, variants, active, sort_order)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
        (
            pid,
            clean(data.get("name"), 120) or pid,
            category_row["name"],
            price_cents,
            old_price_cents,
            clean(data.get("emoji"), 8) or "🎁",
            clean(data.get("image"), 600_000) or None,
            clean(data.get("art"), 200) or None,
            clean(data.get("region"), 20) or "Global",
            clean(data.get("badge"), 30) or None,
            clean(data.get("desc"), 400),
            json.dumps(variants) if variants else None,
            1 if data.get("active", True) else 0,
            int(data.get("sortOrder", 100) or 100),
        ),
    )
    row = fetch_one("SELECT * FROM products WHERE id = ?", (pid,))
    return jsonify(product=product_json(row)), 201


@app.patch("/api/admin/products/<product_id>")
@auth.admin_required
def admin_update_product(product_id):
    row = fetch_one("SELECT * FROM products WHERE id = ?", (product_id,))
    if not row:
        return err("Product not found.", 404)
    data = body()

    updates: dict[str, object] = {}
    simple = {
        "name": ("name", 120),
        "emoji": ("emoji", 8),
        "region": ("region", 20),
        "badge": ("badge", 30),
        "desc": ("description", 400),
        "art": ("art", 200),
    }
    for key, (column, limit) in simple.items():
        if key in data:
            updates[column] = clean(data[key], limit) or None

    if "category" in data:
        category = clean(data["category"], 40)
        if not category:
            return err("Choose a category for the product.")
        category_row = fetch_one(
            "SELECT name FROM categories WHERE name = ? COLLATE NOCASE", (category,)
        )
        if not category_row:
            return err("That category doesn't exist yet — create it in the Categories tab first.")
        updates["category"] = category_row["name"]

    if "image" in data:
        image = str(data["image"] or "")
        if len(image) > 600_000:
            return err("Image too large — use an image under 400 KB.")
        updates["image"] = image or None

    variants_locked = False
    if "variants" in data:
        variants, variant_error = variants_payload(data.get("variants"))
        if variant_error:
            return err(variant_error)
        updates["variants"] = json.dumps(variants) if variants else None
        if variants:
            variants_locked = True
            updates["price_cents"] = min(v["priceCents"] for v in variants)
            updates["old_price_cents"] = next(
                (v["oldPriceCents"] for v in variants if v["priceCents"] == updates["price_cents"]),
                None,
            )

    if "price" in data and not variants_locked:
        try:
            updates["price_cents"] = int(round(float(data["price"]) * 100))
        except (TypeError, ValueError):
            return err("Price must be a number.")
        if updates["price_cents"] <= 0:
            return err("Price must be greater than zero.")
    if "oldPrice" in data and not variants_locked:
        try:
            updates["old_price_cents"] = (
                int(round(float(data["oldPrice"]) * 100)) if data["oldPrice"] else None
            )
        except (TypeError, ValueError):
            return err("Old price must be a number.")
    if "active" in data:
        updates["active"] = 1 if data["active"] else 0
    if "sortOrder" in data:
        try:
            updates["sort_order"] = int(data["sortOrder"])
        except (TypeError, ValueError):
            pass

    if updates:
        sets = ", ".join(f"{k} = ?" for k in updates)
        execute(f"UPDATE products SET {sets} WHERE id = ?", (*updates.values(), product_id))

    return jsonify(product=product_json(fetch_one("SELECT * FROM products WHERE id = ?", (product_id,))))


@app.delete("/api/admin/products/<product_id>")
@auth.admin_required
def admin_delete_product(product_id):
    execute("UPDATE products SET active = 0 WHERE id = ?", (product_id,))
    return jsonify(ok=True)


# ---------------------------------------------------- admin: payment methods
@app.get("/api/admin/payment-methods")
@auth.admin_required
def admin_payment_methods():
    rows = fetch_all("SELECT * FROM payment_methods ORDER BY sort_order, label")
    cfg = payments.config()
    return jsonify(
        methods=[method_json(m, private=True) for m in rows],
        binance={
            "enabled": cfg["binance_enabled"],
            "hasKey": bool(os.environ.get("BINANCE_PAY_API_KEY")),
            "hasSecret": bool(os.environ.get("BINANCE_PAY_SECRET")),
            "keyHint": (os.environ.get("BINANCE_PAY_API_KEY") or "")[-6:],
            "currency": cfg["currency"],
            "sandbox": cfg["sandbox"],
        },
        settings={
            "codesVisible": setting_bool("codes_visible"),
            "deliveryNote": get_setting("delivery_note") or "",
            "supportContact": get_setting("support_contact") or "",
        },
    )


def _method_payload(data: dict) -> dict:
    auto = data.get("autoVerify", data.get("auto_verify", True))
    sort_order = data.get("sortOrder", data.get("sort_order", 100))
    return {
        "label": clean(data.get("label"), 60),
        "asset": clean(data.get("asset"), 12).upper() or "USDT",
        "network": clean(data.get("network"), 40),
        "kind": "binance" if clean(data.get("kind"), 12) == "binance" else "crypto",
        "address": clean(data.get("address"), 200) or None,
        "instructions": clean(data.get("instructions"), 400) or None,
        "image": None,
        "rate_usd": None,
        "auto_verify": 1 if auto else 0,
        "enabled": 1 if data.get("enabled", True) else 0,
        "sort_order": int(sort_order or 100),
    }


@app.post("/api/admin/payment-methods")
@auth.admin_required
def admin_create_method():
    data = body()
    payload = _method_payload(data)
    if not payload["label"]:
        return err("Give the method a name.")

    mid = clean(data.get("id"), 40) or re.sub(r"[^a-z0-9-]", "", payload["label"].lower())[:40]
    if not mid:
        return err("Give the method an id.")
    if fetch_one("SELECT id FROM payment_methods WHERE id = ?", (mid,)):
        return err("A method with that id already exists.")

    image = str(data.get("image") or "")
    if len(image) > 600_000:
        return err("Image too large — use an image under 400 KB.")
    payload["image"] = image or None

    try:
        payload["rate_usd"] = float(data["rateUsd"]) if data.get("rateUsd") else None
    except (TypeError, ValueError):
        return err("Rate must be a number.")

    execute(
        """INSERT INTO payment_methods
           (id, label, asset, network, kind, address, instructions, image, rate_usd,
            auto_verify, enabled, sort_order)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
        (
            mid, payload["label"], payload["asset"], payload["network"], payload["kind"],
            payload["address"], payload["instructions"], payload["image"], payload["rate_usd"],
            payload["auto_verify"], payload["enabled"], payload["sort_order"],
        ),
    )
    row = fetch_one("SELECT * FROM payment_methods WHERE id = ?", (mid,))
    return jsonify(method=method_json(row, private=True)), 201


@app.patch("/api/admin/payment-methods/<method_id>")
@auth.admin_required
def admin_update_method(method_id):
    row = fetch_one("SELECT * FROM payment_methods WHERE id = ?", (method_id,))
    if not row:
        return err("Payment method not found.", 404)
    data = body()
    payload = _method_payload({**row, **data})

    updates = {
        "label": payload["label"] or row["label"],
        "asset": payload["asset"],
        "network": payload["network"],
        "auto_verify": payload["auto_verify"],
        "enabled": payload["enabled"],
        "sort_order": payload["sort_order"],
    }

    if "address" in data:
        updates["address"] = clean(data["address"], 200) or None
    if "instructions" in data:
        updates["instructions"] = clean(data["instructions"], 400) or None
    if "image" in data:
        image = str(data["image"] or "")
        if len(image) > 600_000:
            return err("Image too large — use an image under 400 KB.")
        updates["image"] = image or None
    if "rateUsd" in data:
        try:
            updates["rate_usd"] = float(data["rateUsd"]) if data["rateUsd"] else None
        except (TypeError, ValueError):
            return err("Rate must be a number.")

    sets = ", ".join(f"{k} = ?" for k in updates)
    execute(f"UPDATE payment_methods SET {sets} WHERE id = ?", (*updates.values(), method_id))
    return jsonify(method=method_json(fetch_one("SELECT * FROM payment_methods WHERE id = ?", (method_id,)), private=True))


@app.delete("/api/admin/payment-methods/<method_id>")
@auth.admin_required
def admin_delete_method(method_id):
    execute("UPDATE payment_methods SET enabled = 0 WHERE id = ?", (method_id,))
    return jsonify(ok=True)


@app.post("/api/admin/payment-settings")
@auth.admin_required
def admin_payment_settings():
    data = body()

    if data.get("clearBinance"):
        for key in ("BINANCE_PAY_API_KEY", "BINANCE_PAY_SECRET", "BINANCE_PAY_CERT_SN"):
            os.environ.pop(key, None)
        set_setting("binance_api_key", "")
        set_setting("binance_secret", "")
        set_setting("binance_cert_sn", "")
    else:
        pairs = (
            ("binanceKey", "BINANCE_PAY_API_KEY", "binance_api_key"),
            ("binanceSecret", "BINANCE_PAY_SECRET", "binance_secret"),
            ("binanceCertSn", "BINANCE_PAY_CERT_SN", "binance_cert_sn"),
        )
        for field, env_key, setting in pairs:
            value = data.get(field)
            if isinstance(value, str) and value.strip():
                os.environ[env_key] = value.strip()
                set_setting(setting, value.strip())

    if "codesVisible" in data:
        set_setting("codes_visible", "1" if data["codesVisible"] else "0")
    if "deliveryNote" in data:
        set_setting("delivery_note", clean(data["deliveryNote"], 600))
    if "supportContact" in data:
        set_setting("support_contact", clean(data["supportContact"], 120))

    cfg = payments.config()
    return jsonify(
        ok=True,
        binance={"enabled": cfg["binance_enabled"], "sandbox": cfg["sandbox"]},
        settings={
            "codesVisible": setting_bool("codes_visible"),
            "deliveryNote": get_setting("delivery_note") or "",
            "supportContact": get_setting("support_contact") or "",
        },
    )


@app.get("/api/admin/outbox")
@auth.admin_required
def admin_outbox():
    rows = fetch_all(
        "SELECT id, to_email, subject, body, status, error, created_at FROM outbox "
        "ORDER BY id DESC LIMIT 60"
    )
    return jsonify(emails=rows, smtpConfigured=mailer.configured())


# ------------------------------------------------------------ admin: settings
def _hex_colour(value: str, fallback: str = "#6c5ce7") -> str:
    value = (value or "").strip()
    return value if re.fullmatch(r"#[0-9a-fA-F]{6}", value) else fallback


@app.get("/api/admin/settings")
@auth.admin_required
def admin_get_settings():
    cfg = wallet.money_settings()
    status = notify.configured()
    return jsonify(
        financial={
            "currency": cfg["currency"],
            "symbol": cfg["symbol"],
            "minWithdraw": round(cfg["minWithdrawCents"] / 100, 2),
            "minTopup": round(cfg["minTopupCents"] / 100, 2),
            "manualTopupApproval": cfg["manualApproval"],
        },
        contact={
            "telegramUsername": get_setting("telegram_contact_username") or "",
            "telegramLink": get_setting("telegram_contact_link") or "",
            "discordLink": get_setting("discord_contact_link") or "",
            "supportContact": get_setting("support_contact") or "",
        },
        notifications={
            **status,
            "events": {event: str(get_setting(f"notify_{event}") or "1") == "1"
                       for event in notify.EVENTS},
            "eventLabels": notify.EVENTS,
        },
        general={
            "appName": app_name(),
            "logo": get_setting("app_logo") or "K",
            "accent": get_setting("theme_accent") or "#6c5ce7",
            "maintenance": str(get_setting("maintenance_mode") or "0") == "1",
        },
        security={"resetHours": auth.reset_hours()},
        withdrawalMethods=wallet.withdrawal_methods(public=False),
        log=fetch_all(
            "SELECT channel, event, ok, detail, created_at FROM notification_log "
            "ORDER BY id DESC LIMIT 25"
        ),
    )


@app.post("/api/admin/settings")
@auth.admin_required
def admin_save_settings():
    data = body()

    if "minWithdraw" in data:
        try:
            cents = wallet.to_cents(data["minWithdraw"], field="Minimum withdrawal")
        except wallet.WalletError as exc:
            return err(str(exc))
        if cents < 100:
            return err("Minimum withdrawal cannot be lower than 1.00.")
        set_setting("min_withdraw_cents", str(cents))
    if "minTopup" in data:
        try:
            cents = wallet.to_cents(data["minTopup"], field="Minimum top-up")
        except wallet.WalletError as exc:
            return err(str(exc))
        set_setting("min_topup_cents", str(cents))
    if "currency" in data:
        currency = re.sub(r"[^A-Z]", "", clean(data["currency"], 8).upper())[:3]
        if len(currency) != 3:
            return err("Currency must be a 3-letter code, like USD.")
        set_setting("currency", currency)
    if "currencySymbol" in data:
        symbol = clean(data["currencySymbol"], 4) or "$"
        set_setting("currency_symbol", symbol)
    if "manualTopupApproval" in data:
        set_setting("manual_topup_approval", "1" if data["manualTopupApproval"] else "0")

    for field, setting, limit in (
        ("telegramUsername", "telegram_contact_username", 64),
        ("telegramLink", "telegram_contact_link", 300),
        ("discordLink", "discord_contact_link", 300),
        ("supportContact", "support_contact", 120),
    ):
        if field in data:
            set_setting(setting, clean(data[field], limit))

    for field, setting, limit in (
        ("telegramBotToken", "telegram_bot_token", 120),
        ("telegramAdminChatId", "telegram_admin_chat_id", 64),
        ("discordWebhookUrl", "discord_webhook_url", 400),
    ):
        value = data.get(field)
        if isinstance(value, str) and value.strip():
            set_setting(setting, value.strip()[:limit])
    for field, setting in (
        ("clearTelegramToken", "telegram_bot_token"),
        ("clearDiscordWebhook", "discord_webhook_url"),
    ):
        if data.get(field):
            set_setting(setting, "")

    for event in notify.EVENTS:
        key = f"notify_{event}"
        if key in data:
            set_setting(key, "1" if data[key] else "0")

    if "appName" in data:
        name = clean(data["appName"], 60)
        if not name:
            return err("Give the app a name.")
        set_setting("app_name", name)
    if "logo" in data:
        set_setting("app_logo", clean(data["logo"], 2) or "K")
    if "accent" in data:
        set_setting("theme_accent", _hex_colour(data["accent"]))
    if "maintenance" in data:
        set_setting("maintenance_mode", "1" if data["maintenance"] else "0")
    if "resetHours" in data:
        try:
            hours = int(data["resetHours"])
        except (TypeError, ValueError):
            return err("Reset link lifetime must be a number of hours.")
        if not 1 <= hours <= 720:
            return err("Reset links must last between 1 and 720 hours.")
        set_setting("reset_token_hours", str(hours))

    return admin_get_settings()


@app.post("/api/admin/settings/test")
@auth.admin_required
def admin_test_notification():
    channel = clean(body().get("channel"), 12).lower()
    title = "Test notification"
    lines = [f"This is a test from {app_name()}.", "Notifications are working."]
    if channel == "telegram":
        ok, detail = notify.telegram("<b>Test notification</b>\n" + "\n".join(lines))
        return jsonify(ok=ok, detail=detail)
    if channel == "discord":
        ok, detail = notify.discord(
            {"title": title, "description": "\n".join(lines), "color": 0x6C5CE7,
             "footer": {"text": app_name()}}
        )
        return jsonify(ok=ok, detail=detail)
    return err("Choose telegram or discord.")


@app.post("/api/admin/withdrawal-methods")
@auth.admin_required
def admin_save_withdrawal_method():
    try:
        method = wallet.save_withdrawal_method(body())
    except wallet.WalletError as exc:
        return err(str(exc))
    return jsonify(method=method)


@app.delete("/api/admin/withdrawal-methods/<method_id>")
@auth.admin_required
def admin_delete_withdrawal_method(method_id):
    in_use = fetch_one(
        "SELECT COUNT(*) AS n FROM withdrawals WHERE method = ? "
        "AND status IN ('pending', 'approved', 'processing')",
        (method_id,),
    )
    if in_use["n"]:
        return err("Requests still use this method — finish them before disabling it.")
    execute("UPDATE withdrawal_methods SET enabled = 0 WHERE id = ?", (method_id,))
    return jsonify(ok=True)


# ------------------------------------------------------- admin: conversations
@app.get("/api/admin/conversations")
@auth.admin_required
def admin_conversations():
    rows = fetch_all(
        """SELECT u.id, u.email, u.name, u.avatar, u.contact_type, u.contact_handle,
                  (SELECT body FROM messages m WHERE m.user_id = u.id ORDER BY m.id DESC LIMIT 1) AS last_body,
                  (SELECT created_at FROM messages m WHERE m.user_id = u.id ORDER BY m.id DESC LIMIT 1) AS last_at,
                  (SELECT COUNT(*) FROM messages m WHERE m.user_id = u.id AND m.sender = 'customer'
                     AND m.read_at IS NULL) AS unread
           FROM users u
           WHERE EXISTS (SELECT 1 FROM messages m WHERE m.user_id = u.id)
           ORDER BY last_at DESC"""
    )
    return jsonify(conversations=rows)


@app.get("/api/admin/conversations/<int:user_id>")
@auth.admin_required
def admin_conversation(user_id):
    user = fetch_one(
        "SELECT id, email, name, avatar, contact_type, contact_handle FROM users WHERE id = ?",
        (user_id,),
    )
    if not user:
        return err("Customer not found.", 404)
    rows = fetch_all(
        "SELECT id, sender, body, created_at FROM messages WHERE user_id = ? ORDER BY id",
        (user_id,),
    )
    execute(
        "UPDATE messages SET read_at = datetime('now') WHERE user_id = ? AND sender = 'customer' AND read_at IS NULL",
        (user_id,),
    )
    return jsonify(
        user=user,
        messages=[
            {"id": r["id"], "sender": r["sender"], "body": r["body"], "createdAt": r["created_at"]}
            for r in rows
        ],
    )


@app.post("/api/admin/conversations/<int:user_id>")
@auth.admin_required
def admin_send_message(user_id):
    user = fetch_one("SELECT id, email FROM users WHERE id = ?", (user_id,))
    if not user:
        return err("Customer not found.", 404)
    text = clean(body().get("body"), 2000)
    if not text:
        return err("Write a message first.")

    execute("INSERT INTO messages (user_id, sender, body) VALUES (?, 'admin', ?)", (user_id, text))
    notify.customer_notify(
        user_id, "message", "New message from support", text[:300], "messages"
    )
    notify.emit(
        "new_message",
        "Support reply sent",
        [f"To: {user['email']}", text[:200]],
        customer=user["email"],
        status="sent",
        url=f"{base_url()}/admin.html#messages",
    )

    try:
        base = base_url()
        mailer.send(
            user["email"],
            "New message from Kudsi Shop",
            f"You have a new reply from the Kudsi Shop team:\n\n{text}\n\n"
            f"Open it here: {base}/messages.html",
        )
    except Exception as exc:  # noqa: BLE001
        print(f"[messages] notification failed: {exc}")

    return jsonify(ok=True), 201


# ------------------------------------------------------------------- page guard
def _page_user():
    """Return the signed-in user, or a redirect response for the caller."""
    user = auth.current_user()
    if not user:
        return None, redirect(f"/login.html?next={here()}")
    if user["status"] != "active":
        auth.logout_user()
        return None, redirect("/login.html?suspended=1")
    return user, None


@app.get("/dashboard.html")
def dashboard_page():
    user, redirect_response = _page_user()
    if redirect_response:
        return redirect_response
    if user["role"] == "admin":
        return redirect("/admin.html")
    return send_from_directory(PUBLIC_DIR, "dashboard.html")


@app.get("/wallet.html")
def wallet_page():
    _, redirect_response = _page_user()
    if redirect_response:
        return redirect_response
    return send_from_directory(PUBLIC_DIR, "wallet.html")


@app.get("/admin.html")
def admin_page():
    user, redirect_response = _page_user()
    if redirect_response:
        return redirect_response
    if user["role"] != "admin":
        return redirect("/dashboard.html")
    return send_from_directory(PUBLIC_DIR, "admin.html")


@app.get("/account.html")
def account_page():
    _, redirect_response = _page_user()
    if redirect_response:
        return redirect_response
    return send_from_directory(PUBLIC_DIR, "account.html")


@app.get("/order.html")
def order_page():
    _, redirect_response = _page_user()
    if redirect_response:
        return redirect_response
    return send_from_directory(PUBLIC_DIR, "order.html")


@app.get("/messages.html")
def messages_page():
    _, redirect_response = _page_user()
    if redirect_response:
        return redirect_response
    return send_from_directory(PUBLIC_DIR, "messages.html")


@app.get("/setup.html")
def setup_page():
    if admin_count() > 0:
        return redirect("/login.html")
    return send_from_directory(PUBLIC_DIR, "setup.html")


@app.errorhandler(404)
def not_found(_):
    if request.path.startswith("/api/"):
        return jsonify(error="Not found."), 404
    return send_from_directory(PUBLIC_DIR, "404.html"), 404


@app.errorhandler(413)
def too_large(_):
    return jsonify(error="That file is too large."), 413


# ------------------------------------------------------------------ background
_watcher_started = False


def sweep_payments():
    now = int(time.time())
    execute(
        "UPDATE orders SET status = 'expired' WHERE status = 'pending' "
        "AND expires_at IS NOT NULL AND expires_at < ?",
        (now,),
    )
    rows = fetch_all(
        "SELECT * FROM orders WHERE status = 'pending' AND provider IS NOT NULL "
        "AND provider NOT IN ('binance', 'sandbox') ORDER BY created_at LIMIT 40"
    )
    for order in rows:
        if order["last_checked"] and now - int(order["last_checked"]) < 30:
            continue
        try:
            result = check_crypto_order(order)
            if result.get("paid"):
                print(f"[payments] {order['id']} confirmed via {order['provider']}")
        except Exception as exc:  # noqa: BLE001
            print(f"[payments] check failed for {order['id']}: {exc}")
    sweep_topups()


def sweep_topups():
    """Auto-verify crypto top-ups with the same explorers orders use."""
    rows = fetch_all(
        """SELECT tp.id AS topup_id, tp.pay_amount, tp.pay_asset, tp.pay_address,
                  pm.id AS method_id, pm.label, pm.asset, pm.network, pm.auto_verify, pm.kind
           FROM topups tp JOIN payment_methods pm ON pm.id = tp.method
           WHERE tp.status = 'pending' AND pm.auto_verify = 1 AND pm.kind = 'crypto'
             AND tp.pay_amount IS NOT NULL AND tp.pay_address IS NOT NULL
           ORDER BY tp.created_at LIMIT 20"""
    )
    if not rows:
        return
    used = {
        r["txid"]
        for r in fetch_all(
            "SELECT txid FROM orders WHERE txid IS NOT NULL "
            "UNION SELECT txid FROM topups WHERE txid IS NOT NULL"
        )
    }
    admin = fetch_one("SELECT id FROM users WHERE role = 'admin' ORDER BY id LIMIT 1")
    for row in rows:
        method = {
            "id": row["method_id"],
            "label": row["label"],
            "asset": row["asset"],
            "network": row["network"],
            "address": row["pay_address"],
        }
        try:
            result = crypto.check_payment(
                method,
                {"pay_amount": row["pay_amount"], "pay_asset": row["pay_asset"]},
                used,
            )
        except Exception as exc:  # noqa: BLE001
            print(f"[topup] check failed for {row['topup_id']}: {exc}")
            continue
        if not result.get("paid"):
            continue
        txid = result.get("txid")
        execute(
            "UPDATE topups SET txid = ? WHERE id = ? AND status = 'pending'",
            (txid, row["topup_id"]),
        )
        try:
            topup = wallet.decide_topup(
                row["topup_id"], True, admin["id"] if admin else None,
                f"Auto-verified on-chain ({txid[:16]}…)",
            )
            notify.customer_notify(
                topup["userId"], "topup", "Top-up confirmed",
                f"{wallet.fmt(topup['amountCents'])} was added to your balance.", topup["id"],
            )
            notify.emit(
                "topup_decision",
                "Top-up auto-confirmed",
                [f"Customer: {topup['email']}", f"Amount: {wallet.fmt(topup['amountCents'])}", f"Tx: {txid}"],
                amount=wallet.fmt(topup["amountCents"]),
                customer=topup["email"],
                status="approved",
                color=0x00D4A0,
            )
            print(f"[topup] {row['topup_id']} auto-confirmed")
        except wallet.WalletError as exc:
            print(f"[topup] {row['topup_id']}: {exc}")


def watcher_loop():
    while True:
        try:
            sweep_payments()
        except Exception as exc:  # noqa: BLE001
            print(f"[payments] sweep failed: {exc}")
        time.sleep(45)


def start_watcher():
    global _watcher_started
    if _watcher_started or os.environ.get("DISABLE_PAYMENT_WATCHER") == "1":
        return
    _watcher_started = True
    threading.Thread(target=watcher_loop, daemon=True).start()
    print("  Payment watcher started (checks pending crypto orders every 45s)")


start_watcher()


if __name__ == "__main__":
    port = int(os.environ.get("PORT", 3000))
    print(f"\n  Kudsi Shop running at http://localhost:{port}")
    print(f"  First run? Open http://localhost:{port}/setup to create your admin account.\n")
    app.run(host="127.0.0.1", port=port, debug=os.environ.get("FLASK_DEBUG") == "1")
