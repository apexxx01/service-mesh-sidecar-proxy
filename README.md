# Mini Envoy — Service Mesh Sidecar Proxy 

> **Limits, stated plainly:** this is an educational prototype, **not Envoy**. The core sidecar forwards plain HTTP to local mock
> services and logs every outcome. Health (Healthy/Down) comes from recent request results, not a real health probe, and drain is a
> manual per-upstream switch. Real mTLS between sidecars and a circuit breaker are included as a **bonus beyond the PRD**;
> there is no service discovery, load balancing or production routing.

```
curl / app --http--> [sidecar :8001] --http--> Payments mock :9000   (prefix /)
                          |           \--http--> Orders mock   :9001   (prefix /orders)
                          +-- HTML log view /__sidecar/logs   +-- admin API for the phone app
```

## What it does
| Feature | How |
|---|---|
| Forward GET/POST to a mock upstream, response returned unchanged | `Sidecar.handle` |
| Access log: method, path, status, latency, upstream (JSONL file, survives restart) | `<name>-access.jsonl` |
| Request timeout, clear 504 message, logged as timed out | `timeoutMs` in `config.json` |
| HTML log view (Bootstrap 5, phone cards + laptop table, auto-refresh) | `ui/index.html` at `/__sidecar/logs` |
| Block a configured path: 403, never forwarded, logged as blocked | `blockedPaths` |
| Per-upstream traffic drain: 503 "drained", resumes when switched off, saved to the config file | `POST /__sidecar/drain` |
| Search and status filters, CSV export, row detail, config and About views, empty and error states | log view |
| Sample data seed and reset | "Reset to sample data" button |
| Phone app: Health + Traffic Toggle (Expo Go) | `mobile/App.js` |
| *Bonus:* mTLS 1.3 between sidecars, caller allowlist, wiretap proof, circuit breaker | `--cert/--key/--ca`, `test_mesh.py` |

Request decision order: allowlist (mTLS only) -> blocked path -> drained upstream -> breaker -> forward with timeout.

## Run (no certs needed)
```bash
pip install aiohttp
python payments_app.py 9000 &          # Payments mock
python payments_app.py 9001 &          # Orders mock
python sidecar.py --name demo --outbound-port 8001 --config config.json --admin-token secret
curl localhost:8001/balance            # forwarded
curl localhost:8001/admin              # 403 blocked
curl localhost:8001/slow               # 504 after timeoutMs
# open http://localhost:8001/__sidecar/logs in a browser
```
Drain from the terminal:
`curl -XPOST localhost:8001/__sidecar/drain -H 'authorization: Bearer secret' -d '{"upstream":"payments","drained":true}'`

## Phone app
1. Use the ready project in `mobile/mini-envoy-app` (`npm install`, then `npx expo start`), or `npx create-expo-app mini-envoy-app`, copy `mobile/App.js` over its `App.js` and run `npx expo install react-native-safe-area-context`. Scan the QR in Expo Go.
2. Run the sidecar with `--admin-host 0.0.0.0` so the phone can reach it, then enter `http://<laptop-ip>:8001` in the app.
3. Phone and laptop on the same Wi-Fi (or the laptop's hotspot).

## Tests
```bash
python test_prd.py     # 29 checks: forward, log, timeout, block, drain, health, CSV, UI, token
python test_mesh.py    # 16 bonus checks: mTLS, rogue CA rejected, no plaintext on the wire, circuit breaker
```
`test_mesh.py` needs `bash certs/gen_certs.sh` first. Never commit `certs/*.pem`.

## Static deploy of the log view
`ui/index.html` also works as a static page on GitHub Pages or Vercel: open it as `index.html?api=http://<host>:8001/__sidecar`.

## Screenshots
Laptop width: `sample_data/log-view-laptop.png`. Phone width: `sample_data/log-view-phone.png`.
