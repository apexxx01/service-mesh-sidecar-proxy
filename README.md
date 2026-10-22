# Service Mesh Sidecar Proxy (Mini Envoy)

A small Python sidecar proxy that forwards HTTP requests to a local mock service, applies a timeout, and logs every request. It comes with an HTML access-log view and a 2-screen React Native (Expo Go) app for watching upstream health and draining traffic.

> [!IMPORTANT]
> **This is an educational prototype. It is not Envoy.** It forwards **plain HTTP** to a local mock service. It does **not** implement mTLS, certificate management, real circuit-breaking, outlier detection or production routing. Upstream latency and health are **simulated** from sample data, and there is no real health probe.

**Project ID:** PST_AD_168 · **Track:** Product development (Stretch, Level 5) · **Duration:** 4 weeks · **Program:** Polaris School of Technology OJT 2026

---

## Why this exists

When a service starts forwarding to an unhealthy upstream, the on-call engineer usually has to grep through scattered logs to confirm it, and has no quick way to stop the traffic. Mini Envoy shows, in a small and readable way, how a sidecar proxy helps with that:

1. **Every request in one place.** Method, path, status and latency, all in one log view.
2. **A clear Healthy / Down signal** for the upstream.
3. **A manual drain switch** that stops traffic to a bad upstream and shows the effect right away.

## How it works

```
                     ┌────────────── Mini Envoy sidecar (:8080) ──────────────┐
client ── HTTP ──►   │  1. blocked path?  → 403, logged "blocked"             │
 (curl / browser)    │  2. upstream drained? → 503, logged "drained"          │ ── HTTP ──► mock service (:9000)
                     │  3. forward with timeout → response, or 504 "timeout"  │
                     └──────────┬──────────────────────────────┬──────────────┘
                                │ writes                       │ serves
                       data/minienvoy_log.json        /admin/* JSON API + HTML log view
                                                               ▲
                                              Expo Go app (Health · Traffic Toggle)
```

Every outcome is logged: `forwarded`, `timeout`, `blocked`, `drained` or `upstream_error`.

## Features

| Feature | Priority | Status |
|---|---|---|
| Forward GET and POST to the mock upstream | Must have | 🚧 In progress |
| Access log: method, path, status code, latency | Must have | 🚧 In progress |
| Request timeout with a clear response and a log entry | Must have | 🚧 In progress |
| HTML log view that lists recent requests, with refresh | Must have | ⬜ Planned |
| JSON-file persistence with sample data | Must have | ⬜ Planned |
| Responsive Bootstrap layout (phone + laptop) | Must have | ⬜ Planned |
| Block a configured path and log the attempt | Good to have (graded) | ⬜ Planned |
| Search and status filters, CSV export | Good to have | ⬜ Planned |
| Expo Go app: Health and Traffic Toggle screens | Good to have (graded) | ⬜ Planned |

Legend: ✅ done · 🚧 in progress · ⬜ planned. **Update this table as you merge work.**

## Tech stack

- **Proxy:** Python 3 standard library (`http.server`, `urllib.request`, `json`). There are no third-party dependencies.
- **Log view:** HTML5, CSS3, Bootstrap 5, vanilla JavaScript (`fetch`, DOM, `localStorage`)
- **Mobile:** React Native with Expo Go
- **Data:** JSON files (`minienvoy_log`, `minienvoy_upstreams`, `minienvoy_config`, `minienvoy_prefs`)

## Project structure

<!-- TODO: update this tree once the code is pushed -->
```
service-mesh-sidecar-proxy/
├── proxy/
│   ├── sidecar.py            # ProxyServer, Forwarder, PathBlocker, AccessLogger
│   ├── mock_service.py       # mock upstream: /hello, /orders, /slow, /fail
│   └── store.py              # LocalDataStore: reads and writes the JSON files
├── data/
│   ├── minienvoy_config.json
│   ├── minienvoy_upstreams.json
│   └── minienvoy_log.json    # seeded with sample entries
├── web/                      # HTML log view (Bootstrap 5 + vanilla JS)
│   ├── index.html            # Overview / Status
│   ├── log.html              # Access Log + Log Detail
│   ├── config.html
│   └── about.html
├── mobile/                   # Expo Go app (Health, Traffic Toggle)
├── tests/
│   └── test_proxy.py
└── README.md
```

## Getting started

### Prerequisites
- Python 3.10+
- Node.js 18+ and the **Expo Go** app on your phone (only needed for the mobile app)

