"""
Mini Envoy — an educational sidecar proxy: forwarding, access log, timeout, path blocking,
per-upstream traffic drain, HTML log view, admin API (for the phone app) and, as a bonus,
real mTLS between sidecars plus a circuit breaker.

NOT Envoy. Health and drain are simple, documented behaviours (see README "Limits").

Two kinds of listener (one process can run both):
  OUTBOUND  plain HTTP on localhost -> forwards to upstream(s). Hosts the log view + admin API.
            With --cert it speaks mTLS to a peer sidecar; without it, plain HTTP to a mock service.
  INBOUND   mTLS only -> verifies the caller's certificate + allowlist, forwards to the local app.

Request decision order (PRD forwarding rule):
  allowlist (inbound only) -> blocked path -> drained upstream -> circuit breaker -> forward with timeout
"""
import argparse, asyncio, csv, io, json, os, ssl, time, uuid
from collections import deque
from pathlib import Path
from aiohttp import web, ClientSession, ClientTimeout, TCPConnector, ClientError

HERE = Path(__file__).parent
HOP_BY_HOP = {"connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
              "te", "trailers", "transfer-encoding", "upgrade", "host", "content-length"}
CORS = {"access-control-allow-origin": "*",
        "access-control-allow-headers": "authorization,content-type",
        "access-control-allow-methods": "GET,POST,OPTIONS"}
STATE_RANK = {"CLOSED": 0, "HALF_OPEN": 1, "OPEN": 2}


# ----------------------------------------------------------------- circuit breaker (bonus)
class CircuitBreaker:
    """CLOSED -> (N consecutive failures) -> OPEN -> (cooldown) -> HALF_OPEN -> 1 trial -> CLOSED/OPEN"""

    def __init__(self, threshold=3, cooldown=5.0):
        self.threshold, self.cooldown = threshold, cooldown
        self.state, self.failures, self.opened_at, self.trial_in_flight = "CLOSED", 0, 0.0, False

    def allow(self):
        if self.state == "OPEN" and time.monotonic() - self.opened_at >= self.cooldown:
            self.state, self.trial_in_flight = "HALF_OPEN", False
        if self.state == "OPEN":
            return False
        if self.state == "HALF_OPEN":
            if self.trial_in_flight:
                return False          # only one probe request at a time
            self.trial_in_flight = True
        return True

    def record(self, ok):
        if ok:
            self.state, self.failures, self.trial_in_flight = "CLOSED", 0, False
            return
        self.failures += 1
        if self.state == "HALF_OPEN" or self.failures >= self.threshold:
            self.state, self.opened_at, self.trial_in_flight = "OPEN", time.monotonic(), False


# ----------------------------------------------------------------- upstreams
class Upstream:
    """One mock service behind the sidecar, with its own drain flag, breaker and latency readings."""

    def __init__(self, id, name, target, prefix="/", drained=False, threshold=3, cooldown=5.0):
        self.id, self.name, self.target = id, name, target.rstrip("/")
        self.prefix, self.drained = prefix or "/", bool(drained)
        self.breaker = CircuitBreaker(threshold, cooldown)
        self.lat, self.requests = deque(maxlen=20), 0

    def health(self):
        # "Down" once the breaker has seen 3 consecutive failures; recovers on the next success.
        return "Down" if self.breaker.state != "CLOSED" else "Healthy"

    def view(self):
        avg = round(sum(self.lat) / len(self.lat), 1) if self.lat else None
        return {"id": self.id, "name": self.name, "target": self.target, "prefix": self.prefix,
                "health": self.health(), "breaker": self.breaker.state, "drained": self.drained,
                "avgLatencyMs": avg, "lastLatencyMs": self.lat[-1] if self.lat else None,
                "requests": self.requests}


