import { flags, log, async } from "../../deps.ts";
import Client from "../client.ts";
import "../../setup_log.ts";

const args = flags.parse(Deno.args, {
  default: {
    endpoint: "ws://127.0.0.1:8808",
    name: "sdk-demo",
  },
}) as { _: string[]; endpoint: string; name: string };

const enc = new TextEncoder();
const dec = new TextDecoder();
const client = new Client();
log.info("connecting to %s", args.endpoint);
await client.connect(args.endpoint, (e) => log.error("%#v", e));
log.info("connected, get service %s", args.name);
const srv = await client.get(args.name);
log.info("got service, waiting online");
await srv.waitOnline();
log.info("subscribe event");
await srv.on("test", async (data) => {
  log.info("received event: %#v", dec.decode(data));
});
log.info("call delay(200)");
await srv.call("delay", new Uint8Array(255));
log.info("call echo('test')");
const res = await srv.call("echo", enc.encode("test"));
log.info("back: %s", dec.decode(res));
try {
  log.info("call exception");
  await srv.call("exception", enc.encode("expected exception"));
  log.error("should never go here");
} catch (e) {
  if (!(typeof e === "string")) {
    log.error("%#v", e);
  } else {
    log.info("got exception: %s", e);
  }
}
log.info("try emit event");
await srv.call(
  "broadcast",
  new Uint8Array([4, ...enc.encode("test"), ...enc.encode("boom")]),
);
log.info("delay 1s");
await async.delay(1000);
log.info("bye service");
await srv.disconnect();
log.info("disconnect");
await client.disconnect();
log.info("now exit");
