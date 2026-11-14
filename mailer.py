"""Email delivery.

Configure SMTP with env vars (see .env.example). With no SMTP settings the mail
is still composed and stored in the `outbox` table (status "skipped") so the admin
can read/copy the codes from the dashboard — nothing is lost in development.
"""

import os
import smtplib
import ssl
from email.message import EmailMessage
from email.utils import formataddr

from db import execute


def smtp_config() -> dict:
    return {
        "host": os.environ.get("SMTP_HOST", "").strip(),
        "port": int(os.environ.get("SMTP_PORT", "587") or 587),
        "user": os.environ.get("SMTP_USER", "").strip(),
        "password": os.environ.get("SMTP_PASSWORD", ""),
        "sender": os.environ.get("SMTP_FROM", "").strip(),
        "sender_name": os.environ.get("SMTP_FROM_NAME", "Kudsi Shop").strip(),
        "use_ssl": os.environ.get("SMTP_SSL", "0") == "1",
        "tls": os.environ.get("SMTP_TLS", "1") == "1",
    }


def configured() -> bool:
    cfg = smtp_config()
    return bool(cfg["host"] and cfg["sender"])


def _log(to_email: str, subject: str, body: str, status: str, error: str | None = None):
    execute(
        "INSERT INTO outbox (to_email, subject, body, status, error) VALUES (?, ?, ?, ?, ?)",
        (to_email, subject, body, status, error),
    )


def send(to_email: str, subject: str, text: str, html: str | None = None) -> dict:
    cfg = smtp_config()

    if not configured():
        _log(to_email, subject, text, "skipped", "SMTP not configured")
        print(f"[mail] SMTP not configured — email to {to_email} saved to outbox")
        return {"status": "skipped", "error": "SMTP not configured"}

    message = EmailMessage()
    message["Subject"] = subject
    message["From"] = formataddr((cfg["sender_name"], cfg["sender"]))
    message["To"] = to_email
    message.set_content(text)
    if html:
        message.add_alternative(html, subtype="html")

    try:
        if cfg["use_ssl"]:
            context = ssl.create_default_context()
            with smtplib.SMTP_SSL(cfg["host"], cfg["port"], timeout=25, context=context) as server:
                if cfg["user"]:
                    server.login(cfg["user"], cfg["password"])
                server.send_message(message)
        else:
            with smtplib.SMTP(cfg["host"], cfg["port"], timeout=25) as server:
                server.ehlo()
                if cfg["tls"]:
                    server.starttls(context=ssl.create_default_context())
                    server.ehlo()
                if cfg["user"]:
                    server.login(cfg["user"], cfg["password"])
                server.send_message(message)
    except Exception as exc:  # noqa: BLE001 - surface any SMTP error to the outbox
        _log(to_email, subject, text, "failed", str(exc)[:400])
        print(f"[mail] failed for {to_email}: {exc}")
        return {"status": "failed", "error": str(exc)}

    _log(to_email, subject, text, "sent")
    print(f"[mail] sent to {to_email}: {subject}")
    return {"status": "sent"}
