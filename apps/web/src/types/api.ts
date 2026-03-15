/*
 * Copyright (c) 2026 Homelab Control Plane contributors
 * SPDX-License-Identifier: MIT
 *
 * This module implements the api logic for the repository.
 */
// Frontend API contracts used across dashboard, monitors, AI, and terminal UI.
export type HomeRecentEvent = {
  id: string;
  type: string;
  message: string;
  severity: 'INFO' | 'WARN' | 'ERROR' | 'CRIT' | string;
  hostId?: string | null;
  serviceId?: string | null;
  checkId?: string | null;
  payload?: Record<string, unknown> | null;
  createdAt?: string;
};

/**
 * Describes the home summary response shape.
 */
export type HomeSummaryResponse = {
  cards: {
    hostsOnline: number;
    hostsOffline: number;
    activeAlerts: number;
    failingChecks: number;
  };
  whatsBroken: {
    alerts: Array<Record<string, unknown>>;
    downChecks: Array<Record<string, unknown>>;
    offlineHosts: Array<Record<string, unknown>>;
  };
  recentEvents: HomeRecentEvent[];
  topConsumers: Array<Record<string, unknown>>;
};

/**
 * Describes the host summary shape.
 */
export type HostSummary = {
  id: string;
  hostname: string;
  hostIp: string | null;
};

/**
 * Describes the service summary shape.
 */
export type ServiceSummary = {
  id: string;
  name: string;
};

/**
 * Describes the alert severity shape.
 */
export type AlertSeverity = 'INFO' | 'WARN' | 'ERROR';
/**
 * Describes the alert incident state shape.
 */
export type AlertIncidentState = 'PENDING' | 'FIRING' | 'RESOLVED';
/**
 * Describes the alert comparator shape.
 */
export type AlertComparator = 'GT' | 'GTE' | 'LT' | 'LTE' | 'EQ' | 'NEQ';
/**
 * Describes the alert reducer shape.
 */
export type AlertReducer = 'latest' | 'avg' | 'min' | 'max';
/**
 * Describes the alert condition match shape.
 */
export type AlertConditionMatch = 'ALL' | 'ANY';
/**
 * Describes the alert scope entity shape.
 */
export type AlertScopeEntity = 'host' | 'check' | 'service' | 'homelab';
/**
 * Describes the alert host metric id shape.
 */
export type AlertHostMetricId = 'cpuPct' | 'memPct' | 'diskPct' | 'networkKbps' | 'diskIoOps';
/**
 * Describes the alert homelab metric id shape.
 */
export type AlertHomelabMetricId =
  | 'hostsOnline'
  | 'hostsOffline'
  | 'activeAlerts'
  | 'failingChecks';
/**
 * Describes the alert check mode shape.
 */
export type AlertCheckMode =
  | 'consecutive_failures'
  | 'failures_in_window'
  | 'latency_gt'
  | 'http_status_not';
/**
 * Describes the alert state target shape.
 */
export type AlertStateTarget = 'host_offline' | 'service_unhealthy' | 'check_down';

/**
 * Describes the alert scope shape.
 */
export type AlertScope = {
  entity: AlertScopeEntity;
  hostIds?: string[];
  serviceIds?: string[];
  checkIds?: string[];
  tags?: string[];
};

/**
 * Describes the alert host metric condition shape.
 */
export type AlertHostMetricCondition = {
  kind: 'host_metric';
  metric: AlertHostMetricId;
  comparator: AlertComparator;
  threshold: number;
  reducer: AlertReducer;
  windowMinutes: number;
};

/**
 * Describes the alert homelab metric condition shape.
 */
export type AlertHomelabMetricCondition = {
  kind: 'homelab_metric';
  metric: AlertHomelabMetricId;
  comparator: AlertComparator;
  threshold: number;
};

/**
 * Describes the alert check condition shape.
 */
export type AlertCheckCondition = {
  kind: 'check';
  mode: AlertCheckMode;
  status?: 'DOWN' | 'WARN' | 'UNKNOWN';
  threshold?: number;
  sampleSize?: number;
  expectedStatus?: number;
  windowMinutes?: number;
};

/**
 * Describes the alert state condition shape.
 */
export type AlertStateCondition = {
  kind: 'state';
  target: AlertStateTarget;
  staleMinutes?: number;
};

/**
 * Describes the alert event count condition shape.
 */
export type AlertEventCountCondition = {
  kind: 'event_count';
  comparator: AlertComparator;
  threshold: number;
  windowMinutes: number;
  eventType?: string;
  severity?: AlertSeverity | '';
};

/**
 * Describes the alert condition shape.
 */
export type AlertCondition =
  | AlertHostMetricCondition
  | AlertHomelabMetricCondition
  | AlertCheckCondition
  | AlertStateCondition
  | AlertEventCountCondition;

/**
 * Describes the alert rule spec shape.
 */
