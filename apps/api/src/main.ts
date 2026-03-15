/*
 * Copyright (c) 2026 Homelab Control Plane contributors
 * SPDX-License-Identifier: MIT
 *
 * This module bootstraps the Nest API application and wires the terminal websocket bridge.
 */
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import type { IncomingMessage, Server as HttpServer } from 'node:http';
import type { Socket } from 'node:net';
import { ValidationPipe } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import type { NextFunction, Request, Response } from 'express';
import type { WebSocket } from 'ws';
import { WebSocketServer } from 'ws';
import { AppModule } from './app.module';
import { apiRuntimeLogger, NestRuntimeLogger } from './modules/common/runtime-logger';
import { TerminalService } from './modules/terminal/terminal.service';

// API bootstrap with global validation and `/api` route prefix.
async function bootstrap() {
  const app = await NestFactory.create(AppModule, {
    cors: true,
    logger: new NestRuntimeLogger(),
  });

  app.setGlobalPrefix('api');
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      forbidUnknownValues: true,
      forbidNonWhitelisted: true,
    }),
  );

  app.use((request: Request, response: Response, next: NextFunction) => {
    const startedAt = Date.now();
    const requestId = randomUUID();
    response.setHeader('X-Request-Id', requestId);

    response.on('finish', () => {
      const userId = (request as Request & { user?: { sub?: string } }).user?.sub ?? null;
      apiRuntimeLogger.info('HTTP request completed', {
        requestId,
        method: request.method,
        path: request.originalUrl,
        statusCode: response.statusCode,
        durationMs: Date.now() - startedAt,
        actorUserId: userId,
      });
    });
    next();
  });

  const config = app.get(ConfigService);
  const jwtService = app.get(JwtService);
  const terminalService = app.get(TerminalService);
  const port = config.get<number>('PORT', 4000);

  await app.listen(port, '0.0.0.0');
  bindTerminalSocketServer(app.getHttpServer(), jwtService, terminalService);
  apiRuntimeLogger.info('API server started', {
    port,
  });
}

/**
 * Binds terminal socket server.
 */
function bindTerminalSocketServer(
  httpServer: HttpServer,
  jwtService: JwtService,
  terminalService: TerminalService,
) {
  const webSocketServer = new WebSocketServer({ noServer: true });

  httpServer.on('upgrade', (request: IncomingMessage, socket: Socket, head: Buffer) => {
    let upgrade: { sessionId: string; token: string } | null;
    try {
      upgrade = parseTerminalSocketRequest(request.url);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unauthorized';
      rejectWebSocketUpgrade(socket, 401, message);
      return;
    }
    if (!upgrade) {
      return;
    }

    void authorizeTerminalSocketUpgrade(jwtService, upgrade.token)
      .then((user) => {
        webSocketServer.handleUpgrade(request, socket, head, (ws: WebSocket) => {
          try {
            terminalService.attachWebSocket(user, upgrade.sessionId, ws);
          } catch {
            ws.close(1008, 'terminal session not found');
          }
        });
      })
      .catch((error) => {
        const message = error instanceof Error ? error.message : 'Unauthorized';
        rejectWebSocketUpgrade(socket, 401, message);
      });
  });
}

/**
 * Authorizes terminal socket upgrade.
 */
async function authorizeTerminalSocketUpgrade(jwtService: JwtService, token: string) {
  const payload = await jwtService.verifyAsync<{
    sub: string;
    email: string;
    displayName: string;
  }>(token);

  if (!payload?.sub) {
    throw new Error('Unauthorized');
  }

  return payload;
}

/**
 * Parses terminal socket request.
 */
function parseTerminalSocketRequest(rawUrl: string | undefined) {
  if (!rawUrl) {
    return null;
  }

  const parsed = new URL(rawUrl, 'http://localhost');
  const match = /^\/api\/terminal\/sessions\/([0-9a-f-]+)\/ws$/i.exec(parsed.pathname);
  if (!match) {
    return null;
  }

  const token = parsed.searchParams.get('token');
  if (!token) {
    throw new Error('Missing terminal websocket token');
  }

  return {
    sessionId: match[1] ?? '',
    token,
  };
}

/**
 * Rejects web socket upgrade.
 */
function rejectWebSocketUpgrade(socket: Socket, statusCode: number, message: string) {
  try {
    socket.write(
      `HTTP/1.1 ${statusCode} ${message}\r\nConnection: close\r\nContent-Type: text/plain\r\nContent-Length: ${Buffer.byteLength(message)}\r\n\r\n${message}`,
    );
  } finally {
    socket.destroy();
  }
}

bootstrap().catch((error) => {
  apiRuntimeLogger.error('Failed to start API', {
    error: error instanceof Error ? error.message : String(error),
  });
  process.exit(1);
});
