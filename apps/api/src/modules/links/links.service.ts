/*
 * Copyright (c) 2026 Homelab Control Plane contributors
 * SPDX-License-Identifier: MIT
 *
 * This module implements links service business logic for the service layer.
 */
import { BadRequestException, Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { z } from 'zod';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';

// Dashboard persistence key. Keeps versioning local to this feature boundary.
const linksMemoryKey = 'dashboard_links_v1';

const knownIconIds = [
  'globe',
  'shield',
  'wrench',
  'chart',
  'activity',
  'server',
  'network',
  'hard-drive',
  'home',
  'container',
  'git',
  'cloud',
  'database',
  'router',
  'terminal',
  'bot',
] as const;

const groupColorIds = ['slate', 'blue', 'teal', 'emerald', 'amber', 'rose', 'violet'] as const;
const tileSizeIds = ['sm', 'md', 'lg'] as const;
const hostMetricIds = ['cpu', 'mem', 'disk', 'network', 'diskIo'] as const;
const homelabMetricIds = ['hostsOnline', 'hostsOffline', 'activeAlerts', 'failingChecks'] as const;
const widgetSizeIds = ['normal', 'wide', 'tall'] as const;

const knownIconSchema = z.enum(knownIconIds);
const groupColorSchema = z.enum(groupColorIds);
const tileSizeSchema = z.enum(tileSizeIds);
const hostMetricSchema = z.enum(hostMetricIds);
const homelabMetricSchema = z.enum(homelabMetricIds);
const widgetSizeSchema = z.enum(widgetSizeIds);

// Dashboard schema contract used for validation before persistence.
const linkTileSchema = z
  .object({
    id: z.string().min(1).max(64),
    title: z.string().min(1).max(120),
    url: z
      .string()
      .url()
      .max(500)
      .refine((value) => value.startsWith('http://') || value.startsWith('https://'), {
        message: 'Only HTTP(S) URLs are supported.',
      }),
    description: z.string().max(280).optional(),
    icon: knownIconSchema.default('globe'),
    openInNewTab: z.boolean().default(true),
  })
  .strict();

const hostMetricWidgetSchema = z
  .object({
    id: z.string().min(1).max(64),
    kind: z.literal('host-metric'),
    title: z.string().min(1).max(120),
    description: z.string().max(280).optional(),
    hostId: z.string().min(1).max(64),
    hostName: z.string().min(1).max(120),
    metric: hostMetricSchema,
    size: widgetSizeSchema.default('normal'),
  })
  .strict();

const homelabMetricWidgetSchema = z
  .object({
    id: z.string().min(1).max(64),
    kind: z.literal('homelab-metric'),
    title: z.string().min(1).max(120),
    description: z.string().max(280).optional(),
    metric: homelabMetricSchema,
    size: widgetSizeSchema.default('normal'),
  })
  .strict();

const hostTerminalWidgetSchema = z
  .object({
    id: z.string().min(1).max(64),
    kind: z.literal('host-terminal'),
    title: z.string().min(1).max(120),
    description: z.string().max(280).optional(),
    hostId: z.string().min(1).max(64),
    hostName: z.string().min(1).max(120),
    size: widgetSizeSchema.default('normal'),
  })
  .strict();

const homeSummaryCardWidgetSchema = z
  .object({
    id: z.string().min(1).max(64),
    kind: z.literal('home-summary-card'),
    title: z.string().min(1).max(120),
    description: z.string().max(280).optional(),
    metric: homelabMetricSchema,
    size: widgetSizeSchema.default('normal'),
  })
  .strict();

const homeWhatsBrokenWidgetSchema = z
  .object({
    id: z.string().min(1).max(64),
    kind: z.literal('home-whats-broken'),
    title: z.string().min(1).max(120),
    description: z.string().max(280).optional(),
    size: widgetSizeSchema.default('wide'),
  })
  .strict();

const homeRecentEventsWidgetSchema = z
  .object({
    id: z.string().min(1).max(64),
    kind: z.literal('home-recent-events'),
    title: z.string().min(1).max(120),
    description: z.string().max(280).optional(),
    size: widgetSizeSchema.default('tall'),
  })
  .strict();

const homeTopConsumersWidgetSchema = z
  .object({
    id: z.string().min(1).max(64),
    kind: z.literal('home-top-consumers'),
    title: z.string().min(1).max(120),
    description: z.string().max(280).optional(),
    size: widgetSizeSchema.default('wide'),
  })
  .strict();

const aiChatWidgetSchema = z
  .object({
    id: z.string().min(1).max(64),
    kind: z.literal('ai-chat'),
    title: z.string().min(1).max(120),
    description: z.string().max(280).optional(),
    question: z.string().min(1).max(500).optional(),
    refreshIntervalSec: z.number().int().min(0).max(86_400).nullable().optional(),
    placeholder: z.string().max(240).optional(),
    size: widgetSizeSchema.default('normal'),
  })
  .strict();

const dashboardAgentHighlightsWidgetSchema = z
  .object({
    id: z.string().min(1).max(64),
    kind: z.literal('dashboard-agent-highlights'),
    title: z.string().min(1).max(120),
    description: z.string().max(280).optional(),
    size: widgetSizeSchema.default('wide'),
  })
  .strict();

const linkWidgetSchema = z.discriminatedUnion('kind', [
  hostMetricWidgetSchema,
  hostTerminalWidgetSchema,
  homelabMetricWidgetSchema,
  homeSummaryCardWidgetSchema,
  homeWhatsBrokenWidgetSchema,
  homeRecentEventsWidgetSchema,
  homeTopConsumersWidgetSchema,
  dashboardAgentHighlightsWidgetSchema,
  aiChatWidgetSchema,
]);

const linkGroupSchema = z
  .object({
    id: z.string().min(1).max(64),
    title: z.string().min(1).max(100),
    color: groupColorSchema.default('slate'),
    collapsed: z.boolean().default(false),
    tiles: z.array(linkTileSchema).max(200),
    widgets: z.array(linkWidgetSchema).max(200).default([]),
  })
  .strict();

const linksDashboardSchema = z
  .object({
    version: z.literal(1),
    settings: z
      .object({
        columns: z.number().int().min(1).max(6).default(4),
        tileSize: tileSizeSchema.default('md'),
        defaultOpenInNewTab: z.boolean().default(true),
      })
      .strict(),
    groups: z.array(linkGroupSchema).min(1).max(40),
  })
  .strict();

const updateDashboardSchema = z
  .object({
    confirm: z.literal(true),
    dashboard: linksDashboardSchema,
  })
  .strict();

type KnownIconId = z.infer<typeof knownIconSchema>;
type LinksDashboard = z.infer<typeof linksDashboardSchema>;

type ServiceSnapshot = {
  id: string;
  name: string;
  tags: string[];
  source: string | null;
  instances: Array<{
    id: string;
    name: string;
    endpoint: string | null;
    host: {
      hostname: string;
    } | null;
  }>;
};

type KnownServiceDefinition = {
  id: string;
  displayName: string;
  icon: KnownIconId;
  groupHint: string;
  matchers: string[];
  defaultScheme: 'http' | 'https';
  defaultPorts: number[];
  defaultPath?: string;
};

type LinkSuggestion = {
  id: string;
  serviceId: string;
  serviceName: string;
  title: string;
  url: string;
  description: string;
  icon: KnownIconId;
  groupHint: string;
  confidence: number;
  source: 'endpoint' | 'inferred';
};

type SuggestionCandidate = {
  url: string;
  description: string;
  confidence: number;
  source: 'endpoint' | 'inferred';
};

const knownIcons: Array<{ id: KnownIconId; label: string }> = [
  { id: 'globe', label: 'Generic Service' },
  { id: 'shield', label: 'Security / DNS' },
  { id: 'wrench', label: 'Automation' },
  { id: 'chart', label: 'Observability' },
  { id: 'activity', label: 'Metrics' },
  { id: 'server', label: 'Infrastructure' },
  { id: 'network', label: 'Network' },
  { id: 'hard-drive', label: 'Storage' },
  { id: 'home', label: 'Smart Home' },
  { id: 'container', label: 'Containers' },
  { id: 'git', label: 'Source Control' },
  { id: 'cloud', label: 'Cloud / Sync' },
  { id: 'database', label: 'Database' },
  { id: 'router', label: 'Routing / Proxy' },
  { id: 'terminal', label: 'Admin' },
  { id: 'bot', label: 'Automation Bot' },
];

const knownServices: KnownServiceDefinition[] = [
  {
    id: 'pihole',
    displayName: 'Pi-hole',
    icon: 'shield',
    groupHint: 'Network',
    matchers: ['pihole', 'pi-hole'],
    defaultScheme: 'http',
    defaultPorts: [80],
    defaultPath: '/admin',
  },
  {
    id: 'adguard-home',
    displayName: 'AdGuard Home',
    icon: 'shield',
    groupHint: 'Network',
    matchers: ['adguard', 'adguard-home'],
    defaultScheme: 'http',
    defaultPorts: [3000],
  },
  {
    id: 'jenkins',
    displayName: 'Jenkins',
    icon: 'wrench',
    groupHint: 'Automation',
    matchers: ['jenkins'],
    defaultScheme: 'http',
    defaultPorts: [8080],
  },
  {
    id: 'grafana',
    displayName: 'Grafana',
    icon: 'chart',
    groupHint: 'Monitoring',
    matchers: ['grafana'],
    defaultScheme: 'http',
    defaultPorts: [3000],
  },
  {
    id: 'prometheus',
    displayName: 'Prometheus',
    icon: 'activity',
    groupHint: 'Monitoring',
    matchers: ['prometheus'],
    defaultScheme: 'http',
    defaultPorts: [9090],
  },
  {
    id: 'loki',
    displayName: 'Loki',
    icon: 'activity',
    groupHint: 'Monitoring',
    matchers: ['loki'],
    defaultScheme: 'http',
    defaultPorts: [3100],
  },
  {
    id: 'portainer',
    displayName: 'Portainer',
    icon: 'container',
    groupHint: 'Infrastructure',
    matchers: ['portainer'],
    defaultScheme: 'http',
    defaultPorts: [9000, 9443],
  },
  {
    id: 'proxmox',
    displayName: 'Proxmox',
    icon: 'server',
    groupHint: 'Infrastructure',
    matchers: ['proxmox', 'pve'],
    defaultScheme: 'https',
    defaultPorts: [8006],
  },
  {
    id: 'home-assistant',
    displayName: 'Home Assistant',
    icon: 'home',
    groupHint: 'Smart Home',
    matchers: ['homeassistant', 'home-assistant'],
    defaultScheme: 'http',
    defaultPorts: [8123],
  },
  {
    id: 'traefik',
    displayName: 'Traefik',
    icon: 'router',
    groupHint: 'Network',
    matchers: ['traefik'],
    defaultScheme: 'http',
    defaultPorts: [8080],
  },
  {
    id: 'gitea',
    displayName: 'Gitea',
    icon: 'git',
    groupHint: 'Dev',
    matchers: ['gitea'],
    defaultScheme: 'http',
    defaultPorts: [3000],
  },
  {
    id: 'gitlab',
    displayName: 'GitLab',
    icon: 'git',
    groupHint: 'Dev',
    matchers: ['gitlab'],
    defaultScheme: 'http',
    defaultPorts: [80],
  },
  {
    id: 'nextcloud',
    displayName: 'Nextcloud',
    icon: 'cloud',
    groupHint: 'Apps',
    matchers: ['nextcloud'],
    defaultScheme: 'http',
    defaultPorts: [80],
  },
  {
    id: 'minio',
    displayName: 'MinIO',
    icon: 'database',
    groupHint: 'Storage',
    matchers: ['minio'],
    defaultScheme: 'http',
    defaultPorts: [9001, 9000],
  },
  {
    id: 'n8n',
    displayName: 'n8n',
    icon: 'bot',
    groupHint: 'Automation',
    matchers: ['n8n'],
    defaultScheme: 'http',
    defaultPorts: [5678],
  },
];

// Manages user-customizable dashboard layout, widgets, and link suggestions.
@Injectable()
/**
 * Implements the links service class.
 */
export class LinksService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditService: AuditService,
  ) {}

  // Loads a user dashboard from ops memory and normalizes legacy widget formats.
  async getDashboard(userId: string) {
    const existing = await this.prisma.opsMemory.findUnique({
      where: {
        userId_key: {
          userId,
          key: linksMemoryKey,
        },
      },
    });

    const dashboard = existing
      ? this.parseDashboard(existing.value, makeDefaultDashboard())
      : makeDefaultDashboard();

    return {
      dashboard,
      knownIcons,
      groupColors: groupColorIds,
    };
  }

  // Validates and persists dashboard changes with explicit audit metadata.
  async updateDashboard(userId: string, input: unknown) {
    const parsed = updateDashboardSchema.safeParse(input);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.flatten());
    }

    const dashboard = prioritizeFavoritesGroup(normalizeLegacyWidgetKinds(parsed.data.dashboard));
    const tileCount = dashboard.groups.reduce((total, group) => total + group.tiles.length, 0);
    const widgetCount = dashboard.groups.reduce((total, group) => total + group.widgets.length, 0);

    const saved = await this.prisma.opsMemory.upsert({
      where: {
        userId_key: {
          userId,
          key: linksMemoryKey,
        },
      },
      update: {
        value: dashboard as Prisma.InputJsonValue,
      },
      create: {
        userId,
        key: linksMemoryKey,
        value: dashboard as Prisma.InputJsonValue,
      },
    });

    await this.auditService.write({
      actorUserId: userId,
      action: 'links.dashboard.update',
      targetType: 'ops_memory',
      targetId: saved.id,
      paramsJson: {
        groupCount: dashboard.groups.length,
        tileCount,
        widgetCount,
      },
      success: true,
    });

    return {
      dashboard,
      savedAt: saved.updatedAt.toISOString(),
      knownIcons,
      groupColors: groupColorIds,
    };
  }

  // Generates link suggestions from discovered services and known homelab apps.
  async listSuggestions() {
    const services = await this.prisma.service.findMany({
      orderBy: { name: 'asc' },
      select: {
        id: true,
        name: true,
        tags: true,
        source: true,
        instances: {
          orderBy: { name: 'asc' },
          select: {
            id: true,
            name: true,
            endpoint: true,
            host: {
              select: {
                hostname: true,
              },
            },
          },
        },
      },
    });

    return {
      generatedAt: new Date().toISOString(),
      suggestions: this.buildSuggestions(services),
      knownIcons,
    };
  }

  // Applies schema validation plus migration and default-seeding safeguards.
  private parseDashboard(value: Prisma.JsonValue, fallback: LinksDashboard) {
    const parsed = linksDashboardSchema.safeParse(value);
    if (!parsed.success) {
      return fallback;
    }

    const normalized = normalizeLegacyWidgetKinds(parsed.data);
    return prioritizeFavoritesGroup(ensureDashboardHasCoreWidgets(normalized, fallback));
  }

  // Builds deduplicated suggestion candidates from endpoint and inferred URLs.
  private buildSuggestions(services: ServiceSnapshot[]): LinkSuggestion[] {
    const seenUrls = new Set<string>();
    const suggestions: LinkSuggestion[] = [];

    for (const service of services) {
      const knownService = this.matchKnownService(service);
      const fallbackIcon = knownService?.icon ?? this.inferIcon(service);
      const groupHint = knownService?.groupHint ?? this.inferGroupHint(service);
      const title = knownService?.displayName ?? service.name;

      const candidates: SuggestionCandidate[] = [];
      for (const instance of service.instances) {
        if (!instance.endpoint) {
          continue;
        }

        const normalized = this.normalizeEndpointToUrl(
          instance.endpoint,
          knownService?.defaultPath,
        );
        if (!normalized) {
          continue;
        }

        const detail = instance.name.trim().length > 0 ? instance.name : service.name;
        candidates.push({
          url: normalized,
          description: `Discovered endpoint from ${detail}`,
          confidence: knownService ? 95 : 82,
          source: 'endpoint',
        });
      }

      if (candidates.length === 0 && knownService) {
        const hostnames = new Set<string>();
        for (const instance of service.instances) {
          const hostname = instance.host?.hostname?.trim();
          if (hostname) {
            hostnames.add(hostname);
          }
        }

        for (const hostname of hostnames) {
          const inferred = this.buildInferredUrl(hostname, knownService);
          if (!inferred) {
            continue;
          }

          candidates.push({
            url: inferred,
            description: `Inferred from ${knownService.displayName} on ${hostname}`,
            confidence: 68,
            source: 'inferred',
          });
        }
      }

      const uniqueCandidates = this.uniqueByUrl(candidates).slice(0, 2);
      for (const candidate of uniqueCandidates) {
        const dedupeKey = candidate.url.toLowerCase();
        if (seenUrls.has(dedupeKey)) {
          continue;
        }
        seenUrls.add(dedupeKey);

        suggestions.push({
          id: `${service.id}:${candidate.source}:${suggestions.length + 1}`,
          serviceId: service.id,
          serviceName: service.name,
          title,
          url: candidate.url,
          description: candidate.description,
          icon: fallbackIcon,
          groupHint,
          confidence: candidate.confidence,
          source: candidate.source,
        });
      }
    }

    suggestions.sort((left, right) => {
      if (left.confidence !== right.confidence) {
        return right.confidence - left.confidence;
      }
      return left.title.localeCompare(right.title);
    });

    return suggestions.slice(0, 120);
  }

  // URL-level dedupe helper so multiple instances do not spam same link.
  private uniqueByUrl(candidates: SuggestionCandidate[]) {
    const seen = new Set<string>();
    const unique: SuggestionCandidate[] = [];

    for (const candidate of candidates) {
      const key = candidate.url.toLowerCase();
      if (seen.has(key)) {
        continue;
      }

      seen.add(key);
      unique.push(candidate);
    }

    return unique;
  }

  // Normalizes endpoint input and enforces HTTP(S)-only dashboard links.
  private normalizeEndpointToUrl(rawEndpoint: string, defaultPath?: string) {
    const trimmed = rawEndpoint.trim();
    if (trimmed.length === 0) {
      return null;
    }

    const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed);
    const candidate = hasScheme ? trimmed : `http://${trimmed.replace(/^\/\//, '')}`;

    try {
      const parsed = new URL(candidate);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        return null;
      }

      if (defaultPath && (parsed.pathname === '/' || parsed.pathname.length === 0)) {
        parsed.pathname = normalizePath(defaultPath);
      }

      parsed.hash = '';

      const serialized = parsed.toString();
      if (parsed.pathname === '/' && serialized.endsWith('/')) {
        return serialized.slice(0, -1);
      }

      return serialized;
    } catch {
      return null;
    }
  }

  // Creates a best-effort URL from service defaults when endpoint is missing.
  private buildInferredUrl(hostname: string, service: KnownServiceDefinition) {
    const port = service.defaultPorts[0];
    if (port === undefined) {
      return null;
    }

    const path = service.defaultPath ? normalizePath(service.defaultPath) : '';
    const protocol = service.defaultScheme;
    const portPart = port === 80 && protocol === 'http' ? '' : `:${port}`;

    return `${protocol}://${hostname}${portPart}${path}`;
  }

  // Matches discovered service text against known service fingerprints.
  private matchKnownService(service: ServiceSnapshot): KnownServiceDefinition | null {
    const haystack = [
      service.name,
      service.source ?? '',
      ...service.tags,
      ...service.instances.map((instance) => instance.name),
    ]
      .join(' ')
      .toLowerCase();

    for (const knownService of knownServices) {
      const matched = knownService.matchers.some((matcher) => haystack.includes(matcher));
      if (matched) {
        return knownService;
      }
    }

    return null;
  }

  // Fallback icon inference for unknown services.
  private inferIcon(service: ServiceSnapshot): KnownIconId {
    const text = [service.name, ...service.tags].join(' ').toLowerCase();

    if (text.includes('db') || text.includes('postgres') || text.includes('mysql')) {
      return 'database';
    }
    if (text.includes('proxy') || text.includes('ingress')) {
      return 'router';
    }
    if (text.includes('kube') || text.includes('docker')) {
      return 'container';
    }
    if (text.includes('vpn') || text.includes('dns') || text.includes('firewall')) {
      return 'shield';
    }
    if (text.includes('monitor') || text.includes('metrics') || text.includes('observability')) {
      return 'chart';
    }
    if (text.includes('git') || text.includes('ci')) {
      return 'git';
    }
    if (text.includes('storage') || text.includes('nas') || text.includes('backup')) {
      return 'hard-drive';
    }

    return 'globe';
  }

  // Fallback grouping for unknown services.
  private inferGroupHint(service: ServiceSnapshot) {
    const text = [service.name, ...service.tags].join(' ').toLowerCase();
    if (text.includes('monitor') || text.includes('grafana') || text.includes('prometheus')) {
      return 'Monitoring';
    }
    if (text.includes('proxy') || text.includes('dns') || text.includes('network')) {
      return 'Network';
    }
    if (text.includes('storage') || text.includes('nas') || text.includes('backup')) {
      return 'Storage';
    }
    if (text.includes('git') || text.includes('ci') || text.includes('build')) {
      return 'Dev';
    }
    return 'Services';
  }
}