export type AlertRuleSpec = {
  scope: AlertScope;
  conditions: {
    match: AlertConditionMatch;
    items: AlertCondition[];
  };
  evaluation: {
    pendingMinutes: number;
    recoveryMinutes: number;
    noDataBehavior: 'KEEP_STATE' | 'RESOLVE' | 'ALERT';
  };
  severity: AlertSeverity;
  labels: Record<string, string>;
  delivery: {
    routeIds: string[];
    repeatMinutes: number;
    sendResolved: boolean;
  };
};

/**
 * Describes the alert rule record shape.
 */
export type AlertRuleRecord = {
  id: string;
  name: string;
  description: string | null;
  enabled: boolean;
  specVersion: number;
  type: string;
  spec: AlertRuleSpec;
  createdAt: string;
  updatedAt: string;
};

/**
 * Describes the alert rule mutation payload shape.
 */
export type AlertRuleMutationPayload = {
  confirm: true;
  name: string;
  description?: string;
  enabled: boolean;
  spec: AlertRuleSpec;
};

/**
 * Describes the alert rule draft shape.
 */
export type AlertRuleDraft = {
  name: string;
  description?: string;
  enabled: boolean;
  spec: AlertRuleSpec;
};

/**
 * Describes the alert incident shape.
 */
export type AlertIncident = {
  id: string;
  ruleId: string;
  ruleName: string;
  fingerprint: string;
  state: AlertIncidentState;
  severity: AlertSeverity;
  message: string;
  labels: Record<string, string>;
  values: Record<string, unknown>;
  startedAt: string;
  lastMatchedAt: string | null;
  lastEvaluatedAt: string;
  resolvedAt: string | null;
  acknowledgedAt: string | null;
  host?: {
    id: string;
    name: string;
  } | null;
  service?: {
    id: string;
    name: string;
  } | null;
  check?: {
    id: string;
    name: string;
  } | null;
};

/**
 * Describes the alert catalog metric option shape.
 */
export type AlertCatalogMetricOption<T extends string> = {
  id: T;
  label: string;
  description?: string;
};

/**
 * Describes the alert catalog response shape.
 */
export type AlertCatalogResponse = {
  scopes: AlertScopeEntity[];
  matchModes: AlertConditionMatch[];
  comparators: AlertComparator[];
  reducers: AlertReducer[];
  hostMetrics: AlertCatalogMetricOption<AlertHostMetricId>[];
  homelabMetrics: AlertCatalogMetricOption<AlertHomelabMetricId>[];
  stateTargets: AlertCatalogMetricOption<AlertStateTarget>[];
  checkModes: AlertCatalogMetricOption<AlertCheckMode>[];
  notificationRoutes: NotificationRouteSummary[];
  hosts: HostSummary[];
  services: ServiceSummary[];
  checks: Array<{
    id: string;
    name: string;
    hostId?: string | null;
    serviceId?: string | null;
  }>;
  ruleDefaults: AlertRuleDraft;
};

/**
 * Describes the alert preview incident shape.
 */
export type AlertPreviewIncident = {
  fingerprint: string;
  state: AlertIncidentState;
  message: string;
  severity: AlertSeverity;
  values: Record<string, unknown>;
  host?: {
    id?: string;
    name: string;
  } | null;
  service?: {
    id?: string;
    name: string;
  } | null;
  check?: {
    id?: string;
    name: string;
  } | null;
};

/**
 * Describes the alert preview response shape.
 */
export type AlertPreviewResponse = {
  evaluatedAt: string;
  summary: {
    candidateCount: number;
    matchedCount: number;
    pendingCount: number;
    firingCount: number;
  };
  incidents: AlertPreviewIncident[];
};

/**
 * Describes the alert incidents response shape.
 */
export type AlertIncidentsResponse = {
  incidents: AlertIncident[];
};

/**
 * Describes the alert rules response shape.
 */
export type AlertRulesResponse = {
  rules: AlertRuleRecord[];
};

/**
 * Describes the alert parse response shape.
 */
export type AlertParseResponse = {
  aiEnabled: boolean;
  generatedByAi: boolean;
  warnings: string[];
  rationale?: string | null;
  confidence?: number | null;
  draft: AlertRuleDraft;
};

/**
 * Describes the integration summary shape.
 */
export type IntegrationSummary = {
  id: string;
  name: string;
  type: string;
  enabled?: boolean;
  config?: Record<string, unknown>;
  lastStatus?: string | null;
  lastError?: string | null;
  lastSyncAt?: string | null;
};

/**
 * Describes the integration delete response shape.
 */
export type IntegrationDeleteResponse = {
  ok: true;
  integrationId: string;
  deletedServiceCount: number;
  deletedServiceInstanceCount: number;
  deletedHostCount: number;
};

/**
 * Describes the notification route summary shape.
 */
export type NotificationRouteSummary = {
  id: string;
  name?: string;
  type?: string;
};

/**
 * Describes the ai provider config response shape.
 */
export type AiProviderConfigResponse = {
  configured: boolean;
  model: string;
  updatedAt: string | null;
};

/**
 * Describes the enrollment token shape.
 */
export type EnrollmentToken = {
  id: string;
  expiresAt: string;
  revokedAt: string | null;
};

