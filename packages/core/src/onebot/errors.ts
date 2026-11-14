export class LodestarError extends Error {
  readonly code: string;

  constructor(message: string, code: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
    this.code = code;
  }
}

export class NotConnectedError extends LodestarError {
  constructor(message = 'The OneBot reverse WebSocket is not open') {
    super(message, 'NOT_CONNECTED');
  }
}

export class ProtocolError extends LodestarError {
  constructor(message: string, code = 'PROTOCOL_ERROR') {
    super(message, code);
  }
}

export class InvalidStateError extends LodestarError {
  constructor(message: string) {
    super(message, 'INVALID_STATE');
  }
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  if (typeof error === 'string') {
    return error;
  }

  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}