def sample_entries():
    """Seeded sample log so the log view and phone app have data on first load (and after a reset)."""
    rows = [("GET", "/balance", "payments", 200, "ok", 12.4), ("POST", "/charge", "payments", 200, "ok", 18.9),
            ("GET", "/orders/list", "orders", 200, "ok", 9.7), ("GET", "/slow", "payments", 504, "timeout", 2003.1),
            ("GET", "/admin", None, 403, "blocked", 0.6), ("GET", "/balance", "payments", 200, "ok", 11.2),
            ("GET", "/orders/list", "orders", 503, "drained", 0.5), ("GET", "/balance", "payments", 502, "upstream_down", 4.1),
            ("GET", "/balance", "payments", 502, "upstream_down", 3.8), ("GET", "/balance", "payments", 200, "ok", 10.6)]
    out = []
    for i, (m, p, u, s, o, ms) in enumerate(rows):
        out.append({"ts": f"09:{i:02d}:00", "sidecar": "sample", "id": f"sample{i:02d}", "caller": None,
                    "method": m, "path": p, "upstream": u, "status": s, "outcome": o, "breaker": "CLOSED",
                    "ms": ms, "error": None, "headers": {"host": "localhost"}, "sample": True})
    return out[::-1]


# ----------------------------------------------------------------- the proxy
class Sidecar:
    def __init__(self, name, upstreams, ssl_client, timeout, log_path, allowlist=None,
                 blocked=None, config_path=None, config=None, token=None):
        self.name, self.upstreams, self.ssl_client = name, upstreams, ssl_client
        self.timeout, self.allowlist = timeout, allowlist
        self.blocked = [b for b in (blocked or []) if b]
        self.config_path, self.config, self.token = config_path, config or {}, token
        self.log_path, self.recent = log_path, deque(maxlen=500)
        self.stats = {"requests": 0, "ok": 0, "upstream_errors": 0, "timeouts": 0, "short_circuited": 0,
                      "denied": 0, "blocked": 0, "drained": 0}
        self.session = None
        self.load_recent()

    # ---- lifecycle / persistence
    async def start(self, app):
        conn = TCPConnector(ssl=self.ssl_client) if self.ssl_client else TCPConnector()
        self.session = ClientSession(connector=conn, timeout=ClientTimeout(total=self.timeout))

    async def stop(self, app):
        await self.session.close()

    def load_recent(self):
        try:
            for line in Path(self.log_path).read_text().splitlines()[-500:]:
                e = json.loads(line)
                if e.get("sidecar") == self.name or e.get("sample"):
                    self.recent.appendleft(e)
        except (OSError, ValueError):
            pass

    def log(self, entry):
        self.recent.appendleft(entry)
        with open(self.log_path, "a") as f:
            f.write(json.dumps(entry) + "\n")

    def save_config(self):
        """Persist drain flags back to the JSON config file so they survive a restart."""
        if not self.config_path:
            return
        cfg = dict(self.config)
        cfg["upstreams"] = [{"id": u.id, "name": u.name, "target": u.target, "prefix": u.prefix,
                             "drained": u.drained} for u in self.upstreams]
        Path(self.config_path).write_text(json.dumps(cfg, indent=2) + "\n")

    # ---- routing decisions
    def pick(self, path):
        best = None
        for u in self.upstreams:
            pre = u.prefix.rstrip("/")
            if (u.prefix == "/" or path == pre or path.startswith(pre + "/")) and (best is None or len(u.prefix) > len(best.prefix)):
                best = u
        return best

    def is_blocked(self, path):
        return any(path == b.rstrip("/") or path.startswith(b.rstrip("/") + "/") for b in self.blocked)

    async def handle(self, request):
        t0 = time.perf_counter()
        rid = request.headers.get("x-request-id", uuid.uuid4().hex[:12])
        caller = None
        peercert = request.transport.get_extra_info("peercert") if request.transport else None
        if peercert:  # inbound mTLS: identity comes from the verified certificate, not from headers
            caller = dict(x[0] for x in peercert["subject"]).get("commonName")
        self.stats["requests"] += 1
        up = self.pick(request.path)
        if up:
            up.requests += 1

        def done(status, outcome, body=b"", headers=None, error=None):
            ms = round((time.perf_counter() - t0) * 1000, 1)
            state = up.breaker.state if up else "CLOSED"
            entry = {"ts": time.strftime("%H:%M:%S"), "sidecar": self.name, "id": rid, "caller": caller,
                     "method": request.method, "path": request.path_qs, "upstream": up.id if up else None,
                     "status": status, "outcome": outcome, "breaker": state, "ms": ms, "error": error,
                     "headers": {k: v for k, v in request.headers.items()
                                 if k.lower() not in ("authorization", "cookie")}}
            self.log(entry)
            h = {"x-request-id": rid, "x-sidecar": self.name, "x-breaker": state}
            h.update(headers or {})
            return web.Response(status=status, body=body, headers=h)

        # 1. authorization (inbound mTLS): only allow-listed service identities may call this service
        if self.allowlist is not None and caller not in self.allowlist:
            self.stats["denied"] += 1
            return done(403, "denied", f"identity {caller!r} not allowed\n".encode(), error="caller not on allowlist")

        # 2. blocked path: denied without forwarding
        if self.is_blocked(request.path):
            self.stats["blocked"] += 1
            return done(403, "blocked", b"path blocked by sidecar config\n", error="path is in blockedPaths")

        if up is None:
            return done(404, "no_route", b"no upstream configured for this path\n", error="no upstream matches")

        # 3. drained upstream: operator paused traffic, nothing is forwarded
        if up.drained:
            self.stats["drained"] += 1
            return done(503, "drained", b"traffic drained: new requests to this upstream are paused\n",
                        error="upstream is drained")

        # 4. circuit breaker (bonus): fail fast instead of piling onto a dead upstream
        if not up.breaker.allow():
            self.stats["short_circuited"] += 1
            return done(503, "short_circuit", b"circuit open: upstream unhealthy\n",
                        {"retry-after": str(int(up.breaker.cooldown))}, error="circuit breaker open")

        # 5. forward with the timeout
        rest = request.path_qs
        if up.prefix != "/":
            rest = request.path_qs[len(up.prefix.rstrip("/")):] or "/"
            if not rest.startswith("/"):
                rest = "/" + rest
        fwd = {k: v for k, v in request.headers.items() if k.lower() not in HOP_BY_HOP}
        fwd["x-request-id"] = rid
        if caller:
            fwd["x-mesh-caller"] = caller   # app B learns who called, verified by mTLS
        body = await request.read()
        try:
            async with self.session.request(request.method, up.target + rest, headers=fwd, data=body,
                                            allow_redirects=False) as r:
                payload = await r.read()
                ok = r.status < 500
                up.breaker.record(ok)
                up.lat.append(round((time.perf_counter() - t0) * 1000, 1))
                self.stats["ok" if ok else "upstream_errors"] += 1
                passthru = {k: v for k, v in r.headers.items() if k.lower() not in HOP_BY_HOP}
                return done(r.status, "ok" if ok else "upstream_5xx", payload, passthru,
                            error=None if ok else f"upstream returned {r.status}")
        except asyncio.TimeoutError:
            up.breaker.record(False); self.stats["timeouts"] += 1
            return done(504, "timeout", f"Request timed out after {int(self.timeout * 1000)} ms and was logged\n".encode(),
                        error=f"timeout after {int(self.timeout * 1000)} ms")
        except (ClientError, OSError) as e:
            up.breaker.record(False); self.stats["upstream_errors"] += 1
            return done(502, "upstream_down", f"upstream unreachable: {type(e).__name__}\n".encode(),
                        error=f"upstream unreachable ({type(e).__name__})")

    # ---------- admin API (outbound listener only)
    def authed(self, request):
        return not self.token or request.headers.get("authorization") == f"Bearer {self.token}"

    async def stats_view(self, request):
        worst = max((u.breaker.state for u in self.upstreams), key=STATE_RANK.get)
        return web.json_response({**self.stats, "breaker": worst,
                                  "consecutive_failures": self.upstreams[0].breaker.failures})

    async def health_view(self, request):
        return web.json_response({"sidecar": self.name, "updatedAt": time.strftime("%H:%M:%S"),
                                  "timeoutMs": int(self.timeout * 1000),
                                  "upstreams": [u.view() for u in self.upstreams]})

    async def config_view(self, request):
        return web.json_response({"timeoutMs": int(self.timeout * 1000), "blockedPaths": self.blocked,
                                  "upstreams": [{"id": u.id, "name": u.name, "target": u.target,
                                                 "prefix": u.prefix, "drained": u.drained} for u in self.upstreams],
                                  "tokenRequired": bool(self.token)})

    def filtered(self, request):
        q, st = request.query.get("q", "").lower(), request.query.get("status", "all")
        group = lambda e: "error" if e["outcome"] in ("upstream_5xx", "upstream_down") else e["outcome"]
        return [e for e in self.recent
                if (st == "all" or group(e) == st)
                and (not q or q in " ".join(str(e.get(k, "")) for k in ("method", "path", "upstream", "outcome", "status")).lower())]

    async def logs_json(self, request):
        return web.json_response(self.filtered(request)[:int(request.query.get("limit", 200))])

    async def logs_csv(self, request):
        buf = io.StringIO()
        w = csv.writer(buf)
        w.writerow(["time", "id", "method", "path", "upstream", "status", "outcome", "latency_ms", "caller"])
        for e in self.filtered(request):
            w.writerow([e["ts"], e["id"], e["method"], e["path"], e.get("upstream") or "", e["status"],
                        e["outcome"], e["ms"], e.get("caller") or ""])
        return web.Response(text=buf.getvalue(), content_type="text/csv",
                            headers={"content-disposition": "attachment; filename=mini-envoy-log.csv"})

    async def drain_view(self, request):
        if not self.authed(request):
            return web.json_response({"error": "bearer token required"}, status=401)
        try:
            data = await request.json()
        except ValueError:
            return web.json_response({"error": "send JSON like {\"upstream\":\"payments\",\"drained\":true}"}, status=400)
        up = next((u for u in self.upstreams if u.id == data.get("upstream")), None)
        if up is None:
            return web.json_response({"error": f"unknown upstream {data.get('upstream')!r}"}, status=404)
        up.drained = (not up.drained) if "drained" not in data else bool(data["drained"])
        self.save_config()
        return web.json_response(up.view())

    async def reset_sample(self, request):
        if not self.authed(request):
            return web.json_response({"error": "bearer token required"}, status=401)
        self.recent.clear()
        rows = sample_entries()
        Path(self.log_path).write_text("".join(json.dumps(e) + "\n" for e in reversed(rows)))
        self.recent.extend(rows)
        return web.json_response({"loaded": len(rows)})

    async def clear_log(self, request):
        if not self.authed(request):
            return web.json_response({"error": "bearer token required"}, status=401)
        self.recent.clear()
        Path(self.log_path).write_text("")
        return web.json_response({"cleared": True})

    async def logs_page(self, request):
        return web.FileResponse(HERE / "ui" / "index.html")