/**
 * Describes the agent summary shape.
 */
export type AgentSummary = {
  id: string;
  status: string;
  hostId: string | null;
  revokedAt: string | null;
  displayName: string | null;
  lastSeenAt: string | null;
  host?: {
    id: string;
    hostname: string;
    tags?: unknown;
  } | null;
};

/**
 * Describes the agent recovery claim status shape.
 */
export type AgentRecoveryClaimStatus =
  | 'PENDING_APPROVAL'
  | 'APPROVED_PENDING_AGENT'
  | 'DENIED'
  | 'COMPLETED';

/**
 * Describes the agent recovery claim actor shape.
 */
export type AgentRecoveryClaimActor = {
  id: string;
  email: string;
  displayName: string;
};

/**
 * Describes the agent recovery linked agent shape.
 */
export type AgentRecoveryLinkedAgent = {
  id: string;
  hostId: string | null;
  status: string;
  revokedAt: string | null;
};

/**
 * Describes the agent recovery claim shape.
 */
export type AgentRecoveryClaim = {
  id: string;
  recoveryKeyAlg: string;
  recoveryKeyFingerprint: string;
  hostname: string;
  primaryIp: string | null;
  displayName: string | null;
  endpoint: string;
  mcpEndpoint: string;
  agentVersion: string | null;
  tags: string[];
  status: AgentRecoveryClaimStatus;
  denialReason: string | null;
  firstSeenAt: string;
  lastSeenAt: string;
  approvedAt: string | null;
  deniedAt: string | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
  agent: AgentRecoveryLinkedAgent | null;
  approvedBy: AgentRecoveryClaimActor | null;
  deniedBy: AgentRecoveryClaimActor | null;
};

/**
 * Describes the agent recovery claim list response shape.
 */
export type AgentRecoveryClaimListResponse = {
  claims: AgentRecoveryClaim[];
};

/**
 * Describes the agent recovery summary preview item shape.
 */
export type AgentRecoverySummaryPreviewItem = {
  id: string;
  label: string;
  hostname: string;
  lastSeenAt: string;
};

/**
 * Describes the agent recovery summary response shape.
 */
export type AgentRecoverySummaryResponse = {
  pendingApprovalCount: number;
  pendingApprovalFingerprint: string | null;
  pendingClaimsPreview: AgentRecoverySummaryPreviewItem[];
};

/**
 * Describes the agent recovery claim approve payload shape.
 */
export type AgentRecoveryClaimApprovePayload = {
  confirm: true;
};

/**
 * Describes the agent recovery claim deny payload shape.
 */
export type AgentRecoveryClaimDenyPayload = {
  confirm: true;
  reason: string;
};

/**
 * Describes the check detail shape.
 */
export type CheckDetail = {
  id: string;
  name: string;
  type: string;
  target: string;
  intervalSec: number;
  timeoutMs: number;
};

/**
 * Describes the check history entry shape.
 */
export type CheckHistoryEntry = {
  id: string;
  status: string;
  checkedAt: string;
  latencyMs: number | null;
  httpStatus: number | null;
  errorMessage: string | null;
};

/**
 * Describes the service detail event shape.
 */
export type ServiceDetailEvent = {
  id: string;
  type: string;
  message: string;
};

/**
 * Describes the service detail instance shape.
 */
export type ServiceDetailInstance = {
  id: string;
  name: string;
  endpoint: string | null;
  host?: {
    hostname?: string;
  } | null;
  metadata?: Record<string, unknown>;
};

/**
 * Describes the service detail shape.
 */
export type ServiceDetail = {
  id: string;
  name: string;
  status: string;
  source?: string;
  tags?: string[];
  instances?: ServiceDetailInstance[];
  events?: ServiceDetailEvent[];
};

/**
 * Describes the monitor type shape.
 */
export type MonitorType = 'HTTP' | 'TCP' | 'ICMP';

/**
 * Describes the monitor definition shape.
 */
export type MonitorDefinition = {
  name: string;
  type: MonitorType;
  target: string;
  expectedStatus?: number;
  intervalSec: number;
  timeoutMs: number;
  keyword?: string;
  enabled: boolean;
  hostId?: string;
  serviceId?: string;
};

/**
 * Describes the monitor parse response shape.
 */
export type MonitorParseResponse = {
  aiEnabled: boolean;
  generatedByAi: boolean;
  warnings: string[];
  monitor: MonitorDefinition;
  rationale?: string | null;
  confidence?: number | null;
};

/**
 * Describes the monitor suggestion shape.
 */
export type MonitorSuggestion = MonitorDefinition & {
  id: string;
  rationale?: string;
  confidence?: number;
};

/**
 * Describes the monitor suggestions response shape.
 */
export type MonitorSuggestionsResponse = {
  generatedAt: string;
  aiEnabled: boolean;
  generatedByAi: boolean;
  warnings: string[];
  suggestions: MonitorSuggestion[];
};

/**
 * Describes the agent install action shape.
 */
