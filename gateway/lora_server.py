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
import os
try:
    # Optional: mirror settings from gateway/config.py if available
    # (Python adds script dir to sys.path when executed directly)
    import config as CFG
except Exception:
    CFG = None
from pydantic import BaseModel

try:
    # The required dependencies.  These imports will succeed if you have
    # installed ``transformers`` and ``peft`` in your environment.  If
    # missing, you can install them via pip: ``pip install transformers peft``.
    from transformers import AutoModelForCausalLM, AutoTokenizer
    from peft import PeftModel
except ImportError as e:
    # If dependencies are missing, raise a clear error.  The server will not
    # run without them.
    raise RuntimeError(
        "Required libraries not found. Please install 'transformers' and 'peft'"
    ) from e


app = FastAPI(title="LoRA Model Server", version="0.1.0")

# Data structures to hold loaded models and adapter information.
# ``_models`` maps a user‑defined model name to a dictionary containing
# the loaded tokenizer and PEFT model (base model with adapters attached).
_models: Dict[str, Dict[str, object]] = {}

# ``_loras`` maps a model name to a list of adapter names loaded for that model.
_loras: Dict[str, List[str]] = {}


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

    # Load base tokenizer and model.
    try:
        tokenizer = AutoTokenizer.from_pretrained(req.model_path)
        base_model = AutoModelForCausalLM.from_pretrained(req.model_path)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to load base model: {e}")

    # Start with the base model; adapters will be attached to this instance.
    peft_model = base_model
    loaded_adapters: List[str] = []

    # If LoRA adapters are provided, load them one by one.  The first adapter
    # must be loaded via PeftModel.from_pretrained to wrap the base model.
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

    # Register the model and its adapters.
    _models[model_name] = {
        "model": peft_model,
        "tokenizer": tokenizer,
    }
    _loras[model_name] = loaded_adapters
    return {
        "status": "loaded",
        "model_name": model_name,
        "loras": loaded_adapters,
    }


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
    # Validate that the requested adapter exists for this model.
    if lora_name not in _loras.get(model_name, []):
        raise HTTPException(
            status_code=404,
            detail=f"LoRA '{lora_name}' not loaded for model '{model_name}'.",
        )

    model = _models[model_name]["model"]
    tokenizer = _models[model_name]["tokenizer"]

    try:
        # Activate the specified adapter.
        model.set_adapter(lora_name)
        # Tokenize input.  ``return_tensors='pt'`` produces PyTorch tensors.
        inputs = tokenizer(prompt, return_tensors="pt")
        # Generate output tokens.
        outputs = model.generate(
            **inputs,
            max_new_tokens=max_new_tokens,
            temperature=temperature,
        )
        # Decode the generated tokens into a string.
        result = tokenizer.decode(outputs[0], skip_special_tokens=True)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Inference failed: {e}")

    return {
        "model": model_name,
        "lora": lora_name,
        "prompt": prompt,
        "result": result,
    }


if __name__ == "__main__":
    import uvicorn

    # When run directly, start the FastAPI server.  In production you may
    # choose to run this under Gunicorn or another ASGI server.
    port_env = os.getenv("PORT") or os.getenv("LORA_SERVER_PORT")
    port_cfg = getattr(CFG, "LORA_SERVER_PORT", None) if CFG else None
    port = int(port_env or port_cfg or 8000)
    uvicorn.run(app, host="0.0.0.0", port=port)
