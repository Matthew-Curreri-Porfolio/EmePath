"""
FastAPI server for loading base models and LoRA adapters and serving inference.

This script demonstrates how to load a small number of base language models
into memory once, attach multiple LoRA adapters to each, and expose a simple
HTTP API for inspecting available models/adapters and running text generation
against a chosen base+adapter combination.  The implementation uses
Hugging Face's ``transformers`` library along with the ``peft`` package to
manage LoRA adapters.  Each base model is loaded exactly once and kept in
memory; LoRA adapters are loaded and registered on top of their base model and
can be switched at inference time without reloading the base weights.

Endpoints
---------

* ``POST /load_model`` — load a base model and its LoRA adapters from
  specified file system paths.  The request body must provide a unique
  ``name`` for the model, a local or remote ``model_path`` pointing to the
  pretrained weights, and optionally a dictionary of LoRA names to paths.  The
  endpoint loads the base model and all provided adapters into memory.  If
  the model name already exists, an error is returned.

* ``GET /models`` — return a list of all base model names currently loaded.

* ``GET /models/{model_name}/loras`` — return the names of all LoRA adapters
  loaded for the specified base model.  If the model is not found, an
  error is returned.

* ``POST /inference`` — generate text with a selected base model and LoRA
  adapter.  The request body must include ``model_name``, ``lora_name``,
  and a ``prompt``.  Optional parameters ``max_new_tokens`` and
  ``temperature`` allow control over the length and randomness of the output.
  The endpoint sets the chosen adapter, tokenizes the input, runs
  generation, and returns the decoded text.

Notes
-----

* This script is intended as a blueprint.  Paths for base models and LoRA
  adapters should be replaced with actual directories on your system or
  remote repositories.  Because model loading can be resource‑intensive,
  you may wish to restrict the number of base models kept in memory or
  implement reference counting if models/adapters are loaded and unloaded
  dynamically.

* Concurrency: FastAPI runs asynchronous endpoints.  Hugging Face models
  are not inherently thread‑safe, so if you expect concurrent requests you
  should implement a locking mechanism per model to serialize access or
  consider using a model server like vLLM which handles concurrency
  internally.
"""

from typing import Dict, List, Optional

from fastapi import FastAPI, HTTPException
import logging
import os
try:
    # Optional: mirror settings from gateway/config.py if available
    # (Python adds script dir to sys.path when executed directly)
    import config as CFG
except Exception:
    CFG = None
from pydantic import BaseModel

# Optional HF deps — imported lazily only when used
AutoModelForCausalLM = None
AutoTokenizer = None
PeftModel = None

from shutil import which
import subprocess
import socket
import time
import json
from urllib.request import Request, urlopen
from urllib.error import URLError, HTTPError


def _lazy_import_hf() -> bool:
    global AutoModelForCausalLM, AutoTokenizer, PeftModel
    if AutoModelForCausalLM is not None:
        return True
    try:
        from transformers import AutoModelForCausalLM as _AutoModelForCausalLM, AutoTokenizer as _AutoTokenizer
        from peft import PeftModel as _PeftModel
        AutoModelForCausalLM = _AutoModelForCausalLM
        AutoTokenizer = _AutoTokenizer
        PeftModel = _PeftModel
        return True
    except Exception:
        return False


app = FastAPI(title="LoRA Model Server", version="0.1.0")

# Data structures to hold loaded models and adapter information.
# ``_models`` maps a user‑defined model name to a dictionary containing
# the loaded tokenizer and PEFT model (base model with adapters attached).
_models: Dict[str, Dict[str, object]] = {}

# ``_loras`` maps a model name to a list of adapter names loaded for that model.
_loras: Dict[str, List[str]] = {}

# GGUF backend registry: name -> in-process runner (Python), no external server.
# Map: name -> { kind: 'gguf-python', runner: object, model_path: str }
_gguf: Dict[str, Dict[str, object]] = {}


def _is_gguf_path(p: str) -> bool:
    p = str(p or '')
    if p.lower().endswith('.gguf'):
        return True
    try:
        if os.path.isdir(p):
            for fn in os.listdir(p):
                if fn.lower().endswith('.gguf'):
                    return True
    except Exception:
        pass
    return False


