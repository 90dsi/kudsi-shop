# Kudsi Shop — digital store with accounts, messaging and crypto payments

A complete shop for game cards, gift cards and subscriptions:

- **Customer database** (SQLite) — every buyer is an account with email, name, photo
  and a Telegram/Discord handle
- **Roles** — everyone who signs up is a `customer`; you (the first account) are `admin`
- **Admin dashboard** — sidebar console: Overview, Customers, Top-ups, Withdrawals,
  Orders, Support inbox, Products, Categories, Payments, Settings, Email log
- **Private messaging** — one thread per customer, visible only to that customer and you
- **Checkout** — buyer must leave a Telegram or Discord username; the order id is shown
  at every step so you can match a payment to a person
- **Codes** — generated on payment and shown on the order page; you can also copy them
  from the admin dashboard and send them by DM
- **Binance Pay** — hosted crypto checkout with automatic verification
- **Direct crypto** — BTC, LTC, USDT-TRC20 verified automatically with no API key;
  ETH and USDT-ERC20 with a free Etherscan key
- **Payment methods are editable** — rename, change/hide the address, set a manual rate,
  attach a picture shown while the customer pays
- **Sandbox mode** — test the whole flow before you have any credentials

```
app.py            Flask app + JSON API + payment watcher thread
db.py             SQLite schema, seed data, helpers
auth.py           scrypt password hashing, sessions, role guards
payments.py       Binance Pay client: signing, create order, webhook, status query
crypto.py         BTC/LTC/TRON/ETH address checks + live USD rates
delivery.py       code generation (on-site delivery)
mailer.py         SMTP sending, falls back to the outbox table
public/           storefront, login, setup, account, order, messages, admin
data/store.db     your database (created on first run — back this up!)
.env              your secrets (copy .env.example, never commit)
```

## 1. Run it

```powershell
python -m pip install -r requirements.txt
python app.py
```

Open <http://localhost:3000>. On a fresh install the site sends you to **/setup** —
enter your email and a password there and that account becomes the **admin**.
Everyone who buys afterwards is created as a `customer` automatically.

> `start.bat` does the same thing (installs Flask, starts the server).
> `public.bat` opens a temporary public HTTPS URL for the running server (Cloudflare
> Tunnel) — keep its window open; the URL is printed there and changes each run.

The first admin is the only special account: if that email is lost, delete
`data/store.db` and run setup again (that also wipes orders).

## 2. Admin dashboard

Open **/admin.html** (the Admin link only appears for admins — customers never see it).

| Tab | What you can do |
| --- | --- |
| **Customers** | Photo, name, email, Telegram/Discord handle, role, order count, total spent, every product bought. Search, filter by product/role, export CSV, open their orders, jump into their messages. |
| **Orders** | Every order with items, status, contact handle, payment method/address/txid, codes and delivery state. **Manage** opens the order: verify the payment now, mark paid, resend the codes email, mark delivered, message the customer. |
| **Products** | Add/edit products, upload pictures, prices, compare-at prices, duration options (see §2b), category, visibility, sort order. |
| **Categories** | Create, rename, reorder and delete the categories that power the storefront filters. Delete is blocked while products still use a category. |
| **Messages** | Two-pane inbox. Pick a customer, read the thread, reply. Unread replies are counted on the tab badge and the dashboard stat. |
| **Payments** | Binance keys, store/delivery settings, and the full payment-method editor. |
| **Emails** | Every email the shop generated, with its status (`sent`, `failed`, `skipped`) and the full body, so you can copy codes manually if SMTP is off. |

**Roles:** the dropdown on each customer row promotes them to admin or back.
You cannot demote yourself, and the last admin cannot be removed.

**Customer photos:** customers upload their own picture on /account.html (resized in the
browser). Products can use an uploaded picture or an emoji.

### 2b. Duration options (one card, several prices)

Sell the same product in several lengths — 14 days, 1 month, 3 months — from a single
card. Customers click a duration chip on the card, the price updates, and the chosen
duration is carried through the cart, order, codes and emails.

1. Products → **Edit** (or **+ New product**).
2. Tick **Sell several durations from one product card**.
3. Add one row per duration: a name (free text, e.g. `14 days`), its price, and an
   optional compare-at price. Add at most 12 rows.
4. Save. The card shows the **cheapest** duration as the headline price and "from";
   the first row is pre-selected for customers.

Notes:

- Every duration has its own price; the product's single `price` field is ignored while
  durations exist and is recalculated to the cheapest one.
- Prices are always recalculated on the server at checkout — a tampered browser cannot
  change what a duration costs.
