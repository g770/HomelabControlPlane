/*
 * Copyright (c) 2026 Homelab Control Plane contributors
 * SPDX-License-Identifier: MIT
 *
 * This module implements the service discovery catalog logic for the repository.
 */
import { z } from 'zod';

/**
 * Describes the discovery probe protocol shape.
 */
export type DiscoveryProbeProtocol = 'http' | 'https' | 'tcp';

/**
 * Describes the discovery probe template shape.
 */
export type DiscoveryProbeTemplate = {
  protocol: DiscoveryProbeProtocol;
  ports: number[];
  path?: string;
  statusCodes?: number[];
  bodyContains?: string[];
  headersContain?: string[];
};

/**
 * Describes the service discovery signature shape.
 */
export type ServiceDiscoverySignature = {
  id: string;
  name: string;
  aliases: string[];
  systemdHints: string[];
  containerHints: string[];
  processHints: string[];
  tags: string[];
  probes: DiscoveryProbeTemplate[];
};

const probeTemplateSchema = z
  .object({
    protocol: z.enum(['http', 'https', 'tcp']),
    ports: z.array(z.number().int().min(1).max(65535)).min(1).max(20),
    path: z.string().max(256).optional(),
    statusCodes: z.array(z.number().int().min(100).max(599)).max(10).optional(),
    bodyContains: z.array(z.string().min(1).max(120)).max(12).optional(),
    headersContain: z.array(z.string().min(1).max(120)).max(12).optional(),
  })
  .strict();

/**
 * Implements service discovery signature schema.
 */
export const serviceDiscoverySignatureSchema = z
  .object({
    id: z.string().min(1).max(64),
    name: z.string().min(1).max(120),
    aliases: z.array(z.string().min(1).max(80)).max(20).default([]),
    systemdHints: z.array(z.string().min(1).max(80)).max(20).default([]),
    containerHints: z.array(z.string().min(1).max(120)).max(20).default([]),
    processHints: z.array(z.string().min(1).max(120)).max(20).default([]),
    tags: z.array(z.string().min(1).max(40)).max(10).default([]),
    probes: z.array(probeTemplateSchema).max(20).default([]),
  })
  .strict();

/**
 * Implements service discovery catalog envelope schema.
 */
export const serviceDiscoveryCatalogEnvelopeSchema = z
  .object({
    services: z.array(serviceDiscoverySignatureSchema).min(1).max(120),
  })
  .strict();

/**
 * Defines the builtin_discovery_signatures constant.
 */
