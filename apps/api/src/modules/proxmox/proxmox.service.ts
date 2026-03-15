/*
 * Copyright (c) 2026 Homelab Control Plane contributors
 * SPDX-License-Identifier: MIT
 *
 * This module implements proxmox service business logic for the service layer.
 */
import {
  BadGatewayException,
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { IntegrationType, type Prisma } from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import { SecurityService } from '../common/security.service';
import { PrismaService } from '../../prisma/prisma.service';
import {
  extractProxmoxApiError,
  mapProxmoxFetchError,
  ProxmoxClient,
  readString,
  toRecord,
} from '../integrations/proxmox.client';
import { readProxmoxIntegrationFields } from '../integrations/proxmox.integration';

type GuestKind = 'qemu' | 'lxc';
type GuestAction = 'start' | 'shutdown' | 'stop' | 'reboot';

@Injectable()
/**
 * Implements the proxmox service class.
 */
export class ProxmoxService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly securityService: SecurityService,
    private readonly auditService: AuditService,
  ) {}

  /**
   * Handles list integrations.
   */
  async listIntegrations() {
    const integrations = await this.prisma.integration.findMany({
      where: {
        type: IntegrationType.PROXMOX,
        enabled: true,
      },
      orderBy: [{ name: 'asc' }, { createdAt: 'desc' }],
      include: {
        credential: true,
      },
    });

    return integrations.map((integration) =>
      serializeProxmoxIntegration(
        integration,
        integration.credential
          ? this.securityService.decryptJson<Record<string, unknown>>(
              integration.credential.encryptedBlob,
            )
          : null,
      ),
    );
  }

  async listGuests(
    integrationId: string,
    filters: {
      kind?: string;
      status?: string;
      node?: string;
      search?: string;
    },
  ) {
    const connection = await this.loadIntegrationConnection(integrationId);
    const guests = await this.fetchGuestInventory(connection.client);
    const normalizedFilters = {
      kind: filters.kind === 'qemu' || filters.kind === 'lxc' ? filters.kind : undefined,
      status: readString(filters.status)?.toLowerCase() ?? null,
      node: readString(filters.node),
      search: readString(filters.search)?.toLowerCase() ?? null,
    };

    const filteredGuests = guests.filter((guest) => {
      if (normalizedFilters.kind && guest.kind !== normalizedFilters.kind) {
        return false;
      }
      if (normalizedFilters.status) {
        if (normalizedFilters.status === 'other') {
          if (guest.status === 'running' || guest.status === 'stopped') {
            return false;
          }
        } else if (guest.status.toLowerCase() !== normalizedFilters.status) {
          return false;
        }
      }
      if (normalizedFilters.node && guest.node !== normalizedFilters.node) {
        return false;
      }
      if (normalizedFilters.search) {
        const haystack = `${guest.name} ${guest.vmid}`.toLowerCase();
        return haystack.includes(normalizedFilters.search);
      }
      return true;
    });

    return {
      integration: connection.integration,
      summary: summarizeGuests(filteredGuests),
      filters: {
        nodes: Array.from(new Set(guests.map((guest) => guest.node))).sort(),
      },
      guests: filteredGuests,
    };
  }

  /**
   * Gets guest detail.
   */
  async getGuestDetail(integrationId: string, kind: GuestKind, vmid: number) {
    const connection = await this.loadIntegrationConnection(integrationId);
    const guest = await this.resolveGuest(connection.client, kind, vmid);
    const [statusData, configData] = await Promise.all([
      this.fetchGuestPayload(connection.client, guest.node, kind, vmid, 'status/current'),
      this.fetchGuestPayload(connection.client, guest.node, kind, vmid, 'config'),
    ]);

    return {
      integration: connection.integration,
      guest: {
        ...guest,
        rawStatus: statusData ?? {},
        rawConfig: configData ?? {},
        displayConfig: buildDisplayConfig(kind, guest, statusData, configData),
      },
    };
  }

  /**
   * Handles list guest tasks.
   */
  async listGuestTasks(integrationId: string, kind: GuestKind, vmid: number, limit?: string) {
    const connection = await this.loadIntegrationConnection(integrationId);
    const guest = await this.resolveGuest(connection.client, kind, vmid);
    const parsedLimit = Number(limit ?? '10');
    const taskLimit = Number.isFinite(parsedLimit) ? Math.min(Math.max(parsedLimit, 1), 25) : 10;

    const response = await this.callProxmox(() =>
      connection.client.getJson('/api2/json/nodes/' + encodeURIComponent(guest.node) + '/tasks', {
        limit: taskLimit,
        vmid,
      }),
    );
    const body = toRecord(response.data);
    const tasks = Array.isArray(body?.data) ? body.data : [];

    return {
      integration: connection.integration,
      tasks: tasks
        .map((task) => normalizeTaskSummary(guest.node, task))
        .filter((task): task is NonNullable<typeof task> => task !== null)
        .filter((task) => taskMatchesGuest(task, vmid)),
    };
  }

  async performGuestAction(
    userId: string,
    integrationId: string,
    kind: GuestKind,
    vmid: number,
    action: GuestAction,
  ) {
    const connection = await this.loadIntegrationConnection(integrationId);
    const guest = await this.resolveGuest(connection.client, kind, vmid);
    validateGuestAction(guest, action);

    const response = await this.callProxmox(() =>
      connection.client.postJson(
        `/api2/json/nodes/${encodeURIComponent(guest.node)}/${kind}/${vmid}/status/${action}`,
      ),
    );
    const body = toRecord(response.data);
    const upid = readString(body?.data);
    if (!upid) {
      throw new BadGatewayException('Proxmox action did not return a task id');
    }

    await this.auditService.write({
      actorUserId: userId,
      action: `proxmox.guest.${action}`,
      targetType: 'proxmox_guest',
      targetId: `${integrationId}:${kind}:${vmid}`,
      paramsJson: {
        integrationId,
        kind,
        vmid,
        node: guest.node,
        name: guest.name,
      } as Prisma.InputJsonValue,
      resultJson: {
        upid,
      } as Prisma.InputJsonValue,
      success: true,
    });

    return {
      ok: true as const,
      upid,
    };
  }

  /**
   * Loads integration connection.
   */
  private async loadIntegrationConnection(integrationId: string) {
    const integration = await this.prisma.integration.findFirst({
      where: {
        id: integrationId,
        type: IntegrationType.PROXMOX,
        enabled: true,
      },
      include: {
        credential: true,
      },
    });

    if (!integration || !integration.credential) {
      throw new NotFoundException('Proxmox integration not found');
    }

    const credentials = this.securityService.decryptJson<Record<string, unknown>>(
      integration.credential.encryptedBlob,
    );

    return {
      integration: serializeProxmoxIntegration(integration, credentials),
      client: new ProxmoxClient(
        ProxmoxClient.readConfig(integration.config as Record<string, unknown>),
        ProxmoxClient.readCredentials(credentials),
      ),
    };
  }

  /**
   * Handles fetch guest inventory.
   */
  private async fetchGuestInventory(client: ProxmoxClient) {
    const response = await this.callProxmox(() =>
      client.getJson('/api2/json/cluster/resources', { type: 'vm' }),
    );
    const body = toRecord(response.data);
    const resources = Array.isArray(body?.data) ? body.data : [];

    return resources
      .map((resource) => normalizeGuestSummary(resource))
      .filter((guest): guest is NonNullable<typeof guest> => guest !== null)
      .sort((left, right) => {
        if (left.node !== right.node) {
          return left.node.localeCompare(right.node);
        }
        if (left.kind !== right.kind) {
          return left.kind.localeCompare(right.kind);
        }
        if (left.name !== right.name) {
          return left.name.localeCompare(right.name);
        }
        return left.vmid - right.vmid;
      });
  }

  /**
   * Handles resolve guest.
   */
  private async resolveGuest(client: ProxmoxClient, kind: GuestKind, vmid: number) {
    const guests = await this.fetchGuestInventory(client);
    const guest = guests.find((candidate) => candidate.kind === kind && candidate.vmid === vmid);
    if (!guest) {
      throw new NotFoundException('Proxmox guest not found');
    }
    return guest;
  }

  private async fetchGuestPayload(
    client: ProxmoxClient,
    node: string,
    kind: GuestKind,
    vmid: number,
    suffix: string,
  ) {
    const response = await this.callProxmox(() =>
      client.getJson(`/api2/json/nodes/${encodeURIComponent(node)}/${kind}/${vmid}/${suffix}`),
    );
    const body = toRecord(response.data);
    return toRecord(body?.data) ?? {};
  }

  private async callProxmox(request: () => Promise<{ status: number; data: unknown }>) {
    let response: { status: number; data: unknown };
    try {
      response = await request();
    } catch (error) {
      throw new BadGatewayException(mapProxmoxFetchError(error));
    }

    if (response.status < 200 || response.status >= 300) {
      throw new BadGatewayException(
        extractProxmoxApiError(response.data) ??
          `Proxmox request failed with status ${response.status}`,
      );
    }

    return response;
  }
}

