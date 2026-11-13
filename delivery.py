"""Order fulfilment: generate codes, email them, keep everything idempotent."""

import html
import os

import mailer
from db import execute, fetch_all, fetch_one, get_setting, new_code


def site_url() -> str:
    return os.environ.get("PUBLIC_BASE_URL", "http://localhost:3000").rstrip("/")


def order_codes(order_id: str) -> list[dict]:
    return fetch_all(
        """SELECT c.code, c.product_id, c.variant, i.name
           FROM order_codes c LEFT JOIN order_items i
             ON i.order_id = c.order_id AND i.product_id = c.product_id
            AND IFNULL(i.variant, '') = IFNULL(c.variant, '')
           WHERE c.order_id = ? ORDER BY c.id""",
        (order_id,),
    )


def code_label(code: dict) -> str:
    """Product name plus the chosen duration, for every place a code is shown."""
    name = code.get("name") or code.get("product_id") or ""
    variant = code.get("variant")
    return f"{name} — {variant}" if variant else name


def ensure_codes(order_id: str) -> list[dict]:
    """Create one code per purchased unit. Safe to call more than once."""
    existing = order_codes(order_id)
    if existing:
        return existing

    items = fetch_all("SELECT * FROM order_items WHERE order_id = ? ORDER BY id", (order_id,))
    for item in items:
        for _ in range(int(item["qty"])):
            execute(
                "INSERT INTO order_codes (order_id, product_id, variant, code) VALUES (?, ?, ?, ?)",
                (order_id, item["product_id"], item.get("variant"), new_code()),
            )
    return order_codes(order_id)


def _codes_text(codes: list[dict]) -> str:
    return "\n".join(f"  {c['code']}   ({code_label(c)})" for c in codes)


def _codes_html(codes: list[dict], order_id: str, total: str, note: str) -> str:
    rows = "".join(
        f"<tr><td style='padding:8px 12px;border-bottom:1px solid #262c3b;font-family:Consolas,monospace;"
        f"color:#5df0c4;font-size:15px'>{html.escape(c['code'])}</td>"
        f"<td style='padding:8px 12px;border-bottom:1px solid #262c3b;color:#9aa4b8;font-size:14px'>"
        f"{html.escape(code_label(c))}</td></tr>"
        for c in codes
    )
    return f"""<!DOCTYPE html>
<html><body style="margin:0;background:#0b0d12;padding:28px;font-family:Inter,Arial,sans-serif;color:#eef1f7">
  <div style="max-width:560px;margin:auto;background:#11141c;border:1px solid #262c3b;border-radius:14px;padding:24px">
    <h2 style="margin:0 0 6px;font-size:20px">Your codes are ready</h2>
    <p style="color:#9aa4b8;font-size:14px;margin:0 0 18px">
      Order <strong style="color:#eef1f7">{html.escape(order_id)}</strong> · {html.escape(total)}
    </p>
    <table style="width:100%;border-collapse:collapse;background:#161a24;border-radius:10px;overflow:hidden">
      {rows}
    </table>
    <p style="color:#9aa4b8;font-size:13px;margin-top:18px">{html.escape(note)}</p>
    <p style="font-size:13px;margin-top:18px">
      <a href="{site_url()}/order.html?id={html.escape(order_id)}" style="color:#5df0c4">View this order →</a>
    </p>
  </div>
</body></html>"""


def fulfil(order_id: str) -> dict:
    """Generate codes for a paid order and email them once."""
    order = fetch_one("SELECT * FROM orders WHERE id = ?", (order_id,))
    if not order or order["status"] != "paid":
        return {"codes": [], "email": None}

    codes = ensure_codes(order_id)
    if order["emailed_at"]:
        return {"codes": codes, "email": None}

    note = get_setting("delivery_note") or ""
    contact = f"Telegram/Discord: {order['contact_handle']}\n" if order["contact_handle"] else ""
    total = f"${order['total_cents'] / 100:.2f}"

    text = (
        f"Thanks for your order at Kudsi Shop!\n\n"
        f"Order: {order_id}\n"
        f"Total: {total}\n{contact}\n"
        f"Your codes:\n{_codes_text(codes)}\n\n"
        f"{note}\n\n"
        f"Order page: {site_url()}/order.html?id={order_id}\n"
        f"Questions? Reply to this email or message us on the site."
    )

    result = mailer.send(
        order["email"],
        f"Your Kudsi Shop codes — order {order_id}",
        text,
        _codes_html(codes, order_id, total, note),
    )
    execute("UPDATE orders SET emailed_at = datetime('now') WHERE id = ?", (order_id,))
    return {"codes": codes, "email": result}
