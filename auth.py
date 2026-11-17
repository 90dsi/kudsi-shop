"""Password hashing and session helpers (standard library only)."""

import functools
import hashlib
import hmac
import secrets
import time

from flask import g, jsonify, redirect, request, session

import social
from db import execute, fetch_all, fetch_one, get_db, get_setting

SCRYPT_N = 16384
SCRYPT_R = 8
SCRYPT_P = 1


# ------------------------------------------------------------------ passwords
def hash_password(password: str) -> str:
    salt = secrets.token_bytes(16)
    dk = hashlib.scrypt(password.encode(), salt=salt, n=SCRYPT_N, r=SCRYPT_R, p=SCRYPT_P, dklen=32)
    return f"scrypt${salt.hex()}${dk.hex()}"


def verify_password(password: str, stored: str | None) -> bool:
    if not stored:
        return False
    try:
        algo, salt_hex, hash_hex = stored.split("$")
        if algo != "scrypt":
            return False
        salt = bytes.fromhex(salt_hex)
        expected = bytes.fromhex(hash_hex)
        dk = hashlib.scrypt(
            password.encode(), salt=salt, n=SCRYPT_N, r=SCRYPT_R, p=SCRYPT_P, dklen=len(expected)
        )
        return hmac.compare_digest(dk, expected)
    except (ValueError, TypeError):
        return False


# ------------------------------------------------------------------- sessions
def client_ip() -> str:
    forwarded = request.headers.get("X-Forwarded-For", "")
    value = forwarded.split(",")[0].strip() if forwarded else (request.remote_addr or "")
    return value[:64]


def client_ua() -> str:
    return (request.headers.get("User-Agent") or "")[:255]


def mask_ip(value) -> str:
    """Show enough of an IP to recognise it, never the full address."""
    value = str(value or "").strip()
    if not value:
        return "—"
    if ":" in value:
        parts = [part for part in value.split(":") if part]
        return (":".join(parts[:4]) + "::") if parts else "—"
    parts = value.split(".")
    if len(parts) == 4:
        return ".".join(parts[:3]) + ".x"
    return value[:24]


def device_label(user_agent) -> str:
    ua = str(user_agent or "")
    if not ua:
        return "Unknown device"
    browser = "Browser"
    for needle, label in (
        ("Edg/", "Edge"),
        ("OPR/", "Opera"),
        ("Firefox/", "Firefox"),
        ("Chrome/", "Chrome"),
        ("Safari/", "Safari"),
    ):
        if needle in ua:
            browser = label
            break
    system = "Unknown OS"
    for needle, label in (
        ("Android", "Android"),
        ("iPhone", "iPhone"),
        ("iPad", "iPad"),
        ("Windows", "Windows"),
        ("Mac OS X", "macOS"),
        ("Linux", "Linux"),
    ):
        if needle in ua:
            system = label
            break
    return f"{browser} on {system}"


def record_login_event(user_id, provider: str, status: str, email: str | None = None) -> None:
    try:
        execute(
            "INSERT INTO login_events (user_id, email, provider, status, ip, user_agent) "
            "VALUES (?, ?, ?, ?, ?, ?)",
            (
                user_id,
                (email or "")[:190] or None,
                (provider or "password")[:20],
                (status or "success")[:20],
                client_ip(),
                client_ua(),
            ),
        )
    except Exception:  # noqa: BLE001 - logging must never break sign-in
        pass


def _start_session(user_id: int, provider: str) -> str:
    token = secrets.token_urlsafe(32)
    execute(
        "INSERT INTO user_sessions (user_id, token_hash, provider, ip, user_agent, last_seen_at) "
        "VALUES (?, ?, ?, ?, ?, datetime('now'))",
        (user_id, hash_token(token), (provider or "password")[:20], client_ip(), client_ua()),
    )
    return token


def login_user(user_id: int, provider: str = "password"):
    """Start a brand-new session, invalidating whatever came before it."""
    previous = session.get("sid")
    if previous:
        revoke_session_token(previous)
    token = _start_session(user_id, provider)
    session.clear()
    session["uid"] = user_id
    session["sid"] = token
    session.permanent = True
    g.pop("user", None)  # drop any per-request cache
    execute("UPDATE users SET last_login = datetime('now') WHERE id = ?", (user_id,))
    record_login_event(user_id, provider, "success")


def revoke_session_token(token: str | None) -> bool:
    if not token:
        return False
    with get_db() as con:
        changed = con.execute(
            "UPDATE user_sessions SET revoked_at = datetime('now') "
            "WHERE token_hash = ? AND revoked_at IS NULL",
            (hash_token(str(token)),),
        ).rowcount
    return bool(changed)


