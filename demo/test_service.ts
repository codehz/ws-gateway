import {
  ws,
  MsgPackDecoder,
  MsgPackEncoder,
  flags,
  log,
  async
} from "../deps.ts";
import {
  SERVICE_MAGIC,
  SERVICE_VERSION,
  ServiceSignature,
  ServiceActionType
} from "../constants.ts";
import "../setup_log.ts";

function buildHandshake(name: string) {
  const enc = new MsgPackEncoder();
  enc.putString(SERVICE_MAGIC);
  enc.putInt(SERVICE_VERSION);
  enc.putString(name);
  enc.putString("demo");
  enc.putString("0.0.0");
  return enc.dump();
}

function buildEcho(key: string, id: number, data: Uint8Array): Uint8Array {
  const enc = new MsgPackEncoder();
  enc.putInt(ServiceActionType.Response);
  enc.putInt(id);
  // user data
  enc.putString(key);
  return enc.dump(data);
}

function buildTick() {
  const enc = new MsgPackEncoder();
  enc.putInt(ServiceActionType.Broadcast);
  enc.putString("tick");
  // user data
  enc.putInt(new Date().getTime());
  return enc.dump();
}

async function processPacket(frame: MsgPackDecoder, sock: ws.WebSocket) {
  switch (frame.expectedInteger()) {
    case ServiceSignature.Request: {
      const key = frame.expectedString();
      const id = frame.expectedInteger();
      log.info("call %s@%d", key, id);
      sock.send(buildEcho(key, id, frame.getRest())).catch(() => {});
      break;
    }
    case ServiceSignature.CancelRequest:
      // ignore
      break;
  }
}

const args = flags.parse(Deno.args, {
  default: {
    endpoint: "ws://127.0.0.1:8818",
    name: "demo"
  }
}) as { _: string[]; endpoint: string; name: string };

log.info("connecting %s", args.endpoint);
const sock = await ws.connectWebSocket(args.endpoint);
log.info("connected, sending handshake");
await sock.send(buildHandshake(args.name));
log.info("starting receive");

let done = false;

(async () => {
  do {
    sock.send(buildTick());
    await async.delay(1000);
  } while (!done);
})();

for await (const pkt of sock.receive()) {
  log.debug("packet: %v", pkt);
  if (ws.isWebSocketCloseEvent(pkt)) break;
  if (ws.isWebSocketPingEvent(pkt) || ws.isWebSocketPongEvent(pkt)) continue;
  if (pkt instanceof Uint8Array) {
    await processPacket(new MsgPackDecoder(pkt), sock);
  } else {
    log.error("error: %s", ws);
  }
}
done = true;
if (!sock.isClosed) {
  await sock.close();
}
