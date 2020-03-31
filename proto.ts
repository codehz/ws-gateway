import * as Shared from "./proto/shared_generated.ts";
import * as ServiceT from "./proto/service_generated.ts";
import * as ClientT from "./proto/client_generated.ts";
import * as Flatbuffers from "./proto/flatbuffers.ts";

namespace Proto {
  export import ByteBuffer = Flatbuffers.ByteBuffer;
  export import Builder = Flatbuffers.Builder;
  export import Encoding = Flatbuffers.Encoding;
  export import Long = Flatbuffers.Long;
  export import ExceptionInfo = Shared.WsGw.proto.ExceptionInfo;
  export import Service = ServiceT.WsGw.proto.Service;
  export import Client = ClientT.WsGw.proto.Client;
}

export default Proto;
