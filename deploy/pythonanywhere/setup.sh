#!/usr/bin/env bash
# Run this in a PythonAnywhere Bash console (free accounts get 2 consoles).
#
#   bash setup.sh https://github.com/YOURNAME/kudsi-shop.git
#
# It clones the repo, creates a virtualenv and installs the dependencies.
# After that, create the web app in the PythonAnywhere UI and point its WSGI
# file at deploy/pythonanywhere/wsgi.py.

set -euo pipefail

REPO_URL="${1:?Usage: bash setup.sh <git-repo-url>}"
CODE_DIR="$HOME/kudsi-shop"
DATA_DIR="$HOME/kudsi-data"
VENV="$HOME/.virtualenvs/kudsi"

if [ -d "$CODE_DIR/.git" ]; then
  git -C "$CODE_DIR" pull --ff-only
else
  git clone "$REPO_URL" "$CODE_DIR"
fi

mkdir -p "$DATA_DIR"

python3 -m venv "$VENV"
# shellcheck disable=SC1091
source "$VENV/bin/activate"
pip install --upgrade pip
pip install -r "$CODE_DIR/requirements.txt"

if [ ! -f "$CODE_DIR/.env" ]; then
  cp "$CODE_DIR/deploy/pythonanywhere/env.example" "$CODE_DIR/.env"
  echo
  echo "Created $CODE_DIR/.env - edit it now and set SECRET_KEY + PUBLIC_BASE_URL:"
  echo "  nano $CODE_DIR/.env"
fi

echo
echo "Next steps:"
echo "  1. Upload your existing database to $DATA_DIR/store.db (Files tab)."
echo "  2. PythonAnywhere -> Web -> Add a new web app -> Manual config -> Flask"
echo "     Python 3.13, source: $CODE_DIR"
echo "     WSGI file: $CODE_DIR/deploy/pythonanywhere/wsgi.py"
echo "  3. Add $VENV to the web app's virtualenv setting."
echo "  4. Press Reload."
