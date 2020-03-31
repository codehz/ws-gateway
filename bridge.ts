import { ws, log } from "./deps.ts";
import Proto from "./proto.ts";
import MultiMap from "./multi_map.ts";

enum LinkType {
  method,
  subscribe,
  wait,
}

type LinkData = {
  type: LinkType.method;
  name: string;
  key: string;
  id: number;
} | {
  type: LinkType.subscribe;
  name: string;
  key: string;
} | {
  type: LinkType.wait;
  name: string;
};

const service_map: Map<string, ServiceProxy> = new Map();

const wait_map: MultiMap<string, ClientProxy> = new MultiMap();

const clients: Set<ClientProxy> = new Set();
const client_trace: MultiMap<ClientProxy, LinkData> = new MultiMap();

export class ServiceProxy {
  private readonly pending_call: Map<number, ClientProxy> = new Map();
  private readonly subscribers: MultiMap<string, ClientProxy> = new MultiMap();

  private constructor(
    public readonly name: string,
    public readonly type: string,
    public readonly version: string,
    private readonly sock: ws.WebSocket,
  ) {}

  static register(
    name: string,
    type: string,
    version: string,
    sock: ws.WebSocket,
  ) {
    if (service_map.has(name)) throw new Error("name exists");
    log.info(
      "register service %s (%s: %s) from %#v",
      name,
      type,
      version,
      sock.conn.remoteAddr,
    );
    const ret = new ServiceProxy(name, type, version, sock);
    service_map.set(name, ret);
    wait_map.get(name)?.forEach((client) =>
      client.wait_notify(name, true).catch(() => {})
    );
    return ret;
  }

  unregister() {
    const name = this.name;
    if (!service_map.has(name)) return;
    for (const [client, trace] of client_trace) {
      if (trace.name === name) {
        switch (trace.type) {
          case LinkType.method:
            client.method_cancel(name, trace.id).catch(() => {});
            break;
          case LinkType.subscribe:
            client.subscribe_cancel(name, trace.key).catch(() => {});
            break;
          case LinkType.wait:
            client.wait_notify(name, false).catch(() => {});
            break;
        }
      }
    }
    service_map.delete(name);
    log.info(
      "unregister service %s from %#v",
      name,
      this.sock.conn.remoteAddr,
    );
  }

  method_call(
    key: string,
    id: number,
    arg: Uint8Array,
    client: ClientProxy,
  ) {
    const builder = new Proto.Builder(128);
    builder.finish(Proto.Service.Receive.ReceivePacket.createReceivePacket(
      builder,
      Proto.Service.Receive.Receive.Request,
      Proto.Service.Receive.Request.createRequest(
        builder,
        builder.createString(key),
        id,
        Proto.Service.Receive.Request.createPayloadVector(
          builder,
          arg,
        ),
      ),
    ));
    this.pending_call.set(id, client);
    return this.sock.send(builder.asUint8Array());
  }

  remove_from_pending_call(id: number, from: ClientProxy): boolean {
    if (this.pending_call.get(id) === from) {
      this.pending_call.delete(id);
      return true;
    }
    return false;
  }

  method_cancel(id: number) {
    const builder = new Proto.Builder(128);
    builder.finish(Proto.Service.Receive.ReceivePacket.createReceivePacket(
      builder,
      Proto.Service.Receive.Receive.CancelRequest,
      Proto.Service.Receive.CancelRequest.createCancelRequest(
        builder,
        id,
      ),
    ));
    this.pending_call.delete(id);
    return this.sock.send(builder.asUint8Array());
  }

  generate_id(): number {
    const buffer = new Uint32Array(1);
    while (true) {
      crypto.getRandomValues(buffer);
      const val = buffer[0];
      if (!this.pending_call.has(val)) return val;
    }
  }

  subscribe_client(key: string, client: ClientProxy): boolean {
    return this.subscribers.add(key, client);
  }

  unsubscribe_client(key: string, client: ClientProxy): boolean {
    return this.subscribers.delete(key, client);
  }

  response(
    id: number,
    data: Uint8Array,
  ) {
    const cli = this.pending_call.get(id);
    if (cli) {
      this.pending_call.delete(id);
      return cli.method_response(this.name, id, data);
    }
  }

  exception(
    id: number,
    msg: string,
  ) {
    const cli = this.pending_call.get(id);
    if (cli) {
      this.pending_call.delete(id);
      return cli.method_exception(this.name, id, msg);
    }
  }

