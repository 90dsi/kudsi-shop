"""Customer wallet: balances, top-ups, withdrawals and the transaction ledger.

Money is always handled in integer cents. Nothing here trusts a number that
came from the browser: every amount is re-validated against the database and
every balance change is written inside a BEGIN IMMEDIATE transaction, so two
requests can never spend the same dollar twice.

The rules:

* `wallet_transactions` is append-only. There is no update or delete path.
* A withdrawal reserves the money the moment it is requested (a debit). If it
  is rejected, the exact amount is credited back with kind
  ``withdrawal_refund``. Completing it only changes the request status.
* (kind, reference) is unique, so approving the same top-up twice cannot pay
  twice — the second insert is a no-op.
"""

from __future__ import annotations

import secrets
import sqlite3
from datetime import datetime, timedelta, timezone

from db import execute, fetch_all, fetch_one, get_setting, money_db, set_setting

WITHDRAWAL_STATUSES = ("pending", "approved", "processing", "completed", "rejected")
TOPUP_STATUSES = ("pending", "approved", "rejected", "expired")

KIND_LABELS = {
    "topup": "Top-up",
    "withdrawal": "Withdrawal",
    "withdrawal_refund": "Withdrawal refund",
    "purchase": "Purchase",
    "adjustment": "Adjustment",
    "bonus": "Bonus",
}


class WalletError(Exception):
    """Raised for anything the customer/admin did wrong. Safe to show."""


class InsufficientFunds(WalletError):
    pass


# ------------------------------------------------------------------- settings
def money_settings() -> dict:
    """Financial settings resolved once per call (all admin editable)."""
    try:
        minimum = int(get_setting("min_withdraw_cents") or 200)
    except (TypeError, ValueError):
        minimum = 200
    try:
        min_topup = int(get_setting("min_topup_cents") or 500)
    except (TypeError, ValueError):
        min_topup = 500
    symbol = (get_setting("currency_symbol") or "$").strip()[:4] or "$"
    return {
        "currency": (get_setting("currency") or "USD").strip().upper()[:8] or "USD",
        "symbol": symbol,
        "minWithdrawCents": max(1, minimum),
        "minTopupCents": max(1, min_topup),
        "manualApproval": str(get_setting("manual_topup_approval") or "1") == "1",
    }


def fmt(cents: int, symbol: str | None = None) -> str:
    symbol = symbol if symbol is not None else money_settings()["symbol"]
    return f"{symbol}{int(cents or 0) / 100:,.2f}"


def to_cents(value, *, field: str = "Amount") -> int:
    """Parse a user-supplied amount into cents. Accepts 10, "10", "10.50"."""
    if isinstance(value, bool) or value in (None, ""):
        raise WalletError(f"{field} is required.")
    try:
        amount = round(float(str(value).replace(",", "").strip()) * 100)
    except (TypeError, ValueError):
        raise WalletError(f"{field} must be a number.") from None
    if amount <= 0:
        raise WalletError(f"{field} must be greater than 0.")
    if amount > 100_000_000:
        raise WalletError(f"{field} is too large.")
    return amount


# --------------------------------------------------------------------- ledger
def _insert_tx(
    con,
    user_id: int,
    kind: str,
    direction: str,
    cents: int,
    before: int,
    after: int,
    reference: str | None,
    note: str | None,
    status: str,
):
    con.execute(
        """INSERT INTO wallet_transactions
           (user_id, kind, direction, amount_cents, balance_before_cents,
            balance_after_cents, status, reference, note)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)""",
        (user_id, kind, direction, cents, before, after, status, reference, note),
    )