export type AgentInstallAction = 'INSTALL' | 'ROLLBACK';
/**
 * Describes the agent install status shape.
 */
export type AgentInstallStatus =
  | 'PENDING_APPROVAL'
  | 'APPROVED_AWAITING_EXECUTION'
  | 'RUNNING'
  | 'SUCCEEDED'
  | 'FAILED'
  | 'DENIED';
/**
 * Describes the agent install auth mode shape.
 */
export type AgentInstallAuthMode = 'KEY' | 'PASSWORD';

/**
 * Describes the agent install request log shape.
 */
export type AgentInstallRequestLog = {
  id: string;
  seq: number;
  phase: string;
  level: string;
  message: string;
  createdAt: string;
};

/**
 * Describes the agent install request shape.
 */
export type AgentInstallRequest = {
  id: string;
  action: AgentInstallAction;
  status: AgentInstallStatus;
  requestedByUserId: string;
  approvedByUserId: string | null;
  deniedByUserId: string | null;
  targetHostId: string | null;
  targetHost: string;
  targetPort: number;
  targetUsername: string;
  authMode: AgentInstallAuthMode;
  binaryVersion: string;
  binaryUrlResolved: string | null;
  controlPlaneUrl: string;
  mcpBind: string;
  mcpPort: number;
  mcpAdvertiseUrl: string;
  allowedOrigins: string;
  allowInsecureDev: boolean;
  replaceExisting: boolean;
  installPath: string;
  serviceName: string;
  rollbackOfRequestId: string | null;
  resultCode: string | null;
  resultSummary: string | null;
  errorMessageSanitized: string | null;
  agentIdLinked: string | null;
  approvedAt: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  deniedAt: string | null;
  createdAt: string;
  updatedAt: string;
  logs?: AgentInstallRequestLog[];
};

/**
 * Describes the agent install list response shape.
 */
export type AgentInstallListResponse = {
  requests: AgentInstallRequest[];
};

/**
 * Describes the agent install launch response shape.
 */
export type AgentInstallLaunchResponse = {
  ok: boolean;
  queued: boolean;
  requestId: string;
  alreadyLaunched?: boolean;
  currentStatus?: AgentInstallStatus;
};

/**
 * Describes the agent install binary manifest item shape.
 */
export type AgentInstallBinaryManifestItem = {
  version: string;
  platform: 'linux-amd64' | 'linux-arm64';
  available: boolean;
};

/**
 * Describes the agent install binary manifest response shape.
 */
export type AgentInstallBinaryManifestResponse = {
  enabled: boolean;
  source: 'CONTAINER_STORE';
  storeRootConfigured: boolean;
  defaultVersion: string;
  binaries: AgentInstallBinaryManifestItem[];
};

/**
 * Describes the sidebar nav item id shape.
 */
export type SidebarNavItemId =
  | 'dashboard'
  | 'dashboard-agent'
  | 'hosts'
  | 'proxmox'
  | 'network-monitors'
  | 'alerts'
  | 'service-discovery'
  | 'agent-management'
  | 'ai'
  | 'settings';

/**
 * Describes the proxmox integration summary shape.
 */
export type ProxmoxIntegrationSummary = {
  id: string;
  name: string;
  type: 'PROXMOX';
  enabled: boolean;
  baseUrl: string;
  apiTokenId?: string | null;
  hasApiTokenSecret?: boolean;
  allowInsecureTls: boolean;
  lastStatus?: string | null;
  lastError?: string | null;
  lastSyncAt?: string | null;
  createdAt?: string;
  updatedAt?: string;
};

/**
 * Describes the proxmox guest kind shape.
 */
export type ProxmoxGuestKind = 'qemu' | 'lxc';
/**
 * Describes the proxmox guest action shape.
 */
export type ProxmoxGuestAction = 'start' | 'shutdown' | 'stop' | 'reboot';

/**
 * Describes the proxmox guest summary shape.
 */
export type ProxmoxGuestSummary = {
  id: string;
  kind: ProxmoxGuestKind;
  vmid: number;
  name: string;
  node: string;
  status: string;
  template: boolean;
  locked: boolean;
  tags: string[];
  cpu?: number | null;
  maxCpu?: number | null;
  memoryBytes?: number | null;
  maxMemoryBytes?: number | null;
  diskBytes?: number | null;
  maxDiskBytes?: number | null;
  uptimeSeconds?: number | null;
};

/**
 * Describes the proxmox guest inventory response shape.
 */
export type ProxmoxGuestInventoryResponse = {
  integration: ProxmoxIntegrationSummary;
  guests: ProxmoxGuestSummary[];
  summary: {
    total: number;
    running: number;
    stopped: number;
    qemu: number;
    lxc: number;
  };
  filters: {
    nodes: string[];
  };
};

/**
 * Describes the proxmox guest detail shape.
 */
export type ProxmoxGuestDetail = ProxmoxGuestSummary & {
  rawStatus: Record<string, unknown>;
  rawConfig: Record<string, unknown>;
  displayConfig: Array<{
    label: string;
    value: string;
  }>;
};

