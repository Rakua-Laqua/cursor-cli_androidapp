import { createServer, type IncomingMessage, type Server as HttpServer } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';

import { RelayRouter, type RelayRouterOptions } from './router.js';
import { createFcmSenderFromEnv, type FcmSender, type SchedulePush } from './fcm.js';

export interface RelayServerOptions {
  readonly host?: string;
  readonly port?: number;
  readonly heartbeatIntervalMs?: number;
  readonly staleTimeoutMs?: number;
  readonly fcmSender?: FcmSender | undefined;
  readonly waitingDelayMs?: number | undefined;
  readonly schedulePush?: SchedulePush | undefined;
}

export class RelayServer {
  private readonly host: string;
  private readonly requestedPort: number;
  private readonly heartbeatIntervalMs: number;
  private readonly staleTimeoutMs: number;
  private readonly httpServer: HttpServer;
  private readonly wss: WebSocketServer;
  private readonly router: RelayRouter;
  private heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  private closing: Promise<void> | undefined;

  private constructor(options: RelayServerOptions) {
    this.host = options.host ?? '127.0.0.1';
    this.requestedPort = options.port ?? 8787;
    this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? 30_000;
    this.staleTimeoutMs =
      options.staleTimeoutMs ?? (this.heartbeatIntervalMs > 0 ? this.heartbeatIntervalMs * 2 : 0);
    this.router = new RelayRouter(relayRouterOptions(options));
    this.httpServer = createServer((_request, response) => {
      response.statusCode = 404;
      response.end();
    });
    this.wss = new WebSocketServer({ server: this.httpServer });
    this.wss.on('connection', (socket, request) => {
      this.onConnection(socket, request);
    });
  }

  static async listen(options: RelayServerOptions = {}): Promise<RelayServer> {
    const server = new RelayServer(options);
    await server.start();
    return server;
  }

  get port(): number {
    const address = this.httpServer.address();
    if (typeof address === 'object' && address !== null) {
      return address.port;
    }
    throw new Error('Relay server is not listening');
  }

  machineUrl(machineId: string): string {
    return this.endpointUrl('/machine', machineId);
  }

  clientUrl(machineId: string): string {
    return this.endpointUrl('/client', machineId);
  }

  async close(): Promise<void> {
    if (this.closing === undefined) {
      this.closing = this.doClose();
    }
    await this.closing;
  }

  private endpointUrl(pathname: string, machineId: string): string {
    return `ws://${this.host}:${this.port}${pathname}?machineId=${encodeURIComponent(machineId)}`;
  }

  private async start(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => {
        reject(error);
      };
      this.httpServer.once('error', onError);
      this.httpServer.listen(this.requestedPort, this.host, () => {
        this.httpServer.off('error', onError);
        resolve();
      });
    });
    if (this.heartbeatIntervalMs > 0) {
      this.heartbeatTimer = setInterval(() => {
        this.router.heartbeat(this.staleTimeoutMs);
      }, this.heartbeatIntervalMs);
    }
  }

  private onConnection(socket: WebSocket, request: IncomingMessage): void {
    const url = new URL(request.url ?? '/', `http://${this.host}`);
    const machineId = url.searchParams.get('machineId');
    if (machineId === null || machineId.length === 0) {
      socket.close(1008, 'machineId is required');
      return;
    }
    if (url.pathname === '/machine') {
      this.router.attachMachine(machineId, socket);
      return;
    }
    if (url.pathname === '/client') {
      this.router.attachClient(machineId, socket);
      return;
    }
    socket.close(1008, 'Unknown endpoint');
  }

  private async doClose(): Promise<void> {
    if (this.heartbeatTimer !== undefined) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
    }
    this.router.dispose('Relay server closed');
    await new Promise<void>((resolve, reject) => {
      this.wss.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        this.httpServer.close((httpError) => {
          if (httpError) {
            reject(httpError);
            return;
          }
          resolve();
        });
      });
    });
  }
}

function relayRouterOptions(options: RelayServerOptions): RelayRouterOptions {
  return {
    fcmSender: options.fcmSender ?? createFcmSenderFromEnv(),
    waitingDelayMs: options.waitingDelayMs,
    schedule: options.schedulePush,
  };
}
