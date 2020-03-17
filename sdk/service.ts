import { ws, MsgPackEncoder, MsgPackDecoder, log } from "../deps.ts";
import {
  SERVICE_MAGIC,
  SERVICE_VERSION,
  HANDSHAKE_RESPONSE,
  ServiceSignature,
  ServiceActionType
} from "../constants.ts";
import { ParameterBuilder } from "./shared.ts";

function buildHandshake(name: string, type: string, version: string) {
  const enc = new MsgPackEncoder();
  enc.putString(SERVICE_MAGIC);
  enc.putInt(SERVICE_VERSION);
  enc.putString(name);
  enc.putString(type);
  enc.putString(version);
  return enc.dump();
}

export type MethodHandler = (dec: MsgPackDecoder) => Promise<
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
    defaultHandler: MethodHandler
  ) {
    this.type = type;
    this.version = version;
    this.handlers = new Map(Object.entries(handlers));
    this.defaultHandler = defaultHandler;
  }

  async broadcast(key: string, builder: ParameterBuilder) {
    const enc = new MsgPackEncoder();
    enc.putInt(ServiceActionType.Broadcast);
    enc.putString(key);
    await this.connection.send(enc.dump(builder(enc) as any));
  }

  private async handlePacket(
    frame: MsgPackDecoder,
    async_exception_handler: (e: any) => void
  ) {
    switch (frame.expectedInteger()) {
      case ServiceSignature.Request: {
        const key = frame.expectedString();
        const id = frame.expectedInteger();
        const handler = this.handlers.get(key) ?? this.defaultHandler;
        handler(frame).then(async out => {
          const enc = new MsgPackEncoder();
          enc.putInt(ServiceActionType.Response);
          enc.putInt(id);
          await this.connection.send(enc.dump(out as any));
        }).catch(async (e: any) => {
          const enc = new MsgPackEncoder();
          enc.putInt(ServiceActionType.Exception);
          enc.putInt(id);
          enc.putString(e + "");
          await this.connection.send(enc.dump());
        });
        break;
      }
      case ServiceSignature.CancelRequest:
        // TODO: waiting for https://github.com/denoland/deno/issues/3345
        break;
      default:
        async_exception_handler("illegal op");
    }
  }

  private async loop(
    stream: AsyncIterableIterator<ws.WebSocketEvent>,
    async_exception_handler: (e: any) => void
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
            new MsgPackDecoder(pkt),
            async_exception_handler
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
    async_exception_handler: (e: any) => void
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
      new MsgPackDecoder(handshake_response).expectedString() !==
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