/**
 * Describes the proxmox guest detail response shape.
 */
export type ProxmoxGuestDetailResponse = {
  integration: ProxmoxIntegrationSummary;
  guest: ProxmoxGuestDetail;
};

/**
 * Describes the proxmox task summary shape.
 */
export type ProxmoxTaskSummary = {
  upid: string;
  node: string;
  status?: string | null;
  exitStatus?: string | null;
  type?: string | null;
  user?: string | null;
  startedAt?: string | null;
  endedAt?: string | null;
  description?: string | null;
};

/**
 * Describes the proxmox guest tasks response shape.
 */
export type ProxmoxGuestTasksResponse = {
  integration: ProxmoxIntegrationSummary;
  tasks: ProxmoxTaskSummary[];
};

/**
 * Describes the proxmox guest action request shape.
 */
export type ProxmoxGuestActionRequest = {
  confirm: true;
};

/**
 * Describes the proxmox guest action response shape.
 */
export type ProxmoxGuestActionResponse = {
  ok: true;
  upid: string;
};

/**
 * Describes the sidebar navigation preferences shape.
 */
export type SidebarNavigationPreferences = {
  orderedItemIds: SidebarNavItemId[];
};

/**
 * Describes the user preferences shape.
 */
export type UserPreferences = {
  hiddenHostIds: string[];
  discoverySubnets: string[];
  hostListColumns: {
    hiddenColumnIds: Array<
      | 'ip'
      | 'tags'
      | 'type'
      | 'status'
      | 'cpu'
      | 'mem'
      | 'disk'
      | 'lastSeen'
      | 'agentVersion'
      | 'visibility'
    >;
    widths: Array<{
      id:
        | 'index'
        | 'hostname'
        | 'ip'
        | 'tags'
        | 'type'
        | 'status'
        | 'cpu'
        | 'mem'
        | 'disk'
        | 'lastSeen'
        | 'agentVersion'
        | 'visibility'
        | 'terminal';
      widthPx: number;
    }>;
  };
  dashboardSuggestionsNotice: {
    dismissedFingerprint: string | null;
  };
  dashboardOrphanRecoveryNotice: {
    dismissedFingerprint: string | null;
  };
  sidebarNavigation: SidebarNavigationPreferences;
};

/**
 * Describes the user preferences response shape.
 */
export type UserPreferencesResponse = {
  preferences: UserPreferences;
  updatedAt: string | null;
};

/**
 * Describes the sidebar navigation update payload shape.
 */
export type SidebarNavigationUpdatePayload = {
  confirm: true;
  orderedItemIds: SidebarNavItemId[];
};

/**
 * Describes the service discovery run subnet scan options shape.
 */
export type ServiceDiscoveryRunSubnetScanOptions = {
  enabled?: boolean;
  cidrs?: string[];
  includeAutoLocalCidrs?: boolean;
  includeCommonWebPorts?: boolean;
  maxHosts?: number;
  concurrency?: number;
  connectTimeoutMs?: number;
  toolCallTimeoutMs?: number;
};

/**
 * Describes the service discovery config shape.
 */
export type ServiceDiscoveryConfig = {
  enabled: boolean;
  cidrs: string[];
  includeAutoLocalCidrs: boolean;
  includeCommonWebPorts: boolean;
  maxHosts: number;
  concurrency: number;
  connectTimeoutMs: number;
  toolCallTimeoutMs: number;
};

/**
 * Describes the service discovery config response shape.
 */
export type ServiceDiscoveryConfigResponse = {
  config: ServiceDiscoveryConfig;
  intervalSec: number;
  nextScheduledRunAt: string;
  lastRunAt: string | null;
  isRunning: boolean;
  updatedAt: string;
};

/**
 * Describes the service discovery config update payload shape.
 */
export type ServiceDiscoveryConfigUpdatePayload = {
  confirm: true;
  config: ServiceDiscoveryConfig;
};

/**
 * Describes the service discovery run request payload shape.
 */
export type ServiceDiscoveryRunRequestPayload = {
  confirm: true;
  hostId?: string;
};

/**
 * Describes the service discovery run delete shape.
 */
export type ServiceDiscoveryRunDelete = {
  confirm: true;
};

/**
 * Describes the service discovery run summary shape.
 */
export type ServiceDiscoveryRunSummary = {
  hostCount: number;
  probeCount: number;
  detectedCount: number;
  upsertCount: number;
  errors: number;
  verification?: {
    hostsChecked: number;
    hostsUp: number;
    hostsDown: number;
    hostsSkipped: number;
    servicesChecked: number;
    servicesUp: number;
    servicesDown: number;
    servicesSkipped: number;
    errors: number;
  };
  appliedConfig?: {
    subnetScan: ServiceDiscoveryConfig;
  };
  subnet?: {
    scannerAgents: number;
    cidrCount: number;
    hostsScanned: number;
    hostsReachable: number;
    detections: number;
    upserts: number;
    warnings: string[];
  };
};

/**
 * Describes the service discovery run progress shape.
 */