@web.middleware
async def cors_mw(request, handler):
    if request.path.startswith("/__sidecar"):
        if request.method == "OPTIONS":
            return web.Response(status=204, headers=CORS)
        resp = await handler(request)
        resp.headers.update(CORS)
        return resp
    return await handler(request)


def build_app(sc, admin=True):
    app = web.Application(middlewares=[cors_mw])
    app.on_startup.append(sc.start)
    app.on_cleanup.append(sc.stop)
    if admin:
        r = app.router
        r.add_get("/__sidecar/stats", sc.stats_view)
        r.add_get("/__sidecar/health", sc.health_view)
        r.add_get("/__sidecar/config", sc.config_view)
        r.add_get("/__sidecar/logs", sc.logs_page)
        r.add_get("/__sidecar/logs.json", sc.logs_json)
        r.add_get("/__sidecar/logs.csv", sc.logs_csv)
        r.add_post("/__sidecar/drain", sc.drain_view)
        r.add_post("/__sidecar/reset-sample", sc.reset_sample)
        r.add_post("/__sidecar/clear-log", sc.clear_log)
    app.router.add_route("*", "/{tail:.*}", sc.handle)
    return app


def server_mtls_ctx(cert, key, ca):
    ctx = ssl.create_default_context(ssl.Purpose.CLIENT_AUTH, cafile=ca)
    ctx.load_cert_chain(cert, key)
    ctx.verify_mode = ssl.CERT_REQUIRED          # no client cert = no connection
    ctx.minimum_version = ssl.TLSVersion.TLSv1_3
    return ctx


