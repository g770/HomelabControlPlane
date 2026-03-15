/*
 * Copyright (c) 2026 Homelab Control Plane contributors
 * SPDX-License-Identifier: MIT
 *
 * This module wires the app module providers and dependencies.
 */
import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { loadEnv } from './config/env';
import { PrismaModule } from './prisma/prisma.module';
import { AgentsModule } from './modules/agents/agents.module';
import { AgentInstallModule } from './modules/agent-install/agent-install.module';
import { AgentRecoveryModule } from './modules/agent-recovery/agent-recovery.module';
import { AiModule } from './modules/ai/ai.module';
import { AlertsModule } from './modules/alerts/alerts.module';
import { AuthModule } from './modules/auth/auth.module';
import { AuditModule } from './modules/audit/audit.module';
import { BootstrapService } from './modules/common/bootstrap.service';
import { CommonModule } from './modules/common/common.module';
import { JwtAuthGuard } from './modules/common/jwt-auth.guard';
import { ChecksModule } from './modules/checks/checks.module';
import { DashboardAgentModule } from './modules/dashboard-agent/dashboard-agent.module';
import { EventsModule } from './modules/events/events.module';
import { IntegrationsModule } from './modules/integrations/integrations.module';
import { InventoryModule } from './modules/inventory/inventory.module';
import { LinksModule } from './modules/links/links.module';
import { McpModule } from './modules/mcp/mcp.module';
import { HostTelemetryModule } from './modules/host-telemetry/host-telemetry.module';
import { NotificationsModule } from './modules/notifications/notifications.module';
import { ProxmoxModule } from './modules/proxmox/proxmox.module';
import { ServiceDiscoveryModule } from './modules/service-discovery/service-discovery.module';
import { TerminalModule } from './modules/terminal/terminal.module';
import { ToolProposalsModule } from './modules/tool-proposals/tool-proposals.module';
import { UsersModule } from './modules/users/users.module';

// Root API module wiring authentication guards and feature modules.
@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      load: [loadEnv],
    }),
    CommonModule,
    ThrottlerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => [
        {
          ttl: configService.get<number>('RATE_LIMIT_TTL', 60) * 1000,
          limit: configService.get<number>('RATE_LIMIT_LIMIT', 120),
        },
      ],
    }),
    ScheduleModule.forRoot(),
    PrismaModule,
    AuditModule,
    EventsModule,
    AuthModule,
    AgentsModule,
    AgentRecoveryModule,
    AgentInstallModule,
    InventoryModule,
    HostTelemetryModule,
    ChecksModule,
    DashboardAgentModule,
    AlertsModule,
    IntegrationsModule,
    ProxmoxModule,
    LinksModule,
    McpModule,
    ServiceDiscoveryModule,
    TerminalModule,
    ToolProposalsModule,
    NotificationsModule,
    UsersModule,
    AiModule,
  ],
  providers: [
    BootstrapService,
    {
      provide: APP_GUARD,
      useClass: ThrottlerGuard,
    },
    {
      provide: APP_GUARD,
      useClass: JwtAuthGuard,
    },
  ],
})
/**
 * Implements the app module class.
 */
export class AppModule {}