export type ServiceDiscoveryRunProgress = {
  stage: string;
  selectedHosts: number;
  scannedHosts: number;
  probes: number;
  subnetIpsProbed: number;
  subnetIpsUnique: number;
  subnetIpsReachable: number;
  detections: number;
  upserts: number;
  errors: number;
};

/**
 * Describes the service discovery run console entry shape.
 */
export type ServiceDiscoveryRunConsoleEntry = {
  seq: number;
  timestamp: string;
  level: string;
  message: string;
};

/**
 * Describes the service discovery run console snapshot shape.
 */
export type ServiceDiscoveryRunConsoleSnapshot = {
  entries: ServiceDiscoveryRunConsoleEntry[];
  truncated: boolean;
  lastSeq?: number;
  updatedAt?: string;
};

/**
 * Describes the service discovery run host detection shape.
 */
export type ServiceDiscoveryRunHostDetection = {
  signatureId: string;
  confidence: number;
  endpoint: string | null;
  passive: Record<string, unknown>;
  probeEvidence: {
    attempted?: number;
    matched?: number;
  };
};

/**
 * Describes the service discovery run host result shape.
 */
export type ServiceDiscoveryRunHostResult = {
  hostId: string;
  hostName: string;
  detections: ServiceDiscoveryRunHostDetection[];
  errors: string[];
};

/**
 * Describes the service discovery run subnet detection shape.
 */
export type ServiceDiscoveryRunSubnetDetection = {
  ip: string;
  hostname: string | null;
  serviceId: string;
  serviceName: string;
  endpoint: string | null;
  confidence: number;
  source: 'signature' | 'common-web' | string;
  tags: string[];
  evidence: Record<string, unknown>;
};

/**
 * Describes the service discovery run subnet result shape.
 */
export type ServiceDiscoveryRunSubnetResult = {
  agentId: string;
  hostId: string;
  hostName: string;
  cidrs: string[];
  hostsScanned: number;
  hostsReachable: number;
  detections: ServiceDiscoveryRunSubnetDetection[];
  warnings: string[];
};

/**
 * Describes the service discovery run persisted summary shape.
 */
export type ServiceDiscoveryRunPersistedSummary = {
  summary?: ServiceDiscoveryRunSummary;
  hosts?: ServiceDiscoveryRunHostResult[];
  subnet?: ServiceDiscoveryRunSubnetResult[];
  progress?: ServiceDiscoveryRunProgress;
  console?: ServiceDiscoveryRunConsoleSnapshot;
};

/**
 * Describes the service discovery run history summary shape.
 */
export type ServiceDiscoveryRunHistorySummary =
  | ServiceDiscoveryRunPersistedSummary
  | Record<string, unknown>
  | Array<unknown>
  | string
  | number
  | boolean
  | null;

/**
 * Describes the service discovery run response shape.
 */
export type ServiceDiscoveryRunResponse = {
  runId: string;
  status: 'COMPLETED' | 'FAILED';
  startedAt: string;
  finishedAt: string;
  trigger: 'SCHEDULE' | 'MANUAL';
  summary: ServiceDiscoveryRunSummary;
};

/**
 * Describes the service discovery run history item shape.
 */
export type ServiceDiscoveryRunHistoryItem = {
  id: string;
  trigger: 'SCHEDULE' | 'MANUAL';
  triggeredByUserId: string | null;
  startedAt: string;
  finishedAt: string | null;
  status: 'RUNNING' | 'COMPLETED' | 'FAILED';
  hostCount: number;
  probeCount: number;
  detectedCount: number;
  upsertCount: number;
  errorCount: number;
  error: string | null;
  summary: ServiceDiscoveryRunHistorySummary;
};

/**
 * Describes the service discovery run history response shape.
 */
export type ServiceDiscoveryRunHistoryResponse = {
  runs: ServiceDiscoveryRunHistoryItem[];
};

/**
 * Describes the service discovery run delete response shape.
 */
export type ServiceDiscoveryRunDeleteResponse = {
  ok: true;
  deleted: true;
  runId: string;
};

/**
 * Describes the service discovery catalog response shape.
 */
export type ServiceDiscoveryCatalogResponse = {
  id: string;
  source: 'BUILTIN' | 'HYBRID';
  expiresAt: string;
  lastError: string | null;
  serviceCount: number;
  services: Array<{
    id: string;
    name: string;
    aliases: string[];
    systemdHints: string[];
    containerHints: string[];
    processHints: string[];
    tags: string[];
    probes: Array<{
      protocol: 'http' | 'https' | 'tcp';
      ports: number[];
      path?: string;
      statusCodes?: number[];
      bodyContains?: string[];
      headersContain?: string[];
    }>;
  }>;
};

/**
 * Describes the dashboard agent finding severity shape.
 */
export type DashboardAgentFindingSeverity = 'info' | 'warn' | 'critical';
/**
 * Describes the dashboard agent finding category shape.
 */
export type DashboardAgentFindingCategory =
  | 'monitor'
  | 'host'
  | 'service-discovery'
  | 'event'
  | 'ai-activity'
  | 'system';

