"""
PRD critical-path checks (plain-HTTP mode, no certs): forward, log, timeout, block, drain, health, CSV, UI.
  python test_prd.py
Topology: client -> sidecar :8101 -> payments :9100 (prefix /) and orders :9101 (prefix /orders)
"""
import json, os, shutil, subprocess, sys, tempfile, time, urllib.request, urllib.error, socket

HERE = os.path.dirname(os.path.abspath(__file__)); PY = sys.executable
procs, results = {}, []
TMP = tempfile.mkdtemp(prefix="mini-envoy-")
CFG = os.path.join(TMP, "config.json")
A, TOKEN = "http://127.0.0.1:8101", "secret"

def spawn(name, *args):
    procs[name] = subprocess.Popen([PY, *args], cwd=TMP, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

def wait_port(port, timeout=10):
    end = time.time() + timeout
    while time.time() < end:
        try: socket.create_connection(("127.0.0.1", port), 0.3).close(); return
        except OSError: time.sleep(0.1)
    raise RuntimeError(f"port {port} never came up")

def call(url, method="GET", data=None, token=None):
    h = {"content-type": "application/json"}
    if token: h["authorization"] = f"Bearer {token}"
    req = urllib.request.Request(url, method=method, data=json.dumps(data).encode() if data is not None else None, headers=h)
    t0 = time.perf_counter()
    try:
        with urllib.request.urlopen(req, timeout=10) as r: return r.status, r.read().decode(), dict(r.headers), (time.perf_counter() - t0) * 1000
    except urllib.error.HTTPError as e: return e.code, e.read().decode(), dict(e.headers), (time.perf_counter() - t0) * 1000

def check(name, cond, detail=""):
    results.append(bool(cond)); print(f"  {'PASS' if cond else 'FAIL'}  {name}" + (f"  ({detail})" if detail else ""))

def js(path, **kw): return json.loads(call(A + "/__sidecar" + path, **kw)[1])
def hits(port): return json.loads(call(f"http://127.0.0.1:{port}/hits")[1])["count"]
def start_payments(): spawn("pay", os.path.join(HERE, "payments_app.py"), "9100"); wait_port(9100)

def main():
    json.dump({"timeoutMs": 1500, "blockedPaths": ["/admin", "/internal"], "upstreams": [
        {"id": "payments", "name": "Payments", "target": "http://127.0.0.1:9100", "prefix": "/", "drained": False},
        {"id": "orders", "name": "Orders", "target": "http://127.0.0.1:9101", "prefix": "/orders", "drained": False}]}, open(CFG, "w"))
    start_payments(); spawn("ord", os.path.join(HERE, "payments_app.py"), "9101"); wait_port(9101)
    spawn("sc", os.path.join(HERE, "sidecar.py"), "--name", "svc", "--outbound-port", "8101", "--config", CFG,
          "--admin-token", TOKEN, "--cooldown", "2"); wait_port(8101)

    print("\n1) Forward GET and POST, log every request")
    s, b, h, _ = call(A + "/balance"); check("GET forwarded, response unchanged", s == 200 and json.loads(b)["balance"] == 48000)
    s, b, _, _ = call(A + "/charge", "POST", {"amount": 1500}); check("POST forwarded with body", s == 200 and json.loads(b)["amount"] == 1500)
    s, b, _, _ = call(A + "/orders/balance"); check("prefix route: /orders/* goes to the Orders upstream", s == 200)
    logs = js("/logs.json")
    e = next(x for x in logs if x["path"] == "/balance")
    check("log row has method, path, status, latency, upstream", all(k in e for k in ("method", "path", "status", "ms", "upstream")) and e["upstream"] == "payments", str(e["ms"]) + " ms")
    check("request id returned", "x-request-id" in {k.lower() for k in h})

    print("\n2) Timeout")
    s, b, _, ms = call(A + "/slow"); check("slow upstream -> 504 within the timeout", s == 504 and ms < 2500, f"{ms:.0f} ms")
    check("timeout logged and marked", js("/logs.json?status=timeout")[0]["outcome"] == "timeout")
    check("timeout message names the limit", "1500 ms" in b)

    print("\n3) Blocked path")
    before = hits(9100); s, b, _, _ = call(A + "/admin")
    check("blocked path -> 403", s == 403)
    check("blocked request never reached the upstream", hits(9100) == before, f"hits {before}")
    check("blocked attempt logged", js("/logs.json?status=blocked")[0]["path"] == "/admin")

    print("\n4) Drain")
    s, b, _, _ = call(A + "/__sidecar/drain", "POST", {"upstream": "payments", "drained": True}); check("drain without token -> 401", s == 401)
    s, b, _, _ = call(A + "/__sidecar/drain", "POST", {"upstream": "payments", "drained": True}, token=TOKEN); check("drain with token accepted", s == 200 and json.loads(b)["drained"] is True)
    before = hits(9100); s, b, _, _ = call(A + "/balance")
    check("drained upstream -> 503 drained, not forwarded", s == 503 and hits(9100) == before and "drained" in b)
    check("other upstream still forwards", call(A + "/orders/balance")[0] == 200)
    check("drained request logged", js("/logs.json?status=drained")[0]["outcome"] == "drained")
    check("drain flag persisted to the JSON config", json.load(open(CFG))["upstreams"][0]["drained"] is True)
    call(A + "/__sidecar/drain", "POST", {"upstream": "payments", "drained": False}, token=TOKEN)
    check("turning drain off resumes traffic", call(A + "/balance")[0] == 200)

    print("\n5) Health and recovery")
    hz = js("/health"); check("both upstreams Healthy", all(u["health"] == "Healthy" for u in hz["upstreams"]), json.dumps([u["avgLatencyMs"] for u in hz["upstreams"]]))
    procs["pay"].kill(); procs["pay"].wait(); time.sleep(0.3)
    codes = [call(A + "/balance")[0] for _ in range(3)]
    hz = {u["id"]: u for u in js("/health")["upstreams"]}
    check("3 failures -> Payments Down, Orders still Healthy", hz["payments"]["health"] == "Down" and hz["orders"]["health"] == "Healthy", str(codes))
    start_payments(); time.sleep(2.2)
    call(A + "/balance")
    check("recovers to Healthy after the upstream returns", {u["id"]: u for u in js("/health")["upstreams"]}["payments"]["health"] == "Healthy")

    print("\n6) CSV export, filters, sample data")
    s, body, h, _ = call(A + "/__sidecar/logs.csv")
    check("CSV downloads with header + rows", s == 200 and body.startswith("time,id,method,path") and body.count("\n") > 5, h.get("content-type", ""))
    s, body, _, _ = call(A + "/__sidecar/logs.csv?status=blocked")
    check("CSV respects the status filter", body.count("\n") == 2 and "/admin" in body)
    check("search filter narrows the log", all("orders" in (x["path"] + str(x["upstream"])) for x in js("/logs.json?q=orders")))
    check("reset-sample loads 10 rows", js("/reset-sample", method="POST", token=TOKEN)["loaded"] == 10 and len(js("/logs.json")) == 10)
    js("/clear-log", method="POST", token=TOKEN); check("clear log empties it", js("/logs.json") == [])

    print("\n7) Log view page and API access")
    s, body, _, _ = call(A + "/__sidecar/logs")
    check("HTML log view served", s == 200 and "Mini Envoy" in body and "bootstrap@5" in body and 'name="viewport"' in body)
    check("About text says not Envoy", "not Envoy" in body)
    check("CORS header lets the phone/web app read the API", call(A + "/__sidecar/health")[2].get("access-control-allow-origin") == "*")

    print(f"\n{sum(results)}/{len(results)} checks passed")

if __name__ == "__main__":
    try: main()
    finally:
        for p in procs.values(): p.kill()
        shutil.rmtree(TMP, ignore_errors=True)
    sys.exit(0 if all(results) else 1)
