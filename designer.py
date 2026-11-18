#!/usr/bin/env python3
"""Saint Local Designer — prompt + references -> native Figma screens, using a local model in Ollama.

  ./design "Onboarding flow: welcome, phone, OTP, PIN" --ref ~/Desktop/ref.png
  ./design "Savings goal detail" --ref-selection         # use the frame(s) selected in Figma as references
  ./design harvest                                       # save your hand-fixed frames as training data
  ./design export-training                               # build an MLX fine-tuning set
  ./design check                                         # test Ollama + model
"""
import argparse, asyncio, base64, json, pathlib, re, shutil, sys, time, urllib.request, uuid
from datetime import datetime

ROOT = pathlib.Path(__file__).resolve().parent
CFG = json.loads((ROOT / "config.json").read_text())
DATA = ROOT / "dataset"
RUNS, APPROVED, TRAIN = DATA / "runs", DATA / "approved", DATA / "train"
for d in (RUNS, APPROVED, TRAIN):
    d.mkdir(parents=True, exist_ok=True)

TYPES = {"frame", "text", "rect", "ellipse", "image", "instance"}
COLOR_KEYS = ("fill", "color")


# ---------------------------------------------------------------- helpers
def read(p):
    p = ROOT / p
    return p.read_text() if p.exists() else ""


def tokens(brand):
    p = ROOT / "brands" / f"{brand}.tokens.json"
    return json.loads(p.read_text()) if p.exists() else {"frame": {"w": 390, "h": 844}, "fonts": {}, "colors": {}}


def b64file(path):
    return base64.b64encode(pathlib.Path(path).expanduser().read_bytes()).decode()


def say(msg):
    print(msg, flush=True)


