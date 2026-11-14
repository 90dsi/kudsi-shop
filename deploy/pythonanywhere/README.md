# Deploying Kudsi Shop on PythonAnywhere (free, permanent URL)

Target: `https://<your-username>.pythonanywhere.com` — free, no card, stays online
after your PC is switched off.

Free-tier limits to know before you start:

| Limit | What it means for this shop |
| --- | --- |
| 100 CPU-seconds/day | Fine for a small shop; a busy day can hit the cap and the app pauses until the next day. |
| Outbound allowlist | **Binance Pay and CoinGecko are blocked.** Turn off Binance + automatic crypto verification, or set manual crypto rates. Card/PayPal/sandbox flows are unaffected. |
| No background tasks | The 45-second payment watcher cannot run. Buyers use **"I've paid — check now"**, or you approve payments in Admin → Orders. Keep `DISABLE_PAYMENT_WATCHER=1`. |
| No custom domain | You get the `*.pythonanywhere.com` address only. |
| 512 MB storage | The SQLite database and assets fit easily. |

Everything is enforced by two files in this folder: `wsgi.py` (entry point) and
`setup.sh` (one-shot bootstrap).

---

## 1. Create the account

1. Go to <https://www.pythonanywhere.com> → **Pricing & signup** → **Create a Beginner account** (free).
2. Pick a username — it becomes your URL: `https://<username>.pythonanywhere.com`.
3. Verify the email they send you.

## 2. Get the code onto PythonAnywhere

Pick **one** of these.

### A. From a Git repository (recommended)

Put this project on GitHub first (from your PC) — already done if you cloned the repo
we pushed:

```powershell
& "C:\Program Files\Git\cmd\git.exe" remote add origin https://github.com/<you>/kudsi-shop.git
& "C:\Program Files\Git\cmd\git.exe" push -u origin main
```

Then in PythonAnywhere open **Consoles → Bash**, clone it, and run the bootstrap:

```bash
cd ~
git clone https://github.com/<you>/kudsi-shop.git
bash ~/kudsi-shop/deploy/pythonanywhere/setup.sh
```

If the repo is private, the `git clone` asks for your GitHub username and a personal
access token (GitHub → Settings → Developer settings → Personal access tokens) in place
of the password — or make the repo public and it clones without a prompt.

### B. Without GitHub (zip upload)

1. On your PC, build the bundle:
   ```powershell
   powershell -ExecutionPolicy Bypass -File deploy\pythonanywhere\make-bundle.ps1
   ```
2. PythonAnywhere → **Files** → upload `kudsi-shop.zip` to `/home/<username>/`.
3. In a **Bash** console:

```bash
cd ~ && unzip kudsi-shop.zip && rm kudsi-shop.zip
bash ~/kudsi-shop/deploy/pythonanywhere/setup.sh
```

## 3. Copy your database

Your shop lives in one file. Upload it from **Files → Upload a file** on your PC to:

```
/home/<username>/kudsi-data/store.db
```

Use the **same** file that is running locally (`data/store.db`) so accounts, balances
and products carry over. Do **not** upload `data/secret.key` — a fresh key is created
on the server (that just logs everyone out once).

> If you start empty instead, `/setup` will ask for an admin email and password.

## 4. Check the environment file

`setup.sh` already wrote `.env` with a random `SECRET_KEY` and
`PUBLIC_BASE_URL=https://<username>.pythonanywhere.com`. Confirm it:

```bash
cat ~/kudsi-shop/.env
```

It should look like this:

```
SECRET_KEY=<64 random hex characters>
COOKIE_SECURE=1
TRUST_PROXY=1
DISABLE_PAYMENT_WATCHER=1
PUBLIC_BASE_URL=https://<username>.pythonanywhere.com
PAYMENTS_ALLOW_SANDBOX=0
```

Change anything with `nano ~/kudsi-shop/.env` (`Ctrl+O`, `Enter`, `Ctrl+X` to save).

## 5. Create the web app

1. **Web** tab → **Add a new web app** → **Next**.
2. If asked, choose **Manual configuration** (not "Flask" quickstart) → pick the newest
   Python 3 (3.10 / 3.13). Do not use a version older than 3.10.
3. On the web app page set:

| Field | Value |
| --- | --- |
| **Source code** | `/home/<username>/kudsi-shop` |
| **Working directory** | `/home/<username>/kudsi-shop` |
| **Virtualenv** | `/home/<username>/.virtualenvs/kudsi` |
| **WSGI configuration file** | click it, delete everything, paste the contents of `deploy/pythonanywhere/wsgi.py`, save |

The WSGI file already sets `NEXUSKEYS_DATA_DIR=/home/<username>/kudsi-data`,
`COOKIE_SECURE`, `TRUST_PROXY` and disables the watcher, so the app finds the database
and serves correct HTTPS links.

4. Press the big green **Reload** button.
5. Open `https://<username>.pythonanywhere.com` — the storefront should load.

## 6. Verify

```bash
curl -s https://<username>.pythonanywhere.com/api/health
# {"app":"kudsi-shop","ok":true,...}
```

Then check:

- [ ] storefront loads with products
- [ ] `https://<username>.pythonanywhere.com/login.html` shows the Telegram/Discord cards
- [ ] you can log in as the admin
- [ ] Admin → Settings saves, Admin → Withdrawals shows the current minimum
- [ ] a test order can be created and its codes appear on the order page

If the page shows an error, open the **Web** tab → **Error log** — it names the exact
Python file and line.

## 7. Because the free tier blocks Binance/CoinGecko

Do this once after the first login:

1. **Admin → Payments**: disable **Binance Pay**, and either disable automatic
   verification for BTC/LTC/USDT or set a **manual rate** on each method.
2. Leave **sandbox** off for real orders (`PAYMENTS_ALLOW_SANDBOX=0` already does this).
3. Payments are then confirmed by you in **Admin → Orders** → Manage → **Mark paid**,
   or by the buyer pressing **"I've paid — check now"** when a rate is reachable.

## 8. Updating the site later

```bash
cd ~/kudsi-shop
git pull --ff-only
```

Then press **Reload** on the **Web** tab. Dependency changes need:

```bash
source ~/.virtualenvs/kudsi/bin/activate && pip install -r requirements.txt
```

## 9. Backups

PythonAnywhere → **Files** → `kudsi-data/` → download `store.db` now and then, or:

```bash
cp ~/kudsi-data/store.db ~/kudsi-data/store-$(date +%F).db
```

Free accounts keep 512 MB, so delete old copies.

---

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| `502` or "Something went wrong" | Web tab → Error log. Usually a wrong WSGI path or missing package in the virtualenv. |
| `no such table` | `NEXUSKEYS_DATA_DIR` points somewhere without `store.db`; check the path in the WSGI file. |
| Everyone is logged out after a deploy | `SECRET_KEY` changed (no `.env`, or `secret.key` was replaced). Fix and reload. |
| Login redirects in a loop | `COOKIE_SECURE=1` without HTTPS, or a stale cookie — clear cookies for the domain. |
| `external network access is disabled` | The free tier's allowlist. Expected for Binance/CoinGecko; use manual approval. |
| CSS/JS looks stale | The app sets `?v=N` on assets; bump it in the HTML files if you edited CSS/JS. |

## Why not Vercel?

Vercel's filesystem is ephemeral (SQLite would reset every deploy) and it has no
long-running process for the payment watcher, so it would need Turso + a cron rewrite.
PythonAnywhere runs the same Flask app against a real file on disk — no code changes.
