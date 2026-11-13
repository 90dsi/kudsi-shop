"""SQLite database: schema, migrations, helpers, seeding.

Everything lives in data/store.db — back that file up, that's your shop.
"""

import json
import os
import secrets
import sqlite3
from contextlib import contextmanager
from pathlib import Path

ROOT = Path(__file__).resolve().parent
DATA_DIR = Path(os.environ.get("NEXUSKEYS_DATA_DIR", ROOT / "data"))
DB_PATH = DATA_DIR / "store.db"

SCHEMA = """
CREATE TABLE IF NOT EXISTS users (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    email          TEXT NOT NULL UNIQUE COLLATE NOCASE,
    name           TEXT NOT NULL DEFAULT '',
    password_hash  TEXT,
    role           TEXT NOT NULL DEFAULT 'customer' CHECK (role IN ('customer', 'admin')),
    avatar         TEXT,
    contact_type   TEXT,                      -- telegram | discord
    contact_handle TEXT,
    created_at     TEXT NOT NULL DEFAULT (datetime('now')),
    last_login     TEXT
);

CREATE TABLE IF NOT EXISTS products (
    id              TEXT PRIMARY KEY,
    name            TEXT NOT NULL,
    category        TEXT NOT NULL DEFAULT 'Game Cards',
    price_cents     INTEGER NOT NULL,
    old_price_cents INTEGER,
    emoji           TEXT NOT NULL DEFAULT '🎁',
    image           TEXT,
    art             TEXT,
    region          TEXT NOT NULL DEFAULT 'Global',
    badge           TEXT,
    description     TEXT NOT NULL DEFAULT '',
    variants        TEXT,                    -- JSON list: [{label, priceCents, oldPriceCents}]
    active          INTEGER NOT NULL DEFAULT 1,
    sort_order      INTEGER NOT NULL DEFAULT 100,
    created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS categories (
    name       TEXT PRIMARY KEY COLLATE NOCASE,
    sort_order INTEGER NOT NULL DEFAULT 100,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS orders (
    id             TEXT PRIMARY KEY,
    user_id        INTEGER REFERENCES users(id) ON DELETE SET NULL,
    email          TEXT NOT NULL,
    status         TEXT NOT NULL DEFAULT 'pending'
                   CHECK (status IN ('pending', 'paid', 'expired', 'cancelled')),
    total_cents    INTEGER NOT NULL,
    currency       TEXT NOT NULL DEFAULT 'USD',
    provider       TEXT,                     -- payment method id: binance | btc | ltc | usdt-trc20 | sandbox
    provider_ref   TEXT,
    checkout_url   TEXT,
    pay_address    TEXT,
    pay_amount     TEXT,
    pay_asset      TEXT,
    txid           TEXT,
    contact_type   TEXT,                     -- telegram | discord
    contact_handle TEXT,
    delivered_at   TEXT,
    emailed_at     TEXT,
    last_checked   INTEGER,
    created_at     TEXT NOT NULL DEFAULT (datetime('now')),
    paid_at        TEXT,
    expires_at     INTEGER
);

CREATE TABLE IF NOT EXISTS order_items (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id         TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    product_id       TEXT NOT NULL,
    name             TEXT NOT NULL,
    variant          TEXT,                   -- chosen duration, e.g. "1 month"
    emoji            TEXT,
    image            TEXT,
    qty              INTEGER NOT NULL,
    unit_price_cents INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS order_codes (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id   TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    product_id TEXT NOT NULL,
    variant    TEXT,
    code       TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS messages (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    sender     TEXT NOT NULL CHECK (sender IN ('admin', 'customer')),
    body       TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    read_at    TEXT
);

CREATE TABLE IF NOT EXISTS payment_methods (
    id           TEXT PRIMARY KEY,
    label        TEXT NOT NULL,
    asset        TEXT NOT NULL DEFAULT 'USDT',
    network      TEXT,
    kind         TEXT NOT NULL DEFAULT 'crypto' CHECK (kind IN ('binance', 'crypto')),
    address      TEXT,
    instructions TEXT,
    image        TEXT,
    rate_usd     REAL,                       -- manual USD price of 1 asset; null = live rate
    auto_verify  INTEGER NOT NULL DEFAULT 1,
    enabled      INTEGER NOT NULL DEFAULT 1,
    sort_order   INTEGER NOT NULL DEFAULT 100
);

CREATE TABLE IF NOT EXISTS outbox (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    to_email   TEXT NOT NULL,
    subject    TEXT NOT NULL,
    body       TEXT NOT NULL,
    status     TEXT NOT NULL DEFAULT 'sent',  -- sent | failed | skipped
    error      TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT
);

-- ------------------------------------------------------------------ wallet
-- Every balance change is written to wallet_transactions. That table is the
-- ledger: rows are never updated or deleted, only appended.
CREATE TABLE IF NOT EXISTS wallet_transactions (
    id                   INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id              INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind                 TEXT NOT NULL
                         CHECK (kind IN ('topup', 'withdrawal', 'withdrawal_refund',
                                         'purchase', 'adjustment', 'bonus')),
    direction            TEXT NOT NULL CHECK (direction IN ('credit', 'debit')),
    amount_cents         INTEGER NOT NULL CHECK (amount_cents > 0),
    balance_before_cents INTEGER NOT NULL CHECK (balance_before_cents >= 0),
    balance_after_cents  INTEGER NOT NULL CHECK (balance_after_cents >= 0),
    status               TEXT NOT NULL DEFAULT 'completed',
    reference            TEXT,
    note                 TEXT,
    created_at           TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS topups (
    id           TEXT PRIMARY KEY,
    user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
    method       TEXT,
    asset        TEXT,
    network      TEXT,
    pay_address  TEXT,
    pay_amount   TEXT,
    txid         TEXT,
    status       TEXT NOT NULL DEFAULT 'pending'
                 CHECK (status IN ('pending', 'approved', 'rejected', 'expired')),
    reference    TEXT,
    customer_note TEXT,
    admin_note   TEXT,
    decided_by   INTEGER REFERENCES users(id) ON DELETE SET NULL,
    decided_at   TEXT,
    created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS withdrawals (
    id           TEXT PRIMARY KEY,
    user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
    method       TEXT NOT NULL,
    details      TEXT NOT NULL DEFAULT '',
    status       TEXT NOT NULL DEFAULT 'pending'
                 CHECK (status IN ('pending', 'approved', 'processing', 'completed', 'rejected')),
    admin_note   TEXT,
    decided_by   INTEGER REFERENCES users(id) ON DELETE SET NULL,
    decided_at   TEXT,
    created_at   TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS withdrawal_methods (
    id            TEXT PRIMARY KEY,
    label         TEXT NOT NULL,
    details_label TEXT NOT NULL DEFAULT 'Account details',
    instructions  TEXT,
    enabled       INTEGER NOT NULL DEFAULT 1,
    sort_order    INTEGER NOT NULL DEFAULT 100
);

CREATE TABLE IF NOT EXISTS password_resets (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash TEXT NOT NULL UNIQUE,
    created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    expires_at INTEGER NOT NULL,
    used_at    TEXT,
    revoked_at TEXT,
    channel    TEXT,
    sent_at    TEXT
);

CREATE TABLE IF NOT EXISTS notifications (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    type       TEXT NOT NULL,
    title      TEXT NOT NULL,
    body       TEXT,
    reference  TEXT,
    read_at    TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS notification_log (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    channel    TEXT NOT NULL,
    event      TEXT NOT NULL,
    ok         INTEGER NOT NULL,
    detail     TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_orders_user   ON orders(user_id);
CREATE INDEX IF NOT EXISTS idx_orders_email  ON orders(email);
CREATE INDEX IF NOT EXISTS idx_orders_state  ON orders(status, provider);
CREATE INDEX IF NOT EXISTS idx_items_order   ON order_items(order_id);
CREATE INDEX IF NOT EXISTS idx_items_prod    ON order_items(product_id);
CREATE INDEX IF NOT EXISTS idx_codes_order   ON order_codes(order_id);
CREATE INDEX IF NOT EXISTS idx_messages_user ON messages(user_id, id);
CREATE INDEX IF NOT EXISTS idx_wallet_user   ON wallet_transactions(user_id, id);
CREATE INDEX IF NOT EXISTS idx_wallet_ref    ON wallet_transactions(reference);
CREATE INDEX IF NOT EXISTS idx_topups_user   ON topups(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_topups_state  ON topups(status, created_at);
CREATE INDEX IF NOT EXISTS idx_withdraw_user ON withdrawals(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_withdraw_state ON withdrawals(status, created_at);
CREATE INDEX IF NOT EXISTS idx_resets_user   ON password_resets(user_id, id);
CREATE INDEX IF NOT EXISTS idx_notif_user    ON notifications(user_id, id);
-- One ledger row per reference+kind: replaying an approval can never pay twice.
CREATE UNIQUE INDEX IF NOT EXISTS uq_wallet_kind_ref
    ON wallet_transactions(kind, reference) WHERE reference IS NOT NULL;
"""