def _find_gguf_file(p: str) -> Optional[str]:
    p = str(p or '')
    if p.lower().endswith('.gguf'):
        return p
    try:
        if os.path.isdir(p):
            cands = [os.path.join(p, fn) for fn in os.listdir(p) if fn.lower().endswith('.gguf')]
            if cands:
                # pick the largest as a heuristic for main model
                cands.sort(key=lambda f: os.stat(f).st_size if os.path.exists(f) else 0, reverse=True)
                return cands[0]
    except Exception:
        pass
    return None


def _pick_free_port(start: int = 10050, end: int = 10150) -> int:
    for port in range(start, end + 1):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            try:
                s.bind(('127.0.0.1', port))
                return port
            except OSError:
                continue
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(('127.0.0.1', 0))
        return int(s.getsockname()[1])


def _http_post_json(url: str, body: dict, timeout: float = 30.0) -> dict:
    data = json.dumps(body or {}).encode('utf-8')
    req = Request(url, data=data, method='POST', headers={'content-type': 'application/json'})
    with urlopen(req, timeout=timeout) as r:
        text = r.read().decode('utf-8')
        try:
            return json.loads(text)
        except Exception:
            raise RuntimeError(f'Invalid JSON from {url}')


def _http_get_json(url: str, timeout: float = 10.0) -> dict:
    req = Request(url, method='GET')
    with urlopen(req, timeout=timeout) as r:
        text = r.read().decode('utf-8')
        try:
            return json.loads(text)
        except Exception:
            raise RuntimeError(f'Invalid JSON from {url}')


logger = logging.getLogger(__name__)


def _truthy(value: Optional[str]) -> bool:
    if value is None:
        return False
    return str(value).strip().lower() in {'1', 'true', 'yes', 'on'}


def _start_gguf_python(model_file: str) -> Dict[str, object]:
    """Create an in-process GGUF runner using Python libraries.

    Preference order:
      1) llama_cpp (pip install llama-cpp-python)
      2) ctransformers (pip install ctransformers)

    Returns a dict with a callable `runner(prompt, max_tokens, temperature) -> str`.
    """
    # Try llama_cpp first
    ctx = int(os.getenv('LLAMACPP_CTX', '4096'))
    n_threads = int(os.getenv('LLAMACPP_THREADS', str(os.cpu_count() or 4)))
    n_batch = int(os.getenv('LLAMACPP_N_BATCH', '512'))
    gpu_available = which('nvidia-smi') is not None and not _truthy(
        os.getenv('LLAMACPP_FORCE_CPU')
    )
    n_gpu_layers_env = os.getenv('LLAMACPP_N_GPU_LAYERS')
    main_gpu_env = os.getenv('LLAMACPP_MAIN_GPU')
    flash_attn_env = os.getenv('LLAMACPP_FLASH_ATTN')
    seed_env = os.getenv('LLAMACPP_SEED')

    # Try llama_cpp
    try:
        from llama_cpp import Llama  # type: ignore
        llama_kwargs: Dict[str, object] = {
            'model_path': model_file,
            'n_ctx': ctx,
            'n_threads': n_threads,
            'n_batch': n_batch,
            'use_mmap': True,
            'use_mlock': False,
            'flash_attn': _truthy(flash_attn_env),
        }
        if seed_env is not None:
            try:
                llama_kwargs['seed'] = int(seed_env)
            except ValueError:
                logger.warning('Invalid LLAMACPP_SEED value %s', seed_env)
        if main_gpu_env is not None:
            try:
                llama_kwargs['main_gpu'] = int(main_gpu_env)
            except ValueError:
                logger.warning('Invalid LLAMACPP_MAIN_GPU value %s', main_gpu_env)
        if n_gpu_layers_env is not None:
            try:
                llama_kwargs['n_gpu_layers'] = int(n_gpu_layers_env)
            except ValueError:
                logger.warning('Invalid LLAMACPP_N_GPU_LAYERS value %s', n_gpu_layers_env)
        elif gpu_available:
            llama_kwargs['n_gpu_layers'] = -1
        else:
            llama_kwargs['n_gpu_layers'] = 0

        logger.info(
            'Loading GGUF with llama.cpp (ctx=%s, threads=%s, batch=%s, gpu_layers=%s, main_gpu=%s)',
            llama_kwargs['n_ctx'],
            llama_kwargs['n_threads'],
            llama_kwargs['n_batch'],
            llama_kwargs.get('n_gpu_layers'),
            llama_kwargs.get('main_gpu', 0),
        )

        llm = Llama(**llama_kwargs)

        def _runner(prompt: str, max_tokens: int, temperature: float) -> str:
            out = llm.create_completion(
                prompt=prompt,
                max_tokens=max_tokens,
                temperature=temperature,
            )
            try:
                return ''.join([c.get('text', '') for c in out.get('choices', [])])
            except Exception:
                return ''

        return {'kind': 'gguf-python', 'runner': _runner, 'model_path': model_file}
    except Exception:
        pass

    # Fallback: ctransformers
    try:
        from ctransformers import AutoModelForCausalLM  # type: ignore

        ctransformers_kwargs: Dict[str, object] = {
            'model_type': "llama",
            'context_length': ctx,
        }
        gpu_layers_env = os.getenv('CTRANSFORMERS_GPU_LAYERS')
        if gpu_layers_env is not None:
            try:
                ctransformers_kwargs['gpu_layers'] = int(gpu_layers_env)
            except ValueError:
                logger.warning('Invalid CTRANSFORMERS_GPU_LAYERS value %s', gpu_layers_env)
        elif gpu_available:
            ctransformers_kwargs['gpu_layers'] = -1

        logger.info(
            'Loading GGUF with ctransformers (ctx=%s, gpu_layers=%s)',
            ctransformers_kwargs['context_length'],
            ctransformers_kwargs.get('gpu_layers'),
        )

        llm = AutoModelForCausalLM.from_pretrained(model_file, **ctransformers_kwargs)

        def _runner(prompt: str, max_tokens: int, temperature: float) -> str:
            # ctransformers exposes a callable model returning a generator/string
            try:
                return llm(
                    prompt,
                    max_new_tokens=max_tokens,
                    temperature=temperature,
                )
            except Exception:
                try:
                    # Some versions expose generate()
                    return llm.generate(
                        prompt,
                        max_new_tokens=max_tokens,
                        temperature=temperature,
                    )
                except Exception:
                    return ''

        return {'kind': 'gguf-python', 'runner': _runner, 'model_path': model_file}
    except Exception:
        pass

    raise HTTPException(
        status_code=500,
        detail=(
            "GGUF backend requires a Python runner. Install one of: "
            "'pip install llama-cpp-python' or 'pip install ctransformers'"
        ),
    )


