"""Order fulfilment: generate codes once and show them on the site."""

from db import execute, fetch_all, fetch_one, new_code


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


def fulfil(order_id: str) -> dict:
    """Generate codes for a paid order. Delivery happens on the site, never by email."""
    order = fetch_one("SELECT status FROM orders WHERE id = ?", (order_id,))
    if not order or order["status"] != "paid":
        return {"codes": []}
    return {"codes": ensure_codes(order_id)}
