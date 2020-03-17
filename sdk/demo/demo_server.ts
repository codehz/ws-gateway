import { flags, MsgPackDecoder, log, async } from "../../deps.ts";
import Service from "../service.ts";
import "../../setup_log.ts";

const args = flags.parse(Deno.args, {
  default: {
    endpoint: "ws://127.0.0.1:8818",
    name: "sdk-demo"
  }
}) as { _: string[]; endpoint: string; name: string };

log.info("create service");
const srv = new Service("sdk-demo", "0.0.1", {
  async echo(dec: MsgPackDecoder) {
    log.info("try to echo %#v", dec.getRest());
    return dec.getRest();
  },
  async delay(dec: MsgPackDecoder) {
    const dur = dec.expectedInteger();
    log.info("try to delay %d", dur);
    await async.delay(dur);
  },
  async exception(ex: MsgPackDecoder) {
    log.info("try to throw exception");
    throw new Error(ex.expectedString());
  },
  async broadcast(ex: MsgPackDecoder) {
    await srv.broadcast(ex.expectedString(), () => ex.getRest());
  }
}, () => {
  throw new Error("not implemented");
});

log.info("register service");
await srv.register(args.endpoint, args.name, e => log.error("%#v", e));
log.info("init done.");