def record(
    con,
    user_id: int,
    kind: str,
    direction: str,
    cents: int,
    *,
    reference: str | None = None,
    note: str | None = None,
    status: str = "completed",
    count_deposit: bool = False,
    count_withdrawal: bool = False,
) -> dict | None:
    """Append a ledger row and move the balance. Must run inside money_db().

    Returns None when this reference was already recorded (idempotent replay).
    """
    if cents <= 0:
        raise WalletError("Amount must be greater than zero.")
    if direction not in {"credit", "debit"}:
        raise WalletError("Invalid direction.")
    if kind not in KIND_LABELS:
        raise WalletError("Invalid transaction type.")

    row = con.execute("SELECT balance_cents FROM users WHERE id = ?", (user_id,)).fetchone()
    if not row:
        raise WalletError("Customer not found.")

    if reference:
        seen = con.execute(
            "SELECT id FROM wallet_transactions WHERE kind = ? AND reference = ?",
            (kind, reference),
        ).fetchone()
        if seen:
            return None

    before = int(row["balance_cents"])
    after = before + cents if direction == "credit" else before - cents
    if after < 0:
        raise InsufficientFunds("Not enough available balance.")

    cur = con.execute(
        "UPDATE users SET balance_cents = ? WHERE id = ? AND balance_cents = ?",
        (after, user_id, before),
    )
    if cur.rowcount == 0:  # pragma: no cover - defensive, BEGIN IMMEDIATE serialises
        raise WalletError("Balance changed at the same moment. Please try again.")

    if count_deposit:
        con.execute(
            "UPDATE users SET deposited_cents = deposited_cents + ? WHERE id = ?",
            (cents, user_id),
        )
    if count_withdrawal:
        con.execute(
            "UPDATE users SET withdrawn_cents = withdrawn_cents + ? WHERE id = ?",
            (cents, user_id),
        )

    try:
        _insert_tx(con, user_id, kind, direction, cents, before, after, reference, note, status)
    except sqlite3.IntegrityError:  # unique(kind, reference) lost a race
        return None

    return {
        "userId": user_id,
        "kind": kind,
        "direction": direction,
        "amountCents": cents,
        "balanceBeforeCents": before,
        "balanceAfterCents": after,
        "reference": reference,
        "status": status,
    }


def credit(user_id: int, cents: int, kind: str, reference: str | None, note: str | None = None):
    with money_db() as con:
        return record(
            con,
            user_id,
            kind,
            "credit",
            cents,
            reference=reference,
            note=note,
            count_deposit=(kind == "topup"),
        )


def summary(user_id: int) -> dict:
    row = fetch_one(
        """SELECT u.balance_cents, u.deposited_cents, u.withdrawn_cents,
                  (SELECT COUNT(*) FROM wallet_transactions t WHERE t.user_id = u.id) AS tx_count,
                  (SELECT COUNT(*) FROM withdrawals w WHERE w.user_id = u.id
                     AND w.status IN ('pending', 'approved', 'processing')) AS pending_withdrawals,
                  (SELECT COUNT(*) FROM topups tp WHERE tp.user_id = u.id
                     AND tp.status = 'pending') AS pending_topups
           FROM users u WHERE u.id = ?""",
        (user_id,),
    )
    if not row:
        raise WalletError("Customer not found.")
    cfg = money_settings()
    return {
        "balance": round(row["balance_cents"] / 100, 2),
        "balanceCents": row["balance_cents"],
        "deposited": round(row["deposited_cents"] / 100, 2),
        "depositedCents": row["deposited_cents"],
        "withdrawn": round(row["withdrawn_cents"] / 100, 2),
        "withdrawnCents": row["withdrawn_cents"],
        "transactions": row["tx_count"],
        "pendingWithdrawals": row["pending_withdrawals"],
        "pendingTopups": row["pending_topups"],
        "currency": cfg["currency"],
        "symbol": cfg["symbol"],
        "minWithdrawCents": cfg["minWithdrawCents"],
        "minTopupCents": cfg["minTopupCents"],
    }


