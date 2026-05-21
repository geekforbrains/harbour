export type SocialPlatformId = "overview" | "meta" | "youtube" | "x" | "tiktok" | "linkedin" | "distribution";

export type PlatformStatus = "active" | "next" | "coming_later";

export type AccessMode =
  | "official_api"
  | "authorized_oauth"
  | "licensed_dataset"
  | "owned_media"
  | "robots_allowed_web"
  | "manual_review_required"
  | "not_allowed";

export type AccessPolicy = {
  accessMode: AccessMode;
  canHydrateMetadata: boolean;
  canCollectMetrics: boolean;
  canStoreMetrics: boolean;
  canDownloadMedia: boolean;
  canExtractTranscript: boolean;
  canComputeDerivedScore: boolean;
  dataRetentionDays: number | null;
  notes: string[];
};

export type SocialPlatform = {
  id: SocialPlatformId;
  label: string;
  shortLabel: string;
  href: string;
  status: PlatformStatus;
  buildOrder: number | null;
  description: string;
  primaryAdapters: string[];
  activeSurface: string;
};

export type SocialMetric = {
  label: string;
  value: string;
  detail: string;
  tone: "good" | "warn" | "neutral";
};

export type SocialSection = {
  title: string;
  description: string;
  items: string[];
};

export type SocialSignal = {
  id: string;
  title: string;
  platform: Exclude<SocialPlatformId, "overview" | "distribution">;
  source: string;
  creator: string;
  topic: string;
  hookType: string;
  momentum: number;
  ageBucket: string;
  policy: AccessMode;
  distribution: "draft_ready" | "scheduled" | "not_started" | "blocked";
  brief: "queued" | "included" | "blocked";
};

export type DistributionProvider = {
  id: "blotato" | "ominsocial";
  label: string;
  role: string;
  status: PlatformStatus;
  guardrail: string;
  capabilities: string[];
};

export type WorkerPartition = {
  queue: string;
  target: string;
  purpose: string;
};

export type SocialDashboard = {
  platform: SocialPlatform;
  platforms: SocialPlatform[];
  metrics: SocialMetric[];
  sections: SocialSection[];
  signals: SocialSignal[];
  distributionProviders: DistributionProvider[];
  workerPartitions: WorkerPartition[];
  mcpTools: string[];
  adapterContract: string;
  policy: AccessPolicy;
};

export type SocialBatchRequest = {
  platform?: SocialPlatformId;
  workspaceId?: string | null;
  projectId?: string | null;
  sourceConfigId?: string | null;
  query?: string;
  provider?: "blotato" | "ominsocial" | string;
  sourceItemId?: string | null;
  draftId?: string | null;
  format?: string | null;
};

export const SOCIAL_PLATFORMS: SocialPlatform[] = [
  {
    id: "overview",
    label: "Overview",
    shortLabel: "All",
    href: "/social",
    status: "active",
    buildOrder: null,
    description: "Cross-platform trend command center for client workspaces, daily briefs, and distribution state.",
    primaryAdapters: ["instagram_adapter", "youtube_adapter", "x_adapter", "licensed_data_adapter"],
    activeSurface: "Cross-platform trend dashboard",
  },
  {
    id: "meta",
    label: "Meta",
    shortLabel: "Meta",
    href: "/social/meta",
    status: "active",
    buildOrder: 1,
    description: "Instagram/Reels intelligence first, with broader Meta surfaces planned behind authorized access.",
    primaryAdapters: ["instagram_adapter", "authorized_meta_adapter", "instagram_scrapling_adapter"],
    activeSurface: "Instagram Reels",
  },
  {
    id: "youtube",
    label: "YouTube",
    shortLabel: "YT",
    href: "/social/youtube",
    status: "next",
    buildOrder: 2,
    description: "Shorts and long-form analytics with channel baselines, transcript hooks, and thumbnail signals.",
    primaryAdapters: ["youtube_adapter"],
    activeSurface: "Shorts and long-form videos",
  },
  {
    id: "x",
    label: "X.com",
    shortLabel: "X",
    href: "/social/x",
    status: "next",
    buildOrder: 3,
    description: "Post, video, thread, repost, quote, and conversation intelligence using the existing X tooling first.",
    primaryAdapters: ["x_adapter"],
    activeSurface: "Posts, threads, and video posts",
  },
  {
    id: "tiktok",
    label: "TikTok",
    shortLabel: "TikTok",
    href: "/social/tiktok",
    status: "coming_later",
    buildOrder: null,
    description: "Reserved for a policy-approved TikTok adapter or licensed feed.",
    primaryAdapters: ["tiktok_adapter"],
    activeSurface: "Coming later",
  },
  {
    id: "linkedin",
    label: "LinkedIn",
    shortLabel: "LinkedIn",
    href: "/social/linkedin",
    status: "coming_later",
    buildOrder: null,
    description: "Reserved for authorized company/page analytics and distribution feedback.",
    primaryAdapters: ["linkedin_adapter"],
    activeSurface: "Coming later",
  },
  {
    id: "distribution",
    label: "Distribution",
    shortLabel: "Dist",
    href: "/social/distribution",
    status: "active",
    buildOrder: 4,
    description: "Blotato and Ominsocial drafts, scheduling, publishing status, and authorized performance feedback.",
    primaryAdapters: ["blotato_connector", "ominsocial_connector"],
    activeSurface: "Publishing and feedback",
  },
];