### 1. Run the proxy
```bash
git clone https://github.com/apexxx01/service-mesh-sidecar-proxy.git
cd service-mesh-sidecar-proxy

python proxy/mock_service.py      # terminal 1, mock upstream on :9000
python proxy/sidecar.py           # terminal 2, sidecar on :8080
```

### 2. Send requests through the sidecar
```bash
curl http://localhost:8080/hello                                    # forwarded, 200
curl -X POST http://localhost:8080/orders -d '{"item":"book"}' \
     -H "Content-Type: application/json"                           # forwarded POST
curl http://localhost:8080/slow                                     # 504 after 2000 ms
curl http://localhost:8080/admin-panel                              # 403, blocked path
```

### 3. Open the log view
Go to **http://localhost:8080/** in your browser. Requests show up in the Access Log. Use **Refresh**, the filters, or **Export CSV**.

### 4. Run the mobile app
```bash
cd mobile
npm install
npx expo start
```
Scan the QR code with Expo Go. In the app's settings, set the API address to your laptop's IP, for example `http://192.168.x.x:8080`.

> **Hostel Wi-Fi tip:** campus networks often block devices from talking to each other. If the phone can't reach the laptop, connect the laptop to your **phone's hotspot**. `npx expo start --tunnel` only tunnels the app bundle. It does **not** expose the Python API.

## Configuration

`data/minienvoy_config.json`:
```json
{
  "timeoutMs": 2000,
  "blockedPaths": ["/admin-panel"],
  "upstreamTarget": "http://localhost:9000"
}
```

## Admin API

| Method | Endpoint | Purpose |
|---|---|---|
| GET | `/admin/logs` | Recent log entries (JSON) |
| GET | `/admin/config` | Current timeout, blocked paths and upstream target |
| GET | `/admin/health` | Simulated latency, Healthy/Down, and drained flag |
| POST | `/admin/drain` | Body `{"upstreamId": "payments", "drained": true}` turns drain on or off |

While drain is on, requests to that upstream get `503` and are logged as `drained`. Turning drain off resumes forwarding.

### Log entry format
```json
{
  "entryId": "a1b2c3",
  "method": "GET",
  "path": "/hello",
  "statusCode": 200,
  "latencyMs": 12.4,
  "outcome": "forwarded",
  "at": "2026-10-21T10:15:02Z"
}
```

## Testing

```bash
python -m unittest discover tests
```

End-to-end demo checklist:
- [ ] GET and POST are forwarded, and the response comes back unchanged
- [ ] Every request appears in the log with method, path, status and latency
- [ ] `/slow` returns a timeout response after 2000 ms and is logged
- [ ] A blocked path returns 403, is never forwarded, and is logged
- [ ] Drain on → requests get 503 `drained`; drain off → forwarding resumes
- [ ] Log view is usable at 375 px (phone) and 1280 px (laptop)
- [ ] Expo app shows latency and Healthy/Down, and the toggle changes proxy behaviour

## Deployment

- **Log view:** deployed to GitHub Pages in *demo mode*, using the bundled sample data. <!-- TODO: add link -->
- **Proxy:** runs locally as a Python CLI demo. GitHub Pages can't run Python.

## Screenshots

<!-- TODO: add screenshots at phone and laptop width -->
| Laptop | Phone | Mobile app |
|---|---|---|
| _coming soon_ | _coming soon_ | _coming soon_ |

## Limitations

- Not Envoy, and not production-ready.
- No mTLS, TLS, authentication or certificate management. All traffic is plain HTTP on localhost.
- No real circuit-breaking, retries, load balancing or service discovery.
- Health and latency are simulated from sample data.
- The admin API has no authentication. It's meant for a local or LAN demo only.

## Team

| Name | Role |
|---|---|
| Shridhar Raikar | Backend: proxy, forwarding, timeout, blocking, drain API, JSON store, Python tests |
| J Nishanth Reddy | Frontend: HTML log view, filters, CSV export, responsive layout, accessibility, Expo app |

**Mentor:** Madhushri Tangali <!-- TODO: confirm whether Kshitiz Dhooria should be listed as co-mentor -->

## References

- [Envoy architecture overview](https://www.envoyproxy.io/docs/envoy/latest/intro/arch_overview/arch_overview) (conceptual reading only)
- [Python `http.server`](https://docs.python.org/3/library/http.server.html)
- [Bootstrap 5 docs](https://getbootstrap.com/docs/5.3/)
- [Expo documentation](https://docs.expo.dev/)