def tx_json(row: dict) -> dict:
    cfg = money_settings()
    is_credit = row["direction"] == "credit"
    return {
        "id": row["id"],
        "kind": row["kind"],
        "label": KIND_LABELS.get(row["kind"], row["kind"]),
        "direction": row["direction"],
        "amount": round(row["amount_cents"] / 100, 2),
        "amountCents": row["amount_cents"],
        "signed": (1 if is_credit else -1) * round(row["amount_cents"] / 100, 2),
        "balanceBefore": round(row["balance_before_cents"] / 100, 2),
        "balanceAfter": round(row["balance_after_cents"] / 100, 2),
        "status": row["status"],
        "reference": row["reference"],
        "note": row["note"],
        "createdAt": row["created_at"],
        "symbol": cfg["symbol"],
    }


def transactions(user_id: int, limit: int = 50, offset: int = 0, kinds: tuple | None = None):
    limit = max(1, min(int(limit or 50), 200))
    offset = max(0, int(offset or 0))
    where, params = ["user_id = ?"], [user_id]
    if kinds:
        where.append(f"kind IN ({','.join('?' * len(kinds))})")
        params.extend(kinds)
    rows = fetch_all(
        f"SELECT * FROM wallet_transactions WHERE {' AND '.join(where)} "
        "ORDER BY id DESC LIMIT ? OFFSET ?",
        (*params, limit, offset),
    )
    total = fetch_one(
        f"SELECT COUNT(*) AS n FROM wallet_transactions WHERE {' AND '.join(where)}",
        tuple(params),
    )["n"]
    return [tx_json(r) for r in rows], total


def daily_series(user_id: int | None = None, days: int = 14) -> list[dict]:
    """Deposits vs withdrawals per day, for the dashboard charts."""
    start = (datetime.now(timezone.utc) - timedelta(days=days - 1)).strftime("%Y-%m-%d")
    params: list = [start]
    user_clause = ""
    if user_id:
        user_clause = " AND t.user_id = ?"
        params.append(user_id)
    rows = fetch_all(
        f"""SELECT substr(t.created_at, 1, 10) AS day,
                   SUM(CASE WHEN t.kind = 'topup' AND t.direction = 'credit'
                            THEN t.amount_cents ELSE 0 END) AS deposits,
                   SUM(CASE WHEN t.kind = 'withdrawal' AND t.direction = 'debit'
                            THEN t.amount_cents ELSE 0 END) AS withdrawals
            FROM wallet_transactions t
            WHERE substr(t.created_at, 1, 10) >= ?{user_clause}
            GROUP BY day ORDER BY day""",
        tuple(params),
    )
    by_day = {r["day"]: r for r in rows}
    out = []
    today = datetime.now(timezone.utc).date()
    for offset in range(days - 1, -1, -1):
        day = today - timedelta(days=offset)
        key = day.strftime("%Y-%m-%d")
        row = by_day.get(key, {"deposits": 0, "withdrawals": 0})
        out.append(
            {
                "date": key,
                "label": day.strftime("%d %b"),
                "deposits": round((row["deposits"] or 0) / 100, 2),
                "withdrawals": round((row["withdrawals"] or 0) / 100, 2),
            }
        )
    return out


# --------------------------------------------------------------------- top-ups
def topup_json(row: dict) -> dict:
    symbol = money_settings()["symbol"]
    return {
        "id": row["id"],
        "userId": row["user_id"],
        "customer": row.get("customer_name") or row.get("customer_email") or "",
        "email": row.get("customer_email") or "",
        "amount": round(row["amount_cents"] / 100, 2),
        "amountCents": row["amount_cents"],
        "symbol": symbol,
        "method": row["method"],
        "asset": row["asset"],
        "network": row["network"],
        "address": row["pay_address"],
        "payAmount": row["pay_amount"],
        "txid": row["txid"],
        "hasProof": bool(row.get("proof")),
        "status": row["status"],
        "reference": row["reference"],
        "customerNote": row["customer_note"],
        "adminNote": row["admin_note"],
        "createdAt": row["created_at"],
        "decidedAt": row["decided_at"],
    }