/**
 * Describes the dashboard agent highlight shape.
 */
export type DashboardAgentHighlight = {
  id: string;
  title: string;
  summary: string;
  severity: DashboardAgentFindingSeverity;
  category: DashboardAgentFindingCategory;
  confidence: number;
  evidence: string[];
  investigation: string[];
  recommendedActions: string[];
  references?: {
    hostId?: string;
    monitorId?: string;
    discoveryRunId?: string;
  };
  eventEmitted?: boolean;
};

/**
 * Describes the dashboard agent run summary shape.
 */
export type DashboardAgentRunSummary = {
  analyzedAt: string;
  context: {
    hosts: number;
    monitors: number;
    services: number;
    activeAlerts: number;
    discoveryRunsReviewed: number;
    aiQuestionsReviewed: number;
    eventsReviewed: number;
  };
  notes: string[];
  toolCalls: Array<{
    tool: string;
    ok: boolean;
    details?: string;
  }>;
  openAiCalls: DashboardAgentOpenAiCall[];
};

/**
 * Describes the dashboard agent open ai call status shape.
 */
export type DashboardAgentOpenAiCallStatus = 'completed' | 'invalid_output' | 'failed';

/**
 * Describes the dashboard agent open ai usage shape.
 */
export type DashboardAgentOpenAiUsage = {
  inputTokens: number | null;
  outputTokens: number | null;
  reasoningTokens: number | null;
  totalTokens: number | null;
};

/**
 * Describes the dashboard agent open ai call shape.
 */
export type DashboardAgentOpenAiCall = {
  id: string;
  step: string;
  model: string;
  status: DashboardAgentOpenAiCallStatus;
  startedAt: string;
  finishedAt: string | null;
  durationMs: number | null;
  requestPayload: unknown | null;
  responsePayload: unknown | null;
  outputText: string | null;
  reasoningSummary: string[];
  usage: DashboardAgentOpenAiUsage | null;
  error: string | null;
};

/**
 * Describes the dashboard agent run history item shape.
 */
export type DashboardAgentRunHistoryItem = {
  id: string;
  trigger: 'SCHEDULE' | 'MANUAL';
  triggeredByUserId: string | null;
  startedAt: string;
  finishedAt: string | null;
  status: 'RUNNING' | 'COMPLETED' | 'FAILED';
  findingCount: number;
  highPriorityCount: number;
  highlights: DashboardAgentHighlight[] | null;
  error: string | null;
  summary: DashboardAgentRunSummary | Record<string, unknown> | null;
};

/**
 * Describes the dashboard agent runs response shape.
 */
export type DashboardAgentRunsResponse = {
  runs: DashboardAgentRunHistoryItem[];
};

/**
 * Describes the dashboard agent run detail response shape.
 */
export type DashboardAgentRunDetailResponse = {
  run: DashboardAgentRunHistoryItem;
};

/**
 * Describes the dashboard agent run delete shape.
 */
export type DashboardAgentRunDelete = {
  confirm: true;
};

/**
 * Describes the dashboard agent run delete response shape.
 */
export type DashboardAgentRunDeleteResponse = {
  ok: true;
  deleted: true;
  runId: string;
};

/**
 * Describes the dashboard agent config shape.
 */
export type DashboardAgentConfig = {
  enabled: boolean;
  intervalSec: number;
  escalateCreateEvents: boolean;
  personality: string;
};

/**
 * Describes the dashboard agent config response shape.
 */
export type DashboardAgentConfigResponse = {
  config: DashboardAgentConfig;
  defaultPersonality: string;
  nextScheduledRunAt: string | null;
  lastRunAt: string | null;
  isRunning: boolean;
  updatedAt: string;
};

/**
 * Describes the dashboard agent status response shape.
 */
export type DashboardAgentStatusResponse = {
  enabled: boolean;
  intervalSec: number;
  isRunning: boolean;
  nextScheduledRunAt: string | null;
  lastRunAt: string | null;
  lastRunId: string | null;
  lastRunStatus: 'RUNNING' | 'COMPLETED' | 'FAILED' | null;
};

/**
 * Describes the dashboard agent highlights response shape.
 */
export type DashboardAgentHighlightsResponse = {
  runId: string | null;
  status: 'RUNNING' | 'COMPLETED' | 'FAILED' | null;
  generatedAt: string | null;
  highlights: DashboardAgentHighlight[];
};

/**
 * Describes the known link icon id shape.
 */
export type KnownLinkIconId =
  | 'globe'
  | 'shield'
  | 'wrench'
  | 'chart'
  | 'activity'
  | 'server'
  | 'network'
  | 'hard-drive'
  | 'home'
  | 'container'
  | 'git'
  | 'cloud'
  | 'database'
  | 'router'
  | 'terminal'
  | 'bot';

/**
 * Describes the link group color id shape.
 */
export type LinkGroupColorId = 'slate' | 'blue' | 'teal' | 'emerald' | 'amber' | 'rose' | 'violet';
/**
 * Describes the link tile size id shape.
 */