const DEFAULT_POLICY: AccessPolicy = {
  accessMode: "manual_review_required",
  canHydrateMetadata: true,
  canCollectMetrics: true,
  canStoreMetrics: true,
  canDownloadMedia: false,
  canExtractTranscript: false,
  canComputeDerivedScore: true,
  dataRetentionDays: 30,
  notes: [
    "Use official APIs, authorized OAuth, licensed datasets, owned media, robots-allowed web, or manual review.",
    "Stop deeper processing when source policy is unclear or not allowed.",
    "No login-wall, CAPTCHA, fingerprint, ban, rate-limit, or platform restriction bypass.",
  ],
};

export const DISTRIBUTION_PROVIDERS: DistributionProvider[] = [
  {
    id: "blotato",
    label: "Blotato",
    role: "Outbound publishing and scheduling connector.",
    status: "active",
    guardrail: "Publishing only unless connected-account APIs explicitly expose authorized analytics.",
    capabilities: ["platform-tailored drafts", "schedule posts", "publish posts", "failed post status", "external post mapping"],
  },
  {
    id: "ominsocial",
    label: "Ominsocial",
    role: "Publishing, scheduling, calendar, team workflow, and authorized analytics connector.",
    status: "active",
    guardrail: "Exact API base and brand spelling are credential-bound during implementation.",
    capabilities: ["connected accounts", "team approvals", "calendar status", "publish status", "authorized reporting"],
  },
];

export const SOCIAL_MCP_TOOLS = [
  "discover_viral_candidates",
  "start_video_batch_analysis",
  "start_social_batch_analysis",
  "get_video_analysis_status",
  "get_social_batch_status",
  "get_ranked_viral_candidates",
  "hydrate_video_metadata",
  "hydrate_social_item_metadata",
  "get_video_transcript",
  "get_social_item_transcript",
  "extract_video_hooks",
  "extract_social_hooks",
  "extract_hooks_for_video",
  "extract_keywords",
  "classify_niche",
  "score_virality",
  "score_momentum",
  "cluster_trending_topics",
  "export_ranked_videos",
  "export_ranked_social_items",
  "export_viral_report",
  "export_trend_brief",
  "generate_platform_post_drafts",
  "schedule_social_posts",
  "publish_social_post",
  "get_social_publish_status",
];

export const WORKER_PARTITIONS: WorkerPartition[] = [
  { queue: "discovery-workers", target: "10-30", purpose: "Approved candidate discovery and source config gating." },
  { queue: "metadata-workers", target: "50-200", purpose: "Hydration, creator/channel normalization, and canonical IDs." },
  { queue: "metric-snapshot-workers", target: "100-300", purpose: "Policy-aware views, likes, comments, shares, saves, and velocity snapshots." },
  { queue: "transcript-workers", target: "50-150", purpose: "Authorized captions and customer/creator-provided transcripts." },
  { queue: "asr-workers", target: "10-50", purpose: "Whisper/Deepgram/AssemblyAI for owned, uploaded, licensed, or authorized media." },
  { queue: "vision-workers", target: "25-100", purpose: "Frame sampling, OCR, scene changes, and visual opening classification." },
  { queue: "llm-extraction-workers", target: "50-200", purpose: "Structured hook, topic, entity, niche, audience, and CTA extraction." },
  { queue: "scoring-workers", target: "25-100", purpose: "Velocity, lift, acceleration, engagement, and trend momentum." },
  { queue: "clustering-workers", target: "5-25", purpose: "Topic, hook, creator, and format clustering." },
  { queue: "export-webhook-workers", target: "10-50", purpose: "Harbour, MCP, webhook, and TRON BRAIN outputs." },
  { queue: "distribution-workers", target: "10-50", purpose: "Blotato/Ominsocial drafts, scheduling, publishing status, and feedback." },
];

