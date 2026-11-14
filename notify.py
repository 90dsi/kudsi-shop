"""Telegram + Discord notifications.

Configuration lives in the admin settings page and is stored in the database
(env vars are used as a fallback). Nothing here is ever returned to customers:
the bot token and webhook URL only leave the server through the admin API as
"configured: true/false".

Every send is best-effort. A failed notification is logged and swallowed — it
must never roll back a balance change or break a password reset.
"""

from __future__ import annotations

import json
import os
import urllib.error
import urllib.request

from db import execute, fetch_one, get_setting

EVENTS = {
    "password_reset": "Password reset links",
    "topup_request": "New top-up requests",
    "topup_decision": "Top-up approvals / rejections",
    "withdrawal_request": "New withdrawal requests",
    "withdrawal_decision": "Withdrawal status changes",
    "new_message": "New support messages",
}


def _cfg() -> dict:
    def pick(env: str, key: str) -> str:
        return (os.environ.get(env) or get_setting(key) or "").strip()

    return {
        "telegram_token": pick("TELEGRAM_BOT_TOKEN", "telegram_bot_token"),
        "telegram_chat": pick("TELEGRAM_ADMIN_CHAT_ID", "telegram_admin_chat_id"),
        "discord_webhook": pick("DISCORD_WEBHOOK_URL", "discord_webhook_url"),
        "app_name": (get_setting("app_name") or "Kudsi Shop").strip(),
    }


def configured() -> dict:
    cfg = _cfg()
    return {
        "telegram": bool(cfg["telegram_token"] and cfg["telegram_chat"]),
        "discord": bool(cfg["discord_webhook"]),
        "telegramTokenSet": bool(cfg["telegram_token"]),
        "telegramChatSet": bool(cfg["telegram_chat"]),
        "discordWebhookSet": bool(cfg["discord_webhook"]),
    }