- An order item/product must carry a known duration; unknown or missing ones are rejected.
- Codes are labelled `Product — duration` everywhere (order page, account, email, admin).
- Untick the duration option (or clear all rows) to go back to a single fixed price.

### 2c. Categories (admin → Categories)

Categories are the filter tabs on the storefront, and every product belongs to exactly
one. The shop starts with the categories it already had (`Game Cards`, `Gift Cards`,
`Subscriptions`), imported automatically.

1. **Categories** tab → **+ New category**.
2. Give it a name (e.g. `Xbox`, `PlayStation`, `Nintendo`) and a sort order. Lower
   numbers appear first on the storefront.
3. Open **Products**, edit a product, and pick the category from the dropdown.
4. Save. The storefront tab appears as soon as at least one visible product uses it.

- **Rename** updates every product in that category automatically.
- **Delete** is only allowed when no product uses the category. Move those products to
  another category first.
- Empty categories are hidden from customers but stay available in the admin dropdown.
- Changing a product's category changes where it appears in the storefront filters and
  on its card (`GAME CARDS`, `XBOX`, …).

## 3. Payment methods (admin → Payments)

Each method is one row: **label**, **type** (`Direct crypto` or `Binance Pay`),
**asset**, **network**, **receiving address**, **instructions**, an optional
**payment picture**, a **manual USD rate**, auto-check and visibility.

- **Direct crypto** — paste your wallet address. The customer only sees it after
  choosing the method. Leave the address empty to hide the method from checkout.
- **Binance Pay** — no address needed; customers get a hosted Binance checkout.
- **Hide / show** without deleting: the Hide button on the row, or uncheck "Show at
  checkout". Existing orders keep their details.
- **Manual rate** — leave empty to use the live CoinGecko price (cached 5 minutes).
  Set a number when an explorer/market feed is unavailable.
- **Payment picture** — upload a screenshot/QR; it is shown on the payment step.

The **Store & delivery** card controls the delivery note shown on the order page, the
support handle, and whether codes are shown on the customer's order page. Codes are only
delivered on the site — nothing is emailed.

### How amounts are matched

For direct crypto the server quotes a **unique amount** per order: the USD total is
converted at the current rate and nudged by a few of the coin's smallest units. The
customer must send that exact amount; the address is shared, but the amount identifies
the order. That is why the UI says "send exactly" three times.

- BTC → Blockstream Esplora API
- LTC → Litecoinspace Esplora API
- USDT-TRC20 → TronGrid
- ETH / USDT-ERC20 → Etherscan (`ETHERSCAN_API_KEY` required)

The background watcher checks pending crypto orders **every 45 seconds**, and the
customer's "I've paid — check now" button triggers an immediate check. A match marks
the order paid once, generates the codes, and emails them.

> **Exchange withdrawals:** if the customer sends from an exchange that deducts a fee,
> the received amount will differ and the automatic match fails. Ask them to send the
> exact quoted amount (or confirm the order manually in Orders → Manage → Mark as paid).
> Confirmations are not required for BTC/LTC/TRON (a mempool transaction counts), which
> keeps delivery instant but means a dropped/replaced transaction is rare — you can see
> the txid in the order.

## 4. Binance Pay

1. Create a **Binance merchant** account and get API credentials
   (Merchant dashboard → Developers → API keys).
2. Paste the key, secret and optional certificate SN into **Admin → Payments → Binance
   Pay** and save. (Or put them in `.env`; environment values win over the database.)
3. The status line turns green and Binance Pay appears at checkout.

How verification works:

- **Webhook** — Binance calls `POST /api/webhooks/binance` the moment funds arrive.
  `payments.verify_webhook()` checks the `BinancePay-Signature` HMAC-SHA512 over
  `timestamp \n nonce \n body \n`; bad signatures get a 401. Good ones mark the order
  **paid** immediately. Replays are idempotent.
- **Polling fallback** — checkout/order pages poll `/api/orders/<id>/status`, and
  `GET /api/orders/<id>/verify` asks Binance for the authoritative order status.
- Buyers return to `/order.html?id=...`, which triggers a verification on load.

**Testing before you have credentials:** with no keys the store runs in **Sandbox**
mode — checkout shows "Simulate successful payment", which runs the same paid path as a
real webhook. Set `PAYMENTS_ALLOW_SANDBOX=0` once real keys are in place.

## 5. Email (password resets only)

Order codes are delivered on the site and never emailed. SMTP is used only for
"Forgot password" links. Add SMTP details to `.env` (see `.env.example`):

```
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_USER=you@gmail.com
SMTP_PASSWORD=your-app-password
SMTP_FROM=you@gmail.com
SMTP_FROM_NAME=Kudsi Shop
```