const OVERVIEW_SECTIONS: SocialSection[] = [
  {
    title: "Command Surface",
    description: "Harbour controls batches, source configs, policy state, exports, and distribution jobs.",
    items: ["Client workspace selector", "Platform source selector", "Batch status", "TRON BRAIN brief status"],
  },
  {
    title: "Engine Backbone",
    description: "Temporal, Redpanda, and worker queues process items outside Harbour.",
    items: ["FastAPI internal API", "Custom MCP server as tool interface", "Postgres canonical records", "ClickHouse analytics"],
  },
  {
    title: "Policy Gate",
    description: "Every adapter resolves access policy before metadata, metrics, media, transcript, or scoring work.",
    items: ["Official APIs", "Authorized OAuth", "Licensed datasets", "Owned/customer media", "Robots-allowed web", "Manual review"],
  },
];

const PLATFORM_SECTIONS: Record<SocialPlatformId, SocialSection[]> = {
  overview: OVERVIEW_SECTIONS,
  meta: [
    { title: "Trending Reels", description: "Age-bucketed Reels momentum from approved seeds and watchlists.", items: ["Reels momentum", "Creator baseline lift", "Hook visual type", "Save/share/comment rate"] },
    { title: "Hook Patterns", description: "Transcript, OCR, and opening-frame patterns for short-form video.", items: ["Curiosity gap", "Before/after", "Shock visual", "Social proof"] },
    { title: "Policy Review", description: "Scrapling remains a secondary permitted lane and never bypasses source restrictions.", items: ["Manual review required", "Source data basis", "Retention window", "Blocked item queue"] },
    { title: "Repurpose", description: "Turn approved trends into drafts for Blotato or Ominsocial.", items: ["Platform drafts", "Approval gate", "Schedule status", "Published feedback"] },
  ],
  youtube: [
    { title: "Shorts Trends", description: "Short-form video performance normalized by niche, format, and age bucket.", items: ["Views per hour", "Freshness lift", "Transcript hook", "Thumbnail/OCR signal"] },
    { title: "Long-form Trends", description: "Channel and topic baselines for long-form videos.", items: ["Views per day", "Channel baseline lift", "Comment signal", "Topic momentum"] },
    { title: "Title/Thumbnail Hooks", description: "Pattern scoring for titles, thumbnails, and transcript openings where permitted.", items: ["Title pattern", "Thumbnail text", "First 10 seconds", "CTR proxy signals"] },
    { title: "Search Opportunities", description: "Keyword and topic momentum for content planning.", items: ["Keyword gaps", "Topic clusters", "Niche baselines", "Brief recommendations"] },
  ],
  x: [
    { title: "Viral Posts", description: "Post velocity, author baseline, and conversation expansion.", items: ["Repost velocity", "Quote velocity", "Reply velocity", "Author lift"] },
    { title: "Thread Hooks", description: "Thread opening strength and payoff patterns.", items: ["Opening claim", "Contrarian hook", "Proof-first setup", "CTA pattern"] },
    { title: "Conversation Clusters", description: "Keyword, hashtag, reply, and quote clusters.", items: ["Keyword bursts", "Hashtag bursts", "Reply sentiment", "Quote spread"] },
    { title: "Policy Review", description: "Use X API/xurl first; rendered capture only as approved fallback.", items: ["API-first", "Rate-limit aware", "No write actions by default", "Provenance required"] },
  ],
  tiktok: [
    { title: "Adapter Placeholder", description: "Disabled until official, licensed, owned, or otherwise permitted access is configured.", items: ["TikTok adapter", "Research/API eligibility", "Licensed feed", "Policy gate"] },
  ],
  linkedin: [
    { title: "Adapter Placeholder", description: "Disabled until authorized company/page access and publishing policies are configured.", items: ["Company pages", "Personal profiles", "B2B topic momentum", "Policy gate"] },
  ],
  distribution: [
    { title: "Draft Queue", description: "Repurpose approved trends into platform-specific content drafts.", items: ["Hook reuse", "Audience adaptation", "CTA mapping", "Operator approval"] },
    { title: "Publishing Providers", description: "Blotato and Ominsocial manage scheduling and publishing after approval.", items: ["Connected accounts", "Schedule slots", "Publish status", "Failure reasons"] },
    { title: "Feedback Loop", description: "Authorized performance metrics can feed hook and topic scoring.", items: ["Post timing", "Approval rate", "Published status", "Performance feedback"] },
  ],
};