  broadcast(
    key: string,
    data: Uint8Array,
  ) {
    const subs = this.subscribers.get(key);
    if (subs == undefined) return;
    for (const client of subs) {
      return client.subscribe_notify(this.name, key, data);
    }
  }
}

export class ClientProxy {
  private readonly sock: ws.WebSocket;
  private constructor(sock: ws.WebSocket) {
    this.sock = sock;
  }

  static register(sock: ws.WebSocket) {
    const ret = new ClientProxy(sock);
    clients.add(ret);
    log.debug("client connected %#v", sock.conn.remoteAddr);
    return ret;
  }

  unregister() {
    client_trace.get(this)?.forEach((link) => {
      const service = service_map.get(link.name);
      switch (link.type) {
        case LinkType.method:
          if (!service) return;
          service.method_cancel(link.id).catch(() => {});
          break;
        case LinkType.subscribe:
          if (!service) return;
          service.unsubscribe_client(link.key, this);
          break;
        case LinkType.wait:
          wait_map.delete(link.name, this);
          break;
      }
    });
    client_trace.delete(this);
    clients.delete(this);
    log.debug("client disconnected %#v", this.sock.conn.remoteAddr);
  }

  send_service_list() {
    const builder = new Proto.Builder(256);
    builder.finish(Proto.Client.Receive.ReceivePacket.createReceivePacket(
      builder,
      Proto.Client.Receive.Receive.SyncResult,
      Proto.Client.Receive.Sync.SyncResult.createSyncResult(
        builder,
        Proto.Client.Receive.Sync.Sync.ServiceList,
        Proto.Client.Receive.Sync.ServiceList.createServiceList(
          builder,
          Proto.Client.Receive.Sync.ServiceList.createListVector(
            builder,
            [...service_map.entries()].map(([name, service]) =>
              Proto.Client.Receive.Sync.ServiceDesc.createServiceDesc(
                builder,
                builder.createString(name),
                builder.createString(service.type),
                builder.createString(service.version),
              )
            ),
          ),
        ),
      ),
    ));
    return this.sock.send(builder.asUint8Array());
  }
  add_wait_list(name: string) {
    const builder = new Proto.Builder(64);
    builder.finish(Proto.Client.Receive.ReceivePacket.createReceivePacket(
      builder,
      Proto.Client.Receive.Receive.SyncResult,
      Proto.Client.Receive.Sync.SyncResult.createSyncResult(
        builder,
        Proto.Client.Receive.Sync.Sync.ServiceStatus,
        Proto.Client.Receive.Sync.ServiceStatus.createServiceStatus(
          builder,
          service_map.has(name)
            ? Proto.Client.Receive.OnlineStatus.Online
            : Proto.Client.Receive.OnlineStatus.Offline,
        ),
      ),
    ));
    wait_map.add(name, this);
    client_trace.add(this, { type: LinkType.wait, name: name });
    return this.sock.send(builder.asUint8Array());
  }
  remove_from_wait_list(name: string) {
    const builder = new Proto.Builder(64);
    const result = wait_map.has(name, this);
    builder.finish(Proto.Client.Receive.ReceivePacket.createReceivePacket(
      builder,
      Proto.Client.Receive.Receive.SyncResult,
      Proto.Client.Receive.Sync.SyncResult.createSyncResult(
        builder,
        Proto.Client.Receive.Sync.Sync.SimpleResult,
        Proto.Client.Receive.Sync.SimpleResult.createSimpleResult(
          builder,
          result,
        ),
      ),
    ));
    if (result) {
      wait_map.delete(name, this);
      client_trace.deleteEquals(
        this,
        (item) => item.type === LinkType.wait && item.name === name,
      );
    }
    return this.sock.send(builder.asUint8Array());
  }
  request_method(
    name: string,
    key: string,
    arg: Uint8Array,
  ) {
    const builder = new Proto.Builder(64);
    const service = service_map.get(name);
    if (service == null) {
      builder.finish(Proto.Client.Receive.ReceivePacket.createReceivePacket(
        builder,
        Proto.Client.Receive.Receive.SyncResult,
        Proto.Client.Receive.Sync.SyncResult.createSyncResult(
          builder,
          Proto.Client.Receive.Sync.Sync.NONE,
          0,
        ),
      ));
      return this.sock.send(builder.asUint8Array());
    }
    const id = service.generate_id();
    builder.finish(Proto.Client.Receive.ReceivePacket.createReceivePacket(
      builder,
      Proto.Client.Receive.Receive.SyncResult,
      Proto.Client.Receive.Sync.SyncResult.createSyncResult(
        builder,
        Proto.Client.Receive.Sync.Sync.RequestResult,
        Proto.Client.Receive.Sync.RequestResult.createRequestResult(
          builder,
          id,
        ),
      ),
    ));
    client_trace.add(this, { type: LinkType.method, name, key, id });
    return Promise.allSettled(
      [
        this.sock.send(builder.asUint8Array()),
        service.method_call(key, id, arg, this),
      ],
    );
  }
  cancel_request(
    name: string,
    id: number,
  ) {
    const builder = new Proto.Builder(64);
    const service = service_map.get(name);
    if (service == null) {
      builder.finish(Proto.Client.Receive.ReceivePacket.createReceivePacket(
        builder,
        Proto.Client.Receive.Receive.SyncResult,
        Proto.Client.Receive.Sync.SyncResult.createSyncResult(
          builder,
          Proto.Client.Receive.Sync.Sync.NONE,
          0,
        ),
      ));
      return this.sock.send(builder.asUint8Array());
    }
    const result = service.remove_from_pending_call(id, this);
    builder.finish(Proto.Client.Receive.ReceivePacket.createReceivePacket(
      builder,
      Proto.Client.Receive.Receive.SyncResult,
      Proto.Client.Receive.Sync.SyncResult.createSyncResult(
        builder,
        Proto.Client.Receive.Sync.Sync.SimpleResult,
        Proto.Client.Receive.Sync.SimpleResult.createSimpleResult(
          builder,
          result,
        ),
      ),
    ));
    client_trace.deleteEquals(
      this,
      (item) =>
        item.type === LinkType.method && item.name === name && item.id === id,
    );
    return Promise.allSettled(
      [this.sock.send(builder.asUint8Array()), service.method_cancel(id)],
    );
  }
  add_subscribe(name: string, key: string) {
    const builder = new Proto.Builder(64);
    const service = service_map.get(name);
    if (service == null) {
      builder.finish(Proto.Client.Receive.ReceivePacket.createReceivePacket(
        builder,
        Proto.Client.Receive.Receive.SyncResult,
        Proto.Client.Receive.Sync.SyncResult.createSyncResult(
          builder,
          Proto.Client.Receive.Sync.Sync.NONE,
          0,
        ),
      ));
      return this.sock.send(builder.asUint8Array());
    }
    const result = service.subscribe_client(key, this);
    if (result) {
      client_trace.add(this, { type: LinkType.subscribe, name, key });
    }
    builder.finish(Proto.Client.Receive.ReceivePacket.createReceivePacket(
      builder,
      Proto.Client.Receive.Receive.SyncResult,
      Proto.Client.Receive.Sync.SyncResult.createSyncResult(
        builder,
        Proto.Client.Receive.Sync.Sync.SimpleResult,
        Proto.Client.Receive.Sync.SimpleResult.createSimpleResult(
          builder,
          result,
        ),
      ),
    ));
    return this.sock.send(builder.asUint8Array());
  }
  async unsubscribe(name: string, key: string) {
    const builder = new Proto.Builder(64);
    const service = service_map.get(name);
    if (service == null) {
      builder.finish(Proto.Client.Receive.ReceivePacket.createReceivePacket(
        builder,
        Proto.Client.Receive.Receive.SyncResult,
        Proto.Client.Receive.Sync.SyncResult.createSyncResult(
          builder,
          Proto.Client.Receive.Sync.Sync.NONE,
          0,
        ),
      ));
      return this.sock.send(builder.asUint8Array());
    }
    builder.finish(Proto.Client.Receive.ReceivePacket.createReceivePacket(
      builder,
      Proto.Client.Receive.Receive.SyncResult,
      Proto.Client.Receive.Sync.SyncResult.createSyncResult(
        builder,
        Proto.Client.Receive.Sync.Sync.SimpleResult,
        Proto.Client.Receive.Sync.SimpleResult.createSimpleResult(
          builder,
          service.unsubscribe_client(key, this) && client_trace.deleteEquals(
            this,
            (el) =>
              el.type === LinkType.subscribe && el.name === name &&
                el.key === key,
          ),
        ),
      ),
    ));
    return this.sock.send(builder.asUint8Array());
  }