export const BUILTIN_DISCOVERY_SIGNATURES: ServiceDiscoverySignature[] = [
  {
    id: 'pihole',
    name: 'Pi-hole',
    aliases: ['pi-hole', 'pihole'],
    systemdHints: ['pihole-FTL', 'pihole'],
    containerHints: ['pihole/pihole', 'pihole'],
    processHints: ['pihole-FTL'],
    tags: ['dns', 'adblock', 'network'],
    probes: [
      {
        protocol: 'http',
        ports: [80, 8080],
        path: '/admin',
        statusCodes: [200, 301, 302],
        bodyContains: ['pi-hole'],
      },
    ],
  },
  {
    id: 'jenkins',
    name: 'Jenkins',
    aliases: ['jenkins'],
    systemdHints: ['jenkins'],
    containerHints: ['jenkins/jenkins', 'jenkins'],
    processHints: ['jenkins.war', 'java -jar jenkins'],
    tags: ['ci', 'automation', 'dev'],
    probes: [
      {
        protocol: 'http',
        ports: [8080],
        path: '/login',
        statusCodes: [200, 403],
        bodyContains: ['jenkins'],
      },
    ],
  },
  {
    id: 'kasm',
    name: 'Kasm',
    aliases: ['kasm', 'kasmweb'],
    systemdHints: ['kasm'],
    containerHints: ['kasm', 'kasmweb'],
    processHints: ['kasm'],
    tags: ['workspace', 'remote-desktop'],
    probes: [
      {
        protocol: 'https',
        ports: [443],
        path: '/',
        statusCodes: [200, 302],
        bodyContains: ['kasm'],
      },
      {
        protocol: 'http',
        ports: [80],
        path: '/',
        statusCodes: [200, 301, 302],
        bodyContains: ['kasm'],
      },
    ],
  },
  {
    id: 'grafana',
    name: 'Grafana',
    aliases: ['grafana'],
    systemdHints: ['grafana-server', 'grafana'],
    containerHints: ['grafana/grafana', 'grafana'],
    processHints: ['grafana-server'],
    tags: ['monitoring', 'dashboard'],
    probes: [
      {
        protocol: 'http',
        ports: [3000],
        path: '/login',
        statusCodes: [200],
        bodyContains: ['grafana'],
      },
    ],
  },
  {
    id: 'prometheus',
    name: 'Prometheus',
    aliases: ['prometheus'],
    systemdHints: ['prometheus'],
    containerHints: ['prom/prometheus', 'prometheus'],
    processHints: ['prometheus'],
    tags: ['monitoring', 'metrics'],
    probes: [
      {
        protocol: 'http',
        ports: [9090],
        path: '/-/healthy',
        statusCodes: [200],
      },
    ],
  },
  {
    id: 'loki',
    name: 'Loki',
    aliases: ['loki'],
    systemdHints: ['loki'],
    containerHints: ['grafana/loki', 'loki'],
    processHints: ['loki'],
    tags: ['monitoring', 'logs'],
    probes: [
      {
        protocol: 'http',
        ports: [3100],
        path: '/ready',
        statusCodes: [200],
      },
    ],
  },
  {
    id: 'portainer',
    name: 'Portainer',
    aliases: ['portainer'],
    systemdHints: ['portainer'],
    containerHints: ['portainer/portainer', 'portainer-ce', 'portainer'],
    processHints: ['portainer'],
    tags: ['containers', 'operations'],
    probes: [
      {
        protocol: 'http',
        ports: [9000, 9443],
        path: '/',
        statusCodes: [200, 301, 302],
        bodyContains: ['portainer'],
      },
    ],
  },
  {
    id: 'traefik',
    name: 'Traefik',
    aliases: ['traefik'],
    systemdHints: ['traefik'],
    containerHints: ['traefik'],
    processHints: ['traefik'],
    tags: ['proxy', 'network'],
    probes: [
      {
        protocol: 'http',
        ports: [8080],
        path: '/dashboard/',
        statusCodes: [200, 401, 403],
      },
    ],
  },
  {
    id: 'gitea',
    name: 'Gitea',
    aliases: ['gitea'],
    systemdHints: ['gitea'],
    containerHints: ['gitea/gitea', 'gitea'],
    processHints: ['gitea'],
    tags: ['git', 'dev'],
    probes: [
      {
        protocol: 'http',
        ports: [3000],
        path: '/user/login',
        statusCodes: [200],
        bodyContains: ['gitea'],
      },
    ],
  },
  {
    id: 'nextcloud',
    name: 'Nextcloud',
    aliases: ['nextcloud'],
    systemdHints: ['nextcloud'],
    containerHints: ['nextcloud'],
    processHints: ['nextcloud'],
    tags: ['cloud', 'storage'],
    probes: [
      {
        protocol: 'http',
        ports: [80, 8080],
        path: '/status.php',
        statusCodes: [200],
      },
    ],
  },
  {
    id: 'home-assistant',
    name: 'Home Assistant',
    aliases: ['home assistant', 'home-assistant', 'hass'],
    systemdHints: ['home-assistant', 'hass'],
    containerHints: ['homeassistant/home-assistant', 'home-assistant'],
    processHints: ['homeassistant'],
    tags: ['smarthome'],
    probes: [
      {
        protocol: 'http',
        ports: [8123],
        path: '/',
        statusCodes: [200, 401],
        bodyContains: ['home assistant'],
      },
    ],
  },
  {
    id: 'minio',
    name: 'MinIO',
    aliases: ['minio'],
    systemdHints: ['minio'],
    containerHints: ['minio/minio', 'minio'],
    processHints: ['minio'],
    tags: ['storage', 's3'],
    probes: [
      {
        protocol: 'http',
        ports: [9000, 9001],
        path: '/minio/health/live',
        statusCodes: [200],
      },
    ],
  },
  {
    id: 'proxmox-ve',
    name: 'Proxmox VE',
    aliases: ['proxmox', 'pve'],
    systemdHints: ['pveproxy', 'pvedaemon'],
    containerHints: [],
    processHints: ['pveproxy', 'pvedaemon'],
    tags: ['virtualization', 'hypervisor'],
    probes: [
      {
        protocol: 'https',
        ports: [8006],
        path: '/',
        statusCodes: [200, 401],
        bodyContains: ['proxmox'],
      },
    ],
  },
  {
    id: 'proxmox-backup',
    name: 'Proxmox Backup Server',
    aliases: ['proxmox backup', 'pbs'],
    systemdHints: ['proxmox-backup-proxy', 'proxmox-backup'],
    containerHints: [],
    processHints: ['proxmox-backup-proxy', 'proxmox-backup'],
    tags: ['backup', 'storage'],
    probes: [
      {
        protocol: 'https',
        ports: [8007],
        path: '/',
        statusCodes: [200, 401],
        bodyContains: ['proxmox'],
      },
    ],
  },
  {
    id: 'jellyfin',
    name: 'Jellyfin',
    aliases: ['jellyfin'],
    systemdHints: ['jellyfin'],
    containerHints: ['jellyfin'],
    processHints: ['jellyfin'],
    tags: ['media', 'streaming'],
    probes: [
      {
        protocol: 'http',
        ports: [8096],
        path: '/',
        statusCodes: [200, 302],
        bodyContains: ['jellyfin'],
      },
      {
        protocol: 'https',
        ports: [8920],
        path: '/',
        statusCodes: [200, 302, 401],
        bodyContains: ['jellyfin'],
      },
    ],
  },
  {
    id: 'plex',
    name: 'Plex Media Server',
    aliases: ['plex', 'plex media server'],
    systemdHints: ['plexmediaserver'],
    containerHints: ['plex'],
    processHints: ['plex media server'],
    tags: ['media', 'streaming'],
    probes: [
      {
        protocol: 'http',
        ports: [32400],
        path: '/web',
        statusCodes: [200, 301, 302],
        bodyContains: ['plex'],
      },
    ],
  },
  {
    id: 'immich',
    name: 'Immich',
    aliases: ['immich'],
    systemdHints: [],
    containerHints: ['immich'],
    processHints: ['immich'],
    tags: ['photos', 'media'],
    probes: [
      {
        protocol: 'http',
        ports: [2283],
        path: '/',
        statusCodes: [200, 302],
        bodyContains: ['immich'],
      },
    ],
  },
  {
    id: 'frigate',
    name: 'Frigate',
    aliases: ['frigate'],
    systemdHints: [],
    containerHints: ['frigate'],
    processHints: ['frigate'],
    tags: ['nvr', 'security'],
    probes: [
      {
        protocol: 'http',
        ports: [5000],
        path: '/',
        statusCodes: [200, 302],
        bodyContains: ['frigate'],
      },
      {
        protocol: 'https',
        ports: [8971],
        path: '/',
        statusCodes: [200, 302, 401, 403],
        bodyContains: ['frigate'],
      },
    ],
  },
  {
    id: 'nginx-proxy-manager',
    name: 'Nginx Proxy Manager',
    aliases: ['nginx proxy manager', 'npm'],
    systemdHints: [],
    containerHints: ['nginx-proxy-manager', 'jc21/nginx-proxy-manager'],
    processHints: [],
    tags: ['proxy', 'network'],
    probes: [
      {
        protocol: 'http',
        ports: [81],
        path: '/login',
        statusCodes: [200, 301, 302],
        bodyContains: ['nginx proxy manager'],
      },
    ],
  },
  {
    id: 'navidrome',
    name: 'Navidrome',
    aliases: ['navidrome'],
    systemdHints: ['navidrome'],
    containerHints: ['navidrome'],
    processHints: ['navidrome'],
    tags: ['music', 'media'],
    probes: [
      {
        protocol: 'http',
        ports: [4533],
        path: '/',
        statusCodes: [200, 302],
        bodyContains: ['navidrome'],
      },
    ],
  },
  {
    id: 'paperless-ngx',
    name: 'Paperless-ngx',
    aliases: ['paperless', 'paperless-ngx'],
    systemdHints: [],
    containerHints: ['paperless-ngx'],
    processHints: ['paperless'],
    tags: ['documents', 'ocr'],
    probes: [
      {
        protocol: 'http',
        ports: [8000],
        path: '/api/schema/view/',
        statusCodes: [200, 302],
        bodyContains: ['paperless'],
      },
    ],
  },
  {
    id: 'adguard-home',
    name: 'AdGuard Home',
    aliases: ['adguard', 'adguard home'],
    systemdHints: ['adguardhome', 'adguard-home'],
    containerHints: ['adguard/adguardhome', 'adguardhome'],
    processHints: ['adguardhome'],
    tags: ['dns', 'adblock', 'network'],
    probes: [
      {
        protocol: 'http',
        ports: [3000],
        path: '/',
        statusCodes: [200],
        bodyContains: ['adguard'],
      },
    ],
  },
];