class LoadModelRequest(BaseModel):
    """Payload for loading a base model and optional LoRA adapters."""

    name: str
    model_path: str
    lora_paths: Optional[Dict[str, str]] = None


class InferenceRequest(BaseModel):
    """Payload for running inference with a selected model and adapter."""

    model_name: str
    lora_name: str
    prompt: str
    max_new_tokens: Optional[int] = 128
    temperature: Optional[float] = 0.7


@app.post("/load_model")
async def load_model(req: LoadModelRequest):
    """Load a base model and its LoRA adapters into memory.

    If the provided ``name`` is already in the registry, returns an error.
    Models and adapters are loaded synchronously; depending on model size
    this endpoint may take several seconds or minutes to respond.  After
    loading, the model and its tokenizer remain resident in RAM.
    """
    model_name = req.name
    if model_name in _models:
        raise HTTPException(status_code=400, detail=f"Model '{model_name}' already loaded.")

    # GGUF flow: in-process Python runner (no external llama-server)
    if _is_gguf_path(req.model_path):
        model_file = _find_gguf_file(req.model_path)
        if not model_file:
            raise HTTPException(status_code=400, detail='No .gguf model found in path')
        gg = _start_gguf_python(model_file)
        _gguf[model_name] = gg
        _models[model_name] = {"backend": "gguf-python"}
        _loras[model_name] = []
        return {"status": "loaded", "model_name": model_name, "via": "gguf-python", "loras": []}

    # HF flow: require transformers/peft
    if not _lazy_import_hf():
        raise HTTPException(status_code=500, detail="HF backend not available (install 'transformers' and 'peft' or use a .gguf model)")
    try:
        tokenizer = AutoTokenizer.from_pretrained(req.model_path)
        base_model = AutoModelForCausalLM.from_pretrained(req.model_path)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to load base model: {e}")

    peft_model = base_model
    loaded_adapters: List[str] = []
    if req.lora_paths:
        first = True
        for adapter_name, adapter_path in req.lora_paths.items():
            try:
                if first:
                    peft_model = PeftModel.from_pretrained(
                        base_model,
                        adapter_path,
                        adapter_name=adapter_name,
                    )
                    first = False
                else:
                    peft_model.load_adapter(
                        adapter_path,
                        adapter_name=adapter_name,
                    )
                loaded_adapters.append(adapter_name)
            except Exception as e:
                raise HTTPException(status_code=500, detail=f"Failed to load adapter '{adapter_name}': {e}")

    _models[model_name] = {"backend": "hf", "model": peft_model, "tokenizer": tokenizer}
    _loras[model_name] = loaded_adapters
    return {"status": "loaded", "model_name": model_name, "via": "hf", "loras": loaded_adapters}


