import serveGateway from "./gateway.ts";
import serveService from "./service.ts";
import { log, flags } from "./deps.ts";
import "./setup_log.ts";

const args = flags.parse(Deno.args, {
  default: {
    service: "127.0.0.1:8818",
    gateway: "0.0.0.0:8808",
  },
}) as { _: string[]; service: string; gateway: string };

log.info("service: %s", args.service);
log.info("gateway: %s", args.gateway);
log.debug("result: %#v", await Promise.allSettled(
  [serveService(args.service), serveGateway(args.gateway)],
));