// Provides a starter dashboard so first-run users have actionable defaults.
function makeDefaultDashboard(): LinksDashboard {
  return {
    version: 1,
    settings: {
      columns: 4,
      tileSize: 'md',
      defaultOpenInNewTab: true,
    },
    groups: [
      {
        id: 'favorites',
        title: 'Favorites',
        color: 'slate',
        collapsed: false,
        tiles: [],
        widgets: [],
      },
      {
        id: 'overview',
        title: 'Overview',
        color: 'blue',
        collapsed: false,
        tiles: [],
        widgets: [
          {
            id: 'summary-hosts-online',
            kind: 'homelab-metric',
            title: 'Hosts Online',
            description: 'Healthy hosts currently reporting.',
            metric: 'hostsOnline',
            size: 'normal',
          },
          {
            id: 'summary-hosts-offline',
            kind: 'homelab-metric',
            title: 'Hosts Offline',
            description: 'Hosts currently degraded or disconnected.',
            metric: 'hostsOffline',
            size: 'normal',
          },
          {
            id: 'summary-active-alerts',
            kind: 'homelab-metric',
            title: 'Active Alerts',
            description: 'Open incidents requiring attention.',
            metric: 'activeAlerts',
            size: 'normal',
          },
          {
            id: 'summary-failing-checks',
            kind: 'homelab-metric',
            title: 'Failing Monitors',
            description: 'Monitors currently reporting down.',
            metric: 'failingChecks',
            size: 'normal',
          },
        ],
      },
      {
        id: 'operations',
        title: 'Operations',
        color: 'amber',
        collapsed: false,
        tiles: [],
        widgets: [
          {
            id: 'widget-whats-broken',
            kind: 'home-whats-broken',
            title: "What's Broken",
            description: 'Active alerts, down checks, and offline hosts.',
            size: 'wide',
          },
          {
            id: 'widget-recent-events',
            kind: 'home-recent-events',
            title: 'Recent Events',
            description: 'Latest events with severity context.',
            size: 'tall',
          },
          {
            id: 'widget-top-consumers',
            kind: 'home-top-consumers',
            title: 'Top Resource Consumers',
            description: 'Hosts with highest recent CPU/memory/disk usage.',
            size: 'wide',
          },
          {
            id: 'widget-ask-ai',
            kind: 'ai-chat',
            title: 'AI Question',
            description: 'Auto-runs a fixed question against current homelab context.',
            question: 'What should I look at first right now?',
            refreshIntervalSec: 300,
            size: 'wide',
          },
          {
            id: 'widget-dashboard-agent-highlights',
            kind: 'dashboard-agent-highlights',
            title: 'Dashboard Agent Highlights',
            description: 'Key findings from the latest Dashboard Agent run.',
            size: 'wide',
          },
        ],
      },
    ],
  };
}