def create_topup(user_id: int, cents: int, method_id: str | None, note: str | None) -> dict:
    cfg = money_settings()
    if cents < cfg["minTopupCents"]:
        raise WalletError(
            f"Minimum top-up is {fmt(cfg['minTopupCents'], cfg['symbol'])}."
        )
    topup_id = "TP" + secrets.token_hex(4).upper()
    execute(
        """INSERT INTO topups (id, user_id, amount_cents, method, customer_note)
           VALUES (?, ?, ?, ?, ?)""",
        (topup_id, user_id, cents, (method_id or "manual")[:40], note),
    )
    return topup_json(fetch_one("SELECT * FROM topups WHERE id = ?", (topup_id,)))


def list_topups(status: str | None = None, query: str = "", limit: int = 100) -> list[dict]:
    where, params = ["1 = 1"], []
    if status in TOPUP_STATUSES:
        where.append("tp.status = ?")
        params.append(status)
    if query:
        like = f"%{query}%"
        where.append("(tp.id LIKE ? OR u.email LIKE ? OR u.name LIKE ? OR CAST(u.id AS TEXT) = ?)")
        params += [like, like, like, query]
    rows = fetch_all(
        f"""SELECT tp.*, u.email AS customer_email, u.name AS customer_name
            FROM topups tp JOIN users u ON u.id = tp.user_id
            WHERE {' AND '.join(where)}
            ORDER BY tp.created_at DESC, tp.id DESC LIMIT ?""",
        (*params, max(1, min(limit, 300))),
    )
    return [topup_json(r) for r in rows]


def decide_topup(topup_id: str, approve: bool, admin_id: int, note: str | None = None) -> dict:
    with money_db() as con:
        row = con.execute("SELECT * FROM topups WHERE id = ?", (topup_id,)).fetchone()
        if not row:
            raise WalletError("Top-up not found.")
        if row["status"] != "pending":
            raise WalletError(f"This top-up is already {row['status']}.")

        new_status = "approved" if approve else "rejected"
        cur = con.execute(
            "UPDATE topups SET status = ?, decided_by = ?, decided_at = datetime('now'), "
            "admin_note = COALESCE(?, admin_note) WHERE id = ? AND status = 'pending'",
            (new_status, admin_id, note, topup_id),
        )
        if cur.rowcount == 0:
            raise WalletError("This top-up was just handled by someone else.")

        if approve:
            result = record(
                con,
                row["user_id"],
                "topup",
                "credit",
                int(row["amount_cents"]),
                reference=topup_id,
                note=note or "Top-up approved",
                count_deposit=True,
            )
            if result is None:
                # Ledger already has this top-up: nothing to pay, but the status
                # change above is still correct.
                pass
    return topup_json(fetch_one("SELECT * FROM topups WHERE id = ?", (topup_id,)))


# ----------------------------------------------------------------- withdrawals
def withdrawal_json(row: dict) -> dict:
    symbol = money_settings()["symbol"]
    return {
        "id": row["id"],
        "userId": row["user_id"],
        "customer": row.get("customer_name") or "",
        "email": row.get("customer_email") or "",
        "amount": round(row["amount_cents"] / 100, 2),
        "amountCents": row["amount_cents"],
        "symbol": symbol,
        "method": row["method"],
        "methodLabel": row.get("method_label") or row["method"],
        "details": row["details"],
        "status": row["status"],
        "adminNote": row["admin_note"],
        "createdAt": row["created_at"],
        "updatedAt": row["updated_at"],
        "decidedAt": row["decided_at"],
        "balance": round(row["balance_cents"] / 100, 2) if row.get("balance_cents") is not None else None,
    }