/**
 * Implements serialize proxmox integration.
 */
function serializeProxmoxIntegration(
  integration: {
    id: string;
    name: string;
    type: IntegrationType;
    enabled: boolean;
    config: Prisma.JsonValue;
    lastSyncAt: Date | null;
    lastStatus: string | null;
    lastError: string | null;
    createdAt: Date;
    updatedAt: Date;
  },
  credentials?: Record<string, unknown> | null,
) {
  const fields = readProxmoxIntegrationFields(toJsonRecord(integration.config), credentials);

  return {
    id: integration.id,
    name: integration.name,
    type: integration.type,
    enabled: integration.enabled,
    baseUrl: fields.baseUrl,
    allowInsecureTls: fields.allowInsecureTls,
    apiTokenId: fields.apiTokenId,
    hasApiTokenSecret: fields.hasApiTokenSecret,
    lastSyncAt: integration.lastSyncAt?.toISOString() ?? null,
    lastStatus: integration.lastStatus ?? null,
    lastError: integration.lastError ?? null,
    createdAt: integration.createdAt.toISOString(),
    updatedAt: integration.updatedAt.toISOString(),
  };
}

/**
 * Implements normalize guest summary.
 */
function normalizeGuestSummary(resource: unknown) {
  const record = toRecord(resource);
  if (!record) {
    return null;
  }

  const kind = readString(record.type);
  if (kind !== 'qemu' && kind !== 'lxc') {
    return null;
  }

  const vmid = readNumber(record.vmid);
  const node = readString(record.node);
  if (vmid === null || !node) {
    return null;
  }

  const name = readString(record.name) ?? `${kind.toUpperCase()} ${vmid}`;
  const status = readString(record.status) ?? 'unknown';
  const lock = readString(record.lock);
  const tags = splitTags(readString(record.tags));

  return {
    id: `${kind}:${vmid}`,
    vmid,
    kind,
    name,
    node,
    status,
    template: readFlag(record.template),
    locked: Boolean(lock),
    tags,
    cpu: readNumber(record.cpu),
    maxCpu: readNumber(record.maxcpu),
    memoryBytes: readNumber(record.mem),
    maxMemoryBytes: readNumber(record.maxmem),
    diskBytes: readNumber(record.disk),
    maxDiskBytes: readNumber(record.maxdisk),
    uptimeSeconds: readNumber(record.uptime),
  };
}

