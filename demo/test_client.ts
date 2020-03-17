import {
  ws,
  MsgPackDecoder,
  MsgPackEncoder,
  flags,
  log,
  async
} from "../deps.ts";
import "../setup_log.ts";
import {
  GATEWAY_MAGIC,
  GATEWAY_VERSION,
  GatewayActionType,
  ClientSignature,
  WaitResult,
  HANDSHAKE_RESPONSE
} from "../constants.ts";

function assertEquals<T>(left: T, right: T, ex?: string) {
  if (left !== right) throw new Error(ex || "assert failed");
}

function buildHandshake() {
  const enc = new MsgPackEncoder();
  enc.putString(GATEWAY_MAGIC);
  enc.putInt(GATEWAY_VERSION);
  return enc.dump();
}

function buildGetServiceList() {
  const enc = new MsgPackEncoder();
  enc.putInt(GatewayActionType.GetServiceList);
  return enc.dump();
}

function buildWaitService(name: string) {
  const enc = new MsgPackEncoder();
  enc.putInt(GatewayActionType.WaitService);
  enc.putString(name);
  return enc.dump();
}

function buildMethodCall(name: string, key: string, data: string) {
  const enc = new MsgPackEncoder();
  enc.putInt(GatewayActionType.CallService);
  enc.putString(name);
  enc.putString(key);
  // user data
  enc.putString(data);
  return enc.dump();
}

function buildSubscribe(name: string, key: string) {
  const enc = new MsgPackEncoder();
  enc.putInt(GatewayActionType.SubscribeService);
  enc.putString(name);
  enc.putString(key);
  return enc.dump();
}

const args = flags.parse(Deno.args, {
  default: {
    endpoint: "ws://127.0.0.1:8808",
    name: "demo"
  }
}) as { _: string[]; endpoint: string; name: string };

log.info("connecting %s", args.endpoint);
const sock = await ws.connectWebSocket(args.endpoint);
log.info("connected, sending handshake");
await sock.send(buildHandshake());
log.info("waiting handshake response");

async function* handler(): AsyncGenerator<undefined, void, MsgPackDecoder> {
  const handshake_response = yield;
  assertEquals(
    handshake_response.expectedString(),
    HANDSHAKE_RESPONSE,
    "failed to handshake"
  );
  log.info("handshake ok");
  log.info("get service list");
  await sock.send(buildGetServiceList());
  const service_list = yield;
  assertEquals(
    service_list.expectedInteger(),
    ClientSignature.Sync,
    "Unexpected sig"
  );
  const len = service_list.expectedMap();
  for (let i = 0; i < len; i++) {
    const name = service_list.expectedString();
    assertEquals(
      service_list.expectedArray(),
      2,
      "Unexpected arr"
    );
    const type = service_list.expectedString();
    const version = service_list.expectedString();
    log.info("service %s (%s) version: %s", name, type, version);
  }
  log.info("wait %s service", args.name);
  await sock.send(buildWaitService(args.name));
  const wait_result = yield;
  assertEquals(
    wait_result.expectedInteger(),
    ClientSignature.Sync,
    "Unexpected sig"
  );
  if (!wait_result.expectedBool()) {
    log.debug("service is offline, waiting it online");
    const async_result = yield;
    assertEquals(
      async_result.expectedInteger(),
      ClientSignature.Wait,
      "Unexpected wait result"
    );
    assertEquals(
      async_result.expectedString(),
      args.name,
      "Unexpected wait name"
    );
    assertEquals(
      async_result.expectedBool(),
      WaitResult.Online,
      "Unexpected wait status"
    );
  }
  log.info("service is online");
  await sock.send(buildMethodCall(args.name, "echo", "hello"));
  const callid_res = yield;
  assertEquals(
    callid_res.expectedInteger(),
    ClientSignature.Sync,
    "Unexpected sig"
  );
  assertEquals(callid_res.expectedBool(), true, "Service not found");
  const id = callid_res.expectedInteger();
  log.info("reqid: %d", id);
  const resp = yield;
  assertEquals(
    resp.expectedInteger(),
    ClientSignature.Response,
    "Unexpected sig"
  );
  assertEquals(resp.expectedString(), args.name, "Different service name");
  assertEquals(resp.expectedInteger(), id, "Different id");
  log.info("res: %s", resp.expectedString());
  await sock.send(buildSubscribe(args.name, "tick"));
  const sub_res = yield;
  assertEquals(
    sub_res.expectedInteger(),
    ClientSignature.Sync,
    "Unexpected sig"
  );
  assertEquals(sub_res.expectedBool(), true, "Service not found");
  while (true) {
    const event = yield;
    switch (event.expectedInteger()) {
      case ClientSignature.Wait:
        assertEquals(event.expectedString(), args.name, "Invalid target");
        assertEquals(
          event.expectedBool(),
          WaitResult.Offline,
          "Invalid state"
        );
        return;
      case ClientSignature.CancelSubscribe:
        break;
      case ClientSignature.Broadcast:
        assertEquals(
          event.expectedString(),
          args.name,
          "Service name not match"
        );
        assertEquals(event.expectedString(), "tick", "Invalid event");
        log.info("tick %d", event.expectedInteger());
        break;
      default:
        throw "Invalid state";
    }
  }
}

const hand = handler();
await hand.next();

for await (const pkt of sock.receive()) {
  log.debug("packet: %#v", pkt);
  if (ws.isWebSocketCloseEvent(pkt)) break;
  if (ws.isWebSocketPingEvent(pkt) || ws.isWebSocketPongEvent(pkt)) continue;
  if (pkt instanceof Uint8Array) {
    const { done } = await hand.next(new MsgPackDecoder(pkt));
    if (done) break;
  }
}
log.info("done");