def request_withdrawal(user_id: int, cents: int, method_id: str, details: str) -> dict:
    cfg = money_settings()
    if cents < cfg["minWithdrawCents"]:
        raise WalletError(
            f"Minimum withdrawal is {fmt(cfg['minWithdrawCents'], cfg['symbol'])}."
        )
    method = fetch_one(
        "SELECT * FROM withdrawal_methods WHERE id = ? AND enabled = 1", (method_id,)
    )
    if not method:
        raise WalletError("Choose a withdrawal method.")
    details = (details or "").strip()
    if len(details) < 4:
        raise WalletError(f"Add your {method['details_label'].lower()} so we can pay you.")
    if len(details) > 400:
        raise WalletError("Those details are too long.")

    withdrawal_id = "WD" + secrets.token_hex(4).upper()
    with money_db() as con:
        user = con.execute(
            "SELECT id, balance_cents, status FROM users WHERE id = ?", (user_id,)
        ).fetchone()
        if not user:
            raise WalletError("Customer not found.")
        if user["status"] != "active":
            raise WalletError("This account is suspended.")
        if _recent_duplicate(con, user_id, cents, method["id"]):
            raise WalletError(
                "You just requested this exact withdrawal. Wait a moment before trying again."
            )

        result = record(
            con,
            user_id,
            "withdrawal",
            "debit",
            cents,
            reference=withdrawal_id,
            note=f"Withdrawal via {method['label']}",
            status="pending",
        )
        if result is None:
            raise WalletError("This withdrawal was already recorded.")

        con.execute(
            """INSERT INTO withdrawals (id, user_id, amount_cents, method, details)
               VALUES (?, ?, ?, ?, ?)""",
            (withdrawal_id, user_id, cents, method["id"], details),
        )
    return withdrawal_json(
        fetch_one(
            """SELECT w.*, u.balance_cents, u.email AS customer_email, u.name AS customer_name,
                      (SELECT label FROM withdrawal_methods m WHERE m.id = w.method) AS method_label
               FROM withdrawals w JOIN users u ON u.id = w.user_id WHERE w.id = ?""",
            (withdrawal_id,),
        )
    )


def _recent_duplicate(con, user_id: int, cents: int, method_id: str) -> bool:
    """Block accidental double-submits (same amount + method within a minute).

    A rejected or completed request must not block a legitimate retry.
    """
    row = con.execute(
        "SELECT amount_cents, method, status, created_at FROM withdrawals "
        "WHERE user_id = ? ORDER BY id DESC LIMIT 1",
        (user_id,),
    ).fetchone()
    if not row:
        return False
    if row["status"] not in ("pending", "approved", "processing"):
        return False
    if int(row["amount_cents"]) != cents or row["method"] != method_id:
        return False
    try:
        created = datetime.fromisoformat(row["created_at"]).replace(tzinfo=timezone.utc)
    except ValueError:
        return False
    return (datetime.now(timezone.utc) - created).total_seconds() < 60


def list_withdrawals(
    status: str | None = None, query: str = "", limit: int = 100, user_id: int | None = None
) -> list[dict]:
    where, params = ["1 = 1"], []
    if status in WITHDRAWAL_STATUSES:
        where.append("w.status = ?")
        params.append(status)
    if user_id:
        where.append("w.user_id = ?")
        params.append(user_id)
    if query:
        like = f"%{query}%"
        where.append(
            "(w.id LIKE ? OR u.email LIKE ? OR u.name LIKE ? OR CAST(u.id AS TEXT) = ?)"
        )
        params += [like, like, like, query]
    rows = fetch_all(
        f"""SELECT w.*, u.balance_cents, u.email AS customer_email, u.name AS customer_name,
                   (SELECT label FROM withdrawal_methods m WHERE m.id = w.method) AS method_label
            FROM withdrawals w JOIN users u ON u.id = w.user_id
            WHERE {' AND '.join(where)}
            ORDER BY w.created_at DESC, w.id DESC LIMIT ?""",
        (*params, max(1, min(limit, 300))),
    )
    return [withdrawal_json(r) for r in rows]


