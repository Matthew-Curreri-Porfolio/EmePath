"""
gateway/config.py

Mirror of key gateway settings for Python components (e.g., LoRA server).
Values are derived from environment variables with sensible defaults to
stay aligned with gateway/config.js.
"""

import os


def _env_bool(name: str, default: bool = False) -> bool:
    v = os.getenv(name)
    if v is None:
        return default
    return str(v).strip().lower() in {"1", "true", "yes", "on"}


# Timeouts
GATEWAY_TIMEOUT_MS: int = int(os.getenv("GATEWAY_TIMEOUT_MS", "120000"))

# LoRA Python server
LORA_SERVER_BASE: str = os.getenv("LORA_SERVER_BASE", "http://127.0.0.1:8000")

def _port_from_base(base: str) -> int:
    try:
        from urllib.parse import urlparse

        p = urlparse(base)
        if p.port:
            return int(p.port)
    except Exception:
        pass
    return 8000


LORA_SERVER_PORT: int = int(os.getenv("LORA_SERVER_PORT", str(_port_from_base(LORA_SERVER_BASE))))

# Default model/adapters for LoRA server
LORA_MODEL_NAME: str = os.getenv("LORA_MODEL_NAME", "qwen3-7b")
DEFAULT_UNSLOTH_BASE: str = os.getenv("DEFAULT_UNSLOTH_BASE", "unsloth/Qwen2.5-7B")
DEFAULT_UNSLOTH_4BIT: str = os.getenv(
    "DEFAULT_UNSLOTH_4BIT", "unsloth/Qwen2.5-7B-Instruct-bnb-4bit"
)
LOCAL_HF_REL = os.path.join(
    "gateway", "models", "base", "gpt-oss-20b-bf16"
)
LOCAL_HF_PATH = os.path.abspath(os.path.join(os.getcwd(), LOCAL_HF_REL))
LOCAL_GGUF_REL = os.path.join(
    "gateway",
    "models",
    "base",
    "gpt_unlocked",
    "OpenAI-20B-NEO-Uncensored2-IQ4_NL.gguf",
)
LOCAL_GGUF_PATH = os.path.abspath(os.path.join(os.getcwd(), LOCAL_GGUF_REL))

def _default_model_path() -> str:
    env_path = os.getenv("LORA_MODEL_PATH")
    if env_path:
        return env_path
    if os.path.isdir(LOCAL_HF_PATH):
        return LOCAL_HF_PATH
    if os.path.isfile(LOCAL_GGUF_PATH):
        return LOCAL_GGUF_PATH
    return DEFAULT_UNSLOTH_BASE


LORA_MODEL_PATH: str = _default_model_path()
LORA_DEFAULT_ADAPTER: str = os.getenv("LORA_DEFAULT_ADAPTER", "")
LORA_LORA_PATHS_JSON: str = os.getenv("LORA_LORA_PATHS_JSON", "")
LORA_ADAPTERS_JSON: str = os.getenv("LORA_ADAPTERS_JSON", "")
LORA_ADAPTERS: str = os.getenv("LORA_ADAPTERS", "")
LORA_LOAD_4BIT: bool = _env_bool("LORA_LOAD_4BIT", False)


def as_dict() -> dict:
    return {
        "GATEWAY_TIMEOUT_MS": GATEWAY_TIMEOUT_MS,
        "LORA_SERVER_BASE": LORA_SERVER_BASE,
        "LORA_SERVER_PORT": LORA_SERVER_PORT,
        "LORA_MODEL_NAME": LORA_MODEL_NAME,
        "LORA_MODEL_PATH": LORA_MODEL_PATH,
        "LORA_DEFAULT_ADAPTER": LORA_DEFAULT_ADAPTER,
        "LORA_LORA_PATHS_JSON": LORA_LORA_PATHS_JSON,
        "LORA_ADAPTERS_JSON": LORA_ADAPTERS_JSON,
        "LORA_ADAPTERS": LORA_ADAPTERS,
        "LORA_LOAD_4BIT": LORA_LOAD_4BIT,
        "DEFAULT_UNSLOTH_BASE": DEFAULT_UNSLOTH_BASE,
        "DEFAULT_UNSLOTH_4BIT": DEFAULT_UNSLOTH_4BIT,
    }
