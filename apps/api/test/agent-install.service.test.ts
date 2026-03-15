/*
 * Copyright (c) 2026 Homelab Control Plane contributors
 * SPDX-License-Identifier: MIT
 *
 * This test file verifies the agent install service test behavior.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { chmod, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { AgentInstallService } from '../src/modules/agent-install/agent-install.service';

const actionInstall = 'INSTALL';
const actionRollback = 'ROLLBACK';
const statusApprovedAwaitingExecution = 'APPROVED_AWAITING_EXECUTION';
const statusPendingApproval = 'PENDING_APPROVAL';
const statusRunning = 'RUNNING';
const statusSucceeded = 'SUCCEEDED';

const defaultInstallTimestamp = new Date('2026-02-23T12:00:00.000Z');

describe('AgentInstallService binary delivery', () => {
  const originalCwd = process.cwd();

  /**
   * Builds agent install record for the surrounding workflow.
   */
  const buildAgentInstallRecord = (overrides: Record<string, unknown> = {}) => ({
    id: '4d6b3fd6-3298-4db8-930d-ec77b7f12a31',
    action: actionInstall,
    status: statusApprovedAwaitingExecution,
    requestedByUserId: '67a45ff5-5abc-46e0-bf06-4f97f8e51324',
    approvedByUserId: '67a45ff5-5abc-46e0-bf06-4f97f8e51324',
    deniedByUserId: null,
    targetHostId: null,
    targetHost: '192.168.1.20',
    targetPort: 22,
    targetUsername: 'root',
    authMode: 'KEY',
    binaryVersion: 'v0.2.0',
    binaryUrlResolved: null,
    controlPlaneUrl: 'http://localhost:4000',
    mcpBind: '0.0.0.0',
    mcpPort: 8081,
    mcpAdvertiseUrl: 'http://192.168.1.20:8081',
    allowedOrigins: 'http://localhost:5173',
    allowInsecureDev: true,
    replaceExisting: true,
    installPath: '/usr/local/bin/labagent',
    serviceName: 'labagent',
    rollbackOfRequestId: null,
    resultCode: null,
    resultSummary: null,
    errorMessageSanitized: null,
    agentIdLinked: null,
    approvedAt: defaultInstallTimestamp,
    startedAt: null,
    finishedAt: null,
    deniedAt: null,
    createdAt: defaultInstallTimestamp,
    updatedAt: defaultInstallTimestamp,
    ...overrides,
  });

  /**
   * Builds service.
   */
  const buildService = (configOverrides: Record<string, unknown>) => {
    const configValues: Record<string, unknown> = {
      AGENT_INSTALL_ENABLED: true,
      AGENT_INSTALL_QUEUE_NAME: 'agent-install-jobs',
      AGENT_INSTALL_SECRET_TTL_SEC: 900,
      AGENT_BINARY_DEFAULT_VERSION: 'v0.2.0',
      AGENT_BINARY_STORE_ROOT: '/opt/homelab-agent-binaries',
      ...configOverrides,
    };

    const prisma = {
      host: {
        findUnique: vi.fn(),
      },
      agent: {
        findUnique: vi.fn(),
      },
      agentInstallRequest: {
        create: vi.fn().mockResolvedValue(buildAgentInstallRecord()),
        findFirst: vi.fn(),
        findUnique: vi.fn(),
        update: vi.fn(),
      },
      agentInstallLog: {
        findFirst: vi.fn().mockResolvedValue(null),
        create: vi.fn().mockResolvedValue({
          id: 'log-1',
          seq: 0,
          phase: 'queue',
          level: 'INFO',
          message: 'Execution queued.',
          createdAt: defaultInstallTimestamp,
        }),
      },
    };

    const configService = {
      get: vi.fn((key: string, defaultValue?: unknown) => {
        if (key in configValues) {
          return configValues[key];
        }
        return defaultValue;
      }),
    };

    const agentsService = {};
    const auditService = {
      write: vi.fn().mockResolvedValue(undefined),
    };
    const eventsService = {
      emit: vi.fn().mockResolvedValue(undefined),
    };

    const service = new AgentInstallService(
      prisma as never,
      configService as never,
      agentsService as never,
      auditService as never,
      eventsService as never,
    );

    return { service, prisma, configService, auditService, eventsService };
  };

  /**
   * Implements resolve installer script path.
   */
  const resolveInstallerScriptPath = (service: AgentInstallService) => {
    return (
      service as unknown as { resolveInstallerScriptPath: () => Promise<string> }
    ).resolveInstallerScriptPath();
  };

  /**
   * Builds install command.
   */
  const buildInstallCommand = (service: AgentInstallService) => {
    return (
      service as unknown as {
        buildInstallCommand: (input: {
          remoteInstallerPath: string;
          remoteBinaryPath: string;
          request: {
            controlPlaneUrl: string;
            mcpBind: string;
            mcpPort: number;
            mcpAdvertiseUrl: string;
            allowedOrigins: string;
            allowInsecureDev: boolean;
            replaceExisting: boolean;
            installPath: string;
            serviceName: string;
          };
          enrollmentToken: string;
          sudoPassword?: string;
        }) => string;
      }
    ).buildInstallCommand({
      remoteInstallerPath: '/tmp/install-labagent.sh',
      remoteBinaryPath: '/tmp/labagent',
      request: {
        controlPlaneUrl: 'http://localhost:4000',
        mcpBind: '0.0.0.0',
        mcpPort: 8081,
        mcpAdvertiseUrl: 'http://192.168.1.20:8081',
        allowedOrigins: 'http://localhost:5173',
        allowInsecureDev: true,
        replaceExisting: true,
        installPath: '/usr/local/bin/labagent',
        serviceName: 'labagent',
      },
      enrollmentToken: '0123456789abcdef0123456789abcdef',
    });
  };

  /**
   * Builds install command keep existing.
   */
  const buildInstallCommandKeepExisting = (service: AgentInstallService) => {
    return (
      service as unknown as {
        buildInstallCommand: (input: {
          remoteInstallerPath: string;
          remoteBinaryPath: string;
          request: {
            controlPlaneUrl: string;
            mcpBind: string;
            mcpPort: number;
            mcpAdvertiseUrl: string;
            allowedOrigins: string;
            allowInsecureDev: boolean;
            replaceExisting: boolean;
            installPath: string;
            serviceName: string;
          };
          enrollmentToken: string;
          sudoPassword?: string;
        }) => string;
      }
    ).buildInstallCommand({
      remoteInstallerPath: '/tmp/install-labagent.sh',
      remoteBinaryPath: '/tmp/labagent',
      request: {
        controlPlaneUrl: 'http://localhost:4000',
        mcpBind: '0.0.0.0',
        mcpPort: 8081,
        mcpAdvertiseUrl: 'http://192.168.1.20:8081',
        allowedOrigins: 'http://localhost:5173',
        allowInsecureDev: true,
        replaceExisting: false,
        installPath: '/usr/local/bin/labagent',
        serviceName: 'labagent',
      },
      enrollmentToken: '0123456789abcdef0123456789abcdef',
    });
  };

  afterEach(() => {
    process.chdir(originalCwd);
    vi.restoreAllMocks();
  });

  it('returns container-store manifest entries with availability', async () => {
    const tempRoot = await mkdtemp(path.join(tmpdir(), 'agent-bin-store-'));
    const version = 'v9.9.9';
    const versionDir = path.join(tempRoot, version);
    const amd64Binary = path.join(versionDir, 'labagent-linux-amd64');

    try {
      await mkdir(versionDir, { recursive: true });
      await writeFile(amd64Binary, '#!/bin/sh\necho test\n', { mode: 0o755 });
      await chmod(amd64Binary, 0o755);

      const { service } = buildService({
        AGENT_BINARY_STORE_ROOT: tempRoot,
        AGENT_BINARY_DEFAULT_VERSION: version,
      });

      const manifest = await service.binaryManifest();

      expect(manifest).toMatchObject({
        enabled: true,
        source: 'CONTAINER_STORE',
        defaultVersion: version,
        storeRootConfigured: true,
      });
      expect(manifest.binaries).toContainEqual({
        version,
        platform: 'linux-amd64',
        available: true,
      });
      expect(manifest.binaries).toContainEqual({
        version,
        platform: 'linux-arm64',
        available: false,
      });
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it('creates install requests without external binary URL configuration', async () => {
    const { service, prisma, auditService, eventsService } = buildService({});

    const result = await service.createRequest('67a45ff5-5abc-46e0-bf06-4f97f8e51324', {
      confirm: true,
      action: 'INSTALL',
      targetHost: '192.168.1.20',
      targetPort: 22,
      targetUsername: 'root',
      authMode: 'KEY',
      binaryVersion: 'v0.2.0',
      controlPlaneUrl: 'http://localhost:4000',
      mcpBind: '0.0.0.0',
      mcpPort: 8081,
      mcpAdvertiseUrl: 'http://192.168.1.20:8081',
      allowedOrigins: 'http://localhost:5173',
      allowInsecureDev: true,
      replaceExisting: true,
      installPath: '/usr/local/bin/labagent',
      serviceName: 'labagent',
    });

    expect(result.id).toBe('4d6b3fd6-3298-4db8-930d-ec77b7f12a31');
    expect(result.status).toBe('APPROVED_AWAITING_EXECUTION');
    expect(prisma.agentInstallRequest.create).toHaveBeenCalledTimes(1);
    expect(prisma.agentInstallRequest.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: statusApprovedAwaitingExecution,
          approvedByUserId: '67a45ff5-5abc-46e0-bf06-4f97f8e51324',
        }),
      }),
    );
    expect(auditService.write).toHaveBeenCalledTimes(1);
    expect(eventsService.emit).toHaveBeenCalledTimes(1);
  });

  it('creates uninstall requests for an installed agent', async () => {
    const { service, prisma, auditService, eventsService } = buildService({});
    const sourceRecord = buildAgentInstallRecord({
      id: 'source-request-id',
      status: statusSucceeded,
      action: actionInstall,
      targetHost: '192.168.1.200',
      targetHostId: '7f6e4f53-2e1f-4c9f-b2b6-0e0f6e5eac42',
      agentIdLinked: 'f3f7f2e4-1b39-4b1f-98c6-6e0d8e6dc1f5',
    });
    const createdRecord = buildAgentInstallRecord({
      id: 'rollback-request-id',
      action: actionRollback,
      status: statusApprovedAwaitingExecution,
      targetHost: '192.168.1.200',
      targetHostId: '7f6e4f53-2e1f-4c9f-b2b6-0e0f6e5eac42',
      rollbackOfRequestId: sourceRecord.id,
      agentIdLinked: null,
      approvedByUserId: '67a45ff5-5abc-46e0-bf06-4f97f8e51324',
    });

    prisma.agent.findUnique = vi.fn().mockResolvedValue({
      id: 'f3f7f2e4-1b39-4b1f-98c6-6e0d8e6dc1f5',
      revokedAt: null,
    });
    prisma.agentInstallRequest.findFirst = vi
      .fn()
      .mockResolvedValueOnce(sourceRecord)
      .mockResolvedValueOnce(null);
    prisma.agentInstallRequest.create = vi.fn().mockResolvedValue(createdRecord);

    const result = await service.createUninstallRequestFromAgent(
      'f3f7f2e4-1b39-4b1f-98c6-6e0d8e6dc1f5',
      '67a45ff5-5abc-46e0-bf06-4f97f8e51324',
      {
        confirm: true,
      },
    );

    expect(result.id).toBe('rollback-request-id');
    expect(result.status).toBe(statusApprovedAwaitingExecution);
    expect(result.action).toBe(actionRollback);
    expect(prisma.agentInstallRequest.create).toHaveBeenCalledTimes(1);
    expect(prisma.agentInstallRequest.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: actionRollback,
          status: statusApprovedAwaitingExecution,
          rollbackOfRequestId: sourceRecord.id,
          targetHost: sourceRecord.targetHost,
        }),
      }),
    );
    expect(auditService.write).toHaveBeenCalledTimes(1);
    expect(eventsService.emit).toHaveBeenCalledTimes(1);
  });

  it('queues approved requests when launched', async () => {
    const { service, prisma } = buildService({});
    const queue = {
      add: vi.fn().mockResolvedValue(undefined),
    };
    (service as unknown as { queue: { add: (...args: unknown[]) => Promise<void> } | null }).queue =
      queue;

    prisma.agentInstallRequest.findUnique = vi.fn().mockResolvedValue(
      buildAgentInstallRecord({
        id: 'launchable-request-id',
        status: statusApprovedAwaitingExecution,
      }),
    );

    const result = await service.launchRequest(
      'launchable-request-id',
      '67a45ff5-5abc-46e0-bf06-4f97f8e51324',
      {
        confirm: true,
        authMode: 'KEY',
        sshPrivateKey: '-----BEGIN KEY-----\nabc\n-----END KEY-----',
      },
    );

    expect(result).toMatchObject({
      ok: true,
      queued: true,
      requestId: 'launchable-request-id',
    });
    expect(queue.add).toHaveBeenCalledTimes(1);
  });

  it('returns idempotent success when launching an already running request', async () => {
    const { service, prisma, auditService } = buildService({});
    const queue = {
      add: vi.fn().mockResolvedValue(undefined),
    };
    (service as unknown as { queue: { add: (...args: unknown[]) => Promise<void> } | null }).queue =
      queue;

    prisma.agentInstallRequest.findUnique = vi.fn().mockResolvedValue(
      buildAgentInstallRecord({
        id: 'running-request-id',
        status: statusRunning,
      }),
    );

    const result = await service.launchRequest(
      'running-request-id',
      '67a45ff5-5abc-46e0-bf06-4f97f8e51324',
      {
        confirm: true,
        authMode: 'KEY',
        sshPrivateKey: '-----BEGIN KEY-----\nabc\n-----END KEY-----',
      },
    );

    expect(result).toMatchObject({
      ok: true,
      queued: false,
      requestId: 'running-request-id',
      alreadyLaunched: true,
      currentStatus: statusRunning,
    });
    expect(queue.add).not.toHaveBeenCalled();
    expect(auditService.write).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'agent_install.launch_noop',
        targetId: 'running-request-id',
        success: true,
      }),
    );
  });

  it('throws launch conflict for non-launchable queued state', async () => {
    const { service, prisma } = buildService({});
    const queue = {
      add: vi.fn().mockResolvedValue(undefined),
    };
    (service as unknown as { queue: { add: (...args: unknown[]) => Promise<void> } | null }).queue =
      queue;

    prisma.agentInstallRequest.findUnique = vi.fn().mockResolvedValue(
      buildAgentInstallRecord({
        id: 'pending-request-id',
        status: statusPendingApproval,
      }),
    );

    await expect(
      service.launchRequest('pending-request-id', '67a45ff5-5abc-46e0-bf06-4f97f8e51324', {
        confirm: true,
        authMode: 'KEY',
        sshPrivateKey: '-----BEGIN KEY-----\nabc\n-----END KEY-----',
      }),
    ).rejects.toThrow(`Request is not launchable from status ${statusPendingApproval}`);
  });

  it('throws when an uninstall request is already in progress', async () => {
    const { service, prisma } = buildService({});
    const sourceRecord = buildAgentInstallRecord({
      id: 'source-request-id',
      status: statusSucceeded,
      action: actionInstall,
      targetHost: '192.168.1.200',
      targetHostId: '7f6e4f53-2e1f-4c9f-b2b6-0e0f6e5eac42',
      agentIdLinked: 'f3f7f2e4-1b39-4b1f-98c6-6e0d8e6dc1f5',
    });

    prisma.agent.findUnique = vi.fn().mockResolvedValue({
      id: 'f3f7f2e4-1b39-4b1f-98c6-6e0d8e6dc1f5',
      revokedAt: null,
    });
    prisma.agentInstallRequest.findFirst = vi
      .fn()
      .mockResolvedValueOnce(sourceRecord)
      .mockResolvedValueOnce({
        id: 'active-uninstall-request',
        action: actionRollback,
        status: 'PENDING_APPROVAL',
      });

    await expect(
      service.createUninstallRequestFromAgent(
        'f3f7f2e4-1b39-4b1f-98c6-6e0d8e6dc1f5',
        '67a45ff5-5abc-46e0-bf06-4f97f8e51324',
        {
          confirm: true,
        },
      ),
    ).rejects.toThrow('An uninstall request for this agent is already in progress.');
  });

  it('throws when uninstall request has no successful install request', async () => {
    const { service, prisma } = buildService({});

    prisma.agent.findUnique = vi.fn().mockResolvedValue({
      id: 'f3f7f2e4-1b39-4b1f-98c6-6e0d8e6dc1f5',
      revokedAt: null,
    });
    prisma.agentInstallRequest.findFirst = vi.fn().mockResolvedValue(null);

    await expect(
      service.createUninstallRequestFromAgent(
        'f3f7f2e4-1b39-4b1f-98c6-6e0d8e6dc1f5',
        '67a45ff5-5abc-46e0-bf06-4f97f8e51324',
        {
          confirm: true,
        },
      ),
    ).rejects.toThrow('No successful install request found for this agent');
  });

  it('throws when uninstall target agent is revoked', async () => {
    const { service, prisma } = buildService({});

    prisma.agent.findUnique = vi.fn().mockResolvedValue({
      id: 'e2b9d4ad-2f35-48e2-a5d1-1fd4ebff6a5a',
      revokedAt: new Date('2026-02-23T12:01:00.000Z'),
    });

    await expect(
      service.createUninstallRequestFromAgent(
        'e2b9d4ad-2f35-48e2-a5d1-1fd4ebff6a5a',
        '67a45ff5-5abc-46e0-bf06-4f97f8e51324',
        {
          confirm: true,
        },
      ),
    ).rejects.toThrow('Cannot create uninstall request for revoked agent');
  });

  it('includes replace-existing cleanup when building remote install command', () => {
    const { service } = buildService({});
    const command = buildInstallCommand(service);

    expect(command).toContain('--replace-existing');
    expect(command).toContain('--run-mode systemd');
    expect(command).toContain('--yes');
  });

  it('can skip cleanup when building remote install command', () => {
    const { service } = buildService({});
    const command = buildInstallCommandKeepExisting(service);

    expect(command).toContain('--keep-existing');
    expect(command).not.toContain('--replace-existing');
  });

  it('resolves installer script from current working directory repo root', async () => {
    const tempRoot = await mkdtemp(path.join(tmpdir(), 'agent-install-script-root-'));
    const scriptPath = path.join(tempRoot, 'scripts', 'install-labagent.sh');

    try {
      await mkdir(path.dirname(scriptPath), { recursive: true });
      await writeFile(scriptPath, '#!/usr/bin/env bash\necho ok\n', { mode: 0o755 });
      await chmod(scriptPath, 0o755);

      process.chdir(tempRoot);

      const { service } = buildService({});
      const resolved = await resolveInstallerScriptPath(service);
      expect(resolved).toBe(scriptPath);
    } finally {
      process.chdir(originalCwd);
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it('resolves installer script when API process runs from apps/api cwd', async () => {
    const tempRoot = await mkdtemp(path.join(tmpdir(), 'agent-install-script-appscwd-'));
    const appCwd = path.join(tempRoot, 'apps', 'api');
    const scriptPath = path.join(tempRoot, 'scripts', 'install-labagent.sh');

    try {
      await mkdir(appCwd, { recursive: true });
      await mkdir(path.dirname(scriptPath), { recursive: true });
      await writeFile(scriptPath, '#!/usr/bin/env bash\necho ok\n', { mode: 0o755 });
      await chmod(scriptPath, 0o755);

      process.chdir(appCwd);

      const { service } = buildService({});
      const resolved = await resolveInstallerScriptPath(service);
      expect(resolved).toBe(scriptPath);
    } finally {
      process.chdir(originalCwd);
      await rm(tempRoot, { recursive: true, force: true });
    }
  });
});