def ollama(path, body=None, timeout=1800):
    req = urllib.request.Request(
        CFG["ollama_url"] + path,
        data=json.dumps(body).encode() if body is not None else None,
        headers={"Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read())


def chat(messages):
    body = {
        "model": CFG["model"], "messages": messages, "stream": False, "format": "json", "keep_alive": "30m",
        "options": {"num_ctx": CFG["num_ctx"], "temperature": CFG["temperature"], "num_predict": CFG.get("num_predict", 7000), "repeat_penalty": CFG.get("repeat_penalty", 1.08)},
    }
    if CFG.get("think"):
        body["think"] = True
    t = time.time()
    out = ollama("/api/chat", body)["message"]["content"]
    say(f"  model answered in {time.time() - t:.0f}s")
    return out


def parse_json(text):
    text = re.sub(r"^```(?:json)?|```$", "", text.strip(), flags=re.M).strip()
    a, b = text.find("{"), text.rfind("}")
    if a < 0 or b < 0:
        raise ValueError("no JSON object in the answer")
    return json.loads(text[a : b + 1])



def is_screen(n):
    if not isinstance(n, dict) or n.get("type", "frame") != "frame":
        return False
    kids = n.get("children") or []
    has_status = any(isinstance(k, dict) and str(k.get("component", "")).lower() == "status bar" for k in kids)
    tall = isinstance(n.get("h"), (int, float)) and n["h"] >= 700
    return has_status or tall


def hoist_screens(spec):
    """Small models sometimes close brackets late and nest the next screen inside the previous one. Pull those back out."""
    moved = []

    def walk(node, found):
        keep = []
        for c in node.get("children") or []:
            if is_screen(c):
                found.append(c)
                moved.append(c.get("name", "?"))
                walk(c, found)
            else:
                keep.append(c)
                if isinstance(c, dict):
                    walk(c, found)
        if "children" in node:
            node["children"] = keep

    out = []
    for s in spec["screens"]:
        extra = []
        if isinstance(s, dict):
            walk(s, extra)
        out.append(s)
        out.extend(extra)
    spec["screens"] = out
    if moved:
        say("  fixed nesting: pulled out " + ", ".join(moved))
    return spec


def split_instances(node):
    """A component can't hold children. If the model put a group inside one, keep the group as a frame and put the component after it."""
    kids = node.get("children") if isinstance(node, dict) else None
    if not isinstance(kids, list):
        return
    out = []
    for c in kids:
        if isinstance(c, dict) and c.get("type") == "instance" and isinstance(c.get("children"), list) and c["children"]:
            group = {"type": "frame", "name": (c.get("name") or "Group") + " group", "layout": c.get("layout", "col"),
                     "gap": c.get("gap", 8), "w": "fill", "children": c["children"]}
            inst = {k: v for k, v in c.items() if k not in ("children", "layout", "gap", "pad", "align", "cross")}
            split_instances(group)
            out += [group, inst]
            say(f"  fixed: moved content out of component '{c.get('name') or c.get('component')}'")
        else:
            split_instances(c)
            out.append(c)
    node["children"] = out


def lift_tab_bar(screen):
    """The Tab bar must be a direct child of the screen (it's positioned against the screen)."""
    found = []

    def walk(n):
        kids = n.get("children")
        if not isinstance(kids, list):
            return
        keep = []
        for c in kids:
            if isinstance(c, dict) and str(c.get("component", "")).lower() == "tab bar":
                found.append(c)
            else:
                keep.append(c)
                if isinstance(c, dict):
                    walk(c)
        n["children"] = keep

    for c in screen.get("children") or []:
        if isinstance(c, dict):
            walk(c)
    if found:
        tb = found[-1]
        tb.update({"absolute": True, "x": 16, "y": 836})
        screen.setdefault("children", []).append(tb)
        say("  fixed: moved Tab bar to screen level")

def validate(spec, catalog_names):
    errs = []
    if isinstance(spec, dict) and "screens" not in spec and spec.get("name"):
        spec = {"screens": [spec]}
    if not isinstance(spec, dict) or not isinstance(spec.get("screens"), list) or not spec["screens"]:
        return spec, ['Top level must be {"screens": [ ... ]} with at least one screen.']
    spec = hoist_screens(spec)
    for sc in spec["screens"]:
        split_instances(sc)
        if isinstance(sc, dict):
            lift_tab_bar(sc)
    seen = set()

    def walk(n, path):
        if not isinstance(n, dict):
            errs.append(f"{path}: must be an object")
            return
        t = n.get("type", "frame")
        if t not in TYPES:
            errs.append(f'{path}: unknown type "{t}" (use one of {sorted(TYPES)})')
        if t == "text" and "text" not in n:
            errs.append(f'{path}: text node needs "text"')
        if t == "instance" and catalog_names and str(n.get("component", "")).lower() not in catalog_names:
            errs.append(f'{path}: component "{n.get("component")}" is not in the component list — use an exact name or build it with frames')
        for k in ("w", "h"):
            if k in n and not (isinstance(n[k], (int, float)) or n[k] in ("fill", "hug")):
                errs.append(f'{path}.{k}: must be a number, "fill" or "hug"')
        kids = n.get("children", [])
        if kids and not isinstance(kids, list):
            errs.append(f"{path}.children must be a list")
            return
        for i, c in enumerate(kids or []):
            walk(c, f"{path}.children[{i}]")

    for i, s in enumerate(spec["screens"]):
        name = s.get("name") if isinstance(s, dict) else None
        if not name:
            errs.append(f'screens[{i}] needs a unique "name"')
        elif name.lower() in seen:
            errs.append(f'screen name "{name}" is used twice')
        else:
            seen.add(name.lower())
        walk(s, f"screens[{i}]")
    return spec, errs[:15]


def resolve(node, tok):
    """Swap token names (p800, display, ...) for real values before sending to Figma."""
    colors, fonts = tok.get("colors", {}), tok.get("fonts", {})

    def col(v):
        if isinstance(v, str) and not v.startswith("#") and v in colors:
            return colors[v]
        if isinstance(v, dict) and isinstance(v.get("gradient"), list):
            return {**v, "gradient": [colors.get(c, c) if isinstance(c, str) else c for c in v["gradient"]]}
        return v

    if isinstance(node, list):
        return [resolve(n, tok) for n in node]
    if not isinstance(node, dict):
        return node
    if node.get("type") == "text" and "tracking" not in node and "tracking" in tok:
        node = {**node, "tracking": tok["tracking"]}
    out = {}
    for k, v in node.items():
        if k in COLOR_KEYS:
            v = col(v)
        elif k in ("stroke", "shadow") and isinstance(v, dict) and "color" in v:
            v = {**v, "color": col(v["color"])}
        elif k == "stroke" and isinstance(v, str):
            v = col(v)
        elif k == "font" and v in fonts:
            v = fonts[v]
        elif isinstance(v, (dict, list)):
            v = resolve(v, tok)
        out[k] = v
    return out


def system_prompt(brand, catalog):
    tok = tokens(brand)
    parts = [read("rules/core.md"), read(f"brands/{brand}.md")]
    named = {k: v for k, v in tok.get("colors", {}).items()}
    parts.append("## Colour tokens (use these names)\n" + json.dumps(named))
    parts.append("## Font tokens\n" + json.dumps(tok.get("fonts", {})))
    comps = (catalog or {}).get("components", [])
    if comps:
        groups, lines = {}, []
        for c in comps:
            if "/" in c["name"]:
                pre, _, rest = c["name"].partition("/")
                groups.setdefault(pre, []).append(rest)
            else:
                lines.append(f'- "{c["name"]}" ({c["w"]}x{c["h"]})' + (f' props: {json.dumps(c["props"])}' if c["props"] else "") + (f' — {c.get("desc")}' if c.get("desc") else ""))
        for pre, names in groups.items():
            lines.append(f'- {pre} options (use the name after "{pre}/" as the value of a "{pre}" prop): ' + ", ".join(names))
        parts.append("## Components in this Figma file (use with type \"instance\")\n" + "\n".join(lines))
    else:
        parts.append("## Components\nNone in this file. Build everything from frames and text.")
    extra = ROOT / "rules" / "extra.md"
    if extra.exists():
        parts.append(extra.read_text())
    return "\n\n".join(p for p in parts if p)


def examples(brand):
    """Your approved past work, newest first, as few-shot examples. This is what makes it design like you."""
    msgs, used = [], 0
    files = sorted(APPROVED.glob("*.json"), reverse=True)
    for f in files:
        rec = json.loads(f.read_text())
        if rec.get("brand") != brand:
            continue
        spec = json.dumps(rec["spec"], separators=(",", ":"))
        if used + len(spec) > CFG["example_chars"] or len(msgs) // 2 >= CFG["max_examples"]:
            continue
        msgs += [{"role": "user", "content": rec["prompt"]}, {"role": "assistant", "content": spec}]
        used += len(spec)
    return msgs


# ---------------------------------------------------------------- Figma bridge
class Bridge:
    def __init__(self):
        self.ws, self.pending, self.connected = None, {}, asyncio.Event()

    async def handler(self, ws):
        self.ws = ws
        self.connected.set()
        say("✓ Figma plugin connected")
        try:
            async for raw in ws:
                m = json.loads(raw)
                fut = self.pending.pop(m.get("id"), None)
                if fut and not fut.done():
                    fut.set_result(m)
        finally:
            if self.ws is ws:
                self.ws = None
                self.connected.clear()
                say("… Figma plugin disconnected")

    async def call(self, cmd, timeout=600, **kw):
        if not self.ws:
            say("Waiting for Figma: open your file → Plugins → Development → Saint Local Designer")
            await self.connected.wait()
        mid = uuid.uuid4().hex[:8]
        fut = asyncio.get_running_loop().create_future()
        self.pending[mid] = fut
        await self.ws.send(json.dumps({"id": mid, "cmd": cmd, **kw}))
        m = await asyncio.wait_for(fut, timeout)
        if not m.get("ok"):
            raise RuntimeError(m.get("error"))
        return m["data"]


async def ask(prompt):
    return (await asyncio.to_thread(input, prompt)).strip()


# ---------------------------------------------------------------- commands
async def generate(msgs, catalog_names, tries=3):
    for attempt in range(tries):
        say("→ Designing…" if attempt == 0 else f"→ Fixing spec (attempt {attempt + 1})…")
        raw = await asyncio.to_thread(chat, msgs)
        try:
            spec, errs = validate(parse_json(raw), catalog_names)
        except Exception as e:
            spec, errs = None, [f"Invalid JSON: {e}"]
        if not errs:
            return spec, raw
        say("  problems: " + "; ".join(errs[:4]))
        msgs = msgs + [
            {"role": "assistant", "content": raw[:12000]},
            {"role": "user", "content": "Fix these problems and return the full corrected JSON only:\n- " + "\n- ".join(errs)},
        ]
    if spec and isinstance(spec, dict) and spec.get("screens"):
        say("  rendering anyway with remaining problems")
        return spec, raw
    raise SystemExit("The model could not produce a valid spec. Try a shorter brief, fewer screens, or a larger model.")


async def cmd_design(bridge, a):
    brand = a.brand or CFG["default_brand"]
    tok = tokens(brand)
    run_id = datetime.now().strftime("%Y%m%d-%H%M%S")
    rdir = RUNS / run_id
    rdir.mkdir(parents=True)
    say(f"Run {run_id} · model {CFG['model']} · brand {brand}")

    catalog = {} if a.dry else await bridge.call("catalog")
    names = {c["name"].lower() for c in catalog.get("components", [])}

    refs, ref_files = [], []
    for i, r in enumerate(a.ref or []):
        p = pathlib.Path(r).expanduser()
        shutil.copy(p, rdir / f"ref{i}{p.suffix}")
        ref_files.append(f"ref{i}{p.suffix}")
        refs.append(b64file(p))
    if a.ref_selection and not a.dry:
        for i, img in enumerate(await bridge.call("export_selection")):
            (rdir / f"ref_sel{i}.png").write_bytes(base64.b64decode(img))
            ref_files.append(f"ref_sel{i}.png")
            refs.append(img)

    brief = a.prompt + (f"\n\n{len(refs)} reference image(s) attached." if refs else "")
    base = [{"role": "system", "content": system_prompt(brand, catalog)}] + examples(brand)
    user = {"role": "user", "content": brief, **({"images": refs} if refs else {})}
    spec, raw = await generate(base + [user], names)
    (rdir / "v1.json").write_text(json.dumps(spec, indent=1))

    if a.dry:
        print(json.dumps(spec, indent=1))
        return

    rec = {"id": run_id, "brand": brand, "model": CFG["model"], "prompt": a.prompt, "refs": ref_files, "versions": []}
    section, version, feedback_log = None, 1, []

    async def render(s):
        nonlocal section
        say("→ Building in Figma…")
        res = await bridge.call("render", spec=resolve(s, tok), title=f"{run_id} · {a.prompt[:40]}", replace=section,
                                defaultFont=tok["fonts"].get("ui", "Inter"), w=tok["frame"]["w"], h=tok["frame"]["h"])
        section = res["section"]
        for i, img in enumerate(res["images"]):
            (rdir / f"v{version}_{i}.png").write_bytes(base64.b64decode(img))
        if res["warnings"]:
            say("  Figma notes: " + " | ".join(res["warnings"][:6]))
        return res

    res = await render(spec)
    for _ in range(0 if a.no_review else CFG["review_passes"]):
        version += 1
        say("→ Self-review of the render…")
        crit = {"role": "user", "images": res["images"], "content":
                "These images are the screens your JSON produced, in order. Review them against the brief, references and rules: "
                "clipped or overlapping text, misalignment, cramped or uneven spacing, weak contrast, missing content, more than one primary button. "
                "Return the full improved JSON only. If nothing needs fixing, return it unchanged."}
        new, raw2 = await generate(base + [user, {"role": "assistant", "content": json.dumps(spec)}, crit], names)
        if new == spec:
            say("  no changes")
            break
        spec = new
        (rdir / f"v{version}.json").write_text(json.dumps(spec, indent=1))
        res = await render(spec)

    while True:
        fb = await ask("\nFeedback to revise · 'ok' approve (saves as training data) · 'keep' save without approving · 'q' discard\n> ")
        if fb.lower() in ("ok", "approve", "5", "y"):
            rec.update(approved=True, spec=spec, feedback=feedback_log)
            (APPROVED / f"{run_id}.json").write_text(json.dumps({"brand": brand, "prompt": a.prompt, "spec": spec, "source": "model"}))
            say("✓ Approved. Fix anything by hand in Figma, select the screens and run ./design harvest to save the corrected version.")
            break
        if fb.lower() in ("keep", "skip"):
            rec.update(approved=False, spec=spec, feedback=feedback_log)
            break
        if fb.lower() in ("q", "quit"):
            rec.update(approved=False, discarded=True, feedback=feedback_log)
            break
        if not fb:
            continue
        feedback_log.append(fb)
        version += 1
        rev = {"role": "user", "images": res["images"], "content": f"Current render attached. Revise: {fb}\nReturn the full JSON only."}
        spec, raw = await generate(base + [user, {"role": "assistant", "content": json.dumps(spec)}, rev], names)
        (rdir / f"v{version}.json").write_text(json.dumps(spec, indent=1))
        res = await render(spec)

    rec["section"] = section
    (rdir / "record.json").write_text(json.dumps(rec, indent=1))
    with open(DATA / "log.jsonl", "a") as f:
        f.write(json.dumps({k: rec.get(k) for k in ("id", "brand", "model", "prompt", "approved")}) + "\n")


async def cmd_harvest(bridge, a):
    run = a.run or (sorted(p.name for p in RUNS.iterdir())[-1] if any(RUNS.iterdir()) else None)
    rec = json.loads((RUNS / run / "record.json").read_text()) if run and (RUNS / run / "record.json").exists() else {}
    prompt = a.prompt or rec.get("prompt")
    if not prompt:
        raise SystemExit("No run found to attach this to. Use: ./design harvest --prompt \"what this screen set is\" --brand generic")
    say("Select the finished screens (or their section) in Figma…")
    spec = await bridge.call("serialize_selection")
    brand = a.brand or rec.get("brand") or CFG["default_brand"]
    name = f"{run or datetime.now().strftime('%Y%m%d-%H%M%S')}-gold"
    (APPROVED / f"{name}.json").write_text(json.dumps({"brand": brand, "prompt": prompt, "spec": spec, "source": "human"}))
    say(f"✓ Saved {len(spec['screens'])} screen(s) as gold training data for: “{prompt[:60]}”")


def cmd_export_training(a):
    import random
    rows = []
    for f in sorted(APPROVED.glob("*.json")):
        rec = json.loads(f.read_text())
        sys_msg = read("rules/core.md") + "\n\n" + read(f"brands/{rec['brand']}.md")
        rows.append({"messages": [
            {"role": "system", "content": sys_msg},
            {"role": "user", "content": rec["prompt"]},
            {"role": "assistant", "content": json.dumps(rec["spec"], separators=(",", ":"))},
        ]})
    if len(rows) < 10:
        say(f"Only {len(rows)} approved examples. Collect at least 100–200 before fine-tuning; few-shot examples already use them.")
    random.seed(7)
    random.shuffle(rows)
    cut = max(1, len(rows) // 10)
    for name, part in (("valid", rows[:cut]), ("train", rows[cut:] or rows)):
        with open(TRAIN / f"{name}.jsonl", "w") as f:
            f.writelines(json.dumps(r) + "\n" for r in part)
    say(f"✓ Wrote {len(rows) - cut} train / {cut} valid rows to dataset/train/. See TRAINING.md.")


def cmd_check(a):
    try:
        tags = [m["name"] for m in ollama("/api/tags", timeout=10)["models"]]
    except Exception as e:
        raise SystemExit(f"✗ Ollama isn't running ({e}). Open the Ollama app, then try again.")
    say("✓ Ollama is running. Models: " + ", ".join(tags))
    want = CFG["model"]
    if not any(t == want or t.split(":")[0] == want for t in tags):
        raise SystemExit(f"✗ Model '{want}' not found. Run: ollama pull {want}  (or set \"model\" in config.json)")
    say(f"→ Test call to {want}…")
    out = chat([{"role": "user", "content": 'Return {"ok": true} as JSON.'}])
    say("✓ Model replied: " + out.strip()[:80])



async def cmd_rerender(bridge, a):
    run = a.run or sorted(p.name for p in RUNS.iterdir() if p.is_dir())[-1]
    rdir = RUNS / run
    vs = sorted(rdir.glob("v*.json"), key=lambda p: int(re.sub(r"\\D", "", p.stem) or 0))
    if not vs:
        raise SystemExit(f"No saved design in run {run}")
    spec = json.loads(vs[-1].read_text())
    brand = a.brand or CFG["default_brand"]
    catalog = await bridge.call("catalog")
    spec, errs = validate(spec, {c["name"].lower() for c in catalog.get("components", [])})
    tok = tokens(brand)
    say(f"→ Rebuilding {run} ({vs[-1].name}) in Figma…")
    res = await bridge.call("render", spec=resolve(spec, tok), title=f"{run} · rerender", defaultFont=tok["fonts"].get("ui", "Inter"),
                            w=tok["frame"]["w"], h=tok["frame"]["h"])
    if res["warnings"]:
        say("  Figma notes: " + " | ".join(res["warnings"][:6]))
    say("✓ Done. Fix by hand if needed, then ./design harvest --brand " + brand + " --prompt \"<the brief>\"")


async def cmd_animate(bridge, a):
    say("Select the screen(s) to animate in Figma…")
    tree = await bridge.call("motion_tree")
    run_id = datetime.now().strftime("%Y%m%d-%H%M%S") + "-motion"
    rdir = RUNS / run_id
    rdir.mkdir(parents=True)
    layers = "\n\n".join(f'Screen "{t["name"]}" layers:\n- ' + "\n- ".join(t["layers"]) for t in tree)
    msgs = [{"role": "system", "content": read("rules/motion.md")},
            {"role": "user", "content": f"{a.prompt}\n\n{layers}"}]
    names = {t["name"].lower() for t in tree}
    presets = {"fade-in", "fade-up", "fade-down", "slide-left", "slide-right", "pop", "stagger", "text-reveal", "draw"}
    for attempt in range(3):
        say("→ Planning motion…" if attempt == 0 else f"→ Fixing plan (attempt {attempt + 1})…")
        raw = await asyncio.to_thread(chat, msgs)
        try:
            plan = parse_json(raw)
            errs = []
            for sc in plan.get("screens", []):
                if str(sc.get("name", "")).lower() not in names and len(tree) > 1:
                    errs.append(f'screen "{sc.get("name")}" is not selected')
                for an in sc.get("animations", []):
                    if an.get("preset") not in presets:
                        errs.append(f'unknown preset "{an.get("preset")}"')
            if not plan.get("screens"):
                errs.append('Top level must be {"screens": [...]}')
        except Exception as e:
            plan, errs = None, [f"Invalid JSON: {e}"]
        if not errs:
            break
        say("  problems: " + "; ".join(errs[:4]))
        msgs += [{"role": "assistant", "content": raw[:8000]}, {"role": "user", "content": "Fix and return the full JSON only:\n- " + "\n- ".join(errs)}]
    if not plan:
        raise SystemExit("The model could not produce a motion plan. Try a shorter brief.")
    (rdir / "motion.json").write_text(json.dumps(plan, indent=1))
    say("→ Animating in Figma…")
    res = await bridge.call("animate", spec=plan)
    for line in res["applied"]:
        say("  ✓ " + line)
    if res["warnings"]:
        say("  Figma notes: " + " | ".join(res["warnings"][:6]))
    (rdir / "record.json").write_text(json.dumps({"id": run_id, "prompt": a.prompt, "plan": plan, "applied": res["applied"]}, indent=1))
    say("✓ Done. Press Play in Figma's Motion timeline to preview. Run the same command again to replace the animation.")

# ---------------------------------------------------------------- main
async def with_bridge(fn, a):
    from websockets.asyncio.server import serve
    bridge = Bridge()
    try:
        async with serve(bridge.handler, "localhost", CFG["port"], max_size=None, ping_interval=None):
            await fn(bridge, a)
    except OSError as e:
        raise SystemExit(f"Port {CFG['port']} is busy — is another ./design already running? ({e})")


def main():
    argv = sys.argv[1:]
    if argv and argv[0] not in ("design", "harvest", "rerender", "animate", "export-training", "check", "-h", "--help"):
        argv = ["design"] + argv
    p = argparse.ArgumentParser(prog="design")
    sub = p.add_subparsers(dest="cmd", required=True)
    d = sub.add_parser("design", help="prompt -> screens in Figma")
    d.add_argument("prompt")
    d.add_argument("--ref", action="append", help="reference image (repeatable)")
    d.add_argument("--ref-selection", action="store_true", help="use the frames selected in Figma as references")
    d.add_argument("--brand", help="brand file in brands/ (default from config.json)")
    d.add_argument("--no-review", action="store_true", help="skip the self-review pass")
    d.add_argument("--dry", action="store_true", help="print the JSON only, no Figma")
    h = sub.add_parser("harvest", help="save selected Figma screens as gold training data")
    h.add_argument("--run"); h.add_argument("--prompt"); h.add_argument("--brand")
    an = sub.add_parser("animate", help="plan and apply entrance animations to the selected screens")
    an.add_argument("prompt", nargs="?", default="Animate these screens with tasteful entrance motion.")
    rr = sub.add_parser("rerender", help="rebuild the last (or a given) run in Figma without calling the model")
    rr.add_argument("--run"); rr.add_argument("--brand")
    sub.add_parser("export-training", help="build dataset/train/*.jsonl for fine-tuning")
    sub.add_parser("check", help="test Ollama + model")
    a = p.parse_args(argv)

    if a.cmd == "check":
        return cmd_check(a)
    if a.cmd == "export-training":
        return cmd_export_training(a)
    if a.cmd == "design" and a.dry:
        return asyncio.run(cmd_design(None, a))
    try:
        fn = {"design": cmd_design, "harvest": cmd_harvest, "rerender": cmd_rerender, "animate": cmd_animate}[a.cmd]
        asyncio.run(with_bridge(fn, a))
    except RuntimeError as e:
        raise SystemExit(f"✗ Figma said: {e}")


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print()
