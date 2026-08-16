export type JsonRpcId = string | number;

export interface JsonRpcErrorObject {
  readonly code: number;
  readonly message: string;
  readonly data?: unknown;
}

export type ParsedJsonRpcMessage =
  | {
      readonly kind: 'request';
      readonly id: JsonRpcId;
      readonly method: string;
      readonly params: unknown;
    }
  | {
      readonly kind: 'notification';
      readonly method: string;
      readonly params: unknown;
    }
  | {
      readonly kind: 'success';
      readonly id: JsonRpcId;
      readonly result: unknown;
    }
  | {
      readonly kind: 'error';
      readonly id: JsonRpcId | null;
      readonly error: JsonRpcErrorObject;
    }
  | {
      readonly kind: 'invalid';
      readonly reason: string;
      readonly raw: string;
    };

export class NdjsonBuffer {
  private pending = '';

  push(chunk: string): string[] {
    this.pending += chunk;
    const lines: string[] = [];

    while (true) {
      const idx = this.pending.indexOf('\n');
      if (idx < 0) {
        break;
      }
      const line = this.pending.slice(0, idx).replace(/\r$/, '');
      this.pending = this.pending.slice(idx + 1);
      if (line.trim() !== '') {
        lines.push(line);
      }
    }

    return lines;
  }
}

export function encodeRequest(id: JsonRpcId, method: string, params: unknown | undefined): string {
  const message: Record<string, unknown> = {
    jsonrpc: '2.0',
    id,
    method,
  };
  if (params !== undefined) {
    message.params = params;
  }
  return `${JSON.stringify(message)}\n`;
}

export function encodeNotification(method: string, params: unknown | undefined): string {
  const message: Record<string, unknown> = {
    jsonrpc: '2.0',
    method,
  };
  if (params !== undefined) {
    message.params = params;
  }
  return `${JSON.stringify(message)}\n`;
}

export function encodeResult(id: JsonRpcId, result: unknown): string {
  return `${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`;
}

export function encodeError(id: JsonRpcId | null, error: JsonRpcErrorObject): string {
  return `${JSON.stringify({ jsonrpc: '2.0', id, error })}\n`;
}

export function parseJsonRpcLine(raw: string): ParsedJsonRpcMessage {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    return {
      kind: 'invalid',
      reason: error instanceof Error ? error.message : 'JSON parse failed',
      raw,
    };
  }

  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return { kind: 'invalid', reason: 'JSON-RPC message must be an object', raw };
  }

  const record = value as Record<string, unknown>;
  if (record.jsonrpc !== '2.0') {
    return { kind: 'invalid', reason: 'jsonrpc must be "2.0"', raw };
  }

  const hasId = Object.prototype.hasOwnProperty.call(record, 'id');
  const method =
    typeof record.method === 'string' && record.method.length > 0 ? record.method : undefined;
  const hasResult = Object.prototype.hasOwnProperty.call(record, 'result');
  const hasError = Object.prototype.hasOwnProperty.call(record, 'error');

  if (method !== undefined && hasId) {
    const id = parseId(record.id);
    if (id === undefined) {
      return { kind: 'invalid', reason: 'request id must be string or number', raw };
    }
    return {
      kind: 'request',
      id,
      method,
      params: record.params,
    };
  }

  if (method !== undefined && !hasId) {
    return {
      kind: 'notification',
      method,
      params: record.params,
    };
  }

  if (hasId && hasError) {
    const error = parseErrorObject(record.error);
    if (error === undefined) {
      return { kind: 'invalid', reason: 'error must include numeric code and message', raw };
    }
    return {
      kind: 'error',
      id: parseId(record.id) ?? null,
      error,
    };
  }

  if (hasId && hasResult) {
    const id = parseId(record.id);
    if (id === undefined) {
      return { kind: 'invalid', reason: 'response id must be string or number', raw };
    }
    return {
      kind: 'success',
      id,
      result: record.result,
    };
  }

  return { kind: 'invalid', reason: 'unrecognized JSON-RPC shape', raw };
}

function parseId(value: unknown): JsonRpcId | undefined {
  if (typeof value === 'string' || typeof value === 'number') {
    return value;
  }
  return undefined;
}

function parseErrorObject(value: unknown): JsonRpcErrorObject | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  if (typeof record.code !== 'number' || typeof record.message !== 'string') {
    return undefined;
  }
  if (Object.prototype.hasOwnProperty.call(record, 'data')) {
    return { code: record.code, message: record.message, data: record.data };
  }
  return { code: record.code, message: record.message };
}
