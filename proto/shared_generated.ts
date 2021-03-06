// automatically generated by the FlatBuffers compiler, do not modify

import * as flatbuffers from "./flatbuffers.ts"
/**
 * @constructor
 */
export namespace WsGw.proto{
export class ExceptionInfo {
  bb: flatbuffers.ByteBuffer|null = null;

  bb_pos:number = 0;
/**
 * @param number i
 * @param flatbuffers.ByteBuffer bb
 * @returns ExceptionInfo
 */
__init(i:number, bb:flatbuffers.ByteBuffer):ExceptionInfo {
  this.bb_pos = i;
  this.bb = bb;
  return this;
};

/**
 * @param flatbuffers.ByteBuffer bb
 * @param ExceptionInfo= obj
 * @returns ExceptionInfo
 */
static getRootAsExceptionInfo(bb:flatbuffers.ByteBuffer, obj?:ExceptionInfo):ExceptionInfo {
  return (obj || new ExceptionInfo).__init(bb.readInt32(bb.position()) + bb.position(), bb);
};

/**
 * @param flatbuffers.Encoding= optionalEncoding
 * @returns string|Uint8Array|null
 */
message():string|null
message(optionalEncoding:flatbuffers.Encoding):string|Uint8Array|null
message(optionalEncoding?:any):string|Uint8Array|null {
  var offset = this.bb!.__offset(this.bb_pos, 4);
  return offset ? this.bb!.__string(this.bb_pos + offset, optionalEncoding) : null;
};

/**
 * @param flatbuffers.Builder builder
 */
static startExceptionInfo(builder:flatbuffers.Builder) {
  builder.startObject(1);
};

/**
 * @param flatbuffers.Builder builder
 * @param flatbuffers.Offset messageOffset
 */
static addMessage(builder:flatbuffers.Builder, messageOffset:flatbuffers.Offset) {
  builder.addFieldOffset(0, messageOffset, 0);
};

/**
 * @param flatbuffers.Builder builder
 * @returns flatbuffers.Offset
 */
static endExceptionInfo(builder:flatbuffers.Builder):flatbuffers.Offset {
  var offset = builder.endObject();
  builder.requiredField(offset, 4); // message
  return offset;
};

static createExceptionInfo(builder:flatbuffers.Builder, messageOffset:flatbuffers.Offset):flatbuffers.Offset {
  ExceptionInfo.startExceptionInfo(builder);
  ExceptionInfo.addMessage(builder, messageOffset);
  return ExceptionInfo.endExceptionInfo(builder);
}
}
}