def set_withdrawal_status(
    withdrawal_id: str, status: str, admin_id: int, note: str | None = None
) -> dict:
    """Move a request through the pipeline. Rejecting returns the reserved money."""
    if status not in WITHDRAWAL_STATUSES:
        raise WalletError("Unknown withdrawal status.")

    with money_db() as con:
        row = con.execute("SELECT * FROM withdrawals WHERE id = ?", (withdrawal_id,)).fetchone()
        if not row:
            raise WalletError("Withdrawal not found.")
        current = row["status"]
        if current == status:
            return withdrawal_json(
                fetch_one(
                    """SELECT w.*, u.balance_cents, u.email AS customer_email,
                              u.name AS customer_name,
                              (SELECT label FROM withdrawal_methods m WHERE m.id = w.method) AS method_label
                       FROM withdrawals w JOIN users u ON u.id = w.user_id WHERE w.id = ?""",
                    (withdrawal_id,),
                )
            )
        if current == "rejected":
            raise WalletError("This withdrawal was already rejected.")
        if current == "completed":
            raise WalletError("This withdrawal is already completed.")
        if status == "pending":
            raise WalletError("A withdrawal cannot go back to pending.")

        cur = con.execute(
            "UPDATE withdrawals SET status = ?, admin_note = COALESCE(?, admin_note), "
            "decided_by = ?, decided_at = datetime('now'), updated_at = datetime('now') "
            "WHERE id = ? AND status = ?",
            (status, note, admin_id, withdrawal_id, current),
        )
        if cur.rowcount == 0:
            raise WalletError("This withdrawal was just updated by someone else.")

        # Keep the ledger entry in sync so the customer sees the real state.
        con.execute(
            "UPDATE wallet_transactions SET status = ? WHERE kind = 'withdrawal' AND reference = ?",
            (status, withdrawal_id),
        )

        if status == "rejected":
            record(
                con,
                row["user_id"],
                "withdrawal_refund",
                "credit",
                int(row["amount_cents"]),
                reference=withdrawal_id,
                note=note or "Withdrawal rejected — funds returned",
            )
        if status == "completed":
            con.execute(
                "UPDATE users SET withdrawn_cents = withdrawn_cents + ? WHERE id = ?",
                (int(row["amount_cents"]), row["user_id"]),
            )

    return withdrawal_json(
        fetch_one(
            """SELECT w.*, u.balance_cents, u.email AS customer_email, u.name AS customer_name,
                      (SELECT label FROM withdrawal_methods m WHERE m.id = w.method) AS method_label
               FROM withdrawals w JOIN users u ON u.id = w.user_id WHERE w.id = ?""",
            (withdrawal_id,),
        )
    )


# -------------------------------------------------------------------- methods
def withdrawal_methods(public: bool = True) -> list[dict]:
    where = "WHERE enabled = 1" if public else ""
    rows = fetch_all(
        f"SELECT * FROM withdrawal_methods {where} ORDER BY sort_order, label"
    )
    cfg = money_settings()
    return [
        {
            "id": r["id"],
            "label": r["label"],
            "detailsLabel": r["details_label"],
            "instructions": r["instructions"],
            "enabled": bool(r["enabled"]),
            "sortOrder": r["sort_order"],
            "minWithdrawCents": cfg["minWithdrawCents"],
        }
        for r in rows
    ]


