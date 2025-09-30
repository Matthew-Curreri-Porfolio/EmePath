#!/usr/bin/env python3
# RAX-1: case-aware compact language encoder/decoder (no external deps)
import argparse, base64, json, re, sys, zlib
from collections import Counter, defaultdict

STOP = set(("a an the and or but if then else of to for in on at by with from into over under about as is are was were be been being do does did done have has had having this that these those not very really quite more most less least just only".split()))
WS = re.compile(r"\s+")
PUN = re.compile(r"[^\w:/.\-@#\+^ ]+")
TITLE = re.compile(r"(?<!^)[A-Z][a-z]+")  # naive TitleCase mid-sentence

def stem(w):
    for s in ("ingly","edly","ingly","edly","ment","ness","tion","sion","able","ible","less","ful","ing","ed","es","s"):
        if w.endswith(s) and len(w) > len(s) + 2:
            return w[:-len(s)]
    return w

def norm(text):
    text = PUN.sub(" ", text)
    toks = [t for t in WS.split(text) if t]
    return toks

def is_stop(w):
    lw = w.lower()
    return lw in STOP

def detect_entities(raw):
    ents = set()
    for m in TITLE.finditer(raw):
        ents.add(m.group(0))
    return ents

def build_codebook(texts, min_freq=3, max_size=4096):
    cnt = Counter()
    for t in texts:
        for tok in norm(t.lower()):
            if not is_stop(tok):
                cnt.update([stem(tok)])
    vocab = [w for w,f in cnt.most_common(max_size) if f >= min_freq]
    g = {f"g{i}": w for i,w in enumerate(vocab)}
    inv = {v:k for k,v in g.items()}
    return {"g": g, "inv": inv}

def encode_L1(text, cb):
    raw = text
    ents = detect_entities(raw)
    kept, nums, marks = [], [], []
    for t in norm(raw):
        if t.isdigit():
            nums.append(t); continue
        if t.startswith("^"): kept.append(t[1:]); marks.append(t[1:]); continue
        if TITLE.fullmatch(t): kept.append(f"N:{t}"); continue
        lw = t.lower()
        if is_stop(lw): continue
        kept.append(stem(lw))
    inv = cb.get("inv", {})
    ids = [inv.get(tok, tok) for tok in kept]
    return {"tier":"L1","ids":ids,"nums":nums,"marks":marks}

def decode_L1(obj, cb):
    g = cb.get("g", {})
    toks = [g.get(tok, tok) for tok in obj.get("ids",[])]
    toks += obj.get("nums", [])
    return " ".join(toks)

def pack_frames(frames):
    def enc_args(d):
        return ";".join(f"{k}={v}" for k,v in d.items())
    out=[]
    for f in frames:
        ver = str(f.get("ver",1))
        sid = str(f["sid"])
        typ = f["type"]
        op  = f["op"]
        args= enc_args(f.get("args",{}))
        refs= f.get("refs","")
        out.append("|".join((ver,sid,typ,op,args,refs)))
    return "\n".join(out)

def parse_frames(blob):
    out=[]
    for line in blob.splitlines():
        if not line.strip(): continue
        ver,sid,typ,op,args,refs = (line.split("|",5)+[""]*6)[:6]
        ad={}
        if args:
            for kv in args.split(";"):
                if not kv: continue
                k,v = kv.split("=",1)
                ad[k]=v
        out.append({"ver":ver,"sid":sid,"type":typ,"op":op,"args":ad,"refs":refs})
    return out

def raxb_compress(s:str)->str:
    return base64.b85encode(zlib.compress(s.encode("utf-8"), 9)).decode("ascii")

def raxb_decompress(b85:str)->str:
    return zlib.decompress(base64.b85decode(b85.encode("ascii"))).decode("utf-8")

def demo_frames():
    frames=[
        {"sid":"42","type":"G","op":"declare","args":{"layer":"g","r.admin":"admin","r.user":"user","a.restart":"restart","o.api":"api"},"refs":""},
        {"sid":"42","type":"e","op":"run","args":{"r":"g0","a":"g1","o":"g2","T":"pf","C":"0.9"},"refs":""},
        {"sid":"H1","type":"e","op":"tag","args":{"E":"exp","P:lead":"P:eddington","L":"Principe","D":"1919-05-29","out":"confirm-GR","C":"0.8"},"refs":"gGR"}
    ]
    wire = pack_frames(frames)
    blob = raxb_compress(wire)
    return wire, blob

def main():
    ap = argparse.ArgumentParser(description="RAX-1 codec")
    ap.add_argument("--build-cb", action="store_true", help="build codebook from infile")
    ap.add_argument("--encode", action="store_true", help="encode L1 from infile")
    ap.add_argument("--decode", action="store_true", help="decode L1 from infile (expects JSON with codebook+payload)")
    ap.add_argument("--frames-pack", action="store_true", help="pack frames from JSON list to RAX-T")
    ap.add_argument("--frames-parse", action="store_true", help="parse RAX-T into JSON")
    ap.add_argument("--b85", action="store_true", help="wrap/unwrap base85 (compress/decompress)")
    ap.add_argument("--infile")
    ap.add_argument("--min-freq", type=int, default=3)
    args = ap.parse_args()

    if args.build_cb:
        txt = sys.stdin.read() if not args.infile else open(args.infile,"r",encoding="utf-8").read()
        cb = build_codebook([txt], min_freq=args.min_freq)
        print(json.dumps({"g":cb["g"]}, ensure_ascii=False)); return

    if args.encode:
        txt = sys.stdin.read() if not args.infile else open(args.infile,"r",encoding="utf-8").read()
        cb = build_codebook([txt], min_freq=args.min_freq)
        obj = encode_L1(txt, cb)
        print(json.dumps({"codebook":cb["g"],"payload":obj}, ensure_ascii=False)); return

    if args.decode:
        data = json.load(sys.stdin) if not args.infile else json.load(open(args.infile,"r",encoding="utf-8"))
        cb = {"g":data["codebook"], "inv":{v:k for k,v in data["codebook"].items()}}
        print(decode_L1(data["payload"], cb)); return

    if args.frames_pack:
        data = json.load(sys.stdin) if not args.infile else json.load(open(args.infile,"r",encoding="utf-8"))
        print(pack_frames(data)); return

    if args.frames_parse:
        blob = sys.stdin.read() if not args.infile else open(args.infile,"r",encoding="utf-8").read()
        print(json.dumps(parse_frames(blob), ensure_ascii=False, indent=2)); return

    if args.b85:
        # autodetect: if input looks base85, decompress; else compress
        s = sys.stdin.read() if not args.infile else open(args.infile,"r",encoding="utf-8").read()
        try:
            print(raxb_decompress(s.strip()))
        except Exception:
            print(raxb_compress(s)); return
        return

    wire, blob = demo_frames()
    print("RAX-T demo:\n"+wire+"\n")
    print("RAX-B demo (base85):\n"+blob+"\n")
    print("Parsed:", json.dumps(parse_frames(raxb_decompress(blob)), ensure_ascii=False))

if __name__ == "__main__":
    main()
