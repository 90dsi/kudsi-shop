"""Social sign-in, avatar helpers and Discord bot operations.

Everything here uses only the Python standard library so the shop keeps
running on PythonAnywhere without extra packages.

No OAuth token, client secret or bot token is ever returned to the browser.
Secrets are read from environment variables (or the .env file loaded by
app.py) at call time, never from request data.
"""

from __future__ import annotations

import json
import os
import re
import secrets
import time
import urllib.error
import urllib.parse
import urllib.request

from db import DATA_DIR, get_setting

GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth"
GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token"
GOOGLE_USERINFO_URL = "https://openidconnect.googleapis.com/v1/userinfo"
DISCORD_AUTH_URL = "https://discord.com/oauth2/authorize"
DISCORD_TOKEN_URL = "https://discord.com/api/oauth2/token"
DISCORD_USER_URL = "https://discord.com/api/users/@me"
DISCORD_API = "https://discord.com/api/v10"

AVATAR_DIR = DATA_DIR / "avatars"
AVATAR_RE = re.compile(r"^[a-f0-9]{32}\.(?:jpg|jpeg|png|webp)$")
MAX_AVATAR_BYTES = 2 * 1024 * 1024
MAX_AVATAR_SIDE = 4096

USER_AGENT = "KudsiShop/1.0 (+https://90dsi.pythonanywhere.com)"


class OAuthError(Exception):
    """A provider call failed. The message is safe to show to the customer."""


class DiscordError(Exception):
    """A Discord bot call failed. The message is safe to show to an admin."""

    def __init__(self, message: str, status: int = 502):
        super().__init__(message)
        self.status = status


# ------------------------------------------------------------------ env/config
def _env(name: str) -> str:
    return (os.environ.get(name) or "").strip()


def google_configured() -> bool:
    return bool(_env("GOOGLE_CLIENT_ID") and _env("GOOGLE_CLIENT_SECRET"))


def discord_configured() -> bool:
    return bool(_env("DISCORD_CLIENT_ID") and _env("DISCORD_CLIENT_SECRET"))


def provider_configured(provider: str) -> bool:
    if provider == "google":
        return google_configured()
    if provider == "discord":
        return discord_configured()
    return False


def bot_config() -> dict:
    return {
        "token": _env("DISCORD_BOT_TOKEN"),
        "guild": _env("DISCORD_GUILD_ID"),
        "role": _env("DISCORD_VERIFIED_ROLE_ID"),
        "invite": _env("DISCORD_INVITE_URL")
        or (get_setting("discord_invite_url") or "").strip()
        or (get_setting("discord_contact_link") or "").strip(),
    }


def bot_configured() -> bool:
    cfg = bot_config()
    return bool(cfg["token"] and cfg["guild"] and cfg["role"])


def providers_payload() -> dict:
    """Public flags for the sign-in page. Never contains secrets."""
    return {
        "google": google_configured(),
        "discord": discord_configured(),
        "discordVerification": bot_configured(),
    }


# --------------------------------------------------------------------- OAuth
def authorize_url(provider: str, state: str, redirect_uri: str) -> str:
    if provider == "google":
        params = {
            "client_id": _env("GOOGLE_CLIENT_ID"),
            "redirect_uri": redirect_uri,
            "response_type": "code",
            "scope": "openid email profile",
            "state": state,
            "access_type": "online",
            "prompt": "select_account",
        }
        return f"{GOOGLE_AUTH_URL}?{urllib.parse.urlencode(params)}"
    if provider == "discord":
        params = {
            "client_id": _env("DISCORD_CLIENT_ID"),
            "redirect_uri": redirect_uri,
            "response_type": "code",
            "scope": "identify email",
            "state": state,
            # consent is not required every time, but this keeps linking
            # explicit if the customer wants to use a different account.
            "prompt": "consent",
        }
        return f"{DISCORD_AUTH_URL}?{urllib.parse.urlencode(params)}"
    raise OAuthError("Unknown sign-in provider.")


