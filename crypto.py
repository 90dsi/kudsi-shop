"""Direct crypto payments: amounts, USD rates and automatic on-chain verification.

Supported without any API key:
  BTC   -> Blockstream Esplora API
  LTC   -> Litecoinspace Esplora API
  USDT  -> TRON (TronGrid)
Everything else (ETH, USDT-ERC20) needs an ETHERSCAN_API_KEY.

Verification works by asking the explorer for transactions sent to the shop
address and matching the exact unique amount we quoted for that order. The
customer is asked to send the exact amount, which keeps concurrent orders apart
without needing a new address per order.
"""

import json
import os
import random
import time
import urllib.error
import urllib.request
from decimal import Decimal, InvalidOperation

DECIMALS = {"BTC": 8, "LTC": 8, "ETH": 8, "USDT": 6}
COINGECKO_IDS = {"BTC": "bitcoin", "LTC": "litecoin", "ETH": "ethereum", "USDT": "tether"}
USDT_TRC20_CONTRACT = "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t"
USDT_ERC20_CONTRACT = "0xdAC17F958D2ee523a2206206994597C13D831ec7"

_rate_cache: dict = {"ts": 0.0, "rates": {}}


class RateError(Exception):
    pass


# ------------------------------------------------------------------- helpers
def _http_json(url: str):
    request = urllib.request.Request(
        url, headers={"User-Agent": "KudsiShop/1.0", "Accept": "application/json"}
    )
    with urllib.request.urlopen(request, timeout=18) as response:
        return json.loads(response.read().decode() or "{}")


def _friendly(exc) -> str:
    if isinstance(exc, urllib.error.HTTPError):
        return f"Explorer returned HTTP {exc.code}."
    if isinstance(exc, urllib.error.URLError):
        return "Could not reach the blockchain explorer."
    return str(exc) or "Unknown error"


# --------------------------------------------------------------------- rates
def live_rates(assets) -> dict:
    now = time.time()
    if now - _rate_cache["ts"] < 300 and all(a in _rate_cache["rates"] for a in assets):
        return _rate_cache["rates"]

    ids = ",".join(sorted({COINGECKO_IDS[a] for a in assets if a in COINGECKO_IDS}))
    if not ids:
        return _rate_cache["rates"]
    try:
        url = f"https://api.coingecko.com/api/v3/simple/price?ids={ids}&vs_currencies=usd"
        data = _http_json(url)
        by_id = {v: k for k, v in COINGECKO_IDS.items()}
        rates = {by_id[k]: float(v["usd"]) for k, v in data.items() if k in by_id}
        _rate_cache["ts"] = now
        _rate_cache["rates"].update(rates)
    except Exception:  # noqa: BLE001 - fall back to the last known/manual rate
        pass
    return _rate_cache["rates"]


def asset_rate(asset: str, manual: float | None = None) -> float:
    if manual and manual > 0:
        return float(manual)
    rate = live_rates([asset]).get(asset)
    if not rate:
        raise RateError(
            f"No USD rate available for {asset}. Set a manual rate in Admin -> Payments."
        )
    return rate


# ------------------------------------------------------------------- amounts
def amount_for(total_cents: int, asset: str, manual_rate: float | None = None) -> str:
    """USD total -> asset amount, nudged by a few smallest units so it's unique."""
    rate = asset_rate(asset, manual_rate)
    decimals = DECIMALS.get(asset, 8)
    unit = Decimal(1).scaleb(-decimals)
    base = (Decimal(total_cents) / Decimal(100) / Decimal(str(rate))).quantize(
        unit, rounding="ROUND_UP"
    )
    offset = Decimal(random.randint(1, 900)) * unit
    amount = (base + offset).quantize(unit)
    return f"{amount:.{decimals}f}"


def to_units(amount: str, asset: str) -> int:
    decimals = DECIMALS.get(asset, 8)
    try:
        return int((Decimal(str(amount)) * (Decimal(10) ** decimals)).to_integral_value())
    except (InvalidOperation, ValueError):
        return 0


