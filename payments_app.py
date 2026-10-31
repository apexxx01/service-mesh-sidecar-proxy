"""The 'Payments' mock upstream behind a sidecar. It knows nothing about TLS, breakers or drains."""
import asyncio, sys
from aiohttp import web

HITS = {"count": 0}

async def charge(request):
    HITS["count"] += 1
    body = await request.json()
    return web.json_response({"status": "charged", "amount": body.get("amount"),
                              "secret_ref": "TOP-SECRET-TXN-48000",
                              "caller": request.headers.get("x-mesh-caller")})

async def balance(request):
    HITS["count"] += 1
    return web.json_response({"balance": 48000, "secret_ref": "TOP-SECRET-TXN-48000",
                              "caller": request.headers.get("x-mesh-caller")})

async def slow(request):
    HITS["count"] += 1
    await asyncio.sleep(5)
    return web.json_response({"late": True})

async def admin(request):          # a path the sidecar is configured to block
    HITS["count"] += 1
    return web.json_response({"admin": "should never be reachable through the sidecar"})

async def hits(request):           # lets tests prove a blocked/drained request never arrived
    return web.json_response(HITS)

app = web.Application()
app.router.add_get("/balance", balance)
app.router.add_post("/charge", charge)
app.router.add_get("/slow", slow)
app.router.add_get("/admin", admin)
app.router.add_get("/hits", hits)

if __name__ == "__main__":
    web.run_app(app, host="127.0.0.1", port=int(sys.argv[1]) if len(sys.argv) > 1 else 9000, print=None)
