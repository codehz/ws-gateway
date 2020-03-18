# ws-gateway
WebSocket API gateway built using deno

[Protocol Draft](spec.md)

## Usage

For service:

``` typescript
import { delay } from "https://deno.land/std/util/ts";
import { MsgPackDecoder } from "https://deno.hertz.services/codehz/msgpack-deno";
import Service from "https://deno.hertz.services/codehz/ws-gateway/sdk/service.ts";

// register service
const srv = new Service("demo", "0.0.1", {
  // define methods
  async echo(dec: MsgPackDecoder) {
    return dec.getRest();
  },
  async delay(dec: MsgPackDecoder) {
    const dur = dec.expectedInteger();
    await delay(dur);
  },
  async exception(ex: MsgPackDecoder) {
    throw new Error(ex.expectedString());
  },
  async broadcast(ex: MsgPackDecoder) {
    await srv.broadcast(ex.expectedString(), () => ex.getRest());
  }
}, () => {
  // default method handler
  throw new Error("not implemented");
});

await srv.register("ws://127.0.0.1:8818", "demo", e => log.error("%#v", e));
```

For client:

``` typescript
import Client from "https://deno.hertz.services/codehz/ws-gateway/sdk/client.ts";

const client = new Client();
// connect to ws-gateway
await client.connect("ws://127.0.0.1:8808", e => log.error("%#v", e));
// get service proxy
const srv = await client.get("demo");
// wait service online (return immediately when online already)
await srv.waitOnline();
// subscribe event listener
await srv.on("event", async data => {
  log.info("received event: ", data.expectedString());
});
// call method
await srv.call("delay", enc => {
  // build parameters
  enc.putInt(200);
});
// call method and wait result
const res = await srv.call("echo", enc => {
  enc.putString("test");
});
// parse result
console.log("back: %s", res.expectedString());
try {
  await srv.call("exception", enc => {
    enc.putString("expected exception");
  });
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