@app.get("/models")
async def list_models():
    """Return the list of loaded base models."""
    return {"models": list(_models.keys())}


@app.get("/models/{model_name}/loras")
async def list_loras(model_name: str):
    """Return the list of LoRA adapters loaded for the given base model."""
    if model_name not in _loras:
        raise HTTPException(status_code=404, detail=f"Model '{model_name}' not found.")
    return {"model": model_name, "loras": _loras[model_name]}


@app.post("/inference")
async def inference(req: InferenceRequest):
    """Generate text using a specified model and LoRA adapter.

    Sets the adapter on the selected model, tokenizes the input prompt,
    generates up to ``max_new_tokens`` tokens with the specified sampling
    temperature, and returns the decoded text.  If the model or adapter
    are not found, returns an appropriate HTTP error.
    """
    model_name = req.model_name
    lora_name = req.lora_name
    prompt = req.prompt
    max_new_tokens = req.max_new_tokens
    temperature = req.temperature

    # Validate that the requested model exists.
    if model_name not in _models:
        raise HTTPException(status_code=404, detail=f"Model '{model_name}' not loaded.")

    backend = _models.get(model_name, {}).get('backend')
    if backend == 'gguf-python':
        gg = _gguf.get(model_name)
        if not gg:
            raise HTTPException(status_code=500, detail='gguf backend missing')
        run = gg.get('runner')
        if not callable(run):
            raise HTTPException(status_code=500, detail='gguf runner invalid')
        try:
            text = str(run(prompt, int(max_new_tokens or 128), float(temperature or 0.7)) or '')
            return {"model": model_name, "lora": lora_name, "prompt": prompt, "result": text}
        except Exception as e:
            raise HTTPException(status_code=500, detail=f"GGUF inference failed: {e}")

    if backend != 'hf':
        raise HTTPException(status_code=500, detail='unknown backend')
    # If adapters were loaded, require a valid adapter; otherwise ignore lora_name
    if _loras.get(model_name):
        if lora_name not in _loras.get(model_name, []):
            raise HTTPException(status_code=404, detail=f"LoRA '{lora_name}' not loaded for model '{model_name}'.")

    model = _models[model_name]["model"]
    tokenizer = _models[model_name]["tokenizer"]
    try:
        # Activate the specified adapter when applicable
        if lora_name:
            try:
                model.set_adapter(lora_name)
            except Exception:
                pass
        inputs = tokenizer(prompt, return_tensors="pt")
        outputs = model.generate(
            **inputs,
            max_new_tokens=max_new_tokens,
            temperature=temperature,
        )
        result = tokenizer.decode(outputs[0], skip_special_tokens=True)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Inference failed: {e}")

    return {"model": model_name, "lora": lora_name, "prompt": prompt, "result": result}


@app.get('/health')
async def health():
    return {"ok": True, "models": list(_models.keys())}


if __name__ == "__main__":
    import uvicorn

    # When run directly, start the FastAPI server.  In production you may
    # choose to run this under Gunicorn or another ASGI server.
    port_env = os.getenv("PORT") or os.getenv("LORA_SERVER_PORT")
    port_cfg = getattr(CFG, "LORA_SERVER_PORT", None) if CFG else None
    port = int(port_env or port_cfg or 8000)
    uvicorn.run(app, host="0.0.0.0", port=port)
