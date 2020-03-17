import { MsgPackEncoder } from "../deps.ts";

export type ParameterBuilder = (enc: MsgPackEncoder) => Uint8Array | void;