def client_mtls_ctx(cert, key, ca):
    ctx = ssl.create_default_context(ssl.Purpose.SERVER_AUTH, cafile=ca)
    ctx.load_cert_chain(cert, key)
    ctx.minimum_version = ssl.TLSVersion.TLSv1_3
    return ctx


async def main():
    p = argparse.ArgumentParser(description="Mini Envoy sidecar (educational mock, not Envoy)")
    p.add_argument("--name", required=True)
    p.add_argument("--cert"); p.add_argument("--key"); p.add_argument("--ca")
    p.add_argument("--outbound-port", type=int, help="plain localhost port the app calls")
    p.add_argument("--peer", help="upstream: https://host:port of a peer sidecar (mTLS) or http://host:port of a mock service")
    p.add_argument("--config", help="JSON config: timeoutMs, blockedPaths, upstreams[] (drain flags are saved back)")
    p.add_argument("--block", default="", help="comma-separated blocked path prefixes")
    p.add_argument("--admin-token", default=os.environ.get("MESH_ADMIN_TOKEN"), help="bearer token for POST admin calls")
    p.add_argument("--admin-host", default="127.0.0.1", help="use 0.0.0.0 so a phone on the same Wi-Fi can reach the admin API")
    p.add_argument("--inbound-port", type=int, help="mTLS port other sidecars call")
    p.add_argument("--app", help="http://127.0.0.1:port of the local app")
    p.add_argument("--allow", default="", help="comma-separated caller identities (CNs)")
    p.add_argument("--timeout", type=float, default=2.0)
    p.add_argument("--threshold", type=int, default=3)
    p.add_argument("--cooldown", type=float, default=5.0)
    a = p.parse_args()

    cfg = json.loads(Path(a.config).read_text()) if a.config else {}
    timeout = cfg.get("timeoutMs", a.timeout * 1000) / 1000
    blocked = list(cfg.get("blockedPaths", [])) + a.block.split(",")
    log_path = f"{a.name}-access.jsonl"

    runners = []
    if a.outbound_port:
        if cfg.get("upstreams"):
            ups = [Upstream(u["id"], u.get("name", u["id"]), u["target"], u.get("prefix", "/"), u.get("drained", False),
                            a.threshold, a.cooldown) for u in cfg["upstreams"]]
        else:
            ups = [Upstream("peer", "Peer service", a.peer, "/", False, a.threshold, a.cooldown)]
        ssl_client = client_mtls_ctx(a.cert, a.key, a.ca) if a.cert else None
        sc = Sidecar(f"{a.name}:outbound", ups, ssl_client, timeout, log_path, blocked=blocked,
                     config_path=a.config, config=cfg, token=a.admin_token)
        r = web.AppRunner(build_app(sc)); await r.setup()
        await web.TCPSite(r, a.admin_host, a.outbound_port).start(); runners.append(r)
        mode = "mTLS" if ssl_client else "plain HTTP"
        print(f"[{a.name}] outbound http://{a.admin_host}:{a.outbound_port} -> {[u.target for u in ups]} ({mode}); "
              f"log view: /__sidecar/logs", flush=True)
    if a.inbound_port:
        sc = Sidecar(f"{a.name}:inbound", [Upstream("app", "Local app", a.app, "/", False, a.threshold, a.cooldown)],
                     None, timeout, log_path, allowlist=set(filter(None, a.allow.split(","))), blocked=blocked)
        r = web.AppRunner(build_app(sc, admin=False)); await r.setup()
        await web.TCPSite(r, "127.0.0.1", a.inbound_port,
                          ssl_context=server_mtls_ctx(a.cert, a.key, a.ca)).start(); runners.append(r)
        print(f"[{a.name}] inbound https://127.0.0.1:{a.inbound_port} (mTLS, allow={a.allow}) -> {a.app}", flush=True)
    await asyncio.Event().wait()


if __name__ == "__main__":
    asyncio.run(main())