def _http_json(url: str, *, data: bytes | None = None, headers: dict | None = None,
               method: str = "GET", timeout: int = 15) -> dict:
    req = urllib.request.Request(url, data=data, headers=headers or {}, method=method)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as response:
            body = response.read().decode("utf-8", errors="replace")
            if not body:
                return {}
            try:
                parsed = json.loads(body)
            except ValueError:
                return {}
            return parsed if isinstance(parsed, dict) else {}
    except urllib.error.HTTPError as exc:
        body = exc.read().decode("utf-8", errors="replace")
        message = ""
        try:
            parsed = json.loads(body)
            if isinstance(parsed, dict):
                message = str(parsed.get("error_description") or parsed.get("error") or "")
        except ValueError:
            message = body[:200]
        raise OAuthError(message or "The sign-in provider rejected the request.") from exc
    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        raise OAuthError("Could not reach the sign-in provider. Try again.") from exc


def _exchange_code(provider: str, code: str, redirect_uri: str) -> str:
    if provider == "google":
        token_url = GOOGLE_TOKEN_URL
        client_id = _env("GOOGLE_CLIENT_ID")
        client_secret = _env("GOOGLE_CLIENT_SECRET")
    elif provider == "discord":
        token_url = DISCORD_TOKEN_URL
        client_id = _env("DISCORD_CLIENT_ID")
        client_secret = _env("DISCORD_CLIENT_SECRET")
    else:
        raise OAuthError("Unknown sign-in provider.")

    payload = urllib.parse.urlencode(
        {
            "client_id": client_id,
            "client_secret": client_secret,
            "code": code,
            "grant_type": "authorization_code",
            "redirect_uri": redirect_uri,
        }
    ).encode()
    data = _http_json(
        token_url,
        data=payload,
        method="POST",
        headers={
            "Content-Type": "application/x-www-form-urlencoded",
            "Accept": "application/json",
            "User-Agent": USER_AGENT,
        },
    )
    token = data.get("access_token")
    if not token:
        raise OAuthError("The sign-in provider did not return an access token.")
    return str(token)


def _get_profile(provider: str, token: str) -> dict:
    if provider == "google":
        data = _http_json(
            GOOGLE_USERINFO_URL,
            headers={"Authorization": f"Bearer {token}", "Accept": "application/json", "User-Agent": USER_AGENT},
        )
        sub = str(data.get("sub") or "").strip()
        if not sub:
            raise OAuthError("Google did not return an account id.")
        if data.get("email_verified") is False:
            raise OAuthError("That Google email is not verified.")
        return {
            "provider": "google",
            "id": sub,
            "email": str(data.get("email") or "").strip().lower(),
            "email_verified": bool(data.get("email_verified", True)),
            "name": str(data.get("name") or "").strip(),
            "avatar": str(data.get("picture") or "").strip(),
            "username": str(data.get("email") or "").strip(),
            "global_name": str(data.get("name") or "").strip(),
        }

    if provider == "discord":
        data = _http_json(
            DISCORD_USER_URL,
            headers={"Authorization": f"Bearer {token}", "Accept": "application/json", "User-Agent": USER_AGENT},
        )
        user_id = str(data.get("id") or "").strip()
        if not user_id:
            raise OAuthError("Discord did not return an account id.")
        avatar = str(data.get("avatar") or "").strip()
        username = str(data.get("username") or "").strip()
        global_name = str(data.get("global_name") or "").strip()
        return {
            "provider": "discord",
            "id": user_id,
            "email": str(data.get("email") or "").strip().lower(),
            "email_verified": bool(data.get("verified", True)),
            "name": global_name or username,
            "avatar": discord_avatar_url(user_id, avatar) or "",
            "avatar_hash": avatar,
            "username": username,
            "global_name": global_name,
        }

    raise OAuthError("Unknown sign-in provider.")


def fetch_profile(provider: str, code: str, redirect_uri: str) -> dict:
    token = _exchange_code(provider, code, redirect_uri)
    return _get_profile(provider, token)


# -------------------------------------------------------------------- avatars
def discord_avatar_url(discord_id: str | None, avatar_hash: str | None, size: int = 160) -> str | None:
    if not discord_id or not avatar_hash:
        return None
    if not re.fullmatch(r"[0-9]{5,32}", str(discord_id)):
        return None
    if not re.fullmatch(r"[A-Za-z0-9_]{10,80}", str(avatar_hash)):
        return None
    ext = "gif" if str(avatar_hash).startswith("a_") else "png"
    return f"https://cdn.discordapp.com/avatars/{discord_id}/{avatar_hash}.{ext}?size={size}"


def avatar_filename(row: dict | None) -> str | None:
    if not row:
        return None
    name = str(row.get("avatar_file") or "").strip()
    return name if AVATAR_RE.fullmatch(name) else None


