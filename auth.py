"""Password hashing and session helpers (standard library only)."""

import functools
import hashlib
import hmac
import secrets
import time

from flask import g, jsonify, redirect, request, session

from db import execute, fetch_one, get_db, get_setting

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
def login_user(user_id: int):
    session.clear()
    session["uid"] = user_id
    session.permanent = True
    g.pop("user", None)  # drop any per-request cache


def logout_user():
    session.clear()


def current_user():
    """Session user dict (or None). Cached per request in g."""
    if "user" in g:
        return g.user
    uid = session.get("uid")
    user = None
    if uid:
        user = fetch_one(
            "SELECT id, email, name, role, avatar, contact_type, contact_handle, created_at, "
            "last_login, balance_cents, deposited_cents, withdrawn_cents, status "
            "FROM users WHERE id = ?",
            (uid,),
        )
    g.user = user
    return user


def public_user(user, order_count: int | None = None):
    if not user:
        return None
    data = {k: user[k] for k in ("id", "email", "name", "role", "avatar", "created_at")}
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