def revoke_other_sessions(user_id: int, keep_token: str | None) -> int:
    with get_db() as con:
        if keep_token:
            changed = con.execute(
                "UPDATE user_sessions SET revoked_at = datetime('now') "
                "WHERE user_id = ? AND token_hash != ? AND revoked_at IS NULL",
                (user_id, hash_token(str(keep_token))),
            ).rowcount
        else:
            changed = con.execute(
                "UPDATE user_sessions SET revoked_at = datetime('now') "
                "WHERE user_id = ? AND revoked_at IS NULL",
                (user_id,),
            ).rowcount
    return int(changed or 0)


def logout_user():
    revoke_session_token(session.get("sid"))
    session.clear()
    g.pop("user", None)


def current_user():
    """Session user dict (or None). Cached per request in g."""
    if "user" in g:
        return g.user
    uid = session.get("uid")
    user = None
    token = session.get("sid")
    if uid and token:
        record = fetch_one(
            "SELECT id, revoked_at FROM user_sessions WHERE token_hash = ?",
            (hash_token(str(token)),),
        )
        if not record or record["revoked_at"]:
            # The session was revoked from the security centre (or the database
            # was restored). Treat it as signed out.
            session.clear()
            g.user = None
            return None
        execute(
            "UPDATE user_sessions SET last_seen_at = datetime('now') "
            "WHERE token_hash = ? AND (last_seen_at IS NULL "
            "OR last_seen_at < datetime('now', '-5 minutes'))",
            (hash_token(str(token)),),
        )
    if uid:
        user = fetch_one(
            "SELECT id, email, name, role, avatar, avatar_file, contact_type, contact_handle, "
            "created_at, last_login, balance_cents, deposited_cents, withdrawn_cents, status, "
            "password_hash, google_sub, google_email, google_name, google_avatar, google_linked_at, "
            "discord_id, discord_email, discord_username, discord_global_name, discord_avatar, "
            "discord_linked_at, discord_verified_at, discord_verified_guild, discord_verified_role, "
            "discord_check_at, discord_check_status "
            "FROM users WHERE id = ?",
            (uid,),
        )
        if not user:
            session.clear()
    g.user = user
    return user


def list_sessions(user_id: int, current_token: str | None = None) -> list[dict]:
    rows = fetch_all(
        "SELECT id, token_hash, provider, ip, user_agent, created_at, last_seen_at "
        "FROM user_sessions WHERE user_id = ? AND revoked_at IS NULL "
        "ORDER BY COALESCE(last_seen_at, created_at) DESC LIMIT 50",
        (user_id,),
    )
    current_hash = hash_token(str(current_token)) if current_token else ""
    return [
        {
            "id": row["id"],
            "provider": row["provider"],
            "ip": mask_ip(row["ip"]),
            "device": device_label(row["user_agent"]),
            "createdAt": row["created_at"],
            "lastSeenAt": row["last_seen_at"],
            "current": bool(current_hash and row["token_hash"] == current_hash),
        }
        for row in rows
    ]


def login_activity(user_id: int, limit: int = 20) -> list[dict]:
    rows = fetch_all(
        "SELECT provider, status, ip, user_agent, created_at FROM login_events "
        "WHERE user_id = ? ORDER BY id DESC LIMIT ?",
        (user_id, max(1, min(int(limit), 100))),
    )
    return [
        {
            "provider": row["provider"],
            "status": row["status"],
            "ip": mask_ip(row["ip"]),
            "device": device_label(row["user_agent"]),
            "createdAt": row["created_at"],
        }
        for row in rows
    ]


def count_login_methods(user: dict | None) -> int:
    if not user:
        return 0
    methods = (
        bool(user.get("password_hash") or user.get("has_password")),
        bool(user.get("google_sub")),
        bool(user.get("discord_id")),
    )
    return sum(1 for method in methods if method)


def public_user(user, order_count: int | None = None):
    if not user:
        return None
    data = {k: user[k] for k in ("id", "email", "name", "role", "created_at")}
    data["avatar"] = social.avatar_url(user)
    data["hasCustomAvatar"] = bool(
        user.get("avatar_file") or str(user.get("avatar") or "").startswith("data:image/")
    )
    data["hasPassword"] = bool(user.get("password_hash") or user.get("has_password"))
    data["googleConnected"] = bool(user.get("google_sub"))
    data["discordConnected"] = bool(user.get("discord_id"))
    data["discordVerified"] = bool(user.get("discord_verified_at"))
    data["contact"] = {
        "type": user.get("contact_type"),
        "handle": user.get("contact_handle"),
    }
    if user.get("status"):
        data["status"] = user["status"]
    if order_count is not None:
        data["orders"] = order_count
    return data