/**
 * Implements prioritize favorites group.
 */
function prioritizeFavoritesGroup(dashboard: LinksDashboard): LinksDashboard {
  const favoritesIndex = dashboard.groups.findIndex((group) => group.id === 'favorites');
  if (favoritesIndex <= 0) {
    return dashboard;
  }

  const favorites = dashboard.groups[favoritesIndex];
  if (!favorites) {
    return dashboard;
  }
  const groups = dashboard.groups.filter((_, index) => index !== favoritesIndex);
  return {
    ...dashboard,
    groups: [favorites, ...groups],
  };
}

// Backfills critical home widgets when older layouts are missing them.
function ensureDashboardHasCoreWidgets(
  current: LinksDashboard,
  fallback: LinksDashboard,
): LinksDashboard {
  const hasCoreHomeWidgets = current.groups.some((group) =>
    (group.widgets ?? []).some(
      (widget) =>
        widget.kind === 'homelab-metric' ||
        widget.kind === 'home-summary-card' ||
        widget.kind === 'home-whats-broken' ||
        widget.kind === 'home-recent-events' ||
        widget.kind === 'home-top-consumers',
    ),
  );

  if (hasCoreHomeWidgets) {
    return current;
  }

  const seededGroups = fallback.groups
    .filter((group) => group.id === 'overview' || group.id === 'operations')
    .map((group) => ({
      ...group,
      tiles: [...group.tiles],
      widgets: [...group.widgets],
    }));

  const existingIds = new Set(seededGroups.map((group) => group.id));
  const migratedGroups = [
    ...seededGroups,
    ...current.groups.map((group, index) => {
      if (!existingIds.has(group.id)) {
        return group;
      }

      return {
        ...group,
        id: `${group.id}-${index + 1}`,
      };
    }),
  ];

  return {
    ...current,
    groups: migratedGroups,
  };
}