/**
 * Implements normalize task summary.
 */
function normalizeTaskSummary(node: string, task: unknown) {
  const record = toRecord(task);
  const upid = readString(record?.upid);
  if (!record || !upid) {
    return null;
  }

  return {
    upid,
    node: readString(record.node) ?? node,
    status: readString(record.status),
    exitStatus: readString(record.exitstatus),
    type: readString(record.type),
    user: readString(record.user),
    startedAt: toIsoDate(readNumber(record.starttime)),
    endedAt: toIsoDate(readNumber(record.endtime)),
    description: readString(record.id) ?? readString(record.type),
  };
}

/**
 * Implements task matches guest.
 */
function taskMatchesGuest(
  task: {
    description: string | null;
    upid: string;
  },
  vmid: number,
) {
  if (task.description === String(vmid)) {
    return true;
  }

  return task.upid.includes(`:${vmid}:`);
}

/**
 * Implements summarize guests.
 */
function summarizeGuests(
  guests: Array<{
    status: string;
    kind: GuestKind;
  }>,
) {
  return guests.reduce(
    (summary, guest) => {
      summary.total += 1;
      if (guest.status === 'running') {
        summary.running += 1;
      }
      if (guest.status === 'stopped') {
        summary.stopped += 1;
      }
      if (guest.kind === 'qemu') {
        summary.qemu += 1;
      }
      if (guest.kind === 'lxc') {
        summary.lxc += 1;
      }
      return summary;
    },
    {
      total: 0,
      running: 0,
      stopped: 0,
      qemu: 0,
      lxc: 0,
    },
  );
}

