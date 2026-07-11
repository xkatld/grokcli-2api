from __future__ import annotations

import yaml
from pathlib import Path
from typing import Any

APP_ROOT = Path(__file__).resolve().parent
yaml_path = APP_ROOT / "config.yaml"
if yaml_path.exists():
    with open(yaml_path, "r", encoding="utf-8") as f:
        yaml_config = yaml.safe_load(f) or {}
else:
    yaml_config = {}

HOST = yaml_config.get("host", "127.0.0.1")
PORT = int(yaml_config.get("port", 3000))
DATA_DIR = Path(yaml_config.get("data_dir", "data"))
if not DATA_DIR.is_absolute():
    DATA_DIR = APP_ROOT / DATA_DIR

KEYS_FILE = DATA_DIR / "keys.json"
SETTINGS_FILE = DATA_DIR / "settings.json"
STATIC_DIR = APP_ROOT / "static"
AUTH_FILE = DATA_DIR / "auth.json"
MODELS_CACHE = DATA_DIR / "models_cache.json"

CLI_VERSION = "0.2.93"
CLIENT_SURFACE = "grok-cli"
CLIENT_IDENTIFIER = "grokcli-2api"

CONVERSATION_AFFINITY = True
AFFINITY_TTL = 7200.0
AFFINITY_MAX = 5000

MODEL_HEALTH_AUTO_DISABLE = True
PROBE_MODELS: list[str] = ["grok-4.5"]

TOKEN_REFRESH_WORKERS = 2
MODEL_PROBE_WORKERS = 2
QUOTA_WORKERS = 3
SSO_IMPORT_WORKERS = 3
TOKEN_MAINTAIN_STARTUP_DELAY = 45.0
MODEL_HEALTH_STARTUP_DELAY = 120.0
TOKEN_REFRESH_BATCH = 20
MODEL_PROBE_BATCH = 15
MAINTENANCE_LOCK_TIMEOUT = 180.0

GROK_CLI_CLIENT_ID = "b1a00492-073a-47ea-816f-4c329264a828"
OIDC_ISSUER = "https://auth.x.ai"
OIDC_DEVICE_URL = "https://auth.x.ai/oauth2/device/code"
OIDC_TOKEN_URL = "https://auth.x.ai/oauth2/token"
OIDC_SCOPES = "openid profile email offline_access grok-cli:access api:access conversations:read conversations:write"
XAI_ACCOUNTS_URL = "https://accounts.x.ai/"

TOKEN_REFRESH_SKEW = 120.0
FORCE_UPSTREAM_STREAM = True
TIMEOUT = 600.0
SSE_KEEPALIVE_INTERVAL = 8.0

MODEL_ALIASES: dict[str, str] = {
    "gpt-4": "grok-4.5",
    "gpt-4o": "grok-4.5",
    "gpt-3.5-turbo": "grok-4.5",
    "gpt-4-turbo": "grok-4.5",
    "claude": "grok-4.5",
    "claude-3": "grok-4.5",
    "claude-3-5-sonnet": "grok-4.5",
    "claude-3-5-sonnet-20240620": "grok-4.5",
    "claude-3-5-sonnet-20241022": "grok-4.5",
    "claude-3-5-haiku": "grok-4.5",
    "claude-3-5-haiku-20241022": "grok-4.5",
    "claude-3-haiku": "grok-4.5",
    "claude-3-haiku-20240307": "grok-4.5",
    "claude-3-opus": "grok-4.5",
    "claude-3-opus-20240229": "grok-4.5",
    "claude-3-sonnet": "grok-4.5",
    "claude-3-sonnet-20240229": "grok-4.5",
    "claude-sonnet-4": "grok-4.5",
    "claude-sonnet-4-0": "grok-4.5",
    "claude-sonnet-4-20250514": "grok-4.5",
    "claude-sonnet-4-5": "grok-4.5",
    "claude-sonnet-4-5-20250929": "grok-4.5",
    "claude-opus-4": "grok-4.5",
    "claude-opus-4-0": "grok-4.5",
    "claude-opus-4-20250514": "grok-4.5",
    "claude-opus-4-5": "grok-4.5",
    "claude-haiku-4": "grok-4.5",
    "claude-haiku-4-5": "grok-4.5",
    "claude-haiku-4-5-20251001": "grok-4.5",
    "grok": "grok-4.5",
    "grok-latest": "grok-4.5",
    "grok-build": "grok-build",
    "default": "grok-4.5",
}

DEFAULTS: dict[str, Any] = {
    "DEFAULT_MODEL": "grok-4.5",
    "REQUIRE_API_KEY": "auto",
    "TOKEN_MAINTAIN_INTERVAL": 180.0,
    "MODEL_HEALTH_INTERVAL": 900.0,
    "REASONING_COMPAT": "off",
    "XAI_PROXY": "",
    "XAI_PROXY_USERNAME": "",
    "XAI_PROXY_PASSWORD": "",
    "MOEMAIL_BASE_URL": "https://moemail.521884.xyz",
    "MOEMAIL_API_KEY": "",
    "MOEMAIL_DOMAIN": "lolicc.online",
    "MOEMAIL_EXPIRY_MS": 3600000,
    "PUBLIC_BASE_URL": "",
    "ACCOUNT_MODE": "",
    "API_KEY": "",
    "ADMIN_PASSWORD": "",
    "UPSTREAM_BASE": "https://cli-chat-proxy.grok.com/v1",
}

def __getattr__(name: str) -> Any:
    if name in DEFAULTS:
        import settings_store
        settings_store.ensure_defaults()
        return settings_store.get_config(name.lower(), DEFAULTS[name])
    raise AttributeError(f"module '{__name__}' has no attribute '{name}'")