/**
 * Implements uniq strings.
 */
function uniqStrings(values: string[]) {
  const seen = new Set<string>();
  const next: string[] = [];
  for (const value of values) {
    const trimmed = value.trim();
    if (!trimmed) {
      continue;
    }
    const key = trimmed.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    next.push(trimmed);
  }
  return next;
}

/**
 * Implements dedupe probes.
 */
function dedupeProbes(probes: DiscoveryProbeTemplate[]) {
  const seen = new Set<string>();
  const next: DiscoveryProbeTemplate[] = [];
  for (const probe of probes) {
    const key = JSON.stringify({
      protocol: probe.protocol,
      ports: [...probe.ports].sort((a, b) => a - b),
      path: probe.path ?? '',
      statusCodes: [...(probe.statusCodes ?? [])].sort((a, b) => a - b),
      bodyContains: [...(probe.bodyContains ?? [])].sort(),
      headersContain: [...(probe.headersContain ?? [])].sort(),
    });
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    next.push(probe);
  }
  return next;
}

/**
 * Implements merge service discovery signatures.
 */
export function mergeServiceDiscoverySignatures(
  base: ServiceDiscoverySignature[],
  additions: ServiceDiscoverySignature[],
) {
  const merged = new Map<string, ServiceDiscoverySignature>();
  for (const item of base) {
    merged.set(item.id, {
      ...item,
      aliases: uniqStrings(item.aliases),
      systemdHints: uniqStrings(item.systemdHints),
      containerHints: uniqStrings(item.containerHints),
      processHints: uniqStrings(item.processHints),
      tags: uniqStrings(item.tags),
      probes: dedupeProbes(item.probes),
    });
  }

  for (const item of additions) {
    const current = merged.get(item.id);
    if (!current) {
      merged.set(item.id, {
        ...item,
        aliases: uniqStrings(item.aliases),
        systemdHints: uniqStrings(item.systemdHints),
        containerHints: uniqStrings(item.containerHints),
        processHints: uniqStrings(item.processHints),
        tags: uniqStrings(item.tags),
        probes: dedupeProbes(item.probes),
      });
      continue;
    }
    merged.set(item.id, {
      ...current,
      name: current.name || item.name,
      aliases: uniqStrings([...current.aliases, ...item.aliases]),
      systemdHints: uniqStrings([...current.systemdHints, ...item.systemdHints]),
      containerHints: uniqStrings([...current.containerHints, ...item.containerHints]),
      processHints: uniqStrings([...current.processHints, ...item.processHints]),
      tags: uniqStrings([...current.tags, ...item.tags]),
      probes: dedupeProbes([...current.probes, ...item.probes]),
    });
  }

  return Array.from(merged.values());
}
