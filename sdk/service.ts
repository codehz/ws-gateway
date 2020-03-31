import { ws, log } from "../deps.ts";
import Proto from "../proto.ts";
import {
  SERVICE_MAGIC,
  SERVICE_VERSION,
  HANDSHAKE_RESPONSE,
  ServiceSignature,
  ServiceActionType
} from "../constants.ts";

function buildHandshake(name: string, type: string, version: string) {
  const builder = new Proto.Builder(64);
  builder.finish(Proto.Service.Handshake.createHandshake(
    builder,
    builder.createString(SERVICE_MAGIC),
    SERVICE_VERSION,
    builder.createString(name),
    builder.createString(type),
    builder.createString(version),
  ));
  return builder.asUint8Array();
}

export type MethodHandler = (dec: Uint8Array) => Promise<
  Uint8Array | void
>;

export default class Service {
  private readonly type: string;
  private readonly version: string;
  private connection!: ws.WebSocket;
  private readonly handlers: Map<string, MethodHandler>;
  private readonly defaultHandler: MethodHandler;

  constructor(
    type: string,
    version: string,
    handlers: Record<string, MethodHandler>,
    defaultHandler: MethodHandler,
  ) {
    this.type = type;
    this.version = version;
    this.handlers = new Map(Object.entries(handlers));
    this.defaultHandler = defaultHandler;
  }

  async broadcast(key: string, data: Uint8Array) {
    const builder = new Proto.Builder(64 + data.length);
    builder.finish(Proto.Service.Send.SendPacket.createSendPacket(
      builder,
      Proto.Service.Send.Send.Broadcast,
      Proto.Service.Send.Broadcast.createBroadcast(
        builder,
        builder.createString(key),
        Proto.Service.Send.Broadcast.createPayloadVector(builder, data),
      ),
    ));
    await this.connection.send(builder.asUint8Array());
  }

  private async handlePacket(
    frame: Proto.Service.Receive.ReceivePacket,
    async_exception_handler: (e: any) => void,
  ) {
    switch (frame.packetType()) {
      case Proto.Service.Receive.Receive.Request: {
        const req = frame.packet(new Proto.Service.Receive.Request())!;
        const key = req.key()!;
        const id = req.id()!;
        const handler = this.handlers.get(key) ?? this.defaultHandler;
        handler(req.payloadArray()!).then(async (out) => {
          const builder = new Proto.Builder(64 + (out ? out.length : 0));
          builder.finish(Proto.Service.Send.SendPacket.createSendPacket(
            builder,
            Proto.Service.Send.Send.Response,
            Proto.Service.Send.Response.createResponse(
              builder,
              id,
              Proto.Service.Send.Response.createPayloadVector(
                builder,
                out ? out : [],
              ),
            ),
          ));
          return this.connection.send(builder.asUint8Array());
        }).catch(async (e: any) => {
          const builder = new Proto.Builder(128);
          builder.finish(Proto.Service.Send.SendPacket.createSendPacket(
            builder,
            Proto.Service.Send.Send.Exception,
            Proto.Service.Send.Exception.createException(
              builder,
              id,
              Proto.ExceptionInfo.createExceptionInfo(
                builder,
                builder.createString(e + ""),
              ),
            ),
          ));
          return this.connection.send(builder.asUint8Array());
        });
        break;
      }
      case Proto.Service.Receive.Receive.CancelRequest:
        // TODO: waiting for https://github.com/denoland/deno/issues/3345
        break;
      default:
        async_exception_handler("illegal op");
    }
  }

  private async loop(
    stream: AsyncIterableIterator<ws.WebSocketEvent>,
    async_exception_handler: (e: any) => void,
  ) {
    try {
      for await (const pkt of stream) {
        if (ws.isWebSocketCloseEvent(pkt)) break;
        if (
          ws.isWebSocketPingEvent(pkt) || ws.isWebSocketPongEvent(pkt)
        ) {
          continue;
        }
        if (pkt instanceof Uint8Array) {
          await this.handlePacket(
            Proto.Service.Receive.ReceivePacket.getRootAsReceivePacket(
              new Proto.ByteBuffer(pkt),
            ),
            async_exception_handler,
          );
        } else {
          async_exception_handler(pkt);
        }
      }
    } catch (e) {
      async_exception_handler(e);
    }
  }

  async register(
    endpoint: string,
    name: string,
    async_exception_handler: (e: any) => void,
  ) {
    if (this.isConnected) {
      throw new Error("illegal state");
    }
    const handshake = buildHandshake(name, this.type, this.version);
    const connection = await ws.connectWebSocket(endpoint);
    await connection.send(handshake);
    const stream = connection.receive();
    const { value: handshake_response } = await stream.next();
    if (
      !(handshake_response instanceof Uint8Array) ||
      Proto.Service.HandshakeResponse.getRootAsHandshakeResponse(
        new Proto.ByteBuffer(handshake_response),
      ).magic() !==
        HANDSHAKE_RESPONSE
    ) {
      throw new Error(`failed to handshake_response: ${handshake_response}`);
    }
    this.connection = connection;
    this.loop(stream, async_exception_handler);
  }

  get isConnected(): boolean {
    if (this.connection == null) return false;
    if (this.connection.isClosed) {
      delete this.connection;
      return false;
    }
    return true;
  }

  async unregister() {
    if (this.connection == null) {
      throw new Error("illegal state");
    }
    if (!this.connection.isClosed) {
      try {
        await this.connection.close();
      } catch {
        this.connection.closeForce();
      }
    }
    delete this.connection;
  }
}
