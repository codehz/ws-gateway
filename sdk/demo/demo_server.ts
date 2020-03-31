import { flags, log, async } from "../../deps.ts";
import Service from "../service.ts";
import "../../setup_log.ts";

const args = flags.parse(Deno.args, {
  default: {
    endpoint: "ws://127.0.0.1:8818",
    name: "sdk-demo",
  },
}) as { _: string[]; endpoint: string; name: string };

log.info("create service");

const dec = new TextDecoder();

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

log.info("register service");
await srv.register(args.endpoint, args.name, (e) => log.error("%#v", e));
log.info("init done.");
