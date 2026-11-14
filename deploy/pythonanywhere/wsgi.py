"""PythonAnywhere WSGI entry point.

Point the web app's WSGI file at this file, or copy its contents into the
WSGI file PythonAnywhere generates.

Layout assumed:
    /home/<you>/kudsi-shop   -> this repository
    /home/<you>/kudsi-data   -> SQLite database + secret key (persists)
"""

import os
import sys

HOME = os.path.expanduser("~")
CODE_DIR = os.environ.get("KUDSI_CODE_DIR", os.path.join(HOME, "kudsi-shop"))
DATA_DIR = os.environ.get("NEXUSKEYS_DATA_DIR", os.path.join(HOME, "kudsi-data"))

# Must be set before importing the app: db.py reads these at import time.
os.environ.setdefault("NEXUSKEYS_DATA_DIR", DATA_DIR)
os.environ.setdefault("DISABLE_PAYMENT_WATCHER", "1")
os.environ.setdefault("COOKIE_SECURE", "1")
os.environ.setdefault("TRUST_PROXY", "1")

if CODE_DIR not in sys.path:
    sys.path.insert(0, CODE_DIR)

from app import app as application  # noqa: E402
