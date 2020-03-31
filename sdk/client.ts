import { ws, async } from "../deps.ts";
import Proto from "../proto.ts";
import {
  GATEWAY_MAGIC,
  GATEWAY_VERSION,
  HANDSHAKE_RESPONSE,
  ClientSignature,
  GatewayActionType
} from "../constants.ts";
import Map2 from "../map2.ts";
import { Deferred, deferred } from "https://deno.land/std/util/async.ts";

function buildHandshake() {
  const builder = new Proto.Builder(64);
  builder.finish(
    Proto.Client.Handshake.createHandshake(
      builder,
      builder.createString(GATEWAY_MAGIC),
      GATEWAY_VERSION,
    ),
  );
  return builder.asUint8Array();
}

export type EventHandler = (obj: Uint8Array) => PromiseLike<void>;

export class ServiceProxy {
  private _status: boolean;
  private client: Client;
  private name: string;
  private wait?: Deferred<boolean>;
  private _initFn?: (self: ServiceProxy) => PromiseLike<void>;

  constructor(
    client: Client,
    name: string,
    status: boolean,
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

  async call(key: string, data: Uint8Array): Promise<Uint8Array> {
    return this.client._start_call(this.name, key, data);
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
  private syncHandler?: async.Deferred<Proto.Client.Receive.Sync.SyncResult>;
  private syncQueue: Array<async.Deferred<void>> = [];
  private readonly pending_call: Map2<
    string,
    number,
    async.Deferred<Uint8Array>
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

  private async send_sync(
    data: Uint8Array,
  ): Promise<Proto.Client.Receive.Sync.SyncResult> {
    if (this.syncHandler != null) {
      const sig = deferred<void>();
      this.syncQueue.push(sig);
      await sig;
    }
    const defer = deferred<Proto.Client.Receive.Sync.SyncResult>();
    this.syncHandler = defer;
    await this.connection.send(data);
    return defer;
  }

  async _start_call(
    name: string,
    key: string,
    data: Uint8Array,
  ): Promise<Uint8Array> {
    const builder = new Proto.Builder(64 + data.length);
    builder.finish(Proto.Client.Send.SendPacket.createSendPacket(
      builder,
      Proto.Client.Send.Send.CallService,
      Proto.Client.Send.CallService.createCallService(
        builder,
        builder.createString(name),
        builder.createString(key),
        Proto.Client.Send.CallService.createPayloadVector(builder, data),
      ),
    ));
    const sync = await this.send_sync(builder.asUint8Array());
    if (
      sync.syncType() !== Proto.Client.Receive.Sync.Sync.RequestResult
    ) {
      throw new Error("service not exists");
    }
    const result = sync.sync(new Proto.Client.Receive.Sync.RequestResult())!;
    const id = result.id();
    const defer = deferred<Uint8Array>();
    this.pending_call.set(name, id, defer);
    return defer;
  }

  async _subscribe(
    name: string,
    key: string,
    handler: EventHandler,
  ): Promise<void> {
    if (this.listeners.has(name, key)) {
      throw new Error(
        "cannot subscribe same event multiple times",
      );
    }
    const builder = new Proto.Builder(64);
    builder.finish(Proto.Client.Send.SendPacket.createSendPacket(
      builder,
      Proto.Client.Send.Send.SubscribeService,
      Proto.Client.Send.SubscribeService.createSubscribeService(
        builder,
        builder.createString(name),
        builder.createString(key),
      ),
    ));
    const sync = await this.send_sync(builder.asUint8Array());
    if (
      sync.syncType() !== Proto.Client.Receive.Sync.Sync.SimpleResult
    ) {
      throw new Error("service not exists");
    }
    this.listeners.set(name, key, handler);
  }

  async _unsubscribe(name: string, key: string): Promise<boolean> {
    if (!this.listeners.has(name, key)) return false;
    const builder = new Proto.Builder(64);
    builder.finish(Proto.Client.Send.SendPacket.createSendPacket(
      builder,
      Proto.Client.Send.Send.UnscribeService,
      Proto.Client.Send.UnscribeService.createUnscribeService(
        builder,
        builder.createString(name),
        builder.createString(key),
      ),
    ));
    const sync = await this.send_sync(builder.asUint8Array());
    return sync.syncType() == Proto.Client.Receive.Sync.Sync.SimpleResult &&
      (sync.sync(new Proto.Client.Receive.Sync.SimpleResult())?.ok() ?? false);
  }

  async _cancel_wait(name: string): Promise<boolean> {
    if (this.wait_list.has(name)) {
      const builder = new Proto.Builder(64);
      builder.finish(Proto.Client.Send.SendPacket.createSendPacket(
        builder,
        Proto.Client.Send.Send.CancelWaitService,
        Proto.Client.Send.CancelWaitService.createCancelWaitService(
          builder,
          builder.createString(name),
        ),
      ));
      const sync = await this.send_sync(builder.asUint8Array());
      this.wait_list.delete(name);
      return sync.syncType() == Proto.Client.Receive.Sync.Sync.SimpleResult &&
        (sync.sync(new Proto.Client.Receive.Sync.SimpleResult())?.ok() ??
          false);
    }
    return false;
  }

  async get(name: string): Promise<ServiceProxy> {
    const exist = this.wait_list.get(name);
    if (exist != null) return exist;
    const builder = new Proto.Builder(64);
    builder.finish(Proto.Client.Send.SendPacket.createSendPacket(
      builder,
      Proto.Client.Send.Send.WaitService,
      Proto.Client.Send.WaitService.createWaitService(
        builder,
        builder.createString(name),
      ),
    ));
    const sync = await this.send_sync(builder.asUint8Array());
    const result = sync.sync(new Proto.Client.Receive.Sync.ServiceStatus())!;
    const ret = new ServiceProxy(
      this,
      name,
      result.status()! == Proto.Client.Receive.OnlineStatus.Online,
    );
    this.wait_list.set(name, ret);
    return ret;
  }

  private async handlePacket(
    frame: Proto.Client.Receive.ReceivePacket,
    async_exception_handler: (e: any) => void,
  ) {
    switch (frame.receiveType()) {
      case Proto.Client.Receive.Receive.SyncResult:
        if (this.syncHandler != null) {
          this.syncHandler.resolve(
            frame.receive(new Proto.Client.Receive.Sync.SyncResult())!,
          );
          delete this.syncHandler;
          const next = this.syncQueue.shift();
          if (next) next.resolve();
        } else {
          async_exception_handler("illegal state");
        }
        break;
      case Proto.Client.Receive.Receive.AsyncResult: {
        const asy = frame.receive(
          new Proto.Client.Receive.Async.AsyncResult(),
        )!;
        switch (asy.asyncType()) {
          case Proto.Client.Receive.Async.Async.CallResponse: {
            const resp = asy.async(
              new Proto.Client.Receive.Async.Call.CallResponse(),
            )!;
            const name = resp.name()!;
            const id = resp.id();
            const pending = this.pending_call.get(name, id);
            if (pending) {
              this.pending_call.delete(name, id);
              switch (resp.payloadType()) {
                case Proto.Client.Receive.Async.Call.CallResponsePayload
                  .CallSuccess: {
                  const suc = resp.payload(
                    new Proto.Client.Receive.Async.Call.CallSuccess(),
                  )!;
                  pending.resolve(suc.payloadArray()!);
                  break;
                }
                case Proto.Client.Receive.Async.Call.CallResponsePayload
                  .CallException: {
                  const exp = resp.payload(
                    new Proto.Client.Receive.Async.Call.CallException(),
                  )!;
                  pending.reject(exp.info()!.message()!);
                  break;
                }
                default:
                  pending.reject();
              }
            }
            break;
          }
          case Proto.Client.Receive.Async.Async.Event: {
            const evt = asy.async(
              new Proto.Client.Receive.Async.Event.Event(),
            )!;
            const name = evt.name()!;
            const key = evt.key()!;
            const payload = evt.payload();
            if (payload) {
              await this.listeners.get(name, key)?.(payload.payloadArray()!);
            } else {
              this.listeners.delete(name, key);
            }
            break;
          }
          case Proto.Client.Receive.Async.Async.WaitResult: {
            const res = asy.async(new Proto.Client.Receive.Async.WaitResult())!;
            const name = res.name()!;
            const status =
              res.status() === Proto.Client.Receive.OnlineStatus.Online;
            const pxy = this.wait_list.get(name);
            if (pxy == null) break;
            pxy.status = status;
            if (status == false) {
              const calls = this.pending_call.get(name);
              if (calls != null) {
                for (const [, p] of calls) {
                  p.reject();
                }
                this.pending_call.delete(name);
              }
              this.listeners.delete(name);
            }
            break;
          }
        }
        break;
      }
      default:
        async_exception_handler("illegal op: " + frame.receiveType());
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
            Proto.Client.Receive.ReceivePacket.getRootAsReceivePacket(
              new Proto.ByteBuffer(pkt),
            )!,
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
      Proto.Client.HandshakeResponse.getRootAsHandshakeResponse(
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