def avatar_url(row: dict | None) -> str | None:
    """Resolve the avatar priority: upload, Discord, Google, then letter."""
    if not row:
        return None
    name = avatar_filename(row)
    if name:
        return f"/api/avatars/{name}"
    legacy = str(row.get("avatar") or "").strip()
    if legacy.startswith("data:image/") or legacy.startswith("https://") or legacy.startswith("http://"):
        return legacy
    discord = discord_avatar_url(row.get("discord_id"), row.get("discord_avatar"))
    if discord:
        return discord
    google = str(row.get("google_avatar") or "").strip()
    if google.startswith("https://") or google.startswith("http://"):
        return google
    return None


def decorate_user(row: dict | None) -> dict | None:
    """Add resolved avatar + safe social booleans to a user row."""
    if not row:
        return None
    data = dict(row)
    data["avatar"] = avatar_url(row)
    data["googleConnected"] = bool(row.get("google_sub"))
    data["discordConnected"] = bool(row.get("discord_id"))
    data["discordVerified"] = bool(row.get("discord_verified_at"))
    return data


def sniff_image(raw: bytes) -> tuple[str, str] | None:
    """Return (extension, mimetype) from magic bytes, or None."""
    if len(raw) < 12:
        return None
    if raw.startswith(b"\xff\xd8\xff"):
        return ("jpg", "image/jpeg")
    if raw.startswith(b"\x89PNG\r\n\x1a\n"):
        return ("png", "image/png")
    if raw[:4] == b"RIFF" and raw[8:12] == b"WEBP":
        return ("webp", "image/webp")
    return None


def _png_size(data: bytes) -> tuple[int, int] | None:
    if len(data) < 24:
        return None
    width = int.from_bytes(data[16:20], "big")
    height = int.from_bytes(data[20:24], "big")
    return width, height


def _jpeg_size(data: bytes) -> tuple[int, int] | None:
    index = 2
    sof = {0xC0, 0xC1, 0xC2, 0xC3, 0xC5, 0xC6, 0xC7, 0xC9, 0xCA, 0xCB, 0xCD, 0xCE, 0xCF}
    while index + 9 < len(data):
        if data[index] != 0xFF:
            index += 1
            continue
        marker = data[index + 1]
        if marker in (0xD8, 0xD9) or 0xD0 <= marker <= 0xD7:
            index += 2
            continue
        length = int.from_bytes(data[index + 2:index + 4], "big")
        if length < 2:
            return None
        if marker in sof:
            height = int.from_bytes(data[index + 5:index + 7], "big")
            width = int.from_bytes(data[index + 7:index + 9], "big")
            return width, height
        index += 2 + length
    return None


def _webp_size(data: bytes) -> tuple[int, int] | None:
    if len(data) < 30:
        return None
    chunk = data[12:16]
    try:
        if chunk == b"VP8X":
            width = int.from_bytes(data[24:27], "little") + 1
            height = int.from_bytes(data[27:30], "little") + 1
            return width, height
        if chunk == b"VP8 ":
            if data[23:26] != b"\x9d\x01\x2a":
                return None
            width = int.from_bytes(data[26:28], "little") & 0x3FFF
            height = int.from_bytes(data[28:30], "little") & 0x3FFF
            return width, height
        if chunk == b"VP8L":
            if data[20] != 0x2F:
                return None
            bits = int.from_bytes(data[21:25], "little")
            width = (bits & 0x3FFF) + 1
            height = ((bits >> 14) & 0x3FFF) + 1
            return width, height
    except IndexError:
        return None
    return None


def image_size(raw: bytes, ext: str) -> tuple[int, int] | None:
    if ext == "png":
        return _png_size(raw)
    if ext in {"jpg", "jpeg"}:
        return _jpeg_size(raw)
    if ext == "webp":
        return _webp_size(raw)
    return None


def validate_avatar_bytes(raw: bytes) -> tuple[str | None, str | None]:
    """Validate an uploaded picture. Returns (extension, error)."""
    if not raw:
        return None, "Pick an image to upload."
    if len(raw) > MAX_AVATAR_BYTES:
        return None, "That picture is too large. Use an image under 2 MB."
    found = sniff_image(raw)
    if not found:
        return None, "Upload a JPG, PNG or WebP image."
    ext, _mime = found
    size = image_size(raw, ext)
    if not size:
        return None, "That image file looks damaged."
    width, height = size
    if width < 1 or height < 1:
        return None, "That image file looks damaged."
    if width > MAX_AVATAR_SIDE or height > MAX_AVATAR_SIDE:
        return None, f"Keep pictures under {MAX_AVATAR_SIDE} × {MAX_AVATAR_SIDE} pixels."
    if width * height > MAX_AVATAR_SIDE * MAX_AVATAR_SIDE:
        return None, "That picture is too large to process."
    return ext, None