/**
 * Builds display config.
 */
function buildDisplayConfig(
  kind: GuestKind,
  guest: {
    name: string;
    node: string;
    status: string;
    vmid: number;
  },
  statusData: Record<string, unknown>,
  configData: Record<string, unknown>,
) {
  const rows = [
    ['Type', kind.toUpperCase()],
    ['VMID', String(guest.vmid)],
    ['Name', guest.name],
    ['Node', guest.node],
    ['Status', guest.status],
    ['On Boot', readString(configData.onboot) ?? (readFlag(configData.onboot) ? 'Yes' : 'No')],
    ['Tags', readString(configData.tags)],
    ['Description', readString(configData.description)],
    ['Cores', stringifyNumber(configData.cores)],
    ['Sockets', stringifyNumber(configData.sockets)],
    ['Memory (MiB)', stringifyNumber(configData.memory)],
    ['Uptime (s)', stringifyNumber(statusData.uptime)],
    ['Lock', readString(statusData.lock) ?? readString(configData.lock)],
  ];

  return rows
    .map(([label, value]) => ({ label, value }))
    .filter((row) => typeof row.value === 'string' && row.value.trim().length > 0) as Array<{
    label: string;
    value: string;
  }>;
}

/**
 * Implements validate guest action.
 */
function validateGuestAction(
  guest: {
    template: boolean;
    locked: boolean;
    status: string;
  },
  action: GuestAction,
) {
  if (guest.template) {
    throw new BadRequestException('Template guests cannot be managed');
  }
  if (guest.locked) {
    throw new BadRequestException('Locked guests cannot be managed');
  }
  if (action === 'start' && guest.status !== 'stopped') {
    throw new BadRequestException('Start is only available for stopped guests');
  }
  if (action !== 'start' && guest.status !== 'running') {
    throw new BadRequestException(`${capitalize(action)} is only available for running guests`);
  }
}

/**
 * Implements split tags.
 */
function splitTags(value: string | null) {
  if (!value) {
    return [];
  }

  return value
    .split(/[;,]/)
    .map((tag) => tag.trim())
    .filter((tag) => tag.length > 0);
}

/**
 * Implements read number.
 */
function readNumber(value: unknown) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/**
 * Implements read flag.
 */
function readFlag(value: unknown) {
  if (typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'number') {
    return value > 0;
  }
  const text = readString(value);
  return text ? ['1', 'true', 'yes', 'on'].includes(text.toLowerCase()) : false;
}

/**
 * Implements to iso date.
 */
function toIsoDate(value: number | null) {
  if (value === null) {
    return null;
  }
  return new Date(value * 1000).toISOString();
}

/**
 * Implements stringify number.
 */
function stringifyNumber(value: unknown) {
  const numberValue = readNumber(value);
  return numberValue === null ? null : String(numberValue);
}

/**
 * Implements capitalize.
 */
function capitalize(value: string) {
  return value.length === 0 ? value : value[0].toUpperCase() + value.slice(1);
}

/**
 * Implements to json record.
 */
function toJsonRecord(value: Prisma.JsonValue): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }

  return value as Record<string, unknown>;
}
