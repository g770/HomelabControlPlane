/*
 * Copyright (c) 2026 Homelab Control Plane contributors
 * SPDX-License-Identifier: MIT
 *
 * This test file verifies the service discovery service test behavior.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { ServiceDiscoveryService } from '../src/modules/service-discovery/service-discovery.service';

describe('ServiceDiscoveryService', () => {
  const prisma = {
    serviceDiscoveryConfig: {
      findUnique: vi.fn(),
      upsert: vi.fn(),
    },
    serviceDiscoveryRun: {
      create: vi.fn(),
      update: vi.fn(),
      findMany: vi.fn(),
      findFirst: vi.fn(),
      findUnique: vi.fn(),
      delete: vi.fn(),
    },
    agent: {
      findMany: vi.fn(),
    },
    serviceDiscoveryCatalog: {
      findUnique: vi.fn(),
      upsert: vi.fn(),
    },
    service: {
      upsert: vi.fn(),
      findMany: vi.fn(),
      update: vi.fn(),
    },
    serviceInstance: {
      findUnique: vi.fn(),
      findMany: vi.fn(),
      upsert: vi.fn(),
      update: vi.fn(),
      deleteMany: vi.fn(),
    },
    host: {
      create: vi.fn(),
      findMany: vi.fn(),
      findUnique: vi.fn(),
      upsert: vi.fn(),
      update: vi.fn(),
    },
    hostFact: {
      create: vi.fn(),
    },
    $transaction: vi.fn(),
  };

  const configMap: Record<string, unknown> = {
    DISCOVERY_ENABLED: true,
    DISCOVERY_AI_ENABLED: false,
    DISCOVERY_INTERVAL_SEC: 600,
    DISCOVERY_AI_CATALOG_TTL_SEC: 86400,
    DISCOVERY_MAX_HOSTS_PER_RUN: 120,
    DISCOVERY_MAX_PROBES_PER_HOST: 12,
    DISCOVERY_AUTO_UPSERT: true,
    DISCOVERY_CONFIDENCE_THRESHOLD: 0.75,
    DISCOVERY_SUBNET_ENABLED: false,
    DISCOVERY_SUBNET_DEFAULT_CIDRS: '10.0.0.0/24,172.16.0.0/24,192.168.1.0/24',
    DISCOVERY_SUBNET_MAX_HOSTS: 512,
    DISCOVERY_SUBNET_CONCURRENCY: 24,
    DISCOVERY_SUBNET_CONNECT_TIMEOUT_MS: 750,
    DISCOVERY_SUBNET_MCP_TOOL_TIMEOUT_MS: 120000,
  };

  const configService = {
    get: vi.fn((key: string, fallback?: unknown) => {
      if (Object.hasOwn(configMap, key)) {
        const value = configMap[key];
        return value === undefined ? fallback : value;
      }
      return fallback;
    }),
  };

  const mcpService = {
    callTool: vi.fn(),
  };

  const auditService = {
    write: vi.fn(),
  };

  const eventsService = {
    emit: vi.fn(),
  };
  const aiProviderService = {
    getClient: vi.fn(),
    getModel: vi.fn(() => 'gpt-5-mini'),
  };

  let service: ServiceDiscoveryService;

  beforeEach(() => {
    vi.clearAllMocks();
    configMap.DISCOVERY_SUBNET_ENABLED = false;

    prisma.$transaction.mockImplementation(async (callback: (tx: any) => Promise<unknown>) =>
      callback({
        service: prisma.service,
        serviceInstance: prisma.serviceInstance,
        host: prisma.host,
        hostFact: prisma.hostFact,
        check: { updateMany: vi.fn() },
        alertEvent: { updateMany: vi.fn() },
        event: { updateMany: vi.fn() },
        agent: { update: vi.fn() },
        agentInstallRequest: { updateMany: vi.fn() },
      }),
    );

    prisma.serviceDiscoveryRun.create.mockResolvedValue({
      id: 'f1d8f6ec-6e8a-4aa0-8612-9702ce9aa981',
      startedAt: new Date('2026-02-21T12:00:00.000Z'),
    });

    prisma.serviceDiscoveryRun.update.mockResolvedValue({
      id: 'f1d8f6ec-6e8a-4aa0-8612-9702ce9aa981',
      startedAt: new Date('2026-02-21T12:00:00.000Z'),
      finishedAt: new Date('2026-02-21T12:00:03.000Z'),
      trigger: 'MANUAL',
      status: 'COMPLETED',
      hostCount: 1,
      probeCount: 1,
      detectedCount: 1,
      upsertCount: 1,
      errorCount: 0,
    });

    prisma.serviceDiscoveryRun.findFirst.mockResolvedValue(null);
    prisma.serviceDiscoveryRun.findUnique.mockResolvedValue(null);
    prisma.serviceDiscoveryRun.delete.mockResolvedValue({
      id: 'f1d8f6ec-6e8a-4aa0-8612-9702ce9aa981',
    });
    prisma.serviceDiscoveryConfig.findUnique.mockResolvedValue(null);

    prisma.agent.findMany.mockResolvedValue([
      {
        id: 'agent-1',
        hostId: 'f17f64f2-2c8b-4684-a62f-f02f1a4b12a5',
        host: {
          id: 'f17f64f2-2c8b-4684-a62f-f02f1a4b12a5',
          hostname: 'labbox',
          tags: [],
        },
      },
    ]);

    prisma.service.upsert.mockResolvedValue({
      id: 'service-1',
    });
    prisma.service.findMany.mockResolvedValue([]);
    prisma.service.update.mockResolvedValue({ id: 'service-1' });

    prisma.serviceInstance.findUnique.mockResolvedValue(null);
    prisma.serviceInstance.findMany.mockResolvedValue([]);
    prisma.serviceInstance.upsert.mockResolvedValue({ id: 'instance-1' });
    prisma.serviceInstance.update.mockResolvedValue({ id: 'instance-1' });
    prisma.serviceInstance.deleteMany.mockResolvedValue({ count: 0 });

    prisma.host.findMany.mockResolvedValue([]);
    prisma.host.create.mockResolvedValue({ id: 'host-1', hostname: 'host-1', tags: [] });
    prisma.host.update.mockResolvedValue({ id: 'host-1' });
    prisma.host.findUnique.mockResolvedValue(null);
    prisma.host.upsert.mockResolvedValue({ id: 'host-1', hostname: 'host-1' });
    prisma.hostFact.create.mockResolvedValue({ id: 'fact-1' });

    prisma.serviceDiscoveryConfig.upsert.mockResolvedValue({
      id: 'global',
    });

    mcpService.callTool.mockImplementation(async (params: { toolName: string }) => {
      switch (params.toolName) {
        case 'host.status':
          return {
            result: {
              services: [{ name: 'jenkins.service' }],
            },
          };
        case 'services.list':
          return {
            result: {
              services: [{ name: 'jenkins.service' }],
            },
          };
        case 'containers.list':
          return {
            result: {
              containers: [],
            },
          };
        case 'process.snapshot':
          return {
            result: {
              processes: [
                {
                  name: 'java',
                  command: 'java -jar jenkins.war',
                },
              ],
            },
          };
        case 'service.probe':
          return {
            result: {
              ok: true,
              reachable: true,
              url: 'http://127.0.0.1:8080/login',
            },
          };
        default:
          return { result: {} };
      }
    });

    service = new ServiceDiscoveryService(
      prisma as any,
      configService as any,
      mcpService as any,
      auditService as any,
      eventsService as any,
      aiProviderService as any,
    );
  });

  it('runs manual discovery, probes candidate service, and upserts detection', async () => {
    const result = await service.triggerManualRun('97208421-dcd3-47ef-a4d4-e786d82f9328', {});

    expect(result.status).toBe('COMPLETED');
    expect(result.summary.detectedCount).toBeGreaterThanOrEqual(1);
    expect(result.summary.appliedConfig?.subnetScan.enabled).toBe(false);
    expect(prisma.service.upsert).toHaveBeenCalled();
    expect(prisma.serviceInstance.upsert).toHaveBeenCalled();
    expect(mcpService.callTool).toHaveBeenCalledWith(
      expect.objectContaining({ toolName: 'service.probe' }),
    );
    expect(auditService.write).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'service.discovery.trigger',
        actorUserId: '97208421-dcd3-47ef-a4d4-e786d82f9328',
      }),
    );
    expect(eventsService.emit).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'service.discovery.run',
      }),
    );
  });

  it('polls async subnet scan tools and reads final result', async () => {
    prisma.serviceDiscoveryConfig.findUnique.mockResolvedValueOnce({
      subnetEnabled: true,
      subnetCidrs: ['192.168.3.0/30'],
      includeAutoLocalCidrs: false,
      includeCommonWebPorts: false,
      subnetMaxHosts: 32,
      subnetConcurrency: 4,
      subnetConnectTimeoutMs: 750,
      subnetToolCallTimeoutMs: 120000,
      updatedAt: new Date('2026-02-20T10:00:00.000Z'),
    });

    let statusPollCount = 0;
    mcpService.callTool.mockImplementation(async (params: { toolName: string }) => {
      switch (params.toolName) {
        case 'host.status':
        case 'services.list':
        case 'containers.list':
        case 'process.snapshot':
          return { result: {} };
        case 'network.scan_known_services.start':
          return {
            result: {
              jobId: 'scan-job-1',
              state: 'RUNNING',
            },
          };
        case 'network.scan_known_services.status':
          statusPollCount += 1;
          return {
            result:
              statusPollCount === 1
                ? {
                    jobId: 'scan-job-1',
                    state: 'RUNNING',
                    progress: {
                      hostsScanned: 1,
                      hostsReachable: 1,
                      detections: 0,
                    },
                  }
                : {
                    jobId: 'scan-job-1',
                    state: 'COMPLETED',
                    hostsScanned: 1,
                    hostsReachable: 1,
                    detections: 1,
                    warnings: [],
                  },
          };
        case 'network.scan_known_services.result':
          return {
            result: {
              result: {
                cidrs: ['192.168.3.0/30'],
                hostsScanned: 1,
                hostsReachable: 1,
                probedIps: ['192.168.3.1'],
                reachableIps: ['192.168.3.1'],
                detections: [
                  {
                    ip: '192.168.3.1',
                    hostname: null,
                    serviceId: 'ssh',
                    serviceName: 'SSH',
                    endpoint: 'tcp://192.168.3.1:22',
                    confidence: 0.82,
                    source: 'signature',
                    tags: ['remote'],
                    evidence: {
                      protocol: 'tcp',
                      port: 22,
                    },
                  },
                ],
                warnings: [],
              },
            },
          };
        default:
          return { result: {} };
      }
    });

    const result = await service.triggerManualRun('97208421-dcd3-47ef-a4d4-e786d82f9328', {});

    expect(result.status).toBe('COMPLETED');
    expect(result.summary.appliedConfig?.subnetScan.enabled).toBe(true);
    const subnetCalls = (mcpService.callTool as any).mock.calls
      .map((call: any[]) => call[0]?.toolName)
      .filter((toolName: string) => toolName?.startsWith('network.scan_known_services'));
    expect(subnetCalls).toEqual([
      'network.scan_known_services.start',
      'network.scan_known_services.status',
      'network.scan_known_services.status',
      'network.scan_known_services.result',
    ]);
  });

  it('continues subnet scanning when one agent tool call fails', async () => {
    prisma.serviceDiscoveryConfig.findUnique.mockResolvedValueOnce({
      subnetEnabled: true,
      subnetCidrs: ['10.0.0.0/24'],
      includeAutoLocalCidrs: false,
      includeCommonWebPorts: true,
      subnetMaxHosts: 128,
      subnetConcurrency: 24,
      subnetConnectTimeoutMs: 750,
      subnetToolCallTimeoutMs: 120000,
      updatedAt: new Date('2026-02-20T10:00:00.000Z'),
    });

    mcpService.callTool.mockImplementation(async (params: { toolName: string }) => {
      if (params.toolName === 'network.scan_known_services.start') {
        throw new Error('Tool network.scan_known_services.start is unavailable');
      }
      return { result: {} };
    });

    const result = await service.triggerManualRun('97208421-dcd3-47ef-a4d4-e786d82f9328', {});

    expect(result.status).toBe('COMPLETED');
    expect(result.summary.appliedConfig?.subnetScan.enabled).toBe(true);
    const updateCalls = (prisma.serviceDiscoveryRun.update as any).mock.calls;
    const completedUpdate = updateCalls.find(
      (call: any[]) => call[0]?.data?.status === 'COMPLETED',
    );
    const persistedSummary = completedUpdate?.[0]?.data?.summary;
    const runSummary = persistedSummary?.summary ?? persistedSummary;
    expect(runSummary?.subnet?.warnings).toEqual(
      expect.arrayContaining([
        'Subnet scan failed: Tool network.scan_known_services.start is unavailable',
      ]),
    );
  });

  it('passes persisted subnet tool timeout to agent scan tool call', async () => {
    prisma.serviceDiscoveryConfig.findUnique.mockResolvedValueOnce({
      subnetEnabled: true,
      subnetCidrs: ['192.168.3.0/30'],
      includeAutoLocalCidrs: false,
      includeCommonWebPorts: true,
      subnetMaxHosts: 128,
      subnetConcurrency: 24,
      subnetConnectTimeoutMs: 750,
      subnetToolCallTimeoutMs: 180000,
      updatedAt: new Date('2026-02-20T10:00:00.000Z'),
    });

    mcpService.callTool.mockImplementation(async (params: { toolName: string }) => {
      switch (params.toolName) {
        case 'network.scan_known_services.start':
          return {
            result: {
              jobId: 'scan-job-timeout',
              state: 'RUNNING',
            },
          };
        case 'network.scan_known_services.status':
          return {
            result: {
              jobId: 'scan-job-timeout',
              state: 'COMPLETED',
              hostsScanned: 0,
              hostsReachable: 0,
              detections: 0,
              warnings: [],
            },
          };
        case 'network.scan_known_services.result':
          return {
            result: {
              result: {
                cidrs: ['192.168.3.0/30'],
                hostsScanned: 0,
                hostsReachable: 0,
                probedIps: [],
                reachableIps: [],
                detections: [],
                warnings: [],
              },
            },
          };
        default:
          return { result: {} };
      }
    });

    await service.triggerManualRun('97208421-dcd3-47ef-a4d4-e786d82f9328', {});

    const subnetScanCalls = (mcpService.callTool as any).mock.calls.filter(
      (call: any[]) => call[0]?.toolName === 'network.scan_known_services.start',
    );
    expect(subnetScanCalls[0]?.[0]?.toolParams?.toolCallTimeoutMs).toBe(180000);
  });

  it('returns config with schedule metadata', async () => {
    prisma.serviceDiscoveryConfig.findUnique.mockResolvedValueOnce({
      subnetEnabled: true,
      subnetCidrs: ['192.168.1.0/24'],
      includeAutoLocalCidrs: false,
      includeCommonWebPorts: true,
      subnetMaxHosts: 256,
      subnetConcurrency: 32,
      subnetConnectTimeoutMs: 900,
      subnetToolCallTimeoutMs: 150000,
      updatedAt: new Date('2026-02-21T08:00:00.000Z'),
    });
    prisma.serviceDiscoveryRun.findFirst.mockResolvedValueOnce({
      startedAt: new Date('2026-02-21T09:00:00.000Z'),
    });

    const result = await service.getConfig();

    expect(result.config.enabled).toBe(true);
    expect(result.config.cidrs).toEqual(['192.168.1.0/24']);
    expect(result.intervalSec).toBe(600);
    expect(result.lastRunAt).toBe('2026-02-21T09:00:00.000Z');
    expect(result.updatedAt).toBe('2026-02-21T08:00:00.000Z');
  });

  it('updates persisted config and writes audit event', async () => {
    prisma.serviceDiscoveryConfig.findUnique.mockResolvedValueOnce({
      subnetEnabled: false,
      subnetCidrs: ['10.0.0.0/24'],
      includeAutoLocalCidrs: false,
      includeCommonWebPorts: true,
      subnetMaxHosts: 128,
      subnetConcurrency: 16,
      subnetConnectTimeoutMs: 700,
      subnetToolCallTimeoutMs: 120000,
      updatedAt: new Date('2026-02-21T11:00:00.000Z'),
    });

    await service.updateConfig('97208421-dcd3-47ef-a4d4-e786d82f9328', {
      enabled: true,
      cidrs: ['192.168.1.0/24'],
      includeAutoLocalCidrs: true,
      includeCommonWebPorts: false,
      maxHosts: 300,
      concurrency: 40,
      connectTimeoutMs: 900,
      toolCallTimeoutMs: 180000,
    });

    expect(prisma.serviceDiscoveryConfig.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'global' },
        update: expect.objectContaining({
          subnetEnabled: true,
          subnetCidrs: ['192.168.1.0/24'],
          includeAutoLocalCidrs: true,
          includeCommonWebPorts: false,
          subnetMaxHosts: 300,
          subnetConcurrency: 40,
          subnetConnectTimeoutMs: 900,
          subnetToolCallTimeoutMs: 180000,
        }),
      }),
    );
    expect(auditService.write).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'service.discovery.config.update',
        actorUserId: '97208421-dcd3-47ef-a4d4-e786d82f9328',
      }),
    );
  });

  it('blocks manual discovery when no agents are online', async () => {
    prisma.agent.findMany.mockResolvedValueOnce([]);

    await expect(
      service.triggerManualRun('97208421-dcd3-47ef-a4d4-e786d82f9328', {}),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.serviceDiscoveryRun.create).not.toHaveBeenCalled();
    expect(mcpService.callTool).not.toHaveBeenCalled();
  });

  it('returns no-host agent error when selected host has no online agents', async () => {
    prisma.agent.findMany.mockResolvedValueOnce([]);

    await expect(
      service.triggerManualRun('97208421-dcd3-47ef-a4d4-e786d82f9328', {
        hostId: 'aabbccdd-0000-0000-0000-000000000001',
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.serviceDiscoveryRun.create).not.toHaveBeenCalled();
  });

  it('normalizes invalid listRuns limit values', async () => {
    prisma.serviceDiscoveryRun.findMany.mockResolvedValue([]);

    await service.listRuns(5_000);

    expect(prisma.serviceDiscoveryRun.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        take: 100,
      }),
    );

    prisma.serviceDiscoveryRun.findMany.mockResolvedValue([]);
    await service.listRuns(-9);

    expect(prisma.serviceDiscoveryRun.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        take: 1,
      }),
    );
  });

  it('uses the configured default when listRuns limit is undefined', async () => {
    prisma.serviceDiscoveryRun.findMany.mockResolvedValue([]);

    await service.listRuns();

    expect(prisma.serviceDiscoveryRun.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        take: 20,
      }),
    );
  });

  it('deletes a completed discovery run and audits the action', async () => {
    prisma.serviceDiscoveryRun.findUnique.mockResolvedValueOnce({
      id: 'f1d8f6ec-6e8a-4aa0-8612-9702ce9aa981',
      status: 'COMPLETED',
    });

    const result = await service.deleteRun(
      'f1d8f6ec-6e8a-4aa0-8612-9702ce9aa981',
      '97208421-dcd3-47ef-a4d4-e786d82f9328',
    );

    expect(prisma.serviceDiscoveryRun.delete).toHaveBeenCalledWith({
      where: { id: 'f1d8f6ec-6e8a-4aa0-8612-9702ce9aa981' },
    });
    expect(auditService.write).toHaveBeenCalledWith(
      expect.objectContaining({
        actorUserId: '97208421-dcd3-47ef-a4d4-e786d82f9328',
        action: 'service.discovery.run.delete',
        targetId: 'f1d8f6ec-6e8a-4aa0-8612-9702ce9aa981',
        success: true,
      }),
    );
    expect(result).toEqual({
      ok: true,
      deleted: true,
      runId: 'f1d8f6ec-6e8a-4aa0-8612-9702ce9aa981',
    });
  });

  it('rejects deleting a missing discovery run', async () => {
    prisma.serviceDiscoveryRun.findUnique.mockResolvedValueOnce(null);

    await expect(
      service.deleteRun(
        'f1d8f6ec-6e8a-4aa0-8612-9702ce9aa981',
        '97208421-dcd3-47ef-a4d4-e786d82f9328',
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.serviceDiscoveryRun.delete).not.toHaveBeenCalled();
  });

  it('rejects deleting the active discovery run even if persisted status is stale', async () => {
    prisma.serviceDiscoveryRun.findUnique.mockResolvedValueOnce({
      id: 'f1d8f6ec-6e8a-4aa0-8612-9702ce9aa981',
      status: 'COMPLETED',
    });
    (service as any).activeRunId = 'f1d8f6ec-6e8a-4aa0-8612-9702ce9aa981';

    await expect(
      service.deleteRun(
        'f1d8f6ec-6e8a-4aa0-8612-9702ce9aa981',
        '97208421-dcd3-47ef-a4d4-e786d82f9328',
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.serviceDiscoveryRun.delete).not.toHaveBeenCalled();
  });

  it('reuses an existing host by resolved IP for subnet discovery and renames legacy service instances', async () => {
    const existingHost = {
      id: 'existing-host',
      hostname: '10.0.0.5',
      tags: ['linux'],
      status: 'OK',
      cpuPct: 0,
      memPct: 0,
      diskPct: 0,
      lastSeenAt: new Date('2026-02-20T10:00:00.000Z'),
      agentVersion: '1.0.0',
      createdAt: new Date('2026-02-19T10:00:00.000Z'),
      updatedAt: new Date('2026-02-20T10:00:00.000Z'),
      agent: null,
      facts: [
        {
          id: 'fact-1',
          createdAt: new Date('2026-02-20T10:00:00.000Z'),
          snapshot: { network: { primaryIp: '10.0.0.5' } },
        },
      ],
    };

    prisma.host.findMany.mockImplementation(async (args: { where?: Record<string, any> }) => {
      if (!args.where) {
        return [existingHost];
      }
      return [];
    });
    prisma.host.update.mockResolvedValueOnce({
      id: 'existing-host',
      hostname: 'media',
      tags: ['linux', 'discovered', 'subnet', 'streaming'],
    });
    prisma.serviceInstance.findMany.mockResolvedValueOnce([
      {
        id: 'instance-legacy',
        hostId: 'existing-host',
        serviceId: 'service-1',
        name: 'plex@10.0.0.5',
        status: 'OK',
        endpoint: 'http://10.0.0.5:32400',
        metadata: null,
        lastSeenAt: new Date('2026-02-20T10:00:00.000Z'),
        service: {
          name: 'plex',
        },
      },
    ]);
    prisma.service.upsert.mockResolvedValueOnce({
      id: 'service-1',
    });

    await (service as any).upsertSubnetDiscovery(
      {
        agentId: 'agent-1',
        hostId: 'scanner-host',
        hostName: 'scanner',
      },
      {
        ip: '10.0.0.5',
        hostname: 'media',
        serviceId: 'sig-plex',
        serviceName: 'plex',
        endpoint: 'http://10.0.0.5:32400',
        confidence: 0.98,
        source: 'signature',
        tags: ['streaming'],
        evidence: { banner: 'Plex Media Server' },
      },
      {
        actorUserId: '97208421-dcd3-47ef-a4d4-e786d82f9328',
        runId: 'f1d8f6ec-6e8a-4aa0-8612-9702ce9aa981',
      },
    );

    expect(prisma.host.create).not.toHaveBeenCalled();
    expect(prisma.host.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'existing-host' },
        data: expect.objectContaining({
          hostname: 'media',
        }),
      }),
    );
    expect(prisma.serviceInstance.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'instance-legacy' },
        data: expect.objectContaining({
          hostId: 'existing-host',
          name: 'plex@media',
        }),
      }),
    );
  });

  it('preserves an existing named host when a subnet detection only reports the IP', async () => {
    const existingHost = {
      id: 'existing-host',
      hostname: 'labbox',
      tags: ['linux'],
      status: 'OK',
      cpuPct: 0,
      memPct: 0,
      diskPct: 0,
      lastSeenAt: new Date('2026-02-20T10:00:00.000Z'),
      agentVersion: '1.0.0',
      createdAt: new Date('2026-02-19T10:00:00.000Z'),
      updatedAt: new Date('2026-02-20T10:00:00.000Z'),
      agent: null,
      facts: [
        {
          id: 'fact-2',
          createdAt: new Date('2026-02-20T10:00:00.000Z'),
          snapshot: { network: { primaryIp: '10.0.0.7' } },
        },
      ],
    };

    prisma.host.findMany.mockImplementation(async (args: { where?: Record<string, any> }) => {
      if (!args.where) {
        return [existingHost];
      }
      return [];
    });
    prisma.host.update.mockResolvedValueOnce({
      id: 'existing-host',
      hostname: 'labbox',
      tags: ['linux', 'discovered', 'subnet'],
    });
    prisma.service.upsert.mockResolvedValueOnce({
      id: 'service-1',
    });

    await (service as any).upsertSubnetDiscovery(
      {
        agentId: 'agent-1',
        hostId: 'scanner-host',
        hostName: 'scanner',
      },
      {
        ip: '10.0.0.7',
        hostname: null,
        serviceId: 'sig-grafana',
        serviceName: 'grafana',
        endpoint: 'http://10.0.0.7:3000',
        confidence: 0.91,
        source: 'common-web',
        tags: ['observability'],
        evidence: {},
      },
      {
        actorUserId: '97208421-dcd3-47ef-a4d4-e786d82f9328',
        runId: 'f1d8f6ec-6e8a-4aa0-8612-9702ce9aa981',
      },
    );

    expect(prisma.host.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'existing-host' },
        data: expect.objectContaining({
          hostname: 'labbox',
        }),
      }),
    );
  });
});
