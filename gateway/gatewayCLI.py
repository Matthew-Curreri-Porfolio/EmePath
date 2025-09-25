#!/usr/bin/env python3
"""
Gateway CLI (first GUI) — stdlib only.

Path: gateway/gatewayCLI.py

Env (overrides):
  GATEWAY_BASE       default http://127.0.0.1:3123
  LLAMACPP_SERVER    default http://127.0.0.1:11435
  GW_TOKEN_PATH      default ~/.gateway_cli/token.json
  START_SCRIPT       default ./scripts/start-llama-and-gateway.sh
  MODEL_ARG          optional; forwarded to start script
  LHOST, LPORT, GATEWAY_PORT  optional; forwarded to start script

Examples:
  ./gateway/gatewayCLI.py health
  ./gateway/gatewayCLI.py ready
  ./gateway/gatewayCLI.py models

  ./gateway/gatewayCLI.py rooms dispatch --goal "consensus plan: fix cache"
  ./gateway/gatewayCLI.py db maintain --reencode
  ./gateway/gatewayCLI.py db backup

  ./gateway/gatewayCLI.py login --user me --pass secret
  ./gateway/gatewayCLI.py mem short add --text "rotate keys weekly"
  ./gateway/gatewayCLI.py mem short list

  ./gateway/gatewayCLI.py runtime start         # via /runtime API
  ./gateway/gatewayCLI.py runtime stop
  ./gateway/gatewayCLI.py local start           # runs scripts/start-llama-and-gateway.sh
  ./gateway/gatewayCLI.py local stop            # kills by ports (best-effort)

  ./gateway/gatewayCLI.py lora list
  ./gateway/gatewayCLI.py lora set 0=1.0 1=0.0
  ./gateway/gatewayCLI.py lora erase            # clear slot 0 context

  ./gateway/gatewayCLI.py chat --prompt "ping"  # direct to llama-server
"""
from __future__ import annotations
import argparse, json, os, sys, time, pathlib, subprocess, shlex
from urllib import request, error as urlerror

# -------- defaults --------
DEF_GATEWAY = os.environ.get("GATEWAY_BASE", "http://127.0.0.1:3123").rstrip("/")
DEF_LLAMA   = os.environ.get("LLAMACPP_SERVER", "http://127.0.0.1:11435").rstrip("/")
TOK_PATH    = pathlib.Path(os.environ.get("GW_TOKEN_PATH", str(pathlib.Path.home()/".gateway_cli"/"token.json")))
START_SCRIPT= os.environ.get("START_SCRIPT", "./scripts/start-llama-and-gateway.sh")
TIMEOUT_S   = float(os.environ.get("GW_TIMEOUT", "30"))

# -------- tiny http helper --------
def http_json(method, url, data=None, auth=False, timeout=TIMEOUT_S):
    headers = {"content-type":"application/json"}
    if auth:
        t = _bearer()
        if t: headers["authorization"] = f"Bearer {t}"
    if isinstance(data, (dict, list)): data = json.dumps(data).encode("utf-8")
    elif isinstance(data, str):         data = data.encode("utf-8")
    req = request.Request(url, method=method.upper(), data=data, headers=headers)
    try:
        with request.urlopen(req, timeout=timeout) as resp:
            body = (resp.read() or b"").decode("utf-8", "replace")
            if body.strip().startswith(("{","[")):
                return True, json.loads(body or "null")
            return True, {"ok": True, "status": resp.status, "text": body}
    except urlerror.HTTPError as e:
        try:    return False, json.loads(e.read().decode("utf-8", "replace"))
        except: return False, {"ok": False, "status": e.code, "error": str(e)}
    except Exception as e:
        return False, {"ok": False, "error": str(e)}

def _print(obj, raw=False):
    print(json.dumps(obj, ensure_ascii=False if not raw else True, indent=None if raw else 2))

# -------- token store --------
def _tokdir(): TOK_PATH.parent.mkdir(parents=True, exist_ok=True)
def _save_token(obj):
    _tokdir(); TOK_PATH.write_text(json.dumps(obj, ensure_ascii=False, indent=2))