def _post_json(url: str, payload: dict, timeout: int = 12) -> tuple[bool, str]:
    data = json.dumps(payload).encode()
    req = urllib.request.Request(
        url,
        data=data,
        headers={"Content-Type": "application/json", "User-Agent": "KudsiShop/1.0"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            body = resp.read().decode(errors="replace")
            return 200 <= resp.status < 300, body[:300]
    except urllib.error.HTTPError as exc:
        return False, f"HTTP {exc.code}: {exc.read().decode(errors='replace')[:200]}"
    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        return False, str(exc)[:200]


def telegram(text: str, chat_id: str | None = None) -> tuple[bool, str]:
    cfg = _cfg()
    if not cfg["telegram_token"]:
        return False, "Telegram bot token not configured"
    target = (chat_id or cfg["telegram_chat"]).strip()
    if not target:
        return False, "Telegram chat id not configured"
    return _post_json(
        f"https://api.telegram.org/bot{cfg['telegram_token']}/sendMessage",
        {
            "chat_id": target,
            "text": text[:4000],
            "parse_mode": "HTML",
            "disable_web_page_preview": True,
        },
    )


def discord(embed: dict) -> tuple[bool, str]:
    cfg = _cfg()
    if not cfg["discord_webhook"]:
        return False, "Discord webhook not configured"
    return _post_json(cfg["discord_webhook"], {"embeds": [embed]})


def _log(channel: str, event: str, ok: bool, detail: str = ""):
    try:
        execute(
            "INSERT INTO notification_log (channel, event, ok, detail) VALUES (?, ?, ?, ?)",
            (channel, event[:60], 1 if ok else 0, detail[:400]),
        )
    except Exception:  # noqa: BLE001 - logging must never break the caller
        pass


def _enabled(event: str) -> bool:
    key = f"notify_{event}"
    value = get_setting(key)
    return value is None or str(value) == "1"


def emit(
    event: str,
    title: str,
    lines: list[str] | None = None,
    *,
    amount: str | None = None,
    status: str | None = None,
    customer: str | None = None,
    url: str | None = None,
    color: int = 0x6C5CE7,
) -> dict:
    """Send one event to Telegram and Discord if that event is enabled."""
    result = {"telegram": None, "discord": None, "enabled": _enabled(event)}
    if not result["enabled"]:
        return result

    lines = [line for line in (lines or []) if line]
    cfg = _cfg()
    text_lines = [f"<b>{title}</b>"]
    for line in lines:
        text_lines.append(line)
    if url:
        text_lines.append(f'<a href="{url}">Open in the dashboard</a>')
    text = "\n".join(text_lines)

    if cfg["telegram_token"] and cfg["telegram_chat"]:
        ok, detail = telegram(text)
        _log("telegram", event, ok, detail)
        result["telegram"] = {"ok": ok, "detail": detail}

    if cfg["discord_webhook"]:
        embed = {
            "title": title[:240],
            "color": color,
            "description": "\n".join(lines)[:3800] or None,
            "footer": {"text": cfg["app_name"]},
        }
        fields = []
        if customer:
            fields.append({"name": "Customer", "value": customer[:200], "inline": True})
        if amount:
            fields.append({"name": "Amount", "value": amount[:80], "inline": True})
        if status:
            fields.append({"name": "Status", "value": status[:80], "inline": True})
        if fields:
            embed["fields"] = fields
        if url:
            embed["url"] = url
        ok, detail = discord(embed)
        _log("discord", event, ok, detail)
        result["discord"] = {"ok": ok, "detail": detail}

    return result


# ----------------------------------------------------------- in-app inbox
def customer_notify(
    user_id: int, kind: str, title: str, body: str = "", reference: str | None = None
):
    try:
        execute(
            "INSERT INTO notifications (user_id, type, title, body, reference) "
            "VALUES (?, ?, ?, ?, ?)",
            (user_id, kind[:40], title[:160], (body or "")[:600], reference),
        )
    except Exception:  # noqa: BLE001
        pass


def notifications_for(user_id: int, limit: int = 30) -> list[dict]:
    from db import fetch_all

    data = fetch_all(
        "SELECT * FROM notifications WHERE user_id = ? ORDER BY id DESC LIMIT ?",
        (user_id, max(1, min(limit, 100))),
    )
    return [
        {
            "id": r["id"],
            "type": r["type"],
            "title": r["title"],
            "body": r["body"],
            "reference": r["reference"],
            "read": bool(r["read_at"]),
            "createdAt": r["created_at"],
        }
        for r in data
    ]


def unread_notifications(user_id: int) -> int:
    row = fetch_one(
        "SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND read_at IS NULL",
        (user_id,),
    )
    return row["n"] if row else 0


def mark_notifications_read(user_id: int, notification_id: int | None = None):
    if notification_id:
        execute(
            "UPDATE notifications SET read_at = datetime('now') "
            "WHERE user_id = ? AND id = ? AND read_at IS NULL",
            (user_id, notification_id),
        )
    else:
        execute(
            "UPDATE notifications SET read_at = datetime('now') "
            "WHERE user_id = ? AND read_at IS NULL",
            (user_id,),
        )


# ------------------------------------------------------------- reset links
def send_reset_link(user: dict, url: str, channel: str) -> dict:
    """Send a reset link over Telegram or Discord.

    Telegram DMs require the customer to have started a chat with the bot, so
    the link always goes to the admin chat as well. Discord webhooks cannot open
    a DM either, so the link is posted to the configured channel.
    """
    cfg = _cfg()
    name = user.get("name") or user.get("email") or "customer"
    text = (
        f"<b>Password reset link</b>\n"
        f"Customer: {name} ({user.get('email', '')})\n"
        f"Link: {url}\n"
        "This link works once and expires automatically."
    )

    if channel == "telegram":
        if not cfg["telegram_token"]:
            return {"ok": False, "error": "Add your Telegram bot token in Settings first."}
        if not cfg["telegram_chat"]:
            return {"ok": False, "error": "Add your Telegram chat ID in Settings first."}
        ok, detail = telegram(text)
        _log("telegram", "password_reset", ok, detail)
        handle = (user.get("contact_type") == "telegram" and user.get("contact_handle")) or ""
        handle = str(handle).lstrip("@")
        if ok and handle.isdigit():  # a numeric handle is a real chat id
            dm_ok, dm_detail = telegram(text, chat_id=handle)
            _log("telegram-dm", "password_reset", dm_ok, dm_detail)
        return {"ok": ok, "detail": detail}

    if channel == "discord":
        if not cfg["discord_webhook"]:
            return {"ok": False, "error": "Add a Discord webhook URL in Settings first."}
        ok, detail = discord(
            {
                "title": "Password reset link",
                "color": 0x00D4A0,
                "description": f"Customer: **{name}** ({user.get('email', '')})\n{url}",
                "footer": {"text": cfg["app_name"]},
            }
        )
        _log("discord", "password_reset", ok, detail)
        return {"ok": ok, "detail": detail}

    return {"ok": False, "error": "Choose Telegram or Discord."}
