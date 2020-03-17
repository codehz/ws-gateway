import { ws, MsgPackEncoder, log } from "./deps.ts";
import MultiMap from "./multi_map.ts";
import { ServiceSignature, ClientSignature, WaitResult } from "./constants.ts";

enum LinkType {
  method,
  subscribe,
  wait
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
  private readonly name: string;
  private readonly type: string;
  private readonly version: string;
  private readonly sock: ws.WebSocket;
  private readonly pending_call: Map<number, ClientProxy>;
  private readonly subscribers: MultiMap<string, ClientProxy>;

  private constructor(
    name: string,
    type: string,
    version: string,
    sock: ws.WebSocket
  ) {
    this.name = name;
    this.type = type;
    this.version = version;
    this.sock = sock;
    this.pending_call = new Map();
    this.subscribers = new MultiMap();
  }

  static register(
    name: string,
    type: string,
    version: string,
    sock: ws.WebSocket
  ) {
    if (service_map.has(name)) throw new Error("name exists");
    log.info(
      "register service %s (%s: %s) from %#v",
      name,
      type,
      version,
      sock.conn.remoteAddr
    );
    const ret = new ServiceProxy(name, type, version, sock);
    service_map.set(name, ret);
    wait_map.get(name)?.forEach(client =>
      client.wait_notify(name, WaitResult.Online)
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
            client.wait_notify(name, WaitResult.Offline).catch(() => {});
            break;
        }
      }
    }
    service_map.delete(name);
    log.info(
      "unregister service %s from %#v",
      name,
      this.sock.conn.remoteAddr
    );
  }

  async method_call(
    key: string,
    id: number,
    arg: Uint8Array,
    client: ClientProxy
  ) {
    const enc = new MsgPackEncoder();
    enc.putInt(ServiceSignature.Request);
    enc.putString(key);
    enc.putInt(id);
    this.pending_call.set(id, client);
    await this.sock.send(enc.dump(arg));
  }

  async method_cancel(key: string, id: number) {
    const enc = new MsgPackEncoder();
    enc.putInt(ServiceSignature.CancelRequest);
    enc.putString(key);
    enc.putInt(id);
    this.sock.send(enc.dump());
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

  unsubscribe_client(key: string, client: ClientProxy) {
    this.subscribers.delete(key, client);
  }

  async response(
    id: number,
    data: Uint8Array
  ) {
    return this.pending_call.get(id)?.method_response(this.name, id, data);
  }

  async broadcast(
    key: string,
    data: Uint8Array
  ) {
    const subs = this.subscribers.get(key);
    if (subs == undefined) return;
    for (const client of subs) {
      await client.subscribe_notify(this.name, key, data);
    }
  }

  dump(enc: MsgPackEncoder) {
    enc.putArray(2);
    enc.putString(this.type);
    enc.putString(this.version);
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
    client_trace.get(this)?.forEach(link => {
      const service = service_map.get(link.name);
      switch (link.type) {
        case LinkType.method:
          if (!service) return;
          service.method_cancel(link.key, link.id).catch(() => {});
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

  async send_service_list() {
    const enc = new MsgPackEncoder();
    enc.putInt(ClientSignature.Sync);
    enc.putMap(service_map.size);
    for (const [name, service] of service_map) {
      enc.putString(name);
      service.dump(enc);
    }
    await this.sock.send(enc.dump());
  }
  async add_wait_list(name: string) {
    const enc = new MsgPackEncoder();
    enc.putInt(ClientSignature.Sync);
    enc.putBool(service_map.has(name));
    if (wait_map.add(name, this)) {
      client_trace.add(this, { type: LinkType.wait, name });
    }
    await this.sock.send(enc.dump());
  }
  async request_method(
    name: string,
    key: string,
    arg: Uint8Array
  ) {
    const enc = new MsgPackEncoder();
    enc.putInt(ClientSignature.Sync);
    const service = service_map.get(name);
    if (!service) {
      enc.putBool(false);
      await this.sock.send(enc.dump());
      return;
    }
    enc.putBool(true);
    const id = service.generate_id();
    enc.putInt(id);
    await this.sock.send(enc.dump());
    await service.method_call(key, id, arg, this);
  }
  async add_subscribe(name: string, key: string) {
    const enc = new MsgPackEncoder();
    enc.putInt(ClientSignature.Sync);
    const service = service_map.get(name);
    if (!service) {
      enc.putBool(false);
      await this.sock.send(enc.dump());
      return;
    }
    enc.putBool(true);
    if (service.subscribe_client(key, this)) {
      client_trace.add(this, { type: LinkType.subscribe, name, key });
    }
    await this.sock.send(enc.dump());
  }

  async method_response(name: string, id: number, data: Uint8Array) {
    const enc = new MsgPackEncoder();
    enc.putInt(ClientSignature.Response);
    enc.putString(name);
    enc.putInt(id);
    await this.sock.send(enc.dump(data));
  }
  async subscribe_notify(name: string, key: string, data: Uint8Array) {
    const enc = new MsgPackEncoder();
    enc.putInt(ClientSignature.Broadcast);
    enc.putString(name);
    enc.putString(key);
    await this.sock.send(enc.dump(data));
  }
  async method_cancel(name: string, id: number) {
    const enc = new MsgPackEncoder();
    enc.putInt(ClientSignature.CancelRequest);
    enc.putString(name);
    enc.putInt(id);
    await this.sock.send(enc.dump());
  }
  async subscribe_cancel(name: string, key: string) {
    const enc = new MsgPackEncoder();
    enc.putInt(ClientSignature.CancelSubscribe);
    enc.putString(name);
    enc.putString(key);
    await this.sock.send(enc.dump());
  }
  async wait_notify(name: string, status: boolean) {
    const enc = new MsgPackEncoder();
    enc.putInt(ClientSignature.Wait);
    enc.putString(name);
    enc.putBool(status);
    await this.sock.send(enc.dump());
  }
}
