import { ws, MsgPackEncoder, MsgPackDecoder, async } from "../deps.ts";
import {
  GATEWAY_MAGIC,
  GATEWAY_VERSION,
  HANDSHAKE_RESPONSE,
  ClientSignature,
  GatewayActionType
} from "../constants.ts";
import Map2 from "../map2.ts";
import { Deferred, deferred } from "https://deno.land/std/util/async.ts";
import { ParameterBuilder } from "./shared.ts";

function buildHandshake() {
  const enc = new MsgPackEncoder();
  enc.putString(GATEWAY_MAGIC);
  enc.putInt(GATEWAY_VERSION);
  return enc.dump();
}

export type EventHandler = (dec: MsgPackDecoder) => PromiseLike<void>;

export class ServiceProxy {
  private _status: boolean;
  private client: Client;
  private name: string;
  private wait?: Deferred<boolean>;
  private _initFn?: (self: ServiceProxy) => PromiseLike<void>;

  constructor(
    client: Client,
    name: string,
    status: boolean
  ) {
    this.client = client;
    this.name = name;
    this._status = status;
  }

  init(initFn: (self?: ServiceProxy) => PromiseLike<void>) {
    this._initFn = initFn;
    if (this.status != null && this._initFn != null) {
      this._initFn(this);
    }
  }

  async call(key: string, builder: ParameterBuilder): Promise<MsgPackDecoder> {
    return this.client._start_call(this.name, key, builder);
  }

  async on(key: string, handler: EventHandler): Promise<void> {
    return this.client._subscribe(this.name, key, handler);
  }

  async off(key: string): Promise<boolean> {
    return this.client._unsubscribe(this.name, key);
  }

  async disconnect(): Promise<boolean> {
    return this.client._cancel_wait(this.name);
  }

  async waitOnline(): Promise<void> {
    if (this.status) return;
    this.wait = deferred();
    await this.wait;
  }

  async waitOffline(): Promise<void> {
    if (!this.status) return;
    this.wait = deferred();
    await this.wait;
  }

  get status(): boolean {
    return this._status;
  }
  set status(val: boolean) {
    this._status = val;
    this.wait?.resolve(val);
    delete this.wait;
    this._initFn?.(this);
  }
}

export default class Client {
  private connection!: ws.WebSocket;
  private syncHandler?: async.Deferred<MsgPackDecoder>;
  private syncQueue: Array<async.Deferred<void>> = [];
  private readonly pending_call: Map2<
    string,
    number,
    async.Deferred<MsgPackDecoder>
  > = new Map2();
  private readonly listeners: Map2<
    string,
    string,
    EventHandler
  > = new Map2();
  private readonly wait_list: Map<
    string,
    ServiceProxy
  > = new Map();

  private async send_sync(data: Uint8Array): Promise<MsgPackDecoder> {
    if (this.syncHandler != null) {
      const sig = deferred<void>();
      this.syncQueue.push(sig);
      await sig;
    }
    const defer = deferred<MsgPackDecoder>();
    this.syncHandler = defer;
    await this.connection.send(data);
    return defer;
  }

  async _start_call(
    name: string,
    key: string,
    builder: ParameterBuilder
  ): Promise<MsgPackDecoder> {
    const enc = new MsgPackEncoder();
    enc.putInt(GatewayActionType.CallService);
    enc.putString(name);
    enc.putString(key);
    const sync = await this.send_sync(enc.dump(builder(enc) as any));
    const result = sync.expectedBool();
    if (!result) throw new Error("service not exists");
    const id = sync.expectedInteger();
    const defer = deferred<MsgPackDecoder>();
    this.pending_call.set(name, id, defer);
    return defer;
  }

