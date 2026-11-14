#!/usr/bin/env bash
# One-shot bootstrap for PythonAnywhere (free "Beginner" account).
#
#   1) Get the code there first, either:
#        git clone https://github.com/YOURNAME/kudsi-shop.git ~/kudsi-shop
#      or unzip an uploaded kudsi-shop.zip into ~/kudsi-shop
#
#   2) Then run this script:
#        bash ~/kudsi-shop/deploy/pythonanywhere/setup.sh
#
# It creates ~/kudsi-data, a virtualenv at ~/.virtualenvs/kudsi, installs the
# dependencies and writes a starting .env (edit SECRET_KEY + PUBLIC_BASE_URL).
#
# Optional: pass a repo URL and it clones when the folder is missing:
#        bash setup.sh https://github.com/YOURNAME/kudsi-shop.git

set -euo pipefail

REPO_URL="${1:-}"
CODE_DIR="$HOME/kudsi-shop"
DATA_DIR="$HOME/kudsi-data"
VENV="$HOME/.virtualenvs/kudsi"

if [ -n "$REPO_URL" ] && [ ! -d "$CODE_DIR/.git" ]; then
  echo "==> Cloning $REPO_URL"
  git clone "$REPO_URL" "$CODE_DIR"
fi

if [ ! -f "$CODE_DIR/app.py" ]; then
  echo "Code not found in $CODE_DIR." >&2
  echo "Clone it first:  git clone <repo-url> $CODE_DIR" >&2
  exit 1
fi

echo "==> Creating $DATA_DIR (the database lives here, outside the code)"
mkdir -p "$DATA_DIR"

echo "==> Creating virtualenv $VENV"
if [ ! -d "$VENV" ]; then
  python3 -m venv "$VENV"
fi
# shellcheck disable=SC1091
source "$VENV/bin/activate"
pip install --upgrade --quiet pip
pip install --quiet -r "$CODE_DIR/requirements.txt"

if [ ! -f "$CODE_DIR/.env" ]; then
  echo "==> Writing $CODE_DIR/.env"
  cp "$CODE_DIR/deploy/pythonanywhere/env.example" "$CODE_DIR/.env"
  SECRET=$(python -c "import secrets; print(secrets.token_hex(32))")
  # Replace the placeholder key and point the base URL at this account.
  sed -i "s|^SECRET_KEY=.*|SECRET_KEY=$SECRET|" "$CODE_DIR/.env"
  sed -i "s|^PUBLIC_BASE_URL=.*|PUBLIC_BASE_URL=https://$(whoami).pythonanywhere.com|" "$CODE_DIR/.env"
  echo "    SECRET_KEY and PUBLIC_BASE_URL were filled in automatically."
else
  echo "==> Keeping the existing $CODE_DIR/.env"
fi

cat <<EOF

Done. Next:

  1. Upload your database to  $DATA_DIR/store.db
     (Files tab -> kudsi-data -> Upload a file)

  2. Web tab -> Add a new web app -> Manual configuration -> newest Python 3
       Source code:        $CODE_DIR
       Working directory:  $CODE_DIR
       Virtualenv:         $VENV
       WSGI file:          paste the contents of
                           $CODE_DIR/deploy/pythonanywhere/wsgi.py

  3. Press Reload, then open https://$(whoami).pythonanywhere.com

EOF
