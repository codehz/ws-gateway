import { http, ws, MsgPackDecoder, MsgPackEncoder, log } from "./deps.ts";
import { ClientProxy } from "./bridge.ts";
import {
  GATEWAY_MAGIC,
  GATEWAY_VERSION,
  HANDSHAKE_RESPONSE,
  GatewayActionType as ActionType
} from "./constants.ts";

const RESP = (() => {
  const enc = new MsgPackEncoder();
  enc.putString(HANDSHAKE_RESPONSE);
  return enc.dump();
})();

async function* handleSession(
  sock: ws.WebSocket,
  reg: (() => void)[]
): AsyncGenerator<
  undefined,
  void,
  MsgPackDecoder
> {
  const handshake = yield;
  if (handshake.expectedString() != GATEWAY_MAGIC) {
    throw new Error("Invalid magic");
  }
  if (handshake.expectedInteger() != GATEWAY_VERSION) {
    throw new Error("Invalid version");
  }
  const client = ClientProxy.register(sock);
  reg.push(() => client.unregister());
  await sock.send(RESP);
  while (true) {
    const frame = yield;
    switch (frame.expectedInteger() as ActionType) {
      case ActionType.GetServiceList:
        await client.send_service_list();
        break;
      case ActionType.WaitService:
        await client.add_wait_list(frame.expectedString());
        break;
      case ActionType.CancelWaitService:
        await client.remove_from_wait_list(frame.expectedString());
        break;
      case ActionType.CallService:
        await client.request_method(
          frame.expectedString(),
          frame.expectedString(),
          frame.getRest()
        );
        break;
      case ActionType.CancelCallService:
        await client.cancel_request(
          frame.expectedString(),
          frame.expectedInteger()
        );
        break;
      case ActionType.SubscribeService:
        await client.add_subscribe(
          frame.expectedString(),
          frame.expectedString()
        );
        break;
      case ActionType.UnsubscribeService:
        await client.unsubscribe(
          frame.expectedString(),
          frame.expectedString()
        );
        break;
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
        const { done, value } = await hand.next(new MsgPackDecoder(packet));
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
