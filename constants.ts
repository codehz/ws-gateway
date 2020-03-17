export const HANDSHAKE_RESPONSE = "WS-GATEWAY OK";

export const SERVICE_MAGIC = "WS-GATEWAY";
export const GATEWAY_MAGIC = "WS-GATEWAY-CLIENT";

export const SERVICE_VERSION = 0;
export const GATEWAY_VERSION = 0;

export enum GatewayActionType {
  GetServiceList,
  WaitService,
  CallService,
  SubscribeService,

  CancelWaitService = -1,
  CancelCallService = -2,
  UnsubscribeService = -3
}
export enum ServiceActionType {
  Response,
  Broadcast,
  Exception = -1
}

export enum ServiceSignature {
  Request,
  CancelRequest
}
export enum ClientSignature {
  Sync,
  Response,
  Broadcast,
  Wait,
  CancelRequest,
  CancelSubscribe,
  Exception = -1
}

export const WaitResult = {
  Online: true,
  Offline: false
};