With no SMTP configured the reset email is still composed and saved in `outbox` with
status `skipped` — read/copy the link from **Admin → Email log**, or use the reset-link
generator in the customer's profile. Customers can always be helped with a manually
generated link.

## 6. Customer flow

1. Add products to the cart (pick a duration chip first when the card offers one), open checkout.
2. Enter email/password (account is created automatically) or use the signed-in account.
3. Choose **Telegram** or **Discord** and type the username.
4. Pick a payment method. Binance → hosted checkout. Crypto → exact amount + address +
   optional picture, with copy buttons.
5. Pay, then "I've paid — check now" (or wait for the watcher).
6. When paid, the codes appear on the order page and in the dashboard, and the receipt
   reminds them to send the order id on Telegram/Discord so you can match the payer.
7. Questions? **Messages** in the header opens the private thread; unread replies show a
   badge. You can also open the thread from Customers or an order.

## 7. Security notes

- Passwords: `hashlib.scrypt` with per-user salt; never stored in plain text.
- Sessions: signed, HttpOnly, SameSite=Lax cookies (14 days). Set `COOKIE_SECURE=1`
  behind HTTPS.
- Login/signup/messages are rate-limited per IP.
- Prices are always read from the database — a tampered cart can't change the total.
- `/api/admin/*` requires `role = 'admin'`; page guards redirect customers away from
  /admin.html; order pages only show your own orders (admins can view all).
- Payment addresses and Binance secrets are only returned by admin endpoints.
- Binance secrets saved from the dashboard are stored in `data/store.db` (plain text);
  protect that file. `.env` values are never written back to the database read path.
- Set `SECRET_KEY` in production so sessions survive restarts.

## 8. Going live

This is a Flask dev server; for real traffic use a WSGI server:

```powershell
python -m pip install waitress
waitress-serve --port=8000 app:app
```

Then put it behind HTTPS (Caddy, nginx, or a platform like Render/Railway/Fly.io).
Two things matter:

1. **Persistent disk** for `data/store.db` — most free tiers are ephemeral, so use a
   volume or managed database before taking real orders.
2. **Public HTTPS URL** in `PUBLIC_BASE_URL` — Binance needs it for the webhook,
   and reset links use it.

### Quick public test URL (no hosting account)

For showing the site to someone today, a tunnel forwards a public HTTPS URL to your
local port 3000:

```powershell
# Cloudflare Tunnel (free, no account for a quick tunnel)
winget install --id Cloudflare.cloudflared
cloudflared tunnel --url http://localhost:3000
```

That prints a `https://<random>.trycloudflare.com` URL that works for anyone while your
PC and the tunnel are running. Set the same base URL when you need payment webhooks:

```powershell
$env:PUBLIC_BASE_URL="https://<random>.trycloudflare.com"
```

The URL changes each time you restart a quick tunnel. For a permanent address, use a
named Cloudflare tunnel with your own domain, or deploy to a VPS and run
`waitress-serve` behind Caddy.

### Permanent free hosting (PythonAnywhere)

Step-by-step guide: **[deploy/pythonanywhere/README.md](deploy/pythonanywhere/README.md)**
— a free `<username>.pythonanywhere.com` URL that keeps running when your PC is off,
with SQLite stored outside the code directory so it survives redeploys.

### Containers (Railway, Fly.io, any VPS)

`Dockerfile` and `Procfile` are included. `NEXUSKEYS_DATA_DIR` points the database at a
mounted volume (default `/data` in the image), and `PORT` is read from the environment.
`/api/health` is a ready-made liveness probe.

Back up `data/store.db` regularly (copy it while the server is stopped, or use
`sqlite3 data/store.db ".backup backup.db"`). The watcher stops with the process, so
don't run two copies of the app against one database.

## 9. Everyday maintenance

- Change a customer's role: Customers → role dropdown.
- Hide a product: Products → Hide.
- Change/hide a wallet address: Payments → Edit, or Hide on the row.
- See order codes: Orders → Manage, or the customer's profile → Transactions.
- Reset everything: stop the server, delete `data/store.db`, restart → setup wizard.
- Run a second test copy on another port with its own database:
  ```powershell
  $env:PORT=3001
  $env:NEXUSKEYS_DATA_DIR="C:\temp\nexus-test"
  python app.py
  ```

## Legal reminders

Digital gift-card resale needs authorized suppliers, and most payment providers will
ask about your sourcing. Digital goods are taxable in most countries — a merchant of
record (Lemon Squeezy, Paddle) handles VAT for you. Add real Terms, Refund and Privacy
pages before launch; the footer links are placeholders.