SEED_PRODUCTS = [
    ("steam-20", "Steam Wallet Card $20", "Game Cards", 1949, 2000, "🎮", None,
     "linear-gradient(150deg, #1b2b45, #0f1725)", "Global", "Best seller",
     "Top up your Steam wallet and buy any game, DLC or in-game item.", 10),
    ("psn-50", "PlayStation Store Card $50", "Game Cards", 4799, 5000, "🕹️", None,
     "linear-gradient(150deg, #14264d, #0b1220)", "US", None,
     "Add funds to your PSN wallet for games, add-ons and PS Plus.", 20),
    ("xbox-25", "Xbox Gift Card $25", "Gift Cards", 2425, 2500, "🎁", None,
     "linear-gradient(150deg, #123524, #0a1712)", "Global", None,
     "Redeem for games, apps, movies and more on the Microsoft Store.", 30),
    ("nintendo-35", "Nintendo eShop Card $35", "Gift Cards", 3450, 3500, "🍄", None,
     "linear-gradient(150deg, #4a1220, #1a0a10)", "EU", None,
     "Buy digital Switch games, DLC and Nintendo Switch Online.", 40),
    ("roblox-10", "Roblox Gift Card $10", "Gift Cards", 979, 1000, "🧱", None,
     "linear-gradient(150deg, #3a1414, #170808)", "Global", "Sale",
     "Get Robux to spend on avatar items, game passes and more.", 50),
    ("gp-15", "Google Play Card $15", "Gift Cards", 1469, 1500, "▶️", None,
     "linear-gradient(150deg, #14332b, #0a1714)", "US", None,
     "Apps, games, in-app purchases and books on Google Play.", 60),
    ("gamepass-3m", "Game Pass Ultimate", "Subscriptions", 4499, 4999, "⭐", None,
     "linear-gradient(150deg, #1f2a46, #10141f)", "Global", "Popular",
     "Hundreds of games on console, PC and cloud. Pick your duration.", 70),
    ("psplus-12m", "PS Plus Essential — 12 Months", "Subscriptions", 6499, 7999, "🟦", None,
     "linear-gradient(150deg, #16233f, #0b1120)", "US", "Best value",
     "Online multiplayer, monthly games and exclusive discounts.", 80),
    ("nso-12m", "Switch Online — 12 Months", "Subscriptions", 2249, 2499, "🔴", None,
     "linear-gradient(150deg, #3a0f18, #15070a)", "Global", None,
     "Online play plus a growing library of classic NES and SNES games.", 90),
]

