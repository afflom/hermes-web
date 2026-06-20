// Type surface for holo-wire.mjs (the pure HTTP/1.1 + WebSocket codec). The implementation is plain
// ESM JS so the BDD runner can exercise the exact shipped bytes; this declaration lets the TS
// transport consume it with full typing.

export interface HttpRequestInit {
  method?: string;
  path: string;
  headers?: Record<string, string>;
  body?: string | Uint8Array;
  host?: string;
}
export function encodeHttpRequest(init: HttpRequestInit): Uint8Array;

export interface HttpResponseParse {
  complete: boolean;
  status?: number;
  statusText?: string;
  headers?: Record<string, string>;
  body?: Uint8Array;
}
export function parseHttpResponse(buf: Uint8Array, opts?: { closed?: boolean }): HttpResponseParse;

export function wsHandshakeRequest(
  path: string,
  key: string,
  opts?: { host?: string; headers?: Record<string, string> },
): Uint8Array;
export function wsAcceptFor(key: string): string;
export function readWsHandshakeResponse(
  buf: Uint8Array,
  key: string,
): { ok: boolean; pending?: boolean; headers?: Record<string, string>; rest?: Uint8Array };

export interface WsFrame { opcode: number; payload: Uint8Array; }
export function encodeWsFrame(opcode: number, payload: string | Uint8Array, mask?: Uint8Array): Uint8Array;
export function decodeWsFrames(buf: Uint8Array): { frames: WsFrame[]; rest: Uint8Array };

export function maskKey(): Uint8Array;
export function base64(bytes: Uint8Array): string;
export function sha1Bytes(msg: Uint8Array): Uint8Array;
