#!/usr/bin/env python3
import os, json, requests
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
from dotenv import load_dotenv
from tools.prompt_capsule import decode

load_dotenv()
LLAMA_SERVER = os.getenv("LLAMA_SERVER","http://127.0.0.1:8089")
MODEL_A_PATH = os.getenv("MODEL_A_PATH","/models/llama3.gguf")
KEY_HEX = os.getenv("PCAP_KEY","")

app = FastAPI()

class ChatReq(BaseModel):
  capsule: str
  user: str
  params: dict | None = None

@app.post("/chat")
def chat(r: ChatReq):
  try:
    sys_text = decode(MODEL_A_PATH, r.capsule, KEY_HEX if KEY_HEX else None)
  except Exception as e:
    raise HTTPException(status_code=400, detail=f"capsule error: {e}")
  payload = {
    "prompt": f"<<SYS>>{sys_text}<</SYS>>\n{r.user}",
    "temperature": (r.params or {}).get("temperature", 0.7),
    "cache_prompt": True
  }
  try:
    x = requests.post(f"{LLAMA_SERVER}/completion", json=payload, timeout=600)
    x.raise_for_status()
  except Exception as e:
    raise HTTPException(status_code=502, detail=f"llama.cpp upstream error: {e}")
  return x.json()
