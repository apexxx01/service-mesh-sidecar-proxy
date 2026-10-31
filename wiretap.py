"""A man-in-the-middle 'wiretap': relays TCP bytes between sidecars and records everything it sees.
Used to PROVE zero plaintext leakage: the secret must never appear in the captured bytes."""
import asyncio, sys

listen_port, target_port, capture_file = int(sys.argv[1]), int(sys.argv[2]), sys.argv[3]

async def pipe(reader, writer, sink):
    try:
        while data := await reader.read(65536):
            sink.write(data); sink.flush()
            writer.write(data); await writer.drain()
    except (ConnectionError, asyncio.CancelledError):
        pass
    finally:
        writer.close()

async def handle(client_r, client_w):
    up_r, up_w = await asyncio.open_connection("127.0.0.1", target_port)
    with open(capture_file, "ab") as sink:
        await asyncio.gather(pipe(client_r, up_w, sink), pipe(up_r, client_w, sink))

async def main():
    server = await asyncio.start_server(handle, "127.0.0.1", listen_port)
    print(f"[wiretap] :{listen_port} -> :{target_port}, capturing to {capture_file}", flush=True)
    async with server:
        await server.serve_forever()

asyncio.run(main())