  method_response(name: string, id: number, data: Uint8Array) {
    const builder = new Proto.Builder(64 + data.length);
    builder.finish(Proto.Client.Receive.ReceivePacket.createReceivePacket(
      builder,
      Proto.Client.Receive.Receive.AsyncResult,
      Proto.Client.Receive.Async.AsyncResult.createAsyncResult(
        builder,
        Proto.Client.Receive.Async.Async.CallResponse,
        Proto.Client.Receive.Async.Call.CallResponse.createCallResponse(
          builder,
          builder.createString(name),
          id,
          Proto.Client.Receive.Async.Call.CallResponsePayload.CallSuccess,
          Proto.Client.Receive.Async.Call.CallSuccess.createCallSuccess(
            builder,
            Proto.Client.Receive.Async.Call.CallSuccess.createPayloadVector(
              builder,
              data,
            ),
          ),
        ),
      ),
    ));
    return this.sock.send(builder.asUint8Array());
  }
  async method_exception(name: string, id: number, msg: string) {
    const builder = new Proto.Builder(128);
    builder.finish(Proto.Client.Receive.ReceivePacket.createReceivePacket(
      builder,
      Proto.Client.Receive.Receive.AsyncResult,
      Proto.Client.Receive.Async.AsyncResult.createAsyncResult(
        builder,
        Proto.Client.Receive.Async.Async.CallResponse,
        Proto.Client.Receive.Async.Call.CallResponse.createCallResponse(
          builder,
          builder.createString(name),
          id,
          Proto.Client.Receive.Async.Call.CallResponsePayload.CallException,
          Proto.Client.Receive.Async.Call.CallException.createCallException(
            builder,
            Proto.ExceptionInfo.createExceptionInfo(
              builder,
              builder.createString(msg),
            ),
          ),
        ),
      ),
    ));
    return this.sock.send(builder.asUint8Array());
  }
  subscribe_notify(name: string, key: string, data: Uint8Array) {
    const builder = new Proto.Builder(64 + data.length);
    builder.finish(Proto.Client.Receive.ReceivePacket.createReceivePacket(
      builder,
      Proto.Client.Receive.Receive.AsyncResult,
      Proto.Client.Receive.Async.AsyncResult.createAsyncResult(
        builder,
        Proto.Client.Receive.Async.Async.Event,
        Proto.Client.Receive.Async.Event.Event.createEvent(
          builder,
          builder.createString(name),
          builder.createString(key),
          Proto.Client.Receive.Async.Event.EventPayload.createEventPayload(
            builder,
            Proto.Client.Receive.Async.Event.EventPayload.createPayloadVector(
              builder,
              data,
            ),
          ),
        ),
      ),
    ));
    return this.sock.send(builder.asUint8Array());
  }
  method_cancel(name: string, id: number) {
    const builder = new Proto.Builder(64);
    builder.finish(Proto.Client.Receive.ReceivePacket.createReceivePacket(
      builder,
      Proto.Client.Receive.Receive.AsyncResult,
      Proto.Client.Receive.Async.AsyncResult.createAsyncResult(
        builder,
        Proto.Client.Receive.Async.Async.CallResponse,
        Proto.Client.Receive.Async.Call.CallResponse.createCallResponse(
          builder,
          builder.createString(name),
          id,
          Proto.Client.Receive.Async.Call.CallResponsePayload.NONE,
          0,
        ),
      ),
    ));
    return this.sock.send(builder.asUint8Array());
  }
  subscribe_cancel(name: string, key: string) {
    const builder = new Proto.Builder(64);
    builder.finish(Proto.Client.Receive.ReceivePacket.createReceivePacket(
      builder,
      Proto.Client.Receive.Receive.AsyncResult,
      Proto.Client.Receive.Async.AsyncResult.createAsyncResult(
        builder,
        Proto.Client.Receive.Async.Async.Event,
        Proto.Client.Receive.Async.Event.Event.createEvent(
          builder,
          builder.createString(name),
          builder.createString(key),
          0,
        ),
      ),
    ));
    return this.sock.send(builder.asUint8Array());
  }
  wait_notify(name: string, status: boolean) {
    const builder = new Proto.Builder(64);
    builder.finish(Proto.Client.Receive.ReceivePacket.createReceivePacket(
      builder,
      Proto.Client.Receive.Receive.AsyncResult,
      Proto.Client.Receive.Async.AsyncResult.createAsyncResult(
        builder,
        Proto.Client.Receive.Async.Async.WaitResult,
        Proto.Client.Receive.Async.WaitResult.createWaitResult(
          builder,
          builder.createString(name),
          status
            ? Proto.Client.Receive.OnlineStatus.Online
            : Proto.Client.Receive.OnlineStatus.Offline,
        ),
      ),
    ));
    return this.sock.send(builder.asUint8Array());
  }
}