def store_avatar(raw: bytes, ext: str) -> str:
    """Write the picture under a random, safe filename. Returns the filename."""
    AVATAR_DIR.mkdir(parents=True, exist_ok=True)
    name = f"{secrets.token_hex(16)}.{ext}"
    target = AVATAR_DIR / name
    # A fresh random name can collide only in theory; retry a few times.
    for _ in range(5):
        if not target.exists():
            break
        name = f"{secrets.token_hex(16)}.{ext}"
        target = AVATAR_DIR / name
    with open(target, "wb") as handle:
        handle.write(raw)
    return name


def delete_avatar_file(name: str | None) -> bool:
    if not name or not AVATAR_RE.fullmatch(str(name)):
        return False
    target = AVATAR_DIR / name
    try:
        if target.is_file():
            target.unlink()
            return True
    except OSError:
        pass
    return False


def avatar_path(name: str) -> str | None:
    if not name or not AVATAR_RE.fullmatch(str(name)):
        return None
    target = AVATAR_DIR / name
    return str(target) if target.is_file() else None


# --------------------------------------------------------------- Discord bot
_bot_identity: dict | None = None
_bot_identity_at = 0.0


def _bot_call(method: str, path: str, payload: dict | None = None) -> tuple[int, dict | list | None]:
    cfg = bot_config()
    token = cfg["token"]
    if not token:
        raise DiscordError("Discord bot token is not configured.")
    data = None
    headers = {
        "Authorization": f"Bot {token}",
        "Accept": "application/json",
        "User-Agent": USER_AGENT,
    }
    if payload is not None:
        data = json.dumps(payload).encode()
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(f"{DISCORD_API}{path}", data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=15) as response:
            body = response.read().decode("utf-8", errors="replace")
            if not body:
                return response.status, None
            try:
                return response.status, json.loads(body)
            except ValueError:
                return response.status, None
    except urllib.error.HTTPError as exc:
        body = exc.read().decode("utf-8", errors="replace")
        message = ""
        try:
            parsed = json.loads(body)
            if isinstance(parsed, dict):
                message = str(parsed.get("message") or parsed.get("error") or "")
        except ValueError:
            message = body[:200]
        if exc.code == 401:
            raise DiscordError("The Discord bot token is invalid.", 503) from exc
        if exc.code == 403:
            raise DiscordError(
                "The Discord bot is missing the Manage Roles permission, or its role is below the verified role.",
                503,
            ) from exc
        if exc.code == 404:
            return 404, {"message": message or "Not found"}
        if exc.code == 429:
            raise DiscordError("Discord is rate limiting us. Try again in a minute.", 429) from exc
        raise DiscordError(message or f"Discord returned HTTP {exc.code}.", 502) from exc
    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        raise DiscordError("Could not reach Discord. Try again.", 502) from exc


def _bot_user_id() -> str:
    global _bot_identity, _bot_identity_at
    now = time.time()
    if _bot_identity and now - _bot_identity_at < 3600:
        return str(_bot_identity.get("id") or "")
    status, data = _bot_call("GET", "/users/@me")
    if status != 200 or not isinstance(data, dict) or not data.get("id"):
        raise DiscordError("Could not read the Discord bot account.", 503)
    _bot_identity = data
    _bot_identity_at = now
    return str(data["id"])


def guild_member(user_id: str) -> dict | None:
    cfg = bot_config()
    status, data = _bot_call("GET", f"/guilds/{cfg['guild']}/members/{user_id}")
    if status == 404:
        # A 404 means either "that user is not in the server" or "the bot cannot
        # see that server at all". Check the bot's own access so a missing bot
        # invite is reported as an admin setup problem, not as the customer's
        # fault.
        guild_status, _ = _bot_call("GET", f"/guilds/{cfg['guild']}")
        if guild_status == 404:
            raise DiscordError(
                "The Discord bot is not in the configured server yet. "
                "Ask an admin to invite it, then try again.",
                503,
            )
        return None
    if status != 200 or not isinstance(data, dict):
        raise DiscordError("Could not read the Discord membership.", 502)
    return data


