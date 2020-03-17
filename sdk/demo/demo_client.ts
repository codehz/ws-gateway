import { flags, MsgPackDecoder, log, async } from "../../deps.ts";
import Client from "../client.ts";
import "../../setup_log.ts";

const args = flags.parse(Deno.args, {
  default: {
    endpoint: "ws://127.0.0.1:8808",
    name: "sdk-demo"
  }
}) as { _: string[]; endpoint: string; name: string };

const client = new Client();
log.info("connecting to %s", args.endpoint);
await client.connect(args.endpoint, e => log.error("%#v", e));
log.info("connected, get service %s", args.name);
const srv = await client.get(args.name);
log.info("got service, waiting online");
await srv.waitOnline();
log.info("subscribe event");
await srv.on("event", async data => {
  log.info("received event: %s", data.expectedString());
});
log.info("call delay(200)");
await srv.call("delay", enc => {
  enc.putInt(200);
});
log.info("call echo('test')");
const res = await srv.call("echo", enc => {
  enc.putString("test");
});
log.info("back: %s", res.expectedString());
try {
  log.info("call exception");
  await srv.call("exception", enc => {
    enc.putString("expected exception");
  });
  log.error("should never go here");
} catch (e) {
  if (!(e instanceof MsgPackDecoder)) {
    log.error("%#v", e);
  } else {
    log.info("got exception: %s", e.expectedString());
  }
}
log.info("try emit event");
await srv.call("broadcast", enc => {
  enc.putString("event");
  enc.putString("hello");
});
log.info("delay 1s");
await async.delay(1000);
log.info("bye service");
await srv.disconnect();
log.info("disconnect");
await client.disconnect();
log.info("now exit");