// Handles backward compatibility for renamed widget kinds and AI fields.
function normalizeLegacyWidgetKinds(dashboard: LinksDashboard): LinksDashboard {
  return {
    ...dashboard,
    groups: dashboard.groups.map((group) => ({
      ...group,
      widgets: (group.widgets ?? []).map((widget) =>
        widget.kind === 'home-summary-card'
          ? {
              id: widget.id,
              kind: 'homelab-metric' as const,
              title: widget.title,
              description: widget.description,
              metric: widget.metric,
              size: widget.size,
            }
          : widget.kind === 'ai-chat'
            ? normalizeAiQuestionWidget(widget)
            : widget,
      ),
    })),
  };
}

/**
 * Implements normalize ai question widget.
 */
function normalizeAiQuestionWidget(widget: {
  id: string;
  kind: 'ai-chat';
  title: string;
  description?: string;
  question?: string;
  refreshIntervalSec?: number | null;
  placeholder?: string;
  size: 'normal' | 'wide' | 'tall';
}) {
  // Converts legacy placeholder/title fields into canonical question settings.
  const question =
    widget.question?.trim() ||
    widget.placeholder?.trim() ||
    'What should I look at first right now?';

  const refreshIntervalSec =
    typeof widget.refreshIntervalSec === 'number' && Number.isFinite(widget.refreshIntervalSec)
      ? Math.max(0, Math.min(Math.trunc(widget.refreshIntervalSec), 86_400))
      : null;

  const title = widget.title?.trim().length > 0 ? widget.title : makeAiWidgetTitle(question);
  const description = widget.description?.trim().length
    ? widget.description
    : refreshIntervalSec && refreshIntervalSec > 0
      ? `Refreshes every ${refreshIntervalSec}s.`
      : 'Manual refresh only.';

  return {
    id: widget.id,
    kind: 'ai-chat' as const,
    title,
    description,
    question,
    refreshIntervalSec,
    size: widget.size,
  };
}

/**
 * Implements make ai widget title.
 */
function makeAiWidgetTitle(question: string) {
  const trimmed = question.trim();
  if (!trimmed) {
    return 'AI Question';
  }
  const singleLine = trimmed.replace(/\s+/g, ' ');
  return singleLine.length > 60 ? `${singleLine.slice(0, 57)}...` : singleLine;
}

/**
 * Implements normalize path.
 */
function normalizePath(path: string) {
  const trimmed = path.trim();
  if (trimmed.length === 0) {
    return '';
  }
  return trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
}
