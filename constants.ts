export const SERVICE_MAGIC = "WS-GATEWAY";
export const GATEWAY_MAGIC = "WS-GATEWAY-CLIENT";

export const SERVICE_VERSION = 0;
export const GATEWAY_VERSION = 0;

export enum GatewayActionType {
  GetServiceList,
  WaitService,
  CallService,
  SubscribeService
}
export enum ServiceActionType {
  Response,
  Broadcast
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
  CancelSubscribe
}

export const WaitResult = {
  Online: true,
  Offline: false
};