  async _subscribe(
    name: string,
    key: string,
    handler: EventHandler
  ): Promise<void> {
    if (this.listeners.has(name, key)) {
      throw new Error(
        "cannot subscribe same event multiple times"
      );
    }
    const enc = new MsgPackEncoder();
    enc.putInt(GatewayActionType.SubscribeService);
    enc.putString(name);
    enc.putString(key);
    const sync = await this.send_sync(enc.dump());
    const result = sync.expectedBool();
    if (!result) throw new Error("service not exists");
    this.listeners.set(name, key, handler);
  }

  async _unsubscribe(name: string, key: string): Promise<boolean> {
    if (!this.listeners.has(name, key)) return false;
    const enc = new MsgPackEncoder();
    enc.putInt(GatewayActionType.UnsubscribeService);
    enc.putString(name);
    enc.putString(key);
    const sync = await this.send_sync(enc.dump());
    return sync.expectedBool();
  }

  async _cancel_wait(name: string): Promise<boolean> {
    if (this.wait_list.has(name)) {
      const enc = new MsgPackEncoder();
      enc.putInt(GatewayActionType.CancelWaitService);
      enc.putString(name);
      const sync = await this.send_sync(enc.dump());
      this.wait_list.delete(name);
      return sync.expectedBool();
    }
    return false;
  }

  async get(name: string): Promise<ServiceProxy> {
    const exist = this.wait_list.get(name);
    if (exist != null) return exist;
    const enc = new MsgPackEncoder();
    enc.putInt(GatewayActionType.WaitService);
    enc.putString(name);
    const sync = await this.send_sync(enc.dump());
    const status = sync.expectedBool();
    const ret = new ServiceProxy(this, name, status);
    this.wait_list.set(name, ret);
    return ret;
  }

  private async handlePacket(
    frame: MsgPackDecoder,
    async_exception_handler: (e: any) => void
  ) {
    switch (frame.expectedInteger()) {
      case ClientSignature.Sync:
        if (this.syncHandler != null) {
          this.syncHandler.resolve(frame);
          delete this.syncHandler;
          const next = this.syncQueue.shift();
          if (next) next.resolve();
        } else {
          async_exception_handler("illegal state");
        }
        break;
      case ClientSignature.Response: {
        const name = frame.expectedString();
        const id = frame.expectedInteger();
        const pending = this.pending_call.get(name, id);
        if (pending) {
          this.pending_call.delete(name, id);
          pending.resolve(frame);
        }
        break;
      }
      case ClientSignature.Broadcast: {
        const name = frame.expectedString();
        const key = frame.expectedString();
        await this.listeners.get(name, key)?.(frame);
        break;
      }
      case ClientSignature.Wait: {
        const name = frame.expectedString();
        const status = frame.expectedBool();
        const pxy = this.wait_list.get(name);
        if (pxy != null) pxy.status = status;
        if (status == false) {
          const calls = this.pending_call.get(name);
          if (calls != null) {
            for (const [, p] of calls) {
              p.reject(new Error("service die"));
            }
            this.pending_call.delete(name);
          }
          this.listeners.delete(name);
        }
        break;
      }
      case ClientSignature.CancelRequest: {
        const name = frame.expectedString();
        const id = frame.expectedInteger();
        const pending = this.pending_call.get(name, id);
        if (pending) {
          this.pending_call.delete(name, id);
          pending.reject(new Error("cancel"));
        }
        break;
      }
      case ClientSignature.CancelSubscribe: {
        const name = frame.expectedString();
        const key = frame.expectedString();
        this.listeners.delete(name, key);
        break;
      }
      case ClientSignature.Exception: {
        const name = frame.expectedString();
        const id = frame.expectedInteger();
        const pending = this.pending_call.get(name, id);
        if (pending) {
          this.pending_call.delete(name, id);
          pending.reject(frame);
        }
        break;
      }
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

  async connect(endpoint: string, async_exception_handler: (e: any) => void) {
    if (this.isConnected) {
      throw new Error("illegal state");
    }
    const handshake = buildHandshake();
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

  async disconnect() {
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
