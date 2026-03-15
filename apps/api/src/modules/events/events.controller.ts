/*
 * Copyright (c) 2026 Homelab Control Plane contributors
 * SPDX-License-Identifier: MIT
 *
 * This module exposes events controller request handling for the API service.
 */
import { Controller, Get, MessageEvent, Query, Sse } from '@nestjs/common';
import { Observable, map } from 'rxjs';
import { EventsService } from './events.service';

@Controller('events')
/**
 * Implements the events controller class.
 */
export class EventsController {
  constructor(private readonly eventsService: EventsService) {}

  @Get()
  /**
   * Handles list.
   */
  list(@Query('limit') limit?: string) {
    return this.eventsService.list(limit ? Number(limit) : 100);
  }

  @Sse('stream')
  /**
   * Implements the stream workflow for this file.
   */
  stream(): Observable<MessageEvent> {
    return this.eventsService.stream.pipe(map((event) => ({ data: event })));
  }
}