SEED_METHODS = [
    ("binance", "Binance Pay", "USDT", "Binance", "binance", None,
     "Pay with any crypto or card through Binance. Opens a secure Binance checkout.",
     None, None, 1, 1, 10),
    ("btc", "Bitcoin (BTC)", "BTC", "Bitcoin", "crypto", None,
     "Send the exact BTC amount to the address below. Confirmed automatically.",
     None, None, 1, 1, 20),
    ("ltc", "Litecoin (LTC)", "LTC", "Litecoin", "crypto", None,
     "Send the exact LTC amount to the address below. Confirmed automatically.",
     None, None, 1, 1, 30),
    ("usdt-trc20", "USDT (TRC20)", "USDT", "TRON", "crypto", None,
     "Send USDT on the TRON network only. Confirmed automatically.",
     None, None, 1, 1, 40),
    ("eth", "Ethereum (ETH)", "ETH", "Ethereum", "crypto", None,
     "Send the exact ETH amount to the address below.",
     None, None, 1, 1, 50),
    ("usdt-erc20", "USDT (ERC20)", "USDT", "Ethereum", "crypto", None,
     "Send USDT on the Ethereum network only.",
     None, None, 1, 1, 60),
]

SEED_GAMEPASS_VARIANTS = [
    {"label": "14 days", "priceCents": 999, "oldPriceCents": 1299},
    {"label": "1 month", "priceCents": 1699, "oldPriceCents": 1999},
    {"label": "3 months", "priceCents": 4499, "oldPriceCents": 4999},
]

