"""Payment providers.

Binance Pay (merchant API v3) is the default: it accepts crypto and is verified
automatically two ways —

  1. webhook  -> Binance calls POST /api/webhooks/binance, we verify the HMAC
                 signature and mark the order paid the moment funds land.
  2. polling  -> if a webhook is missed, GET /api/orders/<id>/verify asks Binance
                 for the real order status and syncs it.

Configure with env vars (see .env.example):
  BINANCE_PAY_API_KEY, BINANCE_PAY_SECRET, BINANCE_PAY_CERT_SN (optional),
  PAY_CURRENCY (default USDT), PUBLIC_BASE_URL (https URL of this site).

With no keys, the store runs in SANDBOX mode: orders can be paid with a
"simulate payment" button so you can test the whole flow before going live.
"""

import hashlib
import hmac
import json
import os
import secrets
import time
import urllib.error
import urllib.request
from decimal import Decimal

BINANCE_HOST = os.environ.get("BINANCE_PAY_HOST", "https://bpay.binanceapi.com")


class PaymentError(Exception):
    pass


# ------------------------------------------------------------------ config
def config() -> dict:
    key = os.environ.get("BINANCE_PAY_API_KEY", "").strip()
    secret = os.environ.get("BINANCE_PAY_SECRET", "").strip()
    return {
        "api_key": key,
        "secret": secret,
        "cert_sn": os.environ.get("BINANCE_PAY_CERT_SN", "").strip() or key,
        "currency": os.environ.get("PAY_CURRENCY", "USDT").strip().upper(),
        "base_url": os.environ.get("PUBLIC_BASE_URL", "http://localhost:3000").rstrip("/"),
        "binance_enabled": bool(key and secret),
        "sandbox": not (key and secret) and os.environ.get("PAYMENTS_ALLOW_SANDBOX", "1") == "1",
    }


def amount_for_cents(cents: int) -> str:
    return str((Decimal(cents) / Decimal(100)).quantize(Decimal("0.01")))


# ------------------------------------------------------------------ signing
def _sign(secret: str, timestamp: str, nonce: str, body: str) -> str:
    payload = f"{timestamp}\n{nonce}\n{body}\n"
    return hmac.new(secret.encode(), payload.encode(), hashlib.sha512).hexdigest().upper()


def _headers(cfg: dict, body: str) -> dict:
    ts = str(int(time.time() * 1000))
    nonce = secrets.token_hex(16)
    return {
        "content-type": "application/json",
        "BinancePay-Timestamp": ts,
        "BinancePay-Nonce": nonce,
        "BinancePay-Certificate-SN": cfg["cert_sn"],
        "BinancePay-Signature": _sign(cfg["secret"], ts, nonce, body),
    }


def _post(path: str, payload: dict) -> dict:
    cfg = config()
    body = json.dumps(payload, separators=(",", ":"), ensure_ascii=False)
    req = urllib.request.Request(
        BINANCE_HOST + path,
        data=body.encode(),
        headers=_headers(cfg, body),
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=20) as resp:
            data = json.loads(resp.read().decode() or "{}")
    except urllib.error.HTTPError as e:
        detail = e.read().decode(errors="replace")[:300]
        raise PaymentError(f"Binance Pay rejected the request ({e.code}): {detail}") from e
    except (urllib.error.URLError, TimeoutError) as e:
        raise PaymentError("Could not reach Binance Pay. Check your connection and try again.") from e
    except json.JSONDecodeError as e:
        raise PaymentError("Unexpected response from Binance Pay.") from e

    if str(data.get("status", "")).upper() != "SUCCESS":
        raise PaymentError(data.get("errorMessage") or data.get("code") or "Binance Pay error")
    return data.get("data") or {}


# -------------------------------------------------------------- create order
def create_binance_order(order: dict, items: list[dict]) -> dict:
    cfg = config()
    if not cfg["binance_enabled"]:
        raise PaymentError("Binance Pay is not configured.")

    payload = {
        "env": {"terminalType": "WEB"},
        "orderAmount": amount_for_cents(order["total_cents"]),
        "currency": cfg["currency"],
        "goods": {
            "goodsType": "01",
            "goodsCategory": "Z000",
            "referenceGoodsId": order["id"],
            "goodsName": "Digital gift cards",
            "goodsDetail": ", ".join(f"{i['name']} x{i['qty']}" for i in items)[:240],
        },
        "merchantTradeNo": order["id"],
        "webhookUrl": f"{cfg['base_url']}/api/webhooks/binance",
        "returnUrl": f"{cfg['base_url']}/order.html?id={order['id']}",
        "cancelUrl": f"{cfg['base_url']}/order.html?id={order['id']}&cancelled=1",
    }
    data = _post("/binancepay/openapi/v3/order", payload)
    return {
        "prepay_id": data.get("prepayId"),
        "checkout_url": data.get("checkoutUrl") or data.get("universalUrl"),
        "deeplink": data.get("deeplink"),
        "expire_time": data.get("expireTime"),
    }


# ---------------------------------------------------------------- verify/query
def query_binance_order(merchant_trade_no: str) -> dict:
    return _post("/binancepay/openapi/v3/order/query", {"merchantTradeNo": merchant_trade_no})


def verify_webhook(timestamp: str, nonce: str, signature: str, raw_body: bytes) -> bool:
    cfg = config()
    if not cfg["binance_enabled"] or not (timestamp and nonce and signature):
        return False
    expected = _sign(cfg["secret"], timestamp, nonce, raw_body.decode())
    return hmac.compare_digest(expected, signature.upper())


def webhook_is_paid(payload: dict) -> tuple[bool, str]:
    """Return (is_paid, merchant_trade_no) from a webhook body."""
    biz_type = str(payload.get("bizType", "")).upper()
    biz_status = str(payload.get("bizStatus", "")).upper()
    data = payload.get("data")
    if isinstance(data, str):
        try:
            data = json.loads(data or "{}")
        except json.JSONDecodeError:
            data = {}
    data = data or {}
    trade_no = data.get("merchantTradeNo") or payload.get("merchantTradeNo") or ""
    paid = biz_type == "PAY" and biz_status in {"PAY_SUCCESS", "PAID", "SUCCESS"}
    return paid, trade_no
