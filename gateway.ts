import { http, ws, log } from "./deps.ts";
import Proto from "./proto.ts";
import { ClientProxy } from "./bridge.ts";
import {
  GATEWAY_MAGIC,
  GATEWAY_VERSION,
  HANDSHAKE_RESPONSE,
  GatewayActionType as ActionType
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
  const handshake = Proto.Client.Handshake.getRootAsHandshake(yield);
  if (handshake.magic() != GATEWAY_MAGIC) {
    throw new Error("Invalid magic");
  }
  if (handshake.version() != GATEWAY_VERSION) {
    throw new Error("Invalid version");
  }
  const client = ClientProxy.register(sock);
  reg.push(() => client.unregister());
  await sock.send(RESP);
  while (true) {
    const frame = Proto.Client.Send.SendPacket.getRootAsSendPacket(yield);
    switch (frame.sendType()) {
      case Proto.Client.Send.Send.GetServiceList:
        await client.send_service_list();
        break;
      case Proto.Client.Send.Send.WaitService: {
        const obj = frame.send(new Proto.Client.Send.WaitService())!;
        await client.add_wait_list(obj.name()!);
        break;
      }
      case Proto.Client.Send.Send.CancelWaitService: {
        const obj = frame.send(new Proto.Client.Send.CancelWaitService())!;
        await client.remove_from_wait_list(obj.name()!);
        break;
      }
      case Proto.Client.Send.Send.CallService: {
        const obj = frame.send(new Proto.Client.Send.CallService())!;
        await client.request_method(
          obj.name()!,
          obj.key()!,
          obj.payloadArray()!,
        );
        break;
      }
      case Proto.Client.Send.Send.CancelCallService: {
        const obj = frame.send(new Proto.Client.Send.CancelCallService())!;
        await client.cancel_request(obj.name()!, obj.id()!);
        break;
      }
      case Proto.Client.Send.Send.SubscribeService: {
        const obj = frame.send(new Proto.Client.Send.SubscribeService())!;
        await client.add_subscribe(obj.name()!, obj.key()!);
        break;
      }
      case Proto.Client.Send.Send.UnscribeService: {
        const obj = frame.send(new Proto.Client.Send.UnscribeService())!;
        await client.unsubscribe(obj.name()!, obj.key()!);
        break;
      }
      default:
        await sock.send("Not implemented");
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
        const { done, value } = await hand.next(new Proto.ByteBuffer(packet));
        if (done) break;
        if (value != undefined) {
          reg.push(value);
        }
      }
    }
  } catch (e) {
    log.error("%#v", e);
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