MIGRATIONS = {
    "users": [
        ("contact_type", "TEXT"),
        ("contact_handle", "TEXT"),
        ("balance_cents", "INTEGER NOT NULL DEFAULT 0"),
        ("deposited_cents", "INTEGER NOT NULL DEFAULT 0"),
        ("withdrawn_cents", "INTEGER NOT NULL DEFAULT 0"),
        ("status", "TEXT NOT NULL DEFAULT 'active'"),
        ("suspended_reason", "TEXT"),
    ],
    "products": [
        ("variants", "TEXT"),
    ],
    "order_items": [
        ("variant", "TEXT"),
    ],
    "order_codes": [
        ("variant", "TEXT"),
    ],
    "orders": [
        ("pay_address", "TEXT"),
        ("pay_amount", "TEXT"),
        ("pay_asset", "TEXT"),
        ("txid", "TEXT"),
        ("contact_type", "TEXT"),
        ("contact_handle", "TEXT"),
        ("delivered_at", "TEXT"),
        ("emailed_at", "TEXT"),
        ("last_checked", "INTEGER"),
    ],
}

DEFAULT_SETTINGS = {
    "codes_visible": "1",
    "delivery_note": "Your codes are emailed instantly and also shown on your order page.",
    "support_contact": "",
    "binance_api_key": "",
    "binance_secret": "",
    "binance_cert_sn": "",
    # ---- money
    "currency": "USD",
    "currency_symbol": "$",
    "min_withdraw_cents": "200",
    "min_topup_cents": "500",
    "manual_topup_approval": "1",
    # ---- contact / branding
    "telegram_contact_username": "@t4m31",
    "telegram_contact_link": "https://t.me/t4m31",
    "discord_contact_link": "",
    "app_name": "Kudsi Shop",
    "app_logo": "K",
    "theme_accent": "#6c5ce7",
    "maintenance_mode": "0",
    # ---- notifications
    "telegram_bot_token": "",
    "telegram_admin_chat_id": "",
    "discord_webhook_url": "",
    "notify_password_reset": "1",
    "notify_topup_request": "1",
    "notify_topup_decision": "1",
    "notify_withdrawal_request": "1",
    "notify_withdrawal_decision": "1",
    "notify_new_message": "1",
    # ---- security
    "reset_token_hours": "24",
}

SEED_WITHDRAWAL_METHODS = [
    ("paypal", "PayPal", "PayPal email", "We send the money to your PayPal address.", 1, 10),
    ("usdt-trc20", "USDT (TRC20)", "TRON wallet address", "USDT on the TRON network only.", 1, 20),
    ("bank", "Bank transfer", "Bank name, account number and account holder", "Local bank transfer. Include the IBAN/SWIFT if you are outside the country.", 1, 30),
    ("other", "Other", "Tell us how to pay you", "Our team will contact you to arrange this method.", 1, 40),
]


@contextmanager
def get_db():
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    con = sqlite3.connect(DB_PATH, timeout=10)
    con.row_factory = sqlite3.Row
    con.execute("PRAGMA foreign_keys = ON")
    try:
        yield con
        con.commit()
    except Exception:
        con.rollback()
        raise
    finally:
        con.close()


def fetch_all(sql, params=()):
    with get_db() as con:
        return [dict(r) for r in con.execute(sql, params).fetchall()]


