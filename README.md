# ws-gateway
WebSocket API gateway built using deno

[Protocol Draft](spec.md)

## Usage

For service:

``` typescript
import { delay } from "https://deno.land/std/util.ts";
import Service from "https://deno.hertz.services/codehz/ws-gateway/sdk/service.ts";

// register service
const srv = new Service("sdk-demo", "0.0.1", {
  async echo(obj: Uint8Array) {
    log.info("try to echo %#v", obj);
    return obj;
  },
  async delay(obj: Uint8Array) {
    const dur = obj[0];
    log.info("try to delay %d", dur);
    await async.delay(dur);
  },
  async exception(ex: Uint8Array) {
    log.info("try to throw exception");
    throw new Error(dec.decode(ex));
  },
  async broadcast(obj: Uint8Array) {
    const spl = obj[0];
    const key = dec.decode(obj.subarray(1, spl + 1));
    const data = obj.subarray(spl + 1);
    await srv.broadcast(key, data);
  },
}, () => {
  throw new Error("not implemented");
});

await srv.register("ws://127.0.0.1:8818", "demo", e => log.error("%#v", e));
```

For client:

``` typescript
import Client from "https://deno.hertz.services/codehz/ws-gateway/sdk/client.ts";

const enc = new TextEncoder();
const dec = new TextDecoder();
const client = new Client();
// connect to ws-gateway
await client.connect("ws://127.0.0.1:8808", e => log.error("%#v", e));
// get service proxy
const srv = await client.get("demo");
// wait service online (return immediately when online already)
await srv.waitOnline();
// subscribe event listener
await srv.on("event", async data => {
  log.info("received event: %#v", data);
});
// call method
await srv.call("delay", new Uint8Array(255));
// call method and wait result
const res = await srv.call("echo", enc.encode("test"));
// parse result
console.log("back: %s", res.expectedString());
try {
  await srv.call("exception", enc.encode("expected exception"));
} catch(e) {
  if (e instanceof MsgPackDecoder) {
    console.log("expected exception from service: ", e);
  }
}
// disconnect service
await srv.disconnect();
// disconnect client
await client.disconnect();
```

## LICENSE

GPL v3