def save_withdrawal_method(data: dict) -> dict:
    mid = (data.get("id") or "").strip().lower()[:40]
    mid = "".join(ch for ch in mid if ch.isalnum() or ch in "-_")
    label = (data.get("label") or "").strip()[:60]
    if not label:
        raise WalletError("Give the method a name.")
    if not mid:
        mid = "".join(ch for ch in label.lower().replace(" ", "-") if ch.isalnum() or ch in "-_")[:40]
    if not mid:
        raise WalletError("Give the method an id.")

    details_label = (data.get("detailsLabel") or "Account details").strip()[:80]
    instructions = (data.get("instructions") or "").strip()[:400] or None
    enabled = 1 if data.get("enabled", True) else 0
    try:
        sort_order = int(data.get("sortOrder") or 0)
    except (TypeError, ValueError):
        sort_order = 100
    if not sort_order:
        last = fetch_one("SELECT COALESCE(MAX(sort_order), 0) AS m FROM withdrawal_methods")
        sort_order = int(last["m"]) + 10

    existing = fetch_one("SELECT id FROM withdrawal_methods WHERE id = ?", (mid,))
    if existing:
        execute(
            "UPDATE withdrawal_methods SET label = ?, details_label = ?, instructions = ?, "
            "enabled = ?, sort_order = ? WHERE id = ?",
            (label, details_label, instructions, enabled, sort_order, mid),
        )
    else:
        execute(
            "INSERT INTO withdrawal_methods (id, label, details_label, instructions, enabled, sort_order) "
            "VALUES (?, ?, ?, ?, ?, ?)",
            (mid, label, details_label, instructions, enabled, sort_order),
        )
    return next((m for m in withdrawal_methods(public=False) if m["id"] == mid), {})


# ---------------------------------------------------------------- admin stats
def admin_overview() -> dict:
    cfg = money_settings()
    balances = fetch_one(
        "SELECT COALESCE(SUM(balance_cents), 0) AS total, COUNT(*) AS n FROM users WHERE role = 'customer'"
    )
    deposits = fetch_one("SELECT COALESCE(SUM(amount_cents), 0) AS c FROM topups WHERE status = 'approved'")
    withdrawals = fetch_one("SELECT COALESCE(SUM(amount_cents), 0) AS c FROM withdrawals WHERE status = 'completed'")
    pending_w = fetch_one("SELECT COUNT(*) AS n, COALESCE(SUM(amount_cents), 0) AS c FROM withdrawals WHERE status = 'pending'")
    pending_t = fetch_one("SELECT COUNT(*) AS n, COALESCE(SUM(amount_cents), 0) AS c FROM topups WHERE status = 'pending'")
    customers = fetch_one("SELECT COUNT(*) AS n FROM users WHERE role = 'customer'")["n"]
    suspended = fetch_one("SELECT COUNT(*) AS n FROM users WHERE status = 'suspended'")["n"]
    return {
        "customers": customers,
        "suspended": suspended,
        "totalBalance": round(balances["total"] / 100, 2),
        "totalDeposits": round(deposits["c"] / 100, 2),
        "totalWithdrawals": round(withdrawals["c"] / 100, 2),
        "pendingWithdrawals": pending_w["n"],
        "pendingWithdrawalsAmount": round(pending_w["c"] / 100, 2),
        "pendingTopups": pending_t["n"],
        "pendingTopupsAmount": round(pending_t["c"] / 100, 2),
        "series": daily_series(days=14),
        "currency": cfg["currency"],
        "symbol": cfg["symbol"],
        "minWithdrawCents": cfg["minWithdrawCents"],
    }


def recent_transactions(limit: int = 12) -> list[dict]:
    rows = fetch_all(
        """SELECT t.*, u.email, u.name FROM wallet_transactions t
           JOIN users u ON u.id = t.user_id ORDER BY t.id DESC LIMIT ?""",
        (max(1, min(limit, 100)),),
    )
    out = []
    for row in rows:
        item = tx_json(row)
        item["customer"] = row["name"] or row["email"]
        item["email"] = row["email"]
        out.append(item)
    return out


def log_notification(channel: str, event: str, ok: bool, detail: str = ""):
    execute(
        "INSERT INTO notification_log (channel, event, ok, detail) VALUES (?, ?, ?, ?)",
        (channel, event[:60], 1 if ok else 0, detail[:400]),
    )
