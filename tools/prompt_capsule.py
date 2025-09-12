#!/usr/bin/env python3
import argparse, base64, hashlib, hmac, json, os, struct, sys, zlib
from llama_cpp import Llama

def varint_pack(nums):
  b = bytearray()
  for n in nums:
    while True:
      byte = n & 0x7F
      n >>= 7
      if n != 0: b.append(byte | 0x80)
      else: b.append(byte); break
  return bytes(b)

def varint_unpack(b):
  out=[]; val=0; shift=0
  for byte in b:
    val |= (byte & 0x7F) << shift
    if byte & 0x80: shift += 7
    else: out.append(val); val=0; shift=0
  if shift!=0: raise ValueError("truncated varint")
  return out

def hmac256(key, data): return hmac.new(key, data, hashlib.sha256).hexdigest()

def load_tokenizer(model_path):
  return Llama(model_path=model_path, vocab_only=True, embedding=False, n_ctx=8)

def encode(model_path, prompt, key_hex=None, tokenizer_hint=None):
  llm = load_tokenizer(model_path)
  toks = llm.tokenize(prompt.encode("utf-8"), special=True)
  raw = varint_pack(toks)
  blob = zlib.compress(raw, 9)
  header = {
    "version":"PCAP-V1",
    "tokenizer": tokenizer_hint or os.path.basename(model_path),
    "tok_hash": hashlib.sha256((llm.metadata.get("tokenizer.ggml.model","") or "").encode()).hexdigest(),
    "enc":"b64+zlib+varint"
  }
  blob64 = base64.b64encode(blob).decode()
  mac = hmac256(bytes.fromhex(key_hex), (json.dumps(header,sort_keys=True).encode()+blob)) if key_hex else None
  return json.dumps({"header":header,"blob":blob64,"mac":mac})

def decode(modelA_path, capsule_json, key_hex=None):
  cap = json.loads(capsule_json)
  header, blob64, mac = cap["header"], cap["blob"], cap.get("mac")
  blob = base64.b64decode(blob64)
  if key_hex:
    expect = hmac256(bytes.fromhex(key_hex), (json.dumps(header,sort_keys=True).encode()+blob))
    if not hmac.compare_digest(expect, mac): raise SystemExit("HMAC mismatch")
  toks = varint_unpack(zlib.decompress(blob))
  llmA = load_tokenizer(modelA_path)
  text = llmA.detokenize(toks).decode("utf-8","replace")
  return text

if __name__ == "__main__":
  ap = argparse.ArgumentParser()
  sub = ap.add_subparsers(dest="cmd", required=True)
  e = sub.add_parser("encode"); e.add_argument("--model", required=True); e.add_argument("--key"); e.add_argument("--hint"); e.add_argument("--infile")
  d = sub.add_parser("decode"); d.add_argument("--modelA", required=True); d.add_argument("--key"); d.add_argument("--infile")
  args = ap.parse_args()
  if args.cmd=="encode":
    prompt = sys.stdin.read() if not args.infile else open(args.infile,"r",encoding="utf-8").read()
    print(encode(args.model, prompt, args.key, args.hint))
  else:
    capsule = sys.stdin.read() if not args.infile else open(args.infile,"r",encoding="utf-8").read()
    print(decode(args.modelA, capsule, args.key))
