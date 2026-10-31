"""
End-to-end test of the mesh against the catalog's grading criteria.
  python test_mesh.py

Topology:
  test client --http--> sidecar-a:8001 ==mTLS==> wiretap:9444 --> sidecar-b:9443 --http--> payments:9000
"""
import json, os, ssl, subprocess, sys, time, urllib.request, urllib.error

HERE = os.path.dirname(os.path.abspath(__file__))
C = os.path.join(HERE, "certs")
PY = sys.executable
CAPTURE = os.path.join(HERE, "wire_capture.bin")
procs, results = {}, []


def spawn(name, *args):
    procs[name] = subprocess.Popen([PY, *args], cwd=HERE, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def wait_port(port, tls=False, timeout=10):
    import socket
    end = time.time() + timeout
    while time.time() < end:
        try:
            socket.create_connection(("127.0.0.1", port), 0.3).close(); return
        except OSError:
            time.sleep(0.1)
    raise RuntimeError(f"port {port} never came up")


def call(url, method="GET", data=None, ctx=None):
    req = urllib.request.Request(url, method=method, data=json.dumps(data).encode() if data else None,
                                 headers={"content-type": "application/json"})
    t0 = time.perf_counter()
    try:
        with urllib.request.urlopen(req, context=ctx, timeout=10) as r:
            return r.status, r.read().decode(), dict(r.headers), (time.perf_counter() - t0) * 1000
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode(), dict(e.headers), (time.perf_counter() - t0) * 1000


def check(name, cond, detail=""):
    results.append(cond)
    print(f"  {'PASS' if cond else 'FAIL'}  {name}" + (f"  ({detail})" if detail else ""))


def mtls_ctx(identity, ca="mesh-ca"):
    ctx = ssl.create_default_context(cafile=f"{C}/mesh-ca.pem")
    if identity:
        ctx.load_cert_chain(f"{C}/{identity}.pem", f"{C}/{identity}-key.pem")
    return ctx


def start_app():
    spawn("app", "payments_app.py", "9000"); wait_port(9000)


def main():
    if not os.path.exists(f"{C}/mesh-ca.pem"):
        subprocess.run(["bash", f"{C}/gen_certs.sh"], check=True)
    for f in os.listdir(HERE):
        if f.endswith("-access.jsonl") or f == "wire_capture.bin":
            os.remove(os.path.join(HERE, f))

    start_app()
    spawn("b", "sidecar.py", "--name", "service-b", "--inbound-port", "9443", "--app", "http://127.0.0.1:9000",
          "--cert", f"{C}/service-b.pem", "--key", f"{C}/service-b-key.pem", "--ca", f"{C}/mesh-ca.pem",
          "--allow", "service-a", "--cooldown", "3")
    wait_port(9443)
    spawn("tap", "wiretap.py", "9444", "9443", CAPTURE); wait_port(9444)
    spawn("a", "sidecar.py", "--name", "service-a", "--outbound-port", "8001", "--peer", "https://127.0.0.1:9444",
          "--cert", f"{C}/service-a.pem", "--key", f"{C}/service-a-key.pem", "--ca", f"{C}/mesh-ca.pem",
          "--timeout", "2", "--threshold", "3", "--cooldown", "3")
    wait_port(8001)
    A = "http://127.0.0.1:8001"

    print("\n1) Forwarding through the mesh")
    s, body, h, _ = call(f"{A}/balance")
    check("GET forwarded end-to-end", s == 200 and json.loads(body)["balance"] == 48000)
    check("app B sees verified caller identity", json.loads(body)["caller"] == "service-a", json.loads(body)["caller"])
    check("request id propagated", "x-request-id" in {k.lower() for k in h})
    s, body, _, _ = call(f"{A}/charge", "POST", {"amount": 1500})
    check("POST forwarded with body", s == 200 and json.loads(body)["amount"] == 1500)

    print("\n2) mTLS: nobody without a valid mesh identity gets in")
    try:
        call("http://127.0.0.1:9443/balance"); check("plaintext HTTP rejected", False)
    except Exception as e:
        check("plaintext HTTP rejected", True, type(e).__name__)
    try:
        call("https://127.0.0.1:9443/balance", ctx=mtls_ctx(None)); check("TLS without client cert rejected", False)
    except Exception as e:
        check("TLS without client cert rejected", True, type(e).__name__)
    try:
        ctx = ssl.create_default_context(cafile=f"{C}/mesh-ca.pem")
        ctx.load_cert_chain(f"{C}/attacker.pem", f"{C}/attacker-key.pem")
        call("https://127.0.0.1:9443/balance", ctx=ctx); check("cert from rogue CA rejected", False)
    except Exception as e:
        check("cert from rogue CA rejected", True, type(e).__name__)
    s, body, _, _ = call("https://127.0.0.1:9443/balance", ctx=mtls_ctx("service-c"))
    check("valid identity NOT on allowlist -> 403", s == 403, body.strip())

    print("\n3) Zero plaintext leakage on the wire")
    time.sleep(0.3)
    wire = open(CAPTURE, "rb").read()
    check("wiretap captured traffic", len(wire) > 500, f"{len(wire)} bytes")
    check("secret never visible on the wire", b"TOP-SECRET" not in wire and b"balance" not in wire)

    print("\n4) Timeouts")
    s, _, _, ms = call(f"{A}/slow")
    check("slow upstream -> 504 within timeout", s == 504 and ms < 3000, f"{ms:.0f} ms")
    s, _, _, _ = call(f"{A}/balance")
    check("healthy call afterwards resets breaker", s == 200)

    print("\n5) Circuit breaker")
    procs["app"].kill(); procs["app"].wait(); time.sleep(0.3)
    codes = [call(f"{A}/balance")[0] for _ in range(3)]
    check("3 failed requests reach upstream", all(c >= 500 for c in codes), str(codes))
    s, _, h, ms = call(f"{A}/balance")
    check("4th request short-circuited (breaker OPEN)", s == 503 and h.get("x-breaker") == "OPEN", f"{ms:.1f} ms, no upstream call")
    stats = json.loads(call(f"{A}/__sidecar/stats")[1])
    check("stats report OPEN breaker", stats["breaker"] == "OPEN", json.dumps(stats))
    start_app(); time.sleep(3.2)
    s, _, h, _ = call(f"{A}/balance")
    check("after cooldown + recovery: probe succeeds, breaker CLOSED", s == 200 and h.get("x-breaker") == "CLOSED")

    print(f"\n{sum(results)}/{len(results)} checks passed")
    print(f"live log view while running: {A}/__sidecar/logs")


if __name__ == "__main__":
    try:
        main()
    finally:
        for p in procs.values():
            p.kill()
    sys.exit(0 if all(results) else 1)
