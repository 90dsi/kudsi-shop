"""Payment QR codes.

Crypto payments use the BIP21 URI scheme (`bitcoin:` / `litecoin:`) so a wallet
app that scans the code already knows the address and the exact amount. Other
chains get a plain-address code, which every wallet can still read.

Binance Pay does not have a wallet URI; the merchant API returns a checkout URL
that Binance's app opens directly, so that URL is what the QR encodes.
"""

from __future__ import annotations

from io import BytesIO
from urllib.parse import quote

import qrcode
import qrcode.image.svg

BIP21_SCHEMES = {"BTC": "bitcoin", "LTC": "litecoin"}


def payload(
    *,
    asset: str = "",
    address: str = "",
    amount: str = "",
    reference: str = "",
    label: str = "Kudsi Shop",
    checkout_url: str = "",
) -> str:
    """Return the text to encode, or "" when the payment has nothing to scan."""
    address = (address or "").strip()
    if address:
        scheme = BIP21_SCHEMES.get((asset or "").strip().upper())
        if not scheme:
            return address
        params = []
        if amount:
            params.append(f"amount={quote(str(amount), safe='.')}")
        if label:
            params.append(f"label={quote(label)}")
        if reference:
            params.append(f"message={quote(reference)}")
        query = f"?{'&'.join(params)}" if params else ""
        return f"{scheme}:{address}{query}"
    return (checkout_url or "").strip()


def order_payload(order: dict) -> str:
    return payload(
        asset=order.get("pay_asset") or "",
        address=order.get("pay_address") or "",
        amount=order.get("pay_amount") or "",
        reference=order.get("id") or "",
        checkout_url=order.get("checkout_url") or "",
    )


def topup_payload(topup: dict) -> str:
    address = (topup.get("pay_address") or "").strip()
    if address.startswith(("http://", "https://")):
        # Binance top-ups reuse pay_address for the checkout link.
        return address
    return payload(
        asset=topup.get("asset") or "",
        address=address,
        amount=topup.get("pay_amount") or "",
        reference=topup.get("id") or "",
    )


def svg(text: str, box_size: int = 10, border: int = 4) -> bytes:
    image = qrcode.make(
        text,
        image_factory=qrcode.image.svg.SvgPathImage,
        box_size=box_size,
        border=border,
    )
    buffer = BytesIO()
    image.save(buffer)
    return buffer.getvalue()