def _load_token():
    try: return json.loads(TOK_PATH.read_text())
    except: return None
def _bearer():
    t = _load_token()
    if not t: return None
    if isinstance(t, str): return t
    for k in ("token","accessToken","access_token","jwt","bearer"):
        if k in t and t[k]: return t[k]
    return None

# -------- lora utils --------
def _parse_id_scale(pairs):
    out=[]
    for p in pairs:
        if "=" not in p: continue
        k,v = p.split("=",1)
        try:
            out.append({"id": int(k), "scale": float(v)})
        except: pass
    return out

# -------- local start/stop helpers --------
def _env_for_start(args):
    env = os.environ.copy()
    # pass-through commonly tuned knobs if provided
    for k in ("MODEL_ARG","LHOST","LPORT","LLAMACPP_PORT","GATEWAY_PORT"):
        v = getattr(args, k.lower(), None)
        if v: env[k] = str(v)
    # also mirror LLAMACPP_SERVER if you want gateway to see it
    if "LLAMACPP_SERVER" not in env:
        env["LLAMACPP_SERVER"] = f"http://{env.get('LHOST','127.0.0.1')}:{env.get('LLAMACPP_PORT', env.get('LPORT','11435'))}"
    return env

def _kill_port(port:int):
    # best-effort: lsof may not exist on minimal images; try fuser first
    cmds = [
        f"lsof -t -i :{port}",
        f"fuser -k {port}/tcp || true"
    ]
    pids = []
    try:
        r = subprocess.run(cmds[0], shell=True, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True, timeout=2)
        pids = [int(x) for x in r.stdout.strip().split() if x.strip().isdigit()]
    except: pass
    if pids:
        subprocess.run(["kill"] + [str(p) for p in pids], check=False)
        time.sleep(0.5)
        # force if stubborn
        for p in pids:
            try: os.kill(p, 9)
            except: pass

# =====================================================================================
# Commands
# =====================================================================================
def cmd_health(a): _print(http_json("GET", f"{a.base}/health")[1], a.raw)
def cmd_ready(a):  _print(http_json("GET", f"{a.base}/ready")[1], a.raw)
def cmd_models(a): _print(http_json("GET", f"{a.base}/models")[1], a.raw)

def cmd_rooms_dispatch(a):
    payload={"goal": a.goal}
    if a.id: payload["id"] = a.id
    ok,out = http_json("POST", f"{a.base}/rooms/dispatch", payload)
    _print(out, a.raw)

def cmd_db_maintain(a):
    ok,out = http_json("POST", f"{a.base}/db/maintain", {"reencode": bool(a.reencode)}, auth=True)
    _print(out, a.raw)

def cmd_db_backup(a):
    ok,out = http_json("POST", f"{a.base}/db/backup", {}, auth=True)
    _print(out, a.raw)

def cmd_login(a):
    ok,out = http_json("POST", f"{a.base}/auth/login", {"user": a.user, "password": a.password})
    if not ok: _print(out, a.raw); sys.exit(1)
    token = None
    if isinstance(out, dict):
        for k in ("token","accessToken","access_token","jwt","bearer"):
            if k in out: token = out[k]
        if not token:
            for v in out.values():
                if isinstance(v, str) and len(v) > 16: token = v; break
    _save_token(out if token is None else {"token": token})
    print("[ok] token saved.")

# memory CRUD
def _mem_path(scope): return f"/memory/{'short' if scope=='short' else 'long'}"
def cmd_mem_list(a):
    ok,out = http_json("GET", f"{a.base}{_mem_path(a.scope)}", auth=True)
    _print(out, a.raw)
def cmd_mem_get(a):
    ok,out = http_json("GET", f"{a.base}{_mem_path(a.scope)}/{a.id}", auth=True)
    _print(out, a.raw)