# ------------------------------------------------------------------ explorers
def _esplora_find(base: str, address: str, expected_units: int, used_txids: set):
    txs = _http_json(f"{base}/api/address/{address}/txs")
    for tx in txs or []:
        txid = tx.get("txid")
        if not txid or txid in used_txids:
            continue
        for output in tx.get("vout", []):
            if output.get("scriptpubkey_address") != address:
                continue
            if int(output.get("value", 0)) == expected_units:
                confirmed = bool(tx.get("status", {}).get("confirmed"))
                return {"paid": True, "txid": txid, "confirmed": confirmed}
    return {"paid": False}


def _check_btc(method, order, used_txids):
    return _esplora_find(
        "https://blockstream.info",
        method["address"],
        to_units(order["pay_amount"], "BTC"),
        used_txids,
    )


def _check_ltc(method, order, used_txids):
    return _esplora_find(
        "https://litecoinspace.org",
        method["address"],
        to_units(order["pay_amount"], "LTC"),
        used_txids,
    )


def _check_usdt_tron(method, order, used_txids):
    expected = to_units(order["pay_amount"], "USDT")
    url = (
        f"https://api.trongrid.io/v1/accounts/{method['address']}/transactions/trc20"
        f"?limit=100&only_to=true&contract_address={USDT_TRC20_CONTRACT}"
    )
    data = _http_json(url)
    for tx in data.get("data", []) or []:
        txid = tx.get("transaction_id")
        if not txid or txid in used_txids:
            continue
        if int(tx.get("value", 0)) == expected:
            return {"paid": True, "txid": txid, "confirmed": True}
    return {"paid": False}


def _check_etherscan(method, order, used_txids) -> dict:
    key = os.environ.get("ETHERSCAN_API_KEY", "").strip()
    if not key:
        return {
            "paid": False,
            "supported": False,
            "message": "Automatic checking for Ethereum needs ETHERSCAN_API_KEY in .env.",
        }

    asset = (order.get("pay_asset") or "").upper()
    if asset == "ETH":
        url = (
            "https://api.etherscan.io/api?module=account&action=txlist"
            f"&address={method['address']}&sort=desc&page=1&offset=40&apikey={key}"
        )
        expected = to_units(order["pay_amount"], "ETH") * 10**10  # wei (8 -> 18 decimals)
    else:
        url = (
            "https://api.etherscan.io/api?module=account&action=tokentx"
            f"&contractaddress={USDT_ERC20_CONTRACT}&address={method['address']}"
            f"&sort=desc&page=1&offset=40&apikey={key}"
        )
        expected = to_units(order["pay_amount"], "USDT")

    data = _http_json(url)
    for tx in data.get("result", []) or []:
        if not isinstance(tx, dict):
            continue
        txid = tx.get("hash")
        if not txid or txid in used_txids:
            continue
        if str(tx.get("to", "")).lower() != method["address"].lower():
            continue
        if int(tx.get("value", 0)) == expected:
            return {"paid": True, "txid": txid, "confirmed": int(tx.get("confirmations", 0)) > 0}
    return {"paid": False}


# ----------------------------------------------------------------- dispatcher
def check_payment(method: dict, order: dict, used_txids: set | None = None) -> dict:
    used_txids = used_txids or set()
    asset = (order.get("pay_asset") or method.get("asset") or "").upper()
    network = (method.get("network") or "").upper()

    try:
        if asset == "BTC":
            return _check_btc(method, order, used_txids)
        if asset == "LTC":
            return _check_ltc(method, order, used_txids)
        if asset == "USDT" and "TRON" in network:
            return _check_usdt_tron(method, order, used_txids)
        if asset in {"ETH", "USDT"}:
            return _check_etherscan(method, order, used_txids)
        return {"paid": False, "supported": False, "message": f"No verifier for {asset}."}
    except Exception as exc:  # noqa: BLE001 - network hiccups shouldn't break checkout
        return {"paid": False, "error": _friendly(exc)}