# ------------------------------------------------------------- reset tokens
def hash_token(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def reset_hours() -> int:
    try:
        hours = int(get_setting("reset_token_hours") or 24)
    except (TypeError, ValueError):
        hours = 24
    return max(1, min(hours, 24 * 30))


def create_reset_token(user_id: int, created_by: int | None, channel: str | None = None) -> dict:
    """Single-use token. Creating a new one revokes every older unused link."""
    token = secrets.token_urlsafe(32)
    expires_at = int(time.time()) + reset_hours() * 3600
    with get_db() as con:
        con.execute(
            "UPDATE password_resets SET revoked_at = datetime('now') "
            "WHERE user_id = ? AND used_at IS NULL AND revoked_at IS NULL",
            (user_id,),
        )
        con.execute(
            "INSERT INTO password_resets (user_id, token_hash, created_by, expires_at, channel) "
            "VALUES (?, ?, ?, ?, ?)",
            (user_id, hash_token(token), created_by, expires_at, channel),
        )
        row = con.execute(
            "SELECT id, created_at, expires_at FROM password_resets WHERE token_hash = ?",
            (hash_token(token),),
        ).fetchone()
    return {
        "id": row["id"],
        "token": token,
        "expiresAt": expires_at,
        "hours": reset_hours(),
        "createdAt": row["created_at"],
    }


def token_state(row) -> str:
    if row["used_at"]:
        return "used"
    if row["revoked_at"]:
        return "revoked"
    if int(row["expires_at"]) < int(time.time()):
        return "expired"
    return "active"


def find_reset_token(token: str):
    if not token or len(token) > 200:
        return None
    return fetch_one(
        """SELECT r.*, u.email, u.name, u.status FROM password_resets r
           JOIN users u ON u.id = r.user_id WHERE r.token_hash = ?""",
        (hash_token(token),),
    )


def consume_reset_token(token: str, new_password: str) -> dict:
    """Validate + burn the token and set the new password, atomically."""
    row = find_reset_token(token)
    if not row:
        raise ValueError("This reset link is not valid.")
    state = token_state(row)
    if state == "used":
        raise ValueError("This reset link was already used. Ask for a new one.")
    if state == "revoked":
        raise ValueError("This reset link was replaced by a newer one. Ask for a new one.")
    if state == "expired":
        raise ValueError("This reset link has expired. Ask for a new one.")
    if row["status"] != "active":
        raise ValueError("This account is suspended. Contact support.")

    with get_db() as con:
        changed = con.execute(
            "UPDATE password_resets SET used_at = datetime('now') "
            "WHERE id = ? AND used_at IS NULL",
            (row["id"],),
        ).rowcount
        if not changed:
            raise ValueError("This reset link was already used. Ask for a new one.")
        con.execute(
            "UPDATE users SET password_hash = ? WHERE id = ?",
            (hash_password(new_password), row["user_id"]),
        )
        # Any other open link for this customer dies with the password change.
        con.execute(
            "UPDATE password_resets SET revoked_at = datetime('now') "
            "WHERE user_id = ? AND id != ? AND used_at IS NULL AND revoked_at IS NULL",
            (row["user_id"], row["id"]),
        )
    return {"userId": row["user_id"], "email": row["email"], "name": row["name"]}


# ----------------------------------------------------------------- middleware
def login_required(view):
    @functools.wraps(view)
    def wrapped(*args, **kwargs):
        user = current_user()
        if not user:
            if request.path.startswith("/api/"):
                return jsonify(error="Please sign in to continue."), 401
            return redirect("/login.html")
        if user["status"] != "active" and not request.path.startswith("/api/auth"):
            if request.path.startswith("/api/"):
                return jsonify(error="This account is suspended. Contact support."), 403
            session.clear()
            return redirect("/login.html?suspended=1")
        return view(*args, **kwargs)

    return wrapped


def admin_required(view):
    @functools.wraps(view)
    def wrapped(*args, **kwargs):
        user = current_user()
        if not user:
            return jsonify(error="Please sign in to continue."), 401
        if user["role"] != "admin":
            return jsonify(error="Admin access required."), 403
        return view(*args, **kwargs)

    return wrapped
