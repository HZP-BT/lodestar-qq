import { once } from 'node:events';
import { createServer } from 'node:http';
import type { IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';

import { WebSocketServer } from 'ws';
import type { RawData, WebSocket } from 'ws';

export interface TestConnection {
  socket: WebSocket;
  headers: IncomingHttpHeaders;
}

export interface TestServerOptions {
  path?: string;
  expectedToken?: string;
}

export interface TestServer {
  wss: WebSocketServer;
  url: string;
  connections: TestConnection[];
  messages: unknown[];
  close: () => Promise<void>;
  waitForConnection: (count?: number, timeoutMs?: number) => Promise<void>;
  waitForMessage: (
    predicate: (message: unknown) => boolean,
    timeoutMs?: number,
  ) => Promise<unknown>;
  send: (payload: unknown) => void;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function rawDataToString(data: RawData): string {
  if (typeof data === 'string') {
    return data;
  }

  if (Buffer.isBuffer(data)) {
    return data.toString('utf8');
  }

  if (Array.isArray(data)) {
    return Buffer.concat(data).toString('utf8');
  }

  return Buffer.from(data).toString('utf8');
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    if (predicate()) {
      return;
    }

    await sleep(10);
  }

  throw new Error('Timed out waiting for condition');
}

export async function createTestServer(options: TestServerOptions = {}): Promise<TestServer> {
  const path = options.path ?? '/ws';
  const wss = new WebSocketServer({ port: 0, path });
  await once(wss, 'listening');

  const address = wss.address() as AddressInfo;
  const connections: TestConnection[] = [];
  const messages: unknown[] = [];

  wss.on('connection', (socket, request) => {
    connections.push({ socket, headers: request.headers });

    if (options.expectedToken) {
      const match = /^(?:Bearer|Token) (.+)$/.exec(request.headers.authorization ?? '');

      if (match?.[1] !== options.expectedToken) {
        socket.close(4001, 'unauthorized');
        return;
      }
    }

    socket.on('message', (data) => {
      let payload: unknown;

      try {
        payload = JSON.parse(rawDataToString(data));
      } catch {
        return;
      }

      messages.push(payload);
    });
  });

  const server: TestServer = {
    wss,
    url: `ws://127.0.0.1:${address.port}${path}`,
    connections,
    messages,

    async close() {
      for (const connection of connections) {
        connection.socket.terminate();
      }

      await new Promise<void>((resolve) => {
        wss.close(() => {
          resolve();
        });
      });
    },

    async waitForConnection(count = 1, timeoutMs = 2_000) {
      await waitFor(() => connections.length >= count, timeoutMs);
    },

    async waitForMessage(predicate, timeoutMs = 2_000) {
      const start = Date.now();

      while (Date.now() - start < timeoutMs) {
        const found = messages.find((message) => predicate(message));

        if (found !== undefined) {
          return found;
        }

        await sleep(10);
      }

      throw new Error(`Timed out waiting for message; received ${messages.length}`);
    },

    send(payload) {
      const socket = connections.at(-1)?.socket;

      if (!socket) {
        throw new Error('No active test connection');
      }

      socket.send(JSON.stringify(payload));
    },
  };

  return server;
}

export interface RejectingServer {
  url: string;
  attempts: number;
  close: () => Promise<void>;
}

export async function createRejectingServer(statusCode: number): Promise<RejectingServer> {
  let attempts = 0;
  const server = createServer((_request, response) => {
    response.writeHead(404);
    response.end();
  });

  server.on('upgrade', (_request, socket) => {
    attempts += 1;
    socket.write(
      `HTTP/1.1 ${statusCode} Rejected\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
    );
    socket.destroy();
  });

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });

  const address = server.address() as AddressInfo;

  return {
    url: `ws://127.0.0.1:${address.port}/ws`,
    get attempts() {
      return attempts;
    },
    async close() {
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      });
    },
  };
}