const SIGNALS: SocialSignal[] = [
  {
    id: "ig-reels-creator-ops",
    title: "Creator operators are compressing launch breakdowns into proof-first Reels",
    platform: "meta",
    source: "instagram_scrapling_adapter",
    creator: "@operatorlab",
    topic: "creator economy",
    hookType: "proof_first",
    momentum: 87,
    ageBucket: "0-6h",
    policy: "manual_review_required",
    distribution: "draft_ready",
    brief: "queued",
  },
  {
    id: "yt-shorts-agent-workflows",
    title: "Agent workflow Shorts with title-first mistakes are outpacing long-form clips",
    platform: "youtube",
    source: "youtube_adapter",
    creator: "AI Workflow Lab",
    topic: "agent automation",
    hookType: "mistake_avoidance",
    momentum: 81,
    ageBucket: "6-24h",
    policy: "official_api",
    distribution: "not_started",
    brief: "queued",
  },
  {
    id: "x-thread-build-in-public",
    title: "Build-in-public threads are shifting toward contrarian launch postmortems",
    platform: "x",
    source: "x_adapter",
    creator: "@growthsystems",
    topic: "startup growth",
    hookType: "contrarian_claim",
    momentum: 76,
    ageBucket: "0-3h",
    policy: "official_api",
    distribution: "scheduled",
    brief: "included",
  },
  {
    id: "ig-policy-blocked",
    title: "Blocked private account request kept at metadata-only review",
    platform: "meta",
    source: "instagram_scrapling_adapter",
    creator: "@private-source",
    topic: "restricted source",
    hookType: "not_applicable",
    momentum: 0,
    ageBucket: "blocked",
    policy: "not_allowed",
    distribution: "blocked",
    brief: "blocked",
  },
];

const METRICS_BY_PLATFORM: Record<SocialPlatformId, SocialMetric[]> = {
  overview: [
    { label: "Active platforms", value: "3", detail: "Instagram first, YouTube and X.com next", tone: "good" },
    { label: "Policy gates", value: "7", detail: "All source lanes resolve access policy first", tone: "neutral" },
    { label: "Worker queues", value: "11", detail: "Durable workflows, not 1,000 autonomous agents", tone: "good" },
    { label: "Distribution", value: "2", detail: "Blotato and Ominsocial connectors", tone: "neutral" },
  ],
  meta: [
    { label: "Build state", value: "First", detail: "Instagram/Reels active surface", tone: "good" },
    { label: "Acquisition", value: "Gated", detail: "Approved seeds, watchlists, authorized lanes", tone: "warn" },
    { label: "Visual hooks", value: "0-10s", detail: "Frames, OCR, scene changes where allowed", tone: "good" },
    { label: "Exports", value: "Daily", detail: "TRON BRAIN Instagram brief", tone: "neutral" },
  ],
  youtube: [
    { label: "Build state", value: "Second", detail: "YouTube Data API and authorized accounts", tone: "good" },
    { label: "Formats", value: "2", detail: "Shorts and long-form split", tone: "neutral" },
    { label: "Baselines", value: "Channel", detail: "Creator/channel lift by age bucket", tone: "good" },
    { label: "Hooks", value: "3", detail: "Title, thumbnail, transcript", tone: "neutral" },
  ],
  x: [
    { label: "Build state", value: "Third", detail: "Existing X tooling foundation", tone: "good" },
    { label: "Velocity", value: "4", detail: "Reposts, quotes, replies, views", tone: "neutral" },
    { label: "Threads", value: "Hook", detail: "Opening strength and conversation spread", tone: "good" },
    { label: "Guardrail", value: "API-first", detail: "Rendered capture only approved fallback", tone: "warn" },
  ],
  tiktok: [
    { label: "Build state", value: "Coming Later", detail: "Placeholder until permitted access is ready", tone: "warn" },
    { label: "Adapter", value: "Stub", detail: "No production acquisition yet", tone: "neutral" },
    { label: "Policy", value: "Required", detail: "Official, licensed, owned, or approved access", tone: "warn" },
    { label: "UI", value: "Visible", detail: "Disabled section prevents hidden scope drift", tone: "neutral" },
  ],
  linkedin: [
    { label: "Build state", value: "Coming Later", detail: "Placeholder until authorized access is ready", tone: "warn" },
    { label: "Adapter", value: "Stub", detail: "Company/page analytics later", tone: "neutral" },
    { label: "Policy", value: "Required", detail: "Authorized account and publishing permissions", tone: "warn" },
    { label: "UI", value: "Visible", detail: "Disabled section prevents hidden scope drift", tone: "neutral" },
  ],
  distribution: [
    { label: "Providers", value: "2", detail: "Blotato and Ominsocial", tone: "good" },
    { label: "Approval", value: "Human", detail: "Required before publishing by default", tone: "warn" },
    { label: "Feedback", value: "Scoped", detail: "Only authorized post analytics", tone: "neutral" },
    { label: "Status", value: "Mapped", detail: "Draft, scheduled, published, failed", tone: "good" },
  ],
};