@contextmanager
def money_db():
    """Transaction for balance changes.

    BEGIN IMMEDIATE takes the write lock up front, so two simultaneous
    withdrawals can never read the same starting balance and both succeed.
    """
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    con = sqlite3.connect(DB_PATH, timeout=15, isolation_level=None)
    con.row_factory = sqlite3.Row
    con.execute("PRAGMA foreign_keys = ON")
    con.execute("PRAGMA busy_timeout = 15000")
    con.execute("BEGIN IMMEDIATE")
    try:
        yield con
        con.execute("COMMIT")
    except Exception:
        con.execute("ROLLBACK")
        raise
    finally:
        con.close()


def fetch_one(sql, params=()):
    with get_db() as con:
        row = con.execute(sql, params).fetchone()
        return dict(row) if row else None


def execute(sql, params=()):
    with get_db() as con:
        cur = con.execute(sql, params)
        return cur.lastrowid


# ------------------------------------------------------------------ settings
def get_setting(key: str, default=None):
    row = fetch_one("SELECT value FROM settings WHERE key = ?", (key,))
    if row is None:
        return DEFAULT_SETTINGS.get(key, default)
    return row["value"]


def set_setting(key: str, value: str):
    execute(
        "INSERT INTO settings (key, value) VALUES (?, ?) "
        "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        (key, value),
    )


def setting_bool(key: str, default=True) -> bool:
    value = get_setting(key)
    if value is None:
        return default
    return str(value) == "1"


# ------------------------------------------------------------------ migration
def _columns(con, table):
    return {r["name"] for r in con.execute(f"PRAGMA table_info({table})")}


def _migrate(con):
    for table, columns in MIGRATIONS.items():
        existing = _columns(con, table)
        for name, kind in columns:
            if name not in existing:
                con.execute(f"ALTER TABLE {table} ADD COLUMN {name} {kind}")
    for key, value in DEFAULT_SETTINGS.items():
        con.execute("INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)", (key, value))


def init_db():
    with get_db() as con:
        con.execute("PRAGMA journal_mode = WAL")
        con.executescript(SCHEMA)
        _migrate(con)
        if con.execute("SELECT COUNT(*) FROM products").fetchone()[0] == 0:
            con.executemany(
                """INSERT INTO products
                   (id, name, category, price_cents, old_price_cents, emoji, image,
                    art, region, badge, description, sort_order)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                SEED_PRODUCTS,
            )
            # Game Pass is sold as one card with a duration picker.
            cheapest = min(v["priceCents"] for v in SEED_GAMEPASS_VARIANTS)
            con.execute(
                "UPDATE products SET price_cents = ?, old_price_cents = ?, variants = ? "
                "WHERE id = 'gamepass-3m'",
                (
                    cheapest,
                    next(
                        (v["oldPriceCents"] for v in SEED_GAMEPASS_VARIANTS
                         if v["priceCents"] == cheapest),
                        None,
                    ),
                    json.dumps(SEED_GAMEPASS_VARIANTS),
                ),
            )
        # Admin-managed categories power the storefront filters. Existing shops
        # get their current product categories imported automatically.
        con.execute(
            """INSERT OR IGNORE INTO categories (name, sort_order)
               SELECT category, MIN(sort_order) FROM products
               GROUP BY category
               ORDER BY MIN(sort_order)"""
        )
        if con.execute("SELECT COUNT(*) FROM payment_methods").fetchone()[0] == 0:
            con.executemany(
                """INSERT INTO payment_methods
                   (id, label, asset, network, kind, address, instructions, image,
                    rate_usd, auto_verify, enabled, sort_order)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                SEED_METHODS,
            )
        con.executemany(
            """INSERT OR IGNORE INTO withdrawal_methods
               (id, label, details_label, instructions, enabled, sort_order)
               VALUES (?, ?, ?, ?, ?, ?)""",
            SEED_WITHDRAWAL_METHODS,
        )


# --------------------------------------------------------------------- codes
ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"


def new_code() -> str:
    groups = ["".join(secrets.choice(ALPHABET) for _ in range(5)) for _ in range(3)]
    return "NXS-" + "-".join(groups)