export type LinkTileSizeId = 'sm' | 'md' | 'lg';

/**
 * Describes the link tile shape.
 */
export type LinkTile = {
  id: string;
  title: string;
  url: string;
  description?: string;
  icon: KnownLinkIconId;
  openInNewTab: boolean;
};

/**
 * Describes the link widget metric id shape.
 */
export type LinkWidgetMetricId = 'cpu' | 'mem' | 'disk' | 'network' | 'diskIo';
/**
 * Describes the link widget size id shape.
 */
export type LinkWidgetSizeId = 'normal' | 'wide' | 'tall';
/**
 * Describes the home summary metric id shape.
 */
export type HomeSummaryMetricId = 'hostsOnline' | 'hostsOffline' | 'activeAlerts' | 'failingChecks';
/**
 * Describes the homelab metric id shape.
 */
export type HomelabMetricId = HomeSummaryMetricId;

/**
 * Describes the host metric widget shape.
 */
export type HostMetricWidget = {
  id: string;
  kind: 'host-metric';
  title: string;
  description?: string;
  hostId: string;
  hostName: string;
  metric: LinkWidgetMetricId;
  size: LinkWidgetSizeId;
};

/**
 * Describes the host terminal widget shape.
 */
export type HostTerminalWidget = {
  id: string;
  kind: 'host-terminal';
  title: string;
  description?: string;
  hostId: string;
  hostName: string;
  size: LinkWidgetSizeId;
};

/**
 * Describes the homelab metric widget shape.
 */
export type HomelabMetricWidget = {
  id: string;
  kind: 'homelab-metric';
  title: string;
  description?: string;
  metric: HomelabMetricId;
  size: LinkWidgetSizeId;
};

/**
 * Describes the home summary card widget shape.
 */
export type HomeSummaryCardWidget = {
  id: string;
  kind: 'home-summary-card';
  title: string;
  description?: string;
  metric: HomeSummaryMetricId;
  size: LinkWidgetSizeId;
};

/**
 * Describes the home whats broken widget shape.
 */
export type HomeWhatsBrokenWidget = {
  id: string;
  kind: 'home-whats-broken';
  title: string;
  description?: string;
  size: LinkWidgetSizeId;
};

/**
 * Describes the home recent events widget shape.
 */
export type HomeRecentEventsWidget = {
  id: string;
  kind: 'home-recent-events';
  title: string;
  description?: string;
  size: LinkWidgetSizeId;
};

/**
 * Describes the home top consumers widget shape.
 */
export type HomeTopConsumersWidget = {
  id: string;
  kind: 'home-top-consumers';
  title: string;
  description?: string;
  size: LinkWidgetSizeId;
};

/**
 * Describes the ai chat widget shape.
 */
export type AiChatWidget = {
  id: string;
  kind: 'ai-chat';
  title: string;
  description?: string;
  question: string;
  refreshIntervalSec?: number | null;
  size: LinkWidgetSizeId;
};

/**
 * Describes the dashboard agent highlights widget shape.
 */
export type DashboardAgentHighlightsWidget = {
  id: string;
  kind: 'dashboard-agent-highlights';
  title: string;
  description?: string;
  size: LinkWidgetSizeId;
};

/**
 * Describes the link widget shape.
 */
export type LinkWidget =
  | HostMetricWidget
  | HostTerminalWidget
  | HomelabMetricWidget
  | HomeSummaryCardWidget
  | HomeWhatsBrokenWidget
  | HomeRecentEventsWidget
  | HomeTopConsumersWidget
  | DashboardAgentHighlightsWidget
  | AiChatWidget;

/**
 * Describes the link group shape.
 */
export type LinkGroup = {
  id: string;
  title: string;
  color: LinkGroupColorId;
  collapsed: boolean;
  tiles: LinkTile[];
  widgets: LinkWidget[];
};

/**
 * Describes the links dashboard shape.
 */
export type LinksDashboard = {
  version: 1;
  settings: {
    columns: number;
    tileSize: LinkTileSizeId;
    defaultOpenInNewTab: boolean;
  };
  groups: LinkGroup[];
};

/**
 * Describes the links dashboard response shape.
 */
export type LinksDashboardResponse = {
  dashboard: LinksDashboard;
  knownIcons: Array<{
    id: KnownLinkIconId;
    label: string;
  }>;
  groupColors: LinkGroupColorId[];
  savedAt?: string;
};

/**
 * Describes the link suggestion shape.
 */
export type LinkSuggestion = {
  id: string;
  serviceId: string;
  serviceName: string;
  title: string;
  url: string;
  description: string;
  icon: KnownLinkIconId;
  groupHint: string;
  confidence: number;
  source: 'endpoint' | 'inferred';
};

/**
 * Describes the link suggestions response shape.
 */
export type LinkSuggestionsResponse = {
  generatedAt: string;
  suggestions: LinkSuggestion[];
  knownIcons: Array<{
    id: KnownLinkIconId;
    label: string;
  }>;
};