def _guild_roles() -> list[dict]:
    cfg = bot_config()
    status, data = _bot_call("GET", f"/guilds/{cfg['guild']}/roles")
    if status != 200 or not isinstance(data, list):
        raise DiscordError("Could not read the Discord roles.", 502)
    return data


def _guild_info() -> dict:
    cfg = bot_config()
    status, data = _bot_call("GET", f"/guilds/{cfg['guild']}")
    if status != 200 or not isinstance(data, dict):
        raise DiscordError("Could not read the Discord server.", 502)
    return data


def _check_role_permission() -> tuple[bool, str]:
    """Check the bot can manage the configured role (permissions + hierarchy)."""
    cfg = bot_config()
    roles = _guild_roles()
    target = next((r for r in roles if str(r.get("id")) == cfg["role"]), None)
    if not target:
        return False, "The verified role does not exist on that Discord server."
    if target.get("managed"):
        return False, "That role is managed by an integration and cannot be assigned by the bot."

    guild = _guild_info()
    bot_id = _bot_user_id()
    if str(guild.get("owner_id") or "") == bot_id:
        return True, ""

    status, member = _bot_call("GET", f"/guilds/{cfg['guild']}/members/{bot_id}")
    if status != 200 or not isinstance(member, dict):
        return False, "The bot is not a member of that Discord server."
    bot_role_ids = {str(r) for r in (member.get("roles") or [])}
    by_id = {str(r.get("id")): r for r in roles}
    permissions = 0
    top_position = 0
    for role_id in bot_role_ids:
        role = by_id.get(role_id)
        if not role:
            continue
        try:
            permissions |= int(role.get("permissions") or 0)
            top_position = max(top_position, int(role.get("position") or 0))
        except (TypeError, ValueError):
            continue
    administrator = bool(permissions & (1 << 3))
    manage_roles = bool(permissions & (1 << 28))
    if not administrator and not manage_roles:
        return False, "The bot needs the Manage Roles permission."
    target_position = int(target.get("position") or 0)
    if not administrator and top_position <= target_position:
        return False, "Move the bot's role above the verified role in the Discord role list."
    return True, ""


def check_member_role(user_id: str) -> dict:
    """Read membership + role without changing anything."""
    cfg = bot_config()
    if not bot_configured():
        raise DiscordError("Discord verification is not configured yet.", 503)
    member = guild_member(user_id)
    if not member:
        return {"member": False, "hasRole": False, "status": "not_member"}
    has_role = cfg["role"] in {str(r) for r in (member.get("roles") or [])}
    return {"member": True, "hasRole": has_role, "status": "verified" if has_role else "not_verified"}


def verify_and_assign(user_id: str) -> dict:
    """Verify guild membership then assign the configured role if needed."""
    cfg = bot_config()
    if not bot_configured():
        raise DiscordError("Discord verification is not configured yet.", 503)

    member = guild_member(user_id)
    if not member:
        return {"member": False, "hasRole": False, "status": "not_member"}

    role_ids = {str(r) for r in (member.get("roles") or [])}
    if cfg["role"] in role_ids:
        return {"member": True, "hasRole": True, "status": "already_verified"}

    ok, reason = _check_role_permission()
    if not ok:
        raise DiscordError(reason, 503)

    status, _data = _bot_call(
        "PUT", f"/guilds/{cfg['guild']}/members/{user_id}/roles/{cfg['role']}"
    )
    if status not in (200, 204):
        raise DiscordError("Discord did not accept the role assignment.", 502)
    return {"member": True, "hasRole": True, "status": "verified"}


def remove_role(user_id: str) -> dict:
    cfg = bot_config()
    if not bot_configured():
        raise DiscordError("Discord verification is not configured yet.", 503)
    member = guild_member(user_id)
    if not member:
        return {"member": False, "removed": False, "status": "not_member"}
    role_ids = {str(r) for r in (member.get("roles") or [])}
    if cfg["role"] not in role_ids:
        return {"member": True, "removed": False, "status": "no_role"}
    ok, reason = _check_role_permission()
    if not ok:
        raise DiscordError(reason, 503)
    status, _data = _bot_call(
        "DELETE", f"/guilds/{cfg['guild']}/members/{user_id}/roles/{cfg['role']}"
    )
    if status not in (200, 204):
        raise DiscordError("Discord did not accept the role removal.", 502)
    return {"member": True, "removed": True, "status": "removed"}