export const ADAPTER_CONTRACT = `interface VideoSourceAdapter {
  source: "youtube" | "tiktok" | "instagram" | "x" | "reddit" | "rss" | "custom" | "licensed"
  discover(params: DiscoveryParams): Promise<VideoCandidate[]>
  hydrate(videoId: string): Promise<VideoMetadata>
  getTranscript(videoId: string): Promise<Transcript | null>
  getMetrics(videoId: string): Promise<MetricSnapshot | null>
  getMediaAssets(videoId: string): Promise<MediaAsset[] | null>
  getAccessPolicy(videoId: string): Promise<AccessPolicy>
}`;

export function getSocialPlatform(platform: string | null | undefined): SocialPlatform {
  return SOCIAL_PLATFORMS.find(item => item.id === platform) || SOCIAL_PLATFORMS[0];
}

export function getSocialDashboard(platform: string | null | undefined): SocialDashboard {
  const resolved = getSocialPlatform(platform);
  const signals = resolved.id === "overview" || resolved.id === "distribution"
    ? SIGNALS
    : SIGNALS.filter(signal => signal.platform === resolved.id);

  return {
    platform: resolved,
    platforms: SOCIAL_PLATFORMS,
    metrics: METRICS_BY_PLATFORM[resolved.id],
    sections: PLATFORM_SECTIONS[resolved.id],
    signals,
    distributionProviders: DISTRIBUTION_PROVIDERS,
    workerPartitions: WORKER_PARTITIONS,
    mcpTools: SOCIAL_MCP_TOOLS,
    adapterContract: ADAPTER_CONTRACT,
    policy: DEFAULT_POLICY,
  };
}

export function getSocialSignals(platform: string | null | undefined) {
  const resolved = getSocialPlatform(platform);
  if (resolved.id === "overview" || resolved.id === "distribution") return SIGNALS;
  return SIGNALS.filter(signal => signal.platform === resolved.id);
}

export function getSocialSignal(platform: string | null | undefined, id: string) {
  return getSocialSignals(platform).find(signal => signal.id === id) || null;
}

export function getSocialSourceConfigs(platform: string | null | undefined) {
  const resolved = getSocialPlatform(platform);
  return resolved.primaryAdapters.map(adapter => ({
    id: `${resolved.id}-${adapter}`,
    platform: resolved.id,
    adapter,
    status: resolved.status === "coming_later" ? "planned" : "scaffold",
    policy_basis: resolved.status === "coming_later"
      ? "adapter_not_active"
      : "manual_review_required_until_source_policy_resolves",
  }));
}

export function createLocalSocialBatch(input: SocialBatchRequest) {
  const platform = getSocialPlatform(input.platform || "overview");
  const now = new Date().toISOString();
  return {
    id: `social-batch-${Date.now()}`,
    platform: platform.id,
    status: platform.status === "coming_later" ? "blocked" : "queued",
    created_at: now,
    workspace_id: input.workspaceId || null,
    project_id: input.projectId || null,
    source_config_id: input.sourceConfigId || null,
    query: input.query || null,
    policy_basis: platform.status === "coming_later"
      ? "platform_adapter_not_active"
      : "manual_review_required_until_source_policy_resolves",
    message: platform.status === "coming_later"
      ? `${platform.label} is visible in Harbour but not active yet.`
      : `${platform.label} batch accepted by Harbour fallback. Configure SOCIAL_ENGINE_URL to hand this to FastAPI/Temporal.`,
  };
}

export function createLocalSocialExport(input: SocialBatchRequest) {
  const platform = getSocialPlatform(input.platform || "overview");
  return {
    id: `social-export-${Date.now()}`,
    platform: platform.id,
    status: platform.status === "coming_later" ? "blocked" : "queued",
    destination: "tron_brain_daily_brief",
    policy_basis: platform.status === "coming_later"
      ? "platform_adapter_not_active"
      : "display_allowed_items_only",
    message: platform.status === "coming_later"
      ? `${platform.label} exports are disabled until the adapter is active.`
      : `${platform.label} export queued by Harbour fallback. Configure SOCIAL_ENGINE_URL for live TRON BRAIN export execution.`,
  };
}