def cmd_mem_add(a):
    body = {"content": a.text} if a.text else {}
    if a.json:
        data = a.json
        if data.startswith("@"):
            body.update(json.loads(pathlib.Path(data[1:]).read_text()))
        else:
            try: body.update(json.loads(data))
            except: body["content"] = data
    ok,out = http_json("POST", f"{a.base}{_mem_path(a.scope)}", body, auth=True)
    _print(out, a.raw)
def cmd_mem_del(a):
    ok,out = http_json("DELETE", f"{a.base}{_mem_path(a.scope)}/{a.id}", auth=True)
    _print(out, a.raw)

# runtime via routes
def cmd_runtime_start(a):
    ok,out = http_json("POST", f"{a.base}/runtime/llama/start", {})
    _print(out, a.raw)
def cmd_runtime_stop(a):
    ok,out = http_json("POST", f"{a.base}/runtime/llama/stop", {})
    _print(out, a.raw)

# local start/stop calls your bash starter
def cmd_local_start(a):
    # compose env → call START_SCRIPT
    env = _env_for_start(a)
    script = a.script or START_SCRIPT
    if not pathlib.Path(script).exists():
        print(f"ERR: start script not found: {script}", file=sys.stderr); sys.exit(2)
    print(f"[*] exec {script} …")
    r = subprocess.run([script], env=env, cwd=str(pathlib.Path("./").resolve()))
    if r.returncode != 0: sys.exit(r.returncode)
    # quick readiness ping
    ok,rd = http_json("GET", f"{a.base}/ready")
    _print({"ok": ok and rd.get("ok", False), "ready": rd}, a.raw)

def cmd_local_stop(a):
    # best-effort: kill ports provided or defaults
    lport = int(a.lport or os.environ.get("LLAMACPP_PORT") or os.environ.get("LPORT") or 11435)
    gport = int(a.gateway_port or os.environ.get("GATEWAY_PORT") or 3123)
    print(f"[*] killing listeners on :{lport} and :{gport}")
    _kill_port(lport); _kill_port(gport)
    print("[ok] stopped.")

# warmup (gateway)
def cmd_warmup(a):
    payload = {"prompt": a.prompt or "ping", "max_tokens": a.max_tokens}
    ok,out = http_json("POST", f"{a.base}/warmup", payload)
    _print(out, a.raw)

# llama.cpp LoRA management
def cmd_lora_list(a):
    ok,out = http_json("GET", f"{a.llama}/lora-adapters")
    _print(out if ok else {"ok": False, "error": out}, a.raw)
def cmd_lora_set(a):
    items = _parse_id_scale(a.adapters)
    if not items:
        print("usage: lora set ID=SCALE [ID=SCALE...]", file=sys.stderr); sys.exit(2)
    ok,out = http_json("POST", f"{a.llama}/lora-adapters", items)
    _print(out if ok else {"ok": False, "error": out}, a.raw)
def cmd_lora_erase(a):
    slot = int(a.slot or 0)
    ok,out = http_json("POST", f"{a.llama}/slots/{slot}?action=erase", {})
    _print(out if ok else {"ok": False, "error": out}, a.raw)

# direct chat to llama-server
def cmd_chat(a):
    payload = {
        "model": a.model or "gateway-llama",
        "messages": [{"role":"user","content": a.prompt}],
        "max_tokens": a.max_tokens,
        "temperature": a.temperature
    }
    ok,out = http_json("POST", f"{a.llama}/v1/chat/completions", payload)
    _print(out if ok else {"ok": False, "error": out}, a.raw)

