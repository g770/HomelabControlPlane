/*
 * Copyright (c) 2026 Homelab Control Plane contributors
 * SPDX-License-Identifier: MIT
 *
 * This module exposes alerts controller request handling for the API service.
 */
import { Body, Controller, Delete, Get, Param, Post, Put } from '@nestjs/common';
import {
  alertIncidentAcknowledgeSchema,
  alertParseRequestSchema,
  alertPreviewRequestSchema,
  alertRuleCreateSchema,
  alertRuleDeleteSchema,
  alertRuleUpdateSchema,
  alertSilenceCreateSchema,
  type AlertIncidentAcknowledge,
  type AlertParseRequest,
  type AlertPreviewRequest,
  type AlertRuleCreate,
  type AlertRuleDelete,
  type AlertRuleUpdate,
  type AlertSilenceCreate,
} from '@homelab/shared';
import { CurrentUser } from '../common/current-user.decorator';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { AlertsService } from './alerts.service';

@Controller()
/**
 * Implements the alerts controller class.
 */
export class AlertsController {
  constructor(private readonly alertsService: AlertsService) {}

  @Get('alerts/active')
  /**
   * Handles active.
   */
  active() {
    return this.alertsService.active();
  }

  @Get('alerts/incidents')
  /**
   * Handles incidents.
   */
  incidents() {
    return this.alertsService.listIncidents();
  }

  @Post('alerts/incidents/:id/ack')
  acknowledgeIncident(
    @CurrentUser() user: { sub: string },
    @Param('id') id: string,
    @Body(new ZodValidationPipe(alertIncidentAcknowledgeSchema)) _body: AlertIncidentAcknowledge,
  ) {
    return this.alertsService.acknowledgeIncident(user.sub, id);
  }

  @Get('alerts/rules')
  /**
   * Handles rules.
   */
  rules() {
    return this.alertsService.rules();
  }

  @Get('alert-rules')
  /**
   * Handles legacy rules.
   */
  legacyRules() {
    return this.alertsService.legacyRules();
  }

  @Get('alerts/catalog')
  /**
   * Handles catalog.
   */
  catalog() {
    return this.alertsService.catalog();
  }

  @Post('alerts/preview')
  preview(@Body(new ZodValidationPipe(alertPreviewRequestSchema)) body: AlertPreviewRequest) {
    return this.alertsService.previewRule(body);
  }

  @Post('alerts/ai/parse')
  parseDescription(
    @CurrentUser() user: { sub: string },
    @Body(new ZodValidationPipe(alertParseRequestSchema)) body: AlertParseRequest,
  ) {
    return this.alertsService.parseRuleDescription(user.sub, body);
  }

  @Post('alerts/rules')
  createRule(
    @CurrentUser() user: { sub: string },
    @Body(new ZodValidationPipe(alertRuleCreateSchema)) body: AlertRuleCreate,
  ) {
    return this.alertsService.createRule(user.sub, body);
  }

  @Put('alerts/rules/:id')
  updateRule(
    @CurrentUser() user: { sub: string },
    @Param('id') id: string,
    @Body(new ZodValidationPipe(alertRuleUpdateSchema)) body: AlertRuleUpdate,
  ) {
    return this.alertsService.updateRule(user.sub, id, body);
  }

  @Delete('alerts/rules/:id')
  deleteRule(
    @CurrentUser() user: { sub: string },
    @Param('id') id: string,
    @Body(new ZodValidationPipe(alertRuleDeleteSchema)) _body: AlertRuleDelete,
  ) {
    return this.alertsService.removeRule(user.sub, id);
  }

  @Post('silences')
  createSilence(
    @CurrentUser() user: { sub: string },
    @Body(new ZodValidationPipe(alertSilenceCreateSchema)) body: AlertSilenceCreate,
  ) {
    return this.alertsService.createSilence(user.sub, body);
  }

  @Delete('silences/:id')
  deleteSilence(
    @CurrentUser() user: { sub: string },
    @Param('id') id: string,
    @Body(new ZodValidationPipe(alertRuleDeleteSchema)) _body: AlertRuleDelete,
  ) {
    return this.alertsService.deleteSilence(user.sub, id);
  }
}
