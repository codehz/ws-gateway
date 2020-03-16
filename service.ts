import { http, ws, MsgPackDecoder, log } from "./deps.ts";
import {
  ServiceProxy
} from "./bridge.ts";
import {
  SERVICE_MAGIC,
  SERVICE_VERSION,
  ServiceActionType as ActionType
} from "./constants.ts";

async function* handleSession(
  sock: ws.WebSocket,
  reg: (() => void)[]
): AsyncGenerator<
  undefined,
  void,
  MsgPackDecoder
> {
  const handshake = yield;
  if (handshake.expectedString() != SERVICE_MAGIC) {
    throw new Error("Invalid magic");
  }
  if (handshake.expectedInteger() != SERVICE_VERSION) {
    throw new Error("Invalid version");
  }
  const name = handshake.expectedString();
  const type = handshake.expectedString();
  const version = handshake.expectedString();
  const service = ServiceProxy.register(name, type, version, sock);
  reg.push(() => service.unregister());
  while (true) {
    const frame = yield;
    switch (frame.expectedInteger() as ActionType) {
      case ActionType.Response:
        await service.response(frame.expectedInteger(), frame.getRest());
        break;
      case ActionType.Broadcast:
        await service.broadcast(frame.expectedString(), frame.getRest());
        break;
      default:
        await sock.send(`invalid op: ${type}`);
        break;
    }
  }
}

async function handleWebsocket(sock: ws.WebSocket) {
  const reg: (() => void)[] = [];
  const hand = handleSession(sock, reg);
  await hand.next();
  try {
    for await (const packet of sock.receive()) {
      if (ws.isWebSocketPingEvent(packet) && ws.isWebSocketPongEvent(packet)) {
        continue;
      }
      if (ws.isWebSocketCloseEvent(packet)) break;
      if (packet instanceof Uint8Array) {
        const { done } = await hand.next(new MsgPackDecoder(packet));
        if (done) break;
      }
    }
  } catch (e) {
    try {
      if (e instanceof Error) {
        await sock.send(e.message);
      } else {
        await sock.send(e + "");
      }
    } catch {}
  } finally {
    if (!sock.isClosed) {
      sock.close();
    }
    reg.forEach(x => x());
  }
}

export default async function(address: string) {
  for await (const req of http.serve(address)) {
    ws.acceptWebSocket({
      conn: req.conn,
      headers: req.headers,
      bufReader: req.r,
      bufWriter: req.w
    }).then(handleWebsocket).catch(() => {});
  }
}