# =====================================================================================
# Parser
# =====================================================================================
def build_parser():
    p = argparse.ArgumentParser(prog="gatewayCLI", description="Gateway control CLI")
    p.add_argument("--base", default=DEF_GATEWAY, help=f"gateway base (default {DEF_GATEWAY})")
    p.add_argument("--llama", default=DEF_LLAMA, help=f"llama.cpp server (default {DEF_LLAMA})")
    p.add_argument("--raw", action="store_true", help="raw JSON")
    sp = p.add_subparsers(dest="cmd")

    # health/readiness/models
    sp.add_parser("health").set_defaults(func=cmd_health)
    sp.add_parser("ready").set_defaults(func=cmd_ready)
    sp.add_parser("models").set_defaults(func=cmd_models)

    # rooms
    pr = sp.add_parser("rooms")
    sr = pr.add_subparsers(dest="rooms_cmd")
    srd = sr.add_parser("dispatch")
    srd.add_argument("--goal", required=True)
    srd.add_argument("--id")
    srd.set_defaults(func=cmd_rooms_dispatch)

    # DB
    pdb = sp.add_parser("db")
    sdb = pdb.add_subparsers(dest="db_cmd")
    s1 = sdb.add_parser("maintain"); s1.add_argument("--reencode", action="store_true"); s1.set_defaults(func=cmd_db_maintain)
    s2 = sdb.add_parser("backup");   s2.set_defaults(func=cmd_db_backup)

    # auth
    pa = sp.add_parser("login"); pa.add_argument("--user", required=True); pa.add_argument("--pass", dest="password", required=True); pa.set_defaults(func=cmd_login)

    # memory
    pm = sp.add_parser("mem")
    sm = pm.add_subparsers(dest="mem_cmd")
    for scope in ("short","long"):
        px = sm.add_parser(scope)
        sx = px.add_subparsers(dest=f"{scope}_cmd")
        l = sx.add_parser("list"); l.set_defaults(func=cmd_mem_list, scope=scope)
        g = sx.add_parser("get");  g.add_argument("--id", required=True); g.set_defaults(func=cmd_mem_get, scope=scope)
        a = sx.add_parser("add");  a.add_argument("--text"); a.add_argument("--json"); a.set_defaults(func=cmd_mem_add, scope=scope)
        d = sx.add_parser("del");  d.add_argument("--id", required=True); d.set_defaults(func=cmd_mem_del, scope=scope)

    # runtime via routes
    prt = sp.add_parser("runtime")
    srt = prt.add_subparsers(dest="rt_cmd")
    srt.add_parser("start").set_defaults(func=cmd_runtime_start)
    srt.add_parser("stop").set_defaults(func=cmd_runtime_stop)

    # local start/stop (bash)
    pl = sp.add_parser("local")
    sl = pl.add_subparsers(dest="local_cmd")
    st = sl.add_parser("start")
    st.add_argument("--script", help=f"path to start script (default {START_SCRIPT})")
    st.add_argument("--model_arg", dest="model_arg")
    st.add_argument("--lhost"); st.add_argument("--lport"); st.add_argument("--gateway_port")
    st.set_defaults(func=cmd_local_start)
    sp_stop = sl.add_parser("stop")
    sp_stop.add_argument("--lport"); sp_stop.add_argument("--gateway_port")
    sp_stop.set_defaults(func=cmd_local_stop)

    # lora mgmt (llama-server)
    plo = sp.add_parser("lora")
    slo = plo.add_subparsers(dest="lora_cmd")
    slo.add_parser("list").set_defaults(func=cmd_lora_list)
    ss = slo.add_parser("set"); ss.add_argument("adapters", nargs="+"); ss.set_defaults(func=cmd_lora_set)
    se = slo.add_parser("erase"); se.add_argument("--slot", default=0); se.set_defaults(func=cmd_lora_erase)

    # direct chat (smoke)
    pc = sp.add_parser("chat")
    pc.add_argument("--prompt", required=True)
    pc.add_argument("--model", default="gateway-llama")
    pc.add_argument("--max_tokens", type=int, default=128)
    pc.add_argument("--temperature", type=float, default=0.2)
    pc.set_defaults(func=cmd_chat)

    # warmup
    pw = sp.add_parser("warmup")
    pw.add_argument("--prompt", default="ping")
    pw.add_argument("--max_tokens", type=int, default=32)
    pw.set_defaults(func=cmd_warmup)

    return p

def main():
    p = build_parser()
    a = p.parse_args()
    if not getattr(a, "func", None):
        p.print_help(); sys.exit(2)
    a.func(a)

if __name__ == "__main__":
    main()
