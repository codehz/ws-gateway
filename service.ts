import { http, ws } from "./deps.ts";
import Proto from "./proto.ts";
import { ServiceProxy } from "./bridge.ts";
import {
  SERVICE_MAGIC,
  SERVICE_VERSION,
  HANDSHAKE_RESPONSE,
  ServiceActionType as ActionType
} from "./constants.ts";

const RESP = (() => {
  const builder = new Proto.Builder(32);
  builder.finish(Proto.Service.HandshakeResponse.createHandshakeResponse(
    builder,
    builder.createString(HANDSHAKE_RESPONSE),
  ));
  return builder.asUint8Array();
})();

async function* handleSession(
  sock: ws.WebSocket,
  reg: (() => void)[],
): AsyncGenerator<
  undefined,
  void,
  Proto.ByteBuffer
> {
  const handshake = Proto.Service.Handshake.getRootAsHandshake(yield);
  if (handshake.magic() != SERVICE_MAGIC) {
    throw new Error("Invalid magic: " + handshake.magic());
  }
  if (handshake.version() != SERVICE_VERSION) {
    throw new Error("Invalid version");
  }
  const name = handshake.name()!;
  const type = handshake.type()!;
  const version = handshake.srvver()!;
  reg.push(() => service.unregister());
  const service = ServiceProxy.register(name, type, version, sock);
  await sock.send(RESP);
  while (true) {
    const frame = Proto.Service.Send.SendPacket.getRootAsSendPacket(yield);
    switch (frame.packetType()) {
      case Proto.Service.Send.Send.Response: {
        const resp = frame.packet(new Proto.Service.Send.Response())!;
        await service.response(resp.id(), resp.payloadArray()!);
        break;
      }
      case Proto.Service.Send.Send.Broadcast: {
        const resp = frame.packet(new Proto.Service.Send.Broadcast())!;
        await service.broadcast(resp.key()!, resp.payloadArray()!);
        break;
      }
      case Proto.Service.Send.Send.Exception: {
        const resp = frame.packet(new Proto.Service.Send.Exception())!;
        await service.exception(resp.id(), resp.info()!.message()!);
        break;
      }
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
        const { done } = await hand.next(new Proto.ByteBuffer(packet));
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
    reg.forEach((x) => x());
  }
}

export default async function (address: string) {
  for await (const req of http.serve(address)) {
    ws.acceptWebSocket({
      conn: req.conn,
      headers: req.headers,
      bufReader: req.r,
      bufWriter: req.w,
    }).then(handleWebsocket).catch(() => {});
  }
}
