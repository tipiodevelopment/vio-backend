import { z } from "zod";
import { pgTable, pgEnum, serial, varchar, text, timestamp, json, jsonb, integer, bigint, boolean, uniqueIndex, index, uuid } from "drizzle-orm/pg-core";
import { relations, sql } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";

// Database Tables

// Operator roles (ADR-0007). Hierarchical: super_admin > admin > operator > viewer.
// viewer is the sponsor-facing read-only role; sponsor_id links it to its sponsor.
export const userRoleEnum = pgEnum("user_role", ["super_admin", "admin", "operator", "viewer", "sponsor"]);

// Operators (dashboard users). Distinct from end_users (viewers of broadcasts).
// Legacy reachu_user_id kept nullable during Phase 2 transition; dropped in Phase 4.
// firebase_uid links the row to the shared Commerce Firebase identity (ADR-0007);
// rows are pre-provisioned (strict allowlist) and the uid attaches on first login.
export const users = pgTable("users", {
  id: serial("id").primaryKey(),
  reachuUserId: varchar("reachu_user_id", { length: 255 }).unique(),
  firebaseUid: varchar("firebase_uid", { length: 128 }).unique(),
  role: userRoleEnum("role").notNull().default("viewer"),
  sponsorId: integer("sponsor_id").references((): AnyPgColumn => sponsors.id),
  // Tenancy (ADR-0007): admin = tenant root (owns client_apps + sponsors via
  // their user_id). operator/viewer belong to an admin's tenant via this FK.
  // null for super_admin (global) and for admin (they ARE the tenant root).
  parentAdminId: integer("parent_admin_id").references((): AnyPgColumn => users.id),
  email: text("email"),
  name: text("name"),
  firebaseToken: text("firebase_token"),
  createdAt: timestamp("created_at").defaultNow().notNull()
});

// End-users (SDK viewers) — identified by the opaque id the partner (Viaplay, TV2)
// passes at SDK init. Unique per (client_app, external_user_id). Replaces the
// legacy reachu_user_id varchar pattern used across poll_votes, contest_participations, device_tokens.
export const endUsers = pgTable("end_users", {
  id: serial("id").primaryKey(),
  clientAppId: integer("client_app_id").notNull().references(() => clientApps.id, { onDelete: 'cascade' }),
  externalUserId: varchar("external_user_id", { length: 255 }).notNull(),
  firstSeenAt: timestamp("first_seen_at").defaultNow().notNull(),
  lastSeenAt: timestamp("last_seen_at").defaultNow().notNull(),
  metadata: json("metadata"),
}, (t) => [
  uniqueIndex("uniq_end_users_app_external").on(t.clientAppId, t.externalUserId),
  index("idx_end_users_last_seen").on(t.clientAppId, t.lastSeenAt),
]);

export const clientApps = pgTable("client_apps", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull().references(() => users.id, { onDelete: 'cascade' }),
  name: varchar("name", { length: 255 }).notNull(),
  /**
   * Legacy single-app identifier. A surface is NOT one native app (VG = web +
   * iOS + Android), so real identifiers live per platform in `surfacePlatforms`.
   * Nullable since migration 0010 — a web/Vev surface has none.
   */
  bundleId: varchar("bundle_id", { length: 255 }).unique(),
  apiKey: text("api_key").notNull().unique(),
  reachuApiKey: text("reachu_api_key"),
  description: text("description"),
  status: varchar("status", { length: 20 }).notNull().default('active'),
  iconUrl: text("icon_url"),
  bannerUrl: text("banner_url"),
  webhookUrl: varchar("webhook_url", { length: 512 }),
  /** Partner URL for POST { userId, deviceToken, platform } — filled when Vio forwards after SDK register-device */
  partnerDeviceRegisterUrl: varchar("partner_device_register_url", { length: 512 }),
  /** TV enablement — this app has one or more TV variants (Apple TV, Android TV) */
  tvEnabled: boolean("tv_enabled").notNull().default(false),
  /** Array of TV platforms supported: ['apple-tv', 'android-tv', 'fire-tv', ...] */
  tvPlatforms: text("tv_platforms").array().default(sql`'{}'`).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull()
});

/**
 * Platforms of a surface (migration 0010).
 *
 * Vocabulary: **Surface** = the publisher property where Vio runs (VG, TV2) —
 * that's `clientApps` above, whose table rename is a separate project because
 * the SDK contract exposes `clientAppId`. **Platform** = web/iOS/Android/Vev/TV
 * within it. **Placement** = the slot inside (`appPlacements`). **Channel** is a
 * COMMERCE concept (the brand's product outlet) and is never used for surfaces.
 *
 * `surfaceId` already uses the target vocabulary, so the future table rename
 * needs no change here.
 */
export const surfacePlatforms = pgTable("surface_platforms", {
  id: serial("id").primaryKey(),
  surfaceId: integer("surface_id").notNull().references(() => clientApps.id, { onDelete: 'cascade' }),
  /** 'web' | 'ios' | 'android' | 'vev' | 'apple-tv' | 'android-tv' | 'fire-tv' */
  kind: varchar("kind", { length: 32 }).notNull(),
  /** bundle id / package name / web domain / Vev project id — null when not needed yet. */
  identifier: varchar("identifier", { length: 255 }),
  enabled: boolean("enabled").notNull().default(true),
  createdAt: timestamp("created_at").defaultNow().notNull()
});

export const channels = pgTable("channels", {
  id: serial("id").primaryKey(),
  clientAppId: integer("client_app_id").references(() => clientApps.id, { onDelete: 'set null' }),
  name: varchar("name", { length: 255 }).notNull(),
  description: text("description"),
  dynamicConfig: json("dynamic_config"),
  createdAt: timestamp("created_at").defaultNow().notNull()
});

export const sponsors = pgTable("sponsors", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull().references(() => users.id, { onDelete: 'cascade' }),
  name: varchar("name", { length: 255 }).notNull(),
  description: text("description"),
  logoUrl: text("logo_url"),
  avatarUrl: text("avatar_url"),
  primaryColor: varchar("primary_color", { length: 20 }),
  secondaryColor: varchar("secondary_color", { length: 20 }),
  commerceApiKey: text("commerce_api_key"),
  commerceChannelId: text("commerce_channel_id"),
  /** Firebase uid of the Commerce business/supplier this sponsor was created
   *  from (auto-provisioning). Null for sponsors an admin created by hand. */
  commerceUserUid: varchar("commerce_user_uid", { length: 128 }).unique(),
  /** Payment methods supported by this sponsor's Commerce tenant.
   *  Initial value set manually; later updates arrive via Commerce → Vio webhook.
   *  Examples: ['card', 'klarna', 'vipps', 'apple_pay', 'google_pay']. */
  paymentMethods: json("payment_methods").$type<string[]>().default([]).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull()
});

export const campaigns = pgTable("campaigns", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull().references(() => users.id, { onDelete: 'cascade' }),
  clientAppId: integer("client_app_id").references(() => clientApps.id, { onDelete: 'cascade' }),
  channelId: integer("channel_id").references(() => channels.id, { onDelete: 'cascade' }),
  /** The single primary sponsor of the campaign. Set at creation, immutable after
   *  any child row (broadcast, poll, activation, cart_intent) exists. Phase 3 enforced. */
  primarySponsorId: integer("primary_sponsor_id").notNull().references(() => sponsors.id, { onDelete: 'restrict' }),
  name: varchar("name", { length: 255 }).notNull(),
  logo: text("logo"),
  description: text("description"),
  startDate: timestamp("start_date"),
  endDate: timestamp("end_date"),
  isPaused: varchar("is_paused", { length: 10 }).notNull().default('false'),
  reachuChannelId: varchar("reachu_channel_id", { length: 255 }),  // DEPRECATED — dropped in Phase 4
  reachuApiKey: text("reachu_api_key"),                             // DEPRECATED — dropped in Phase 4
  tipioLivestreamData: json("tipio_livestream_data"),
  isSegmented: varchar("is_segmented", { length: 10 }).notNull().default('false'),
  targetCountries: text("target_countries").array(),
  targetPercentage: integer("target_percentage"),
  matchId: varchar("match_id", { length: 255 }),
  matchName: varchar("match_name", { length: 255 }),
  matchStartTime: timestamp("match_start_time"),
  brandName: varchar("brand_name", { length: 255 }),
  brandIconAsset: varchar("brand_icon_asset", { length: 255 }),
  brandIconUrl: text("brand_icon_url"),
  brandLogoUrl: text("brand_logo_url"),
  /** DEPRECATED — moved to sponsors.paymentMethods. Dropped in Phase 4. */
  paymentMethods: json("payment_methods").$type<string[]>(),
  webhookUrl: varchar("webhook_url", { length: 512 }),
  createdAt: timestamp("created_at").defaultNow().notNull()
});

// Campaign Translations - for sponsorBadgeText and other campaign-specific translations
export const campaignTranslations = pgTable("campaign_translations", {
  id: serial("id").primaryKey(),
  campaignId: integer("campaign_id").notNull().references(() => campaigns.id, { onDelete: 'cascade' }),
  languageCode: varchar("language_code", { length: 10 }).notNull(),
  sponsorBadgeText: varchar("sponsor_badge_text", { length: 255 })
});

// Campaign Engagement Config - engagement settings per campaign
export const campaignEngagementConfig = pgTable("campaign_engagement_config", {
  id: serial("id").primaryKey(),
  campaignId: integer("campaign_id").notNull().references(() => campaigns.id, { onDelete: 'cascade' }),
  demoMode: varchar("demo_mode", { length: 10 }).notNull().default('false'),
  defaultPollDuration: integer("default_poll_duration").notNull().default(300),
  defaultContestDuration: integer("default_contest_duration").notNull().default(600),
  maxVotesPerPoll: integer("max_votes_per_poll").notNull().default(1),
  maxContestsPerMatch: integer("max_contests_per_match").notNull().default(10),
  enableRealTimeUpdates: varchar("enable_real_time_updates", { length: 10 }).notNull().default('true'),
  updateInterval: integer("update_interval").notNull().default(1000)
});

// Campaign UI Config - UI theme settings per campaign
export const campaignUiConfig = pgTable("campaign_ui_config", {
  id: serial("id").primaryKey(),
  campaignId: integer("campaign_id").notNull().references(() => campaigns.id, { onDelete: 'cascade' }),
  primaryColor: varchar("primary_color", { length: 7 }).notNull().default('#007AFF'),
  secondaryColor: varchar("secondary_color", { length: 7 }).notNull().default('#5856D6'),
  componentConfigs: json("component_configs")
});

// Campaign Feature Flags - feature toggles per campaign
export const campaignFeatureFlags = pgTable("campaign_feature_flags", {
  id: serial("id").primaryKey(),
  campaignId: integer("campaign_id").notNull().references(() => campaigns.id, { onDelete: 'cascade' }),
  enableLiveStreaming: varchar("enable_live_streaming", { length: 10 }).notNull().default('true'),
  enableProductCatalog: varchar("enable_product_catalog", { length: 10 }).notNull().default('true'),
  enableEngagement: varchar("enable_engagement", { length: 10 }).notNull().default('true'),
  enablePolls: varchar("enable_polls", { length: 10 }).notNull().default('true'),
  enableContests: varchar("enable_contests", { length: 10 }).notNull().default('true')
});

// SDK Translations - global/campaign/match-specific translations
export const sdkTranslations = pgTable("sdk_translations", {
  id: serial("id").primaryKey(),
  languageCode: varchar("language_code", { length: 10 }).notNull(),
  campaignId: integer("campaign_id").references(() => campaigns.id, { onDelete: 'cascade' }),
  matchId: varchar("match_id", { length: 255 }),
  translationKey: varchar("translation_key", { length: 100 }).notNull(),
  translationValue: text("translation_value").notNull(),
  dateFormat: varchar("date_format", { length: 50 }).notNull().default('dd.MM.yyyy'),
  timeFormat: varchar("time_format", { length: 50 }).notNull().default('HH:mm')
});

export const events = pgTable("events", {
  id: serial("id").primaryKey(),
  campaignId: integer("campaign_id").notNull().references(() => campaigns.id, { onDelete: 'cascade' }),
  type: varchar("type", { length: 50 }).notNull(),
  data: json("data").notNull(),
  campaignLogo: text("campaign_logo"),
  timestamp: timestamp("timestamp").defaultNow().notNull()
});

export const campaignFormState = pgTable("campaign_form_state", {
  id: serial("id").primaryKey(),
  campaignId: integer("campaign_id").notNull().references(() => campaigns.id, { onDelete: 'cascade' }),
  formType: varchar("form_type", { length: 50 }).notNull(),
  formData: json("form_data").notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull()
});

export const scheduledComponents = pgTable("scheduled_components", {
  id: serial("id").primaryKey(),
  campaignId: integer("campaign_id").notNull().references(() => campaigns.id, { onDelete: 'cascade' }),
  /** Sponsor of this scheduled component. Must be the campaign's primary sponsor
   *  or one of its secondary sponsors. Validated at endpoint layer. Phase 3 enforced. */
  sponsorId: integer("sponsor_id").notNull().references(() => sponsors.id, { onDelete: 'restrict' }),
  type: varchar("type", { length: 50 }).notNull(), // carousel, store_view, product_spotlight, liveshow_trigger
  scheduledTime: timestamp("scheduled_time").notNull(),
  endTime: timestamp("end_time"), // Optional end time for component display
  data: json("data").notNull(),
  status: varchar("status", { length: 20 }).notNull().default('pending'), // pending, sent, cancelled
  createdAt: timestamp("created_at").defaultNow().notNull()
});

// Dynamic Components - Reusable UI components library
export const components = pgTable("components", {
  id: varchar("id", { length: 50 }).primaryKey().default(sql`gen_random_uuid()`),
  type: varchar("type", { length: 50 }).notNull(), // banner, countdown, carousel_auto, carousel_manual, product_spotlight, offer_badge
  name: varchar("name", { length: 255 }).notNull(),
  config: json("config").notNull(), // Type-specific configuration
  isTemplate: boolean("is_template").notNull().default(false), // true = base template, false = regular component
  createdAt: timestamp("created_at").defaultNow().notNull()
});

// Campaign Components — instances of a named placement bound to a campaign,
// with sponsor + product overrides + scheduling. Each row references an
// `app_placements` entry directly (the named instance the operator picked
// from the dashboard) — the underlying component template + locationId
// live there, not duplicated here.
//
// Multi-sponsor rotation: operator can create multiple rows for the same
// (campaign, app_placement) with different sponsors / scheduled times,
// but only ONE may be `status='active'` at a time. Enforced by partial
// UNIQUE index `idx_campaign_components_one_active`.
export const campaignComponents = pgTable("campaign_components", {
  id: serial("id").primaryKey(),
  campaignId: integer("campaign_id").notNull().references(() => campaigns.id, { onDelete: 'cascade' }),
  /** FK to the named app_placement the operator picked. Source of truth for
   *  the underlying template + locationId; this row only adds sponsor +
   *  product overrides + scheduling. */
  appPlacementId: integer("app_placement_id").notNull().references(() => appPlacements.id, { onDelete: 'restrict' }),
  /** Sponsor that owns this placement (branding + commerce key source).
   *  Must be the campaign's primary sponsor or one of its secondary
   *  sponsors. Phase 3 enforced. */
  sponsorId: integer("sponsor_id").notNull().references(() => sponsors.id, { onDelete: 'restrict' }),
  /** Optional broadcast scope. NULL = placement active for the whole
   *  campaign. Set = placement only active during that specific broadcast. */
  broadcastId: varchar("broadcast_id", { length: 255 }).references((): AnyPgColumn => broadcasts.broadcastId, { onDelete: 'cascade' }),
  instanceName: varchar("instance_name", { length: 255 }), // Optional UX label distinct from app_placement.name (e.g. "Carrusel home — XXL drop")
  status: varchar("status", { length: 20 }).notNull().default('inactive'), // active, inactive
  customConfig: json("custom_config"), // Campaign-specific overlay (e.g. productIds list)
  scheduledTime: timestamp("scheduled_time"), // Auto-activate at this time
  endTime: timestamp("end_time"), // Auto-deactivate at this time
  activatedAt: timestamp("activated_at"),
  matchId: varchar("match_id", { length: 255 }),
  videoStartTime: integer("video_start_time"),
  videoEndTime: integer("video_end_time"),
  scheduledStartTime: timestamp("scheduled_start_time"),
  scheduledEndTime: timestamp("scheduled_end_time"),
  /** User who created this campaign placement (operator audit trail). */
  createdBy: integer("created_by").references(() => users.id, { onDelete: 'set null' }),
  updatedAt: timestamp("updated_at").defaultNow().notNull()
});

// NOTE: `app_components` table dropped in migration 0004 — fully redundant
// with `app_placements` (a placement implies the app supports the underlying
// template). Schema definition removed; storage helpers + endpoints have
// been migrated to read from `app_placements` instead.

// App Component Locations - Slots declared by the partner SDK (via manifest upload)
// where placements may render. Operator picks from these in the dashboard when
// adding a campaign_components instance. The dev declares them once at app boot
// via `Vio.registerPlacementLocation(...)` and the manifest endpoint upserts
// them; subsequent runs of the same dev's app are idempotent.
//
// `locationId` is a free-form short identifier the dev's SwiftUI/Compose layout
// uses (e.g. "home_top", "match_sidebar"). It mirrors the same string written
// to `campaign_components.location_id` when the operator binds a placement to
// this slot.
//
// Scoped per `client_app_id` because two partner apps may legitimately reuse
// the same `home_top` label without colliding.
export const appComponentLocations = pgTable("app_component_locations", {
  id: serial("id").primaryKey(),
  clientAppId: integer("client_app_id").notNull().references(() => clientApps.id, { onDelete: 'cascade' }),
  locationId: varchar("location_id", { length: 100 }).notNull(),
  displayName: varchar("display_name", { length: 255 }),
  /** Soft-delete: SDK manifest is sync-semantic — locations not in the new
   *  payload get `deprecated_at = now()` instead of being deleted. The
   *  dashboard hides deprecated locations from the "Add from library"
   *  picker; existing app_placements pointing at them keep working with
   *  a warning. */
  deprecatedAt: timestamp("deprecated_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull()
}, (table) => ({
  // Idempotency: one row per (app, locationId). Manifest upserts hit this.
  uniqAppLocation: uniqueIndex("idx_app_component_locations_unique")
    .on(table.clientAppId, table.locationId),
}));

// Named app-instances of placements — the explicit declaration of which
// (template, location, name) tuples the partner app implements.
//
// Created by **operator/admin via the dashboard `/apps/:id` "Add from
// library" form** — NOT by the SDK manifest. The dashboard combines:
//   - a template id (from the read-only library)
//   - a locationId (from `app_component_locations`, the SDK's slot manifest)
//   - a name (human-readable, e.g. "Carrusel home")
//
// The campaign placement picker (`/campaigns/:id`) reads exclusively from
// this table and offers `(name)` to the operator; the operator then adds
// `sponsor + products` to create a `campaign_components` instance.
//
// Two UNIQUE indexes:
//   - (client_app_id, name) — name is human-facing id, unique per app so
//     picker labels are unambiguous.
//   - (client_app_id, component_id, location_id) — only one placement per
//     (type, slot) per app. For A/B variants, declare distinct locations
//     (`home_top_a`, `home_top_b`).
//
// Soft-delete: operator removal sets `deprecated_at = now()` (ON DELETE
// from a deprecated location cascade-deprecates these too). Existing
// `campaign_components` referring to a deprecated placement keep
// rendering with a dashboard warning until the operator unbinds them.
export const appPlacements = pgTable("app_placements", {
  id: serial("id").primaryKey(),
  clientAppId: integer("client_app_id").notNull().references(() => clientApps.id, { onDelete: 'cascade' }),
  componentId: varchar("component_id").notNull().references(() => components.id, { onDelete: 'restrict' }),
  locationId: varchar("location_id", { length: 100 }).notNull(),
  name: varchar("name", { length: 255 }).notNull(),
  customConfig: json("custom_config"),
  /** Soft-delete (operator removal or location cascade). Existing
   *  campaign_components keep rendering with a dashboard warning. */
  deprecatedAt: timestamp("deprecated_at"),
  /** Audit: operator user who created this placement. */
  createdBy: integer("created_by").references(() => users.id, { onDelete: 'set null' }),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull()
}, (table) => ({
  uniqByName: uniqueIndex("idx_app_placements_unique_name")
    .on(table.clientAppId, table.name),
  uniqBySlot: uniqueIndex("idx_app_placements_unique_slot")
    .on(table.clientAppId, table.componentId, table.locationId),
  byClientApp: index("idx_app_placements_client_app").on(table.clientAppId),
}));

// Broadcasts - represents live events/matches that campaigns are associated with
export const broadcasts = pgTable("broadcasts", {
  broadcastId: varchar("broadcast_id", { length: 255 }).primaryKey(),
  broadcastName: varchar("broadcast_name", { length: 255 }).notNull(),
  description: text("description"),
  externalId: varchar("external_id", { length: 255 }),
  campaignId: integer("campaign_id").references(() => campaigns.id, { onDelete: 'cascade' }),
  channelId: integer("channel_id").references(() => channels.id, { onDelete: 'set null' }),
  startTime: timestamp("start_time"),
  endTime: timestamp("end_time"),
  status: varchar("status", { length: 20 }).notNull().default('upcoming'),
  viewerCount: integer("viewer_count").default(0),
  peakViewers: integer("peak_viewers").default(0),
  metadata: json("metadata"),
  createdBy: integer("created_by").references(() => users.id, { onDelete: 'set null' }),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
  sportmonksFixtureId: integer("sportmonks_fixture_id"),
  homeTeamName: varchar("home_team_name", { length: 255 }),
  homeTeamLogo: varchar("home_team_logo", { length: 512 }),
  awayTeamName: varchar("away_team_name", { length: 255 }),
  awayTeamLogo: varchar("away_team_logo", { length: 512 }),
  matchStartingAt: timestamp("match_starting_at"),
  leagueName: varchar("league_name", { length: 255 }),
  showLineup: boolean("show_lineup").notNull().default(false),
  startedAt: timestamp("started_at"),
  /** Opt-in flag for the engagement system on this broadcast. Default false —
   *  operator enables per broadcast. Controls whether polls/contests are
   *  offered to clients and whether the SDK opens the engagement WebSocket. */
  engagementEnabled: boolean("engagement_enabled").notNull().default(false),
}, (table) => ({
  externalIdCampaignIdx: index("idx_broadcasts_external_id_campaign").on(table.externalId, table.campaignId),
}));

// Polls - engagement polls associated with broadcasts
export const polls = pgTable("polls", {
  id: serial("id").primaryKey(),
  broadcastId: varchar("broadcast_id", { length: 255 }).notNull().references(() => broadcasts.broadcastId, { onDelete: 'cascade' }),
  /** Sponsor that brands this poll. Defaults to the campaign's primary sponsor
   *  but can be overridden to any secondary. Phase 3 enforced. */
  sponsorId: integer("sponsor_id").notNull().references(() => sponsors.id, { onDelete: 'restrict' }),
  question: text("question").notNull(),
  startTime: timestamp("start_time"),
  endTime: timestamp("end_time"),
  isActive: boolean("is_active").notNull().default(true),
  totalVotes: integer("total_votes").notNull().default(0),
  duration: integer("duration"),
  videoStartTime: integer("video_start_time"),
  videoEndTime: integer("video_end_time"),
  broadcastStartTime: timestamp("broadcast_start_time"),
  scheduledStartTime: timestamp("scheduled_start_time"),
  scheduledEndTime: timestamp("scheduled_end_time"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull()
}, (table) => [
  index("idx_polls_broadcast_id").on(table.broadcastId),
  index("idx_polls_is_active").on(table.isActive),
  index("idx_polls_scheduled").on(table.scheduledStartTime, table.scheduledEndTime),
]);

// Poll Options - choices for each poll
export const pollOptions = pgTable("poll_options", {
  id: serial("id").primaryKey(),
  pollId: integer("poll_id").notNull().references(() => polls.id, { onDelete: 'cascade' }),
  text: varchar("text", { length: 500 }).notNull(),
  voteCount: integer("vote_count").notNull().default(0),
  displayOrder: integer("display_order").notNull().default(0),
  createdAt: timestamp("created_at").defaultNow().notNull()
}, (table) => [
  index("idx_poll_options_poll_id").on(table.pollId),
]);

// Poll Votes - individual vote records
export const pollVotes = pgTable("poll_votes", {
  id: serial("id").primaryKey(),
  pollId: integer("poll_id").notNull().references(() => polls.id, { onDelete: 'cascade' }),
  optionId: integer("option_id").notNull().references(() => pollOptions.id, { onDelete: 'cascade' }),
  /** DEPRECATED — the old varchar identity (reachu_user_id string). Kept for
   *  legacy reads during Phase 2 transition, then dropped in Phase 4. */
  userId: varchar("user_id", { length: 255 }).notNull(),
  /** New FK to end_users (SDK viewers). Nullable in Phase 2; enforced in Phase 3. */
  endUserId: integer("end_user_id").references(() => endUsers.id, { onDelete: 'cascade' }),
  broadcastId: varchar("broadcast_id", { length: 255 }).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull()
}, (table) => [
  uniqueIndex("unique_user_poll").on(table.pollId, table.userId),
  index("idx_poll_votes_poll_id").on(table.pollId),
  index("idx_poll_votes_broadcast_id").on(table.broadcastId),
  index("idx_poll_votes_end_user").on(table.endUserId),
]);

// Contests - engagement contests associated with broadcasts
export const contests = pgTable("contests", {
  id: serial("id").primaryKey(),
  broadcastId: varchar("broadcast_id", { length: 255 }).notNull().references(() => broadcasts.broadcastId, { onDelete: 'cascade' }),
  /** Sponsor that brands this contest. Same semantics as polls.sponsorId. Phase 3 enforced. */
  sponsorId: integer("sponsor_id").notNull().references(() => sponsors.id, { onDelete: 'restrict' }),
  title: varchar("title", { length: 500 }).notNull(),
  description: text("description"),
  prize: varchar("prize", { length: 500 }),
  contestType: varchar("contest_type", { length: 50 }).notNull(),
  startTime: timestamp("start_time"),
  endTime: timestamp("end_time"),
  isActive: boolean("is_active").notNull().default(true),
  imageUrl: varchar("image_url", { length: 1000 }),
  videoStartTime: integer("video_start_time"),
  videoEndTime: integer("video_end_time"),
  broadcastStartTime: timestamp("broadcast_start_time"),
  scheduledStartTime: timestamp("scheduled_start_time"),
  scheduledEndTime: timestamp("scheduled_end_time"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull()
}, (table) => [
  index("idx_contests_broadcast_id").on(table.broadcastId),
  index("idx_contests_is_active").on(table.isActive),
  index("idx_contests_scheduled").on(table.scheduledStartTime, table.scheduledEndTime),
]);

// Contest Participations - individual participation records
export const contestParticipations = pgTable("contest_participations", {
  id: serial("id").primaryKey(),
  contestId: integer("contest_id").notNull().references(() => contests.id, { onDelete: 'cascade' }),
  /** DEPRECATED — legacy varchar identity. Kept during Phase 2 transition. */
  userId: varchar("user_id", { length: 255 }).notNull(),
  /** New FK to end_users. Nullable in Phase 2; enforced in Phase 3. */
  endUserId: integer("end_user_id").references(() => endUsers.id, { onDelete: 'cascade' }),
  broadcastId: varchar("broadcast_id", { length: 255 }).notNull(),
  answers: json("answers"),
  createdAt: timestamp("created_at").defaultNow().notNull()
}, (table) => [
  uniqueIndex("unique_user_contest").on(table.contestId, table.userId),
  index("idx_contest_participations_contest_id").on(table.contestId),
  index("idx_contest_participations_broadcast_id").on(table.broadcastId),
  index("idx_contest_participations_end_user").on(table.endUserId),
]);

// Broadcast Ads — scheduled/active ads linked to a broadcast
export const broadcastAds = pgTable("broadcast_ads", {
  id: serial("id").primaryKey(),
  broadcastId: varchar("broadcast_id", { length: 255 }).notNull().references(() => broadcasts.broadcastId, { onDelete: 'cascade' }),
  name: varchar("name", { length: 255 }).notNull(),
  description: text("description"),
  imageUrl: text("image_url"),
  ctaUrl: text("cta_url"),
  startTime: varchar("start_time", { length: 20 }),
  duration: varchar("duration", { length: 20 }),
  adType: varchar("ad_type", { length: 50 }).notNull().default('banner'),
  isActive: boolean("is_active").notNull().default(true),
  displayOrder: integer("display_order").notNull().default(0),
  createdAt: timestamp("created_at").defaultNow().notNull()
}, (table) => [
  index("idx_broadcast_ads_broadcast_id").on(table.broadcastId),
]);

// Broadcast Products — shoppable products linked to a broadcast
export const broadcastProducts = pgTable("broadcast_products", {
  id: serial("id").primaryKey(),
  broadcastId: varchar("broadcast_id", { length: 255 }).notNull().references(() => broadcasts.broadcastId, { onDelete: 'cascade' }),
  name: varchar("name", { length: 255 }).notNull(),
  subtitle: text("subtitle"),
  price: varchar("price", { length: 20 }).notNull().default('0'),
  originalPrice: varchar("original_price", { length: 20 }),
  imageUrl: text("image_url"),
  buyUrl: text("buy_url"),
  status: varchar("status", { length: 20 }).notNull().default('available'),
  displayOrder: integer("display_order").notNull().default(0),
  createdAt: timestamp("created_at").defaultNow().notNull()
}, (table) => [
  index("idx_broadcast_products_broadcast_id").on(table.broadcastId),
]);

// Chat Messages — live chat messages per broadcast
export const chatMessages = pgTable("chat_messages", {
  id: serial("id").primaryKey(),
  broadcastId: varchar("broadcast_id", { length: 255 }).notNull().references(() => broadcasts.broadcastId, { onDelete: 'cascade' }),
  username: varchar("username", { length: 100 }).notNull(),
  message: text("message").notNull(),
  type: varchar("type", { length: 50 }).notNull().default('message'), // 'message' | 'tweet'
  metadata: json("metadata"), // For tweets: { tweetId, via, metrics: { likes, retweets } }
  createdAt: timestamp("created_at").defaultNow().notNull()
}, (table) => [
  index("idx_chat_messages_broadcast_id").on(table.broadcastId),
]);

// Device tokens for APNs push notifications
export const deviceTokens = pgTable("device_tokens", {
  id: serial("id").primaryKey(),
  campaignId: integer("campaign_id").notNull().references(() => campaigns.id, { onDelete: 'cascade' }),
  /** DEPRECATED — legacy varchar identity. */
  userId: varchar("user_id", { length: 255 }).notNull(),
  /** New FK to end_users. Nullable in Phase 2; enforced in Phase 3. */
  endUserId: integer("end_user_id").references(() => endUsers.id, { onDelete: 'cascade' }),
  deviceId: varchar("device_id", { length: 255 }).notNull(),
  deviceToken: varchar("device_token", { length: 512 }).notNull(),
  platform: varchar("platform", { length: 20 }).notNull().default('ios'),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (table) => [
  uniqueIndex("idx_device_tokens_campaign_user").on(table.campaignId, table.userId),
  index("idx_device_tokens_end_user").on(table.endUserId),
]);

export type DeviceToken = typeof deviceTokens.$inferSelect;
export type InsertDeviceToken = typeof deviceTokens.$inferInsert;

// Sportmonks cache — stores API responses to avoid repeated calls
export const sportmonksCache = pgTable("sportmonks_cache", {
  id: serial("id").primaryKey(),
  cacheType: varchar("cache_type", { length: 50 }).notNull(),
  leagueId: integer("league_id"),
  dateFrom: varchar("date_from", { length: 20 }),
  dateTo: varchar("date_to", { length: 20 }),
  data: json("data").notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const insertSportmonksCacheSchema = createInsertSchema(sportmonksCache).omit({ id: true });
export type SportmonksCache = typeof sportmonksCache.$inferSelect;
export type InsertSportmonksCache = z.infer<typeof insertSportmonksCacheSchema>;

// Events outbox — backs every realtime event the server emits to WS clients.
//
// HTTP handlers INSERT into this table inside the SAME transaction as the
// data change (atomicity: never lose an event after a successful commit,
// never spuriously emit one if the data change rolled back). A worker
// (server/events/worker.ts) polls pending rows every 500ms with
// `FOR UPDATE SKIP LOCKED` and ships them via `broadcastToCampaign` etc.
//
// Module-agnostic + scope-agnostic by design: the same table backs
// placements (today), engagement/broadcast (future), and cart-intent
// (migration target). See migrations/0005_events_outbox.sql for the full
// rationale and TASK_PLACEMENTS.md "Sprint 2026-04-28 PM" for the plan.
export const eventsOutbox = pgTable("events_outbox", {
  id: uuid("id").primaryKey().defaultRandom(),
  /** Wire event type, e.g. 'placement_status_changed'. */
  topic: text("topic").notNull(),
  /** Subscription bucket. 'placements' | 'engagement' | 'broadcast' | 'cart_intent'. */
  module: text("module").notNull(),
  /** Routing target type. 'campaign' | 'broadcast' | 'user'. */
  scopeType: text("scope_type").notNull(),
  /** Numeric id of the routing target (campaign.id, end_users.id, …). */
  scopeId: bigint("scope_id", { mode: "number" }).notNull(),
  /** Free-form payload; each topic owns its shape (see server/events/types.ts). */
  payload: jsonb("payload").notNull(),
  /** Authoritative timestamp at outbox INSERT (used by SDK for sequencing). */
  serverTimestamp: timestamp("server_timestamp", { withTimezone: true }).defaultNow().notNull(),
  /** Lifecycle. 'pending' → 'sent' (ok) | 'failed' (transient) | 'dead' (max attempts). */
  status: text("status").notNull().default("pending"),
  attempts: integer("attempts").notNull().default(0),
  lastError: text("last_error"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  processedAt: timestamp("processed_at", { withTimezone: true }),
}, (table) => ({
  // Worker hot-path: status='pending' ORDER BY created_at LIMIT N.
  pendingIdx: index("events_outbox_pending_idx").on(table.createdAt),
  // Audit / replay: "all events for campaign 36 in time order".
  scopeIdx: index("events_outbox_scope_idx").on(table.scopeType, table.scopeId, table.serverTimestamp),
}));

export type EventsOutboxRow = typeof eventsOutbox.$inferSelect;
export type InsertEventsOutboxRow = typeof eventsOutbox.$inferInsert;

// Campaign Sponsors — many-to-many campaigns <-> sponsors with role
export const campaignSponsors = pgTable("campaign_sponsors", {
  id: serial("id").primaryKey(),
  campaignId: integer("campaign_id").notNull().references(() => campaigns.id, { onDelete: 'cascade' }),
  sponsorId: integer("sponsor_id").notNull().references(() => sponsors.id, { onDelete: 'cascade' }),
  role: varchar("role", { length: 50 }).notNull().default('shoppable'), // 'engagement' | 'shoppable' | 'full'
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => ({
  uniqueCampaignSponsor: uniqueIndex("unique_campaign_sponsor").on(table.campaignId, table.sponsorId),
}));

// Broadcast Campaigns — many-to-many broadcasts <-> campaigns
export const broadcastCampaigns = pgTable("broadcast_campaigns", {
  id: serial("id").primaryKey(),
  broadcastId: varchar("broadcast_id", { length: 255 }).notNull().references((): AnyPgColumn => broadcasts.broadcastId, { onDelete: 'cascade' }),
  campaignId: integer("campaign_id").notNull().references(() => campaigns.id, { onDelete: 'cascade' }),
  isPrimary: boolean("is_primary").default(false),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => ({
  uniqueBroadcastCampaign: uniqueIndex("unique_broadcast_campaign").on(table.broadcastId, table.campaignId),
}));

// Broadcast Sponsor Slots — pre-configured shoppable ad schedule per broadcast
export const broadcastSponsorSlots = pgTable("broadcast_sponsor_slots", {
  id: serial("id").primaryKey(),
  broadcastId: varchar("broadcast_id", { length: 255 }).notNull().references((): AnyPgColumn => broadcasts.broadcastId, { onDelete: 'cascade' }),
  sponsorId: integer("sponsor_id").notNull().references(() => sponsors.id, { onDelete: 'cascade' }),
  campaignId: integer("campaign_id").references(() => campaigns.id, { onDelete: 'set null' }),
  role: varchar("role", { length: 50 }).notNull().default('shoppable'),
  type: varchar("type", { length: 50 }).notNull().default('product'), // 'product' | 'lead' | 'poll_cta' | 'contest_cta' | 'link'
  config: json("config").default({}), // type-specific config payload
  triggerType: varchar("trigger_type", { length: 50 }).notNull().default('manual'), // 'manual' | 'match_minute' | 'absolute_time'
  triggerValue: text("trigger_value"), // minute number or ISO datetime string
  autoExecute: boolean("auto_execute").default(false),
  productIds: integer("product_ids").array().default(sql`'{}'`),
  status: varchar("status", { length: 20 }).default('scheduled'), // 'scheduled' | 'active' | 'completed'
  executedAt: timestamp("executed_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

// Shoppable Ad Activations — one row per shoppable_ad dispatch (manual, scheduled, or SDK-triggered)
// Separate from generic events table because this is a high-volume, queryable engagement signal
// that needs proper FKs (sponsor, slot, client_app) for analytics and attribution.
export const shoppableAdActivations = pgTable("shoppable_ad_activations", {
  id: serial("id").primaryKey(),
  broadcastId: varchar("broadcast_id", { length: 255 }).notNull()
    .references((): AnyPgColumn => broadcasts.broadcastId, { onDelete: 'cascade' }),
  campaignId: integer("campaign_id").notNull()
    .references(() => campaigns.id, { onDelete: 'cascade' }),
  sponsorId: integer("sponsor_id").references(() => sponsors.id, { onDelete: 'set null' }),
  slotId: integer("slot_id").references(() => broadcastSponsorSlots.id, { onDelete: 'set null' }),
  clientAppId: integer("client_app_id").references(() => clientApps.id, { onDelete: 'set null' }),
  productId: varchar("product_id", { length: 255 }).notNull(), // external Commerce id, not a local FK
  productSnapshot: json("product_snapshot").notNull(), // { id, name, price, currency, imageUrl } captured at dispatch time
  sponsorSnapshot: json("sponsor_snapshot"), // { name, logoUrl, primaryColor } captured at dispatch time
  source: varchar("source", { length: 30 }).notNull(), // 'admin-api' | 'dashboard' | 'tv-sdk' | 'slot-scheduler'
  wsEventSent: boolean("ws_event_sent").notNull().default(true),
  metadata: json("metadata"), // future-proof payload (userId, deviceId, experiment tags, etc.)
  triggeredAt: timestamp("triggered_at").defaultNow().notNull(),
}, (table) => [
  index("idx_shoppable_activations_broadcast_time").on(table.broadcastId, table.triggeredAt),
  index("idx_shoppable_activations_campaign_time").on(table.campaignId, table.triggeredAt),
  index("idx_shoppable_activations_sponsor").on(table.sponsorId),
  index("idx_shoppable_activations_slot").on(table.slotId),
  index("idx_shoppable_activations_source_time").on(table.source, table.triggeredAt),
]);

// TV sessions — state of an active Vio TV SDK instance for an end-user.
// UPSERTed at SDK init (POST /api/sdk/tv/session/start). Not per-connection.
// One row per (client_app, user, platform). Closed by inactivity or explicit end.
export const tvSessions = pgTable("tv_sessions", {
  id: serial("id").primaryKey(),
  clientAppId: integer("client_app_id").notNull().references(() => clientApps.id, { onDelete: 'cascade' }),
  endUserId: integer("end_user_id").notNull().references(() => endUsers.id, { onDelete: 'cascade' }),
  /** SDK-generated persistent device identifier (IDFV / ANDROID_ID / UUID). Optional for debug. */
  tvDeviceId: varchar("tv_device_id", { length: 255 }),
  platform: varchar("platform", { length: 20 }).notNull(),  // 'apple-tv' | 'android-tv' | ...
  startedAt: timestamp("started_at").defaultNow().notNull(),
  lastSeenAt: timestamp("last_seen_at").defaultNow().notNull(),
  endedAt: timestamp("ended_at"),
}, (t) => [
  uniqueIndex("uniq_tv_sessions_app_user_platform").on(t.clientAppId, t.endUserId, t.platform),
  index("idx_tv_sessions_last_seen").on(t.endUserId, t.lastSeenAt),
]);

// Cart intents — user indicated intent to buy after seeing a shoppable_ad or placement.
// Replaces the fire-and-forget behaviour of /api/campaigns/:id/cart-intent with full persistence.
// Carries the attribution chain: source_activation_id (from shoppable_ad) or source_component_id (from a placement).
export const cartIntents = pgTable("cart_intents", {
  id: serial("id").primaryKey(),
  endUserId: integer("end_user_id").notNull().references(() => endUsers.id, { onDelete: 'cascade' }),
  campaignId: integer("campaign_id").notNull().references(() => campaigns.id, { onDelete: 'cascade' }),
  clientAppId: integer("client_app_id").notNull().references(() => clientApps.id, { onDelete: 'cascade' }),
  tvSessionId: integer("tv_session_id").references(() => tvSessions.id, { onDelete: 'set null' }),
  sponsorId: integer("sponsor_id").references(() => sponsors.id, { onDelete: 'set null' }),
  productId: varchar("product_id", { length: 255 }).notNull(),  // external Commerce id
  sourceActivationId: integer("source_activation_id").references(() => shoppableAdActivations.id, { onDelete: 'set null' }),
  sourceComponentId: integer("source_component_id").references(() => campaignComponents.id, { onDelete: 'set null' }),
  deliveryMode: varchar("delivery_mode", { length: 20 }).notNull(),  // 'websocket' | 'dual' | 'webhook' | 'apns' | 'dropped'
  userConnected: boolean("user_connected").notNull(),
  envelope: json("envelope").notNull(),  // v1 canonical envelope shipped to the client / partner
  metadata: json("metadata"),
  triggeredAt: timestamp("triggered_at").defaultNow().notNull(),
}, (t) => [
  index("idx_cart_intents_campaign_time").on(t.campaignId, t.triggeredAt),
  index("idx_cart_intents_end_user_time").on(t.endUserId, t.triggeredAt),
  index("idx_cart_intents_source_activation").on(t.sourceActivationId),
  index("idx_cart_intents_sponsor").on(t.sponsorId),
  index("idx_cart_intents_delivery_mode_time").on(t.deliveryMode, t.triggeredAt),
]);

export const insertCampaignSponsorSchema = createInsertSchema(campaignSponsors).omit({ id: true, createdAt: true });
export const insertBroadcastCampaignSchema = createInsertSchema(broadcastCampaigns).omit({ id: true, createdAt: true });
export const insertBroadcastSponsorSlotSchema = createInsertSchema(broadcastSponsorSlots).omit({ id: true, createdAt: true }).extend({
  productIds: z.array(z.number()).optional(),
  type: z.enum(['product', 'lead', 'poll_cta', 'contest_cta', 'link']).default('product'),
  config: z.record(z.any()).optional(),
});
export const shoppableAdSourceEnum = z.enum(['admin-api', 'dashboard', 'tv-sdk', 'slot-scheduler']);
export const insertShoppableAdActivationSchema = createInsertSchema(shoppableAdActivations)
  .omit({ id: true, triggeredAt: true })
  .extend({
    source: shoppableAdSourceEnum,
    productSnapshot: z.record(z.any()),
    sponsorSnapshot: z.record(z.any()).optional().nullable(),
    metadata: z.record(z.any()).optional().nullable(),
  });

export type CampaignSponsor = typeof campaignSponsors.$inferSelect;
export type InsertCampaignSponsor = z.infer<typeof insertCampaignSponsorSchema>;
export type BroadcastCampaign = typeof broadcastCampaigns.$inferSelect;
export type InsertBroadcastCampaign = z.infer<typeof insertBroadcastCampaignSchema>;
export type BroadcastSponsorSlot = typeof broadcastSponsorSlots.$inferSelect;
export type InsertBroadcastSponsorSlot = z.infer<typeof insertBroadcastSponsorSlotSchema>;
export type ShoppableAdActivation = typeof shoppableAdActivations.$inferSelect;
export type InsertShoppableAdActivation = z.infer<typeof insertShoppableAdActivationSchema>;
export type ShoppableAdSource = z.infer<typeof shoppableAdSourceEnum>;

// --- Multi-sponsor redesign: new entities ---

export const tvPlatformEnum = z.enum(['apple-tv', 'android-tv', 'fire-tv', 'roku']);
export const cartIntentDeliveryModeEnum = z.enum(['websocket', 'dual', 'webhook', 'apns', 'dropped']);

export const insertEndUserSchema = createInsertSchema(endUsers).omit({ id: true, firstSeenAt: true, lastSeenAt: true });
export const insertTvSessionSchema = createInsertSchema(tvSessions).omit({ id: true, startedAt: true, lastSeenAt: true, endedAt: true })
  .extend({ platform: tvPlatformEnum });
export const insertCartIntentSchema = createInsertSchema(cartIntents).omit({ id: true, triggeredAt: true })
  .extend({
    deliveryMode: cartIntentDeliveryModeEnum,
    envelope: z.record(z.any()),
    metadata: z.record(z.any()).optional().nullable(),
  });

export type EndUser = typeof endUsers.$inferSelect;
export type InsertEndUser = z.infer<typeof insertEndUserSchema>;
export type TvSession = typeof tvSessions.$inferSelect;
export type InsertTvSession = z.infer<typeof insertTvSessionSchema>;
export type CartIntent = typeof cartIntents.$inferSelect;
export type InsertCartIntent = z.infer<typeof insertCartIntentSchema>;
export type TvPlatform = z.infer<typeof tvPlatformEnum>;
export type CartIntentDeliveryMode = z.infer<typeof cartIntentDeliveryModeEnum>;

// Relations
export const usersRelations = relations(users, ({ many }) => ({
  campaigns: many(campaigns),
  clientApps: many(clientApps),
  sponsors: many(sponsors)
}));

export const sponsorsRelations = relations(sponsors, ({ one, many }) => ({
  user: one(users, {
    fields: [sponsors.userId],
    references: [users.id]
  }),
  campaigns: many(campaigns),
  campaignSponsors: many(campaignSponsors),
  broadcastSponsorSlots: many(broadcastSponsorSlots),
}));

export const clientAppsRelations = relations(clientApps, ({ one, many }) => ({
  user: one(users, {
    fields: [clientApps.userId],
    references: [users.id]
  }),
  channels: many(channels),
  campaigns: many(campaigns),
  appComponentLocations: many(appComponentLocations),
  appPlacements: many(appPlacements)
}));

export const appComponentLocationsRelations = relations(appComponentLocations, ({ one }) => ({
  clientApp: one(clientApps, {
    fields: [appComponentLocations.clientAppId],
    references: [clientApps.id]
  })
}));

export const appPlacementsRelations = relations(appPlacements, ({ one }) => ({
  clientApp: one(clientApps, {
    fields: [appPlacements.clientAppId],
    references: [clientApps.id]
  }),
  component: one(components, {
    fields: [appPlacements.componentId],
    references: [components.id]
  })
}));

export const channelsRelations = relations(channels, ({ one, many }) => ({
  clientApp: one(clientApps, {
    fields: [channels.clientAppId],
    references: [clientApps.id]
  }),
  campaigns: many(campaigns)
}));

export const campaignsRelations = relations(campaigns, ({ one, many }) => ({
  user: one(users, {
    fields: [campaigns.userId],
    references: [users.id]
  }),
  clientApp: one(clientApps, {
    fields: [campaigns.clientAppId],
    references: [clientApps.id]
  }),
  channel: one(channels, {
    fields: [campaigns.channelId],
    references: [channels.id]
  }),
  primarySponsor: one(sponsors, {
    fields: [campaigns.primarySponsorId],
    references: [sponsors.id]
  }),
  events: many(events),
  formStates: many(campaignFormState),
  scheduledComponents: many(scheduledComponents),
  campaignComponents: many(campaignComponents),
  translations: many(campaignTranslations),
  engagementConfig: many(campaignEngagementConfig),
  uiConfig: many(campaignUiConfig),
  featureFlags: many(campaignFeatureFlags),
  broadcasts: many(broadcasts),
  campaignSponsors: many(campaignSponsors),
  broadcastCampaigns: many(broadcastCampaigns),
}));

export const campaignTranslationsRelations = relations(campaignTranslations, ({ one }) => ({
  campaign: one(campaigns, {
    fields: [campaignTranslations.campaignId],
    references: [campaigns.id]
  })
}));

export const campaignEngagementConfigRelations = relations(campaignEngagementConfig, ({ one }) => ({
  campaign: one(campaigns, {
    fields: [campaignEngagementConfig.campaignId],
    references: [campaigns.id]
  })
}));

export const campaignUiConfigRelations = relations(campaignUiConfig, ({ one }) => ({
  campaign: one(campaigns, {
    fields: [campaignUiConfig.campaignId],
    references: [campaigns.id]
  })
}));

export const campaignFeatureFlagsRelations = relations(campaignFeatureFlags, ({ one }) => ({
  campaign: one(campaigns, {
    fields: [campaignFeatureFlags.campaignId],
    references: [campaigns.id]
  })
}));

export const sdkTranslationsRelations = relations(sdkTranslations, ({ one }) => ({
  campaign: one(campaigns, {
    fields: [sdkTranslations.campaignId],
    references: [campaigns.id]
  })
}));

export const eventsRelations = relations(events, ({ one }) => ({
  campaign: one(campaigns, {
    fields: [events.campaignId],
    references: [campaigns.id]
  })
}));

export const campaignFormStateRelations = relations(campaignFormState, ({ one }) => ({
  campaign: one(campaigns, {
    fields: [campaignFormState.campaignId],
    references: [campaigns.id]
  })
}));

export const scheduledComponentsRelations = relations(scheduledComponents, ({ one }) => ({
  campaign: one(campaigns, {
    fields: [scheduledComponents.campaignId],
    references: [campaigns.id]
  })
}));

export const componentsRelations = relations(components, ({ many }) => ({
  appPlacements: many(appPlacements),
}));

export const campaignComponentsRelations = relations(campaignComponents, ({ one }) => ({
  campaign: one(campaigns, {
    fields: [campaignComponents.campaignId],
    references: [campaigns.id]
  }),
  appPlacement: one(appPlacements, {
    fields: [campaignComponents.appPlacementId],
    references: [appPlacements.id]
  }),
  sponsor: one(sponsors, {
    fields: [campaignComponents.sponsorId],
    references: [sponsors.id]
  })
}));

export const campaignSponsorsRelations = relations(campaignSponsors, ({ one }) => ({
  campaign: one(campaigns, { fields: [campaignSponsors.campaignId], references: [campaigns.id] }),
  sponsor: one(sponsors, { fields: [campaignSponsors.sponsorId], references: [sponsors.id] }),
}));

export const broadcastCampaignsRelations = relations(broadcastCampaigns, ({ one }) => ({
  broadcast: one(broadcasts, { fields: [broadcastCampaigns.broadcastId], references: [broadcasts.broadcastId] }),
  campaign: one(campaigns, { fields: [broadcastCampaigns.campaignId], references: [campaigns.id] }),
}));

export const broadcastSponsorSlotsRelations = relations(broadcastSponsorSlots, ({ one, many }) => ({
  broadcast: one(broadcasts, { fields: [broadcastSponsorSlots.broadcastId], references: [broadcasts.broadcastId] }),
  sponsor: one(sponsors, { fields: [broadcastSponsorSlots.sponsorId], references: [sponsors.id] }),
  campaign: one(campaigns, { fields: [broadcastSponsorSlots.campaignId], references: [campaigns.id] }),
  activations: many(shoppableAdActivations),
}));

export const shoppableAdActivationsRelations = relations(shoppableAdActivations, ({ one }) => ({
  broadcast: one(broadcasts, { fields: [shoppableAdActivations.broadcastId], references: [broadcasts.broadcastId] }),
  campaign: one(campaigns, { fields: [shoppableAdActivations.campaignId], references: [campaigns.id] }),
  sponsor: one(sponsors, { fields: [shoppableAdActivations.sponsorId], references: [sponsors.id] }),
  slot: one(broadcastSponsorSlots, { fields: [shoppableAdActivations.slotId], references: [broadcastSponsorSlots.id] }),
  clientApp: one(clientApps, { fields: [shoppableAdActivations.clientAppId], references: [clientApps.id] }),
}));

export const broadcastsRelations = relations(broadcasts, ({ one, many }) => ({
  campaign: one(campaigns, {
    fields: [broadcasts.campaignId],
    references: [campaigns.id]
  }),
  channel: one(channels, {
    fields: [broadcasts.channelId],
    references: [channels.id]
  }),
  creator: one(users, {
    fields: [broadcasts.createdBy],
    references: [users.id]
  }),
  polls: many(polls),
  contests: many(contests),
  ads: many(broadcastAds),
  products: many(broadcastProducts),
  chatMessages: many(chatMessages),
  broadcastCampaigns: many(broadcastCampaigns),
  sponsorSlots: many(broadcastSponsorSlots),
}));

export const broadcastAdsRelations = relations(broadcastAds, ({ one }) => ({
  broadcast: one(broadcasts, {
    fields: [broadcastAds.broadcastId],
    references: [broadcasts.broadcastId]
  })
}));

export const broadcastProductsRelations = relations(broadcastProducts, ({ one }) => ({
  broadcast: one(broadcasts, {
    fields: [broadcastProducts.broadcastId],
    references: [broadcasts.broadcastId]
  })
}));

export const chatMessagesRelations = relations(chatMessages, ({ one }) => ({
  broadcast: one(broadcasts, {
    fields: [chatMessages.broadcastId],
    references: [broadcasts.broadcastId]
  })
}));

export const pollsRelations = relations(polls, ({ one, many }) => ({
  broadcast: one(broadcasts, {
    fields: [polls.broadcastId],
    references: [broadcasts.broadcastId]
  }),
  options: many(pollOptions),
  votes: many(pollVotes)
}));

export const pollOptionsRelations = relations(pollOptions, ({ one }) => ({
  poll: one(polls, {
    fields: [pollOptions.pollId],
    references: [polls.id]
  })
}));

export const pollVotesRelations = relations(pollVotes, ({ one }) => ({
  poll: one(polls, {
    fields: [pollVotes.pollId],
    references: [polls.id]
  }),
  option: one(pollOptions, {
    fields: [pollVotes.optionId],
    references: [pollOptions.id]
  })
}));

export const contestsRelations = relations(contests, ({ one, many }) => ({
  broadcast: one(broadcasts, {
    fields: [contests.broadcastId],
    references: [broadcasts.broadcastId]
  }),
  participations: many(contestParticipations)
}));

export const contestParticipationsRelations = relations(contestParticipations, ({ one }) => ({
  contest: one(contests, {
    fields: [contestParticipations.contestId],
    references: [contests.id]
  }),
  endUser: one(endUsers, {
    fields: [contestParticipations.endUserId],
    references: [endUsers.id]
  })
}));

// --- Multi-sponsor redesign: new relations ---
export const endUsersRelations = relations(endUsers, ({ one, many }) => ({
  clientApp: one(clientApps, { fields: [endUsers.clientAppId], references: [clientApps.id] }),
  tvSessions: many(tvSessions),
  cartIntents: many(cartIntents),
  pollVotes: many(pollVotes),
  contestParticipations: many(contestParticipations),
  deviceTokens: many(deviceTokens),
}));

export const tvSessionsRelations = relations(tvSessions, ({ one, many }) => ({
  clientApp: one(clientApps, { fields: [tvSessions.clientAppId], references: [clientApps.id] }),
  endUser: one(endUsers, { fields: [tvSessions.endUserId], references: [endUsers.id] }),
  cartIntents: many(cartIntents),
}));

export const cartIntentsRelations = relations(cartIntents, ({ one }) => ({
  endUser: one(endUsers, { fields: [cartIntents.endUserId], references: [endUsers.id] }),
  campaign: one(campaigns, { fields: [cartIntents.campaignId], references: [campaigns.id] }),
  clientApp: one(clientApps, { fields: [cartIntents.clientAppId], references: [clientApps.id] }),
  tvSession: one(tvSessions, { fields: [cartIntents.tvSessionId], references: [tvSessions.id] }),
  sponsor: one(sponsors, { fields: [cartIntents.sponsorId], references: [sponsors.id] }),
  sourceActivation: one(shoppableAdActivations, { fields: [cartIntents.sourceActivationId], references: [shoppableAdActivations.id] }),
  sourceComponent: one(campaignComponents, { fields: [cartIntents.sourceComponentId], references: [campaignComponents.id] }),
}));

// Insert Schemas
export const insertUserSchema = createInsertSchema(users).omit({ 
  id: true,
  createdAt: true 
});

export const insertSponsorSchema = createInsertSchema(sponsors).omit({ 
  id: true,
  createdAt: true 
});

export const insertClientAppSchema = createInsertSchema(clientApps).omit({ 
  id: true,
  createdAt: true 
});

export const insertSurfacePlatformSchema = createInsertSchema(surfacePlatforms).omit({
  id: true,
  createdAt: true
});

export const insertChannelSchema = createInsertSchema(channels).omit({
  id: true,
  createdAt: true
});

export const insertCampaignSchema = createInsertSchema(campaigns).omit({ 
  id: true,
  createdAt: true 
});

// Update schema for campaign - accepts ISO date strings instead of Date objects
export const updateCampaignSchema = insertCampaignSchema.partial().extend({
  startDate: z.string().datetime().nullable().optional(),
  endDate: z.string().datetime().nullable().optional(),
  targetCountries: z.array(z.string()).nullable().optional(),
  targetPercentage: z.number().min(1).max(100).nullable().optional(),
  isSegmented: z.string().optional(),
  matchId: z.string().nullable().optional(),
  matchName: z.string().nullable().optional(),
  matchStartTime: z.string().datetime().nullable().optional()
});

export const insertEventSchema = createInsertSchema(events).omit({ 
  id: true,
  timestamp: true 
});

export const insertFormStateSchema = createInsertSchema(campaignFormState).omit({ 
  id: true,
  updatedAt: true 
});

export const insertScheduledComponentSchema = createInsertSchema(scheduledComponents).omit({ 
  id: true,
  createdAt: true 
});

export const insertComponentSchema = createInsertSchema(components).omit({ 
  id: true,
  createdAt: true 
});

export const insertCampaignComponentSchema = createInsertSchema(campaignComponents).omit({ 
  id: true,
  updatedAt: true 
});

export const insertAppComponentLocationSchema = createInsertSchema(appComponentLocations).omit({
  id: true,
  createdAt: true,
  updatedAt: true
});

export const insertAppPlacementSchema = createInsertSchema(appPlacements).omit({
  id: true,
  createdAt: true,
  updatedAt: true
});

export const insertCampaignTranslationSchema = createInsertSchema(campaignTranslations).omit({ 
  id: true 
});

export const insertCampaignEngagementConfigSchema = createInsertSchema(campaignEngagementConfig).omit({ 
  id: true 
});

export const insertCampaignUiConfigSchema = createInsertSchema(campaignUiConfig).omit({ 
  id: true 
});

export const insertCampaignFeatureFlagsSchema = createInsertSchema(campaignFeatureFlags).omit({ 
  id: true 
});

export const insertSdkTranslationSchema = createInsertSchema(sdkTranslations).omit({ 
  id: true 
});

export const insertBroadcastSchema = createInsertSchema(broadcasts).omit({
  createdAt: true,
  updatedAt: true
});

export const insertBroadcastAdSchema = createInsertSchema(broadcastAds).omit({
  id: true,
  createdAt: true
});

export const insertBroadcastProductSchema = createInsertSchema(broadcastProducts).omit({
  id: true,
  createdAt: true
});

export const insertChatMessageSchema = createInsertSchema(chatMessages).omit({
  id: true,
  createdAt: true
});

export const updateBroadcastSchema = insertBroadcastSchema.partial().extend({
  startTime: z.string().datetime().nullable().optional(),
  endTime: z.string().datetime().nullable().optional()
});

export const insertPollSchema = createInsertSchema(polls).omit({
  id: true,
  totalVotes: true,
  createdAt: true,
  updatedAt: true
});

export const insertPollOptionSchema = createInsertSchema(pollOptions).omit({
  id: true,
  voteCount: true,
  createdAt: true
});

export const insertPollVoteSchema = createInsertSchema(pollVotes).omit({
  id: true,
  createdAt: true
});

export const insertContestSchema = createInsertSchema(contests).omit({
  id: true,
  createdAt: true,
  updatedAt: true
});

export const insertContestParticipationSchema = createInsertSchema(contestParticipations).omit({
  id: true,
  createdAt: true
});

// API Input Validation Schemas
export const createPollInputSchema = z.object({
  question: z.string().min(1, "Question is required").max(500),
  options: z.array(z.union([z.string().min(1), z.object({ text: z.string().min(1) })])).min(2, "At least 2 options are required").max(20),
  duration: z.number().int().min(1).optional(),
  startTime: z.string().datetime().optional(),
  endTime: z.string().datetime().optional(),
  isActive: z.boolean().optional().default(true),
  videoStartTime: z.number().int().min(0).optional(),
  videoEndTime: z.number().int().min(0).optional(),
  broadcastStartTime: z.string().datetime().optional(),
});

export const createContestInputSchema = z.object({
  title: z.string().min(1, "Title is required").max(500),
  description: z.string().max(2000).optional(),
  prize: z.string().max(500).optional(),
  contestType: z.string().min(1, "Contest type is required").max(50),
  startTime: z.string().datetime().optional(),
  endTime: z.string().datetime().optional(),
  isActive: z.boolean().optional().default(true),
  videoStartTime: z.number().int().min(0).optional(),
  videoEndTime: z.number().int().min(0).optional(),
  broadcastStartTime: z.string().datetime().optional(),
});

export const voteInputSchema = z.object({
  optionId: z.number().int().positive("optionId is required"),
  userId: z.string().min(1, "userId is required").max(255),
  broadcastId: z.string().min(1, "broadcastId is required").max(255),
});

export const participateInputSchema = z.object({
  userId: z.string().min(1, "userId is required").max(255),
  broadcastId: z.string().min(1, "broadcastId is required").max(255),
  answers: z.record(z.any()).optional(),
});

// Types
export type User = typeof users.$inferSelect;
export type InsertUser = z.infer<typeof insertUserSchema>;
export type Sponsor = typeof sponsors.$inferSelect;
export type InsertSponsor = z.infer<typeof insertSponsorSchema>;
export type ClientApp = typeof clientApps.$inferSelect;
export type SurfacePlatform = typeof surfacePlatforms.$inferSelect;
export type InsertSurfacePlatform = z.infer<typeof insertSurfacePlatformSchema>;
/** Platform kinds a surface can have. Order drives the dashboard picker. */
export const SURFACE_PLATFORM_KINDS = ['web', 'ios', 'android', 'vev', 'apple-tv', 'android-tv', 'fire-tv'] as const;
export type SurfacePlatformKind = typeof SURFACE_PLATFORM_KINDS[number];
export type InsertClientApp = z.infer<typeof insertClientAppSchema>;
export type Channel = typeof channels.$inferSelect;
export type InsertChannel = z.infer<typeof insertChannelSchema>;
export type Campaign = typeof campaigns.$inferSelect;
export type InsertCampaign = z.infer<typeof insertCampaignSchema>;
export type UpdateCampaign = z.infer<typeof updateCampaignSchema>;
export type Event = typeof events.$inferSelect;
export type InsertEvent = z.infer<typeof insertEventSchema>;
export type CampaignFormState = typeof campaignFormState.$inferSelect;
export type InsertFormState = z.infer<typeof insertFormStateSchema>;
export type ScheduledComponent = typeof scheduledComponents.$inferSelect;
export type InsertScheduledComponent = z.infer<typeof insertScheduledComponentSchema>;
export type Component = typeof components.$inferSelect;
export type InsertComponent = z.infer<typeof insertComponentSchema>;
export type CampaignComponent = typeof campaignComponents.$inferSelect;
export type InsertCampaignComponent = z.infer<typeof insertCampaignComponentSchema>;
export type AppComponentLocation = typeof appComponentLocations.$inferSelect;
export type InsertAppComponentLocation = z.infer<typeof insertAppComponentLocationSchema>;
export type AppPlacement = typeof appPlacements.$inferSelect;
export type InsertAppPlacement = z.infer<typeof insertAppPlacementSchema>;
export type CampaignTranslation = typeof campaignTranslations.$inferSelect;
export type InsertCampaignTranslation = z.infer<typeof insertCampaignTranslationSchema>;
export type CampaignEngagementConfig = typeof campaignEngagementConfig.$inferSelect;
export type InsertCampaignEngagementConfig = z.infer<typeof insertCampaignEngagementConfigSchema>;
export type CampaignUiConfig = typeof campaignUiConfig.$inferSelect;
export type InsertCampaignUiConfig = z.infer<typeof insertCampaignUiConfigSchema>;
export type CampaignFeatureFlags = typeof campaignFeatureFlags.$inferSelect;
export type InsertCampaignFeatureFlags = z.infer<typeof insertCampaignFeatureFlagsSchema>;
export type SdkTranslation = typeof sdkTranslations.$inferSelect;
export type InsertSdkTranslation = z.infer<typeof insertSdkTranslationSchema>;
export type Broadcast = typeof broadcasts.$inferSelect;
export type InsertBroadcast = z.infer<typeof insertBroadcastSchema>;
export type UpdateBroadcast = z.infer<typeof updateBroadcastSchema>;
export type Poll = typeof polls.$inferSelect;
export type InsertPoll = z.infer<typeof insertPollSchema>;
export type PollOptionRecord = typeof pollOptions.$inferSelect;
export type InsertPollOption = z.infer<typeof insertPollOptionSchema>;
export type PollVote = typeof pollVotes.$inferSelect;
export type InsertPollVote = z.infer<typeof insertPollVoteSchema>;
export type Contest = typeof contests.$inferSelect;
export type InsertContest = z.infer<typeof insertContestSchema>;
export type ContestParticipation = typeof contestParticipations.$inferSelect;
export type InsertContestParticipation = z.infer<typeof insertContestParticipationSchema>;
export type BroadcastAd = typeof broadcastAds.$inferSelect;
export type InsertBroadcastAd = z.infer<typeof insertBroadcastAdSchema>;
export type BroadcastProduct = typeof broadcastProducts.$inferSelect;
export type InsertBroadcastProduct = z.infer<typeof insertBroadcastProductSchema>;
export type ChatMessage = typeof chatMessages.$inferSelect;
export type InsertChatMessage = z.infer<typeof insertChatMessageSchema>;

// Event schemas
export const productEventSchema = z.object({
  id: z.number().optional(),
  type: z.literal("product"),
  data: z.object({
    id: z.string(),
    productId: z.string(),
    name: z.string(),
    description: z.string(),
    price: z.string(),
    currency: z.string().default("USD"),
    imageUrl: z.string().url().optional()
  }),
  campaignLogo: z.string().optional(),
  timestamp: z.number()
});

export const pollOptionSchema = z.object({
  text: z.string(),
  imageUrl: z.string().optional()
});

export const pollEventSchema = z.object({
  id: z.number().optional(),
  type: z.literal("poll"),
  broadcastId: z.string().optional(),
  data: z.object({
    id: z.string(),
    question: z.string(),
    options: z.array(pollOptionSchema),
    duration: z.number(),
    imageUrl: z.string().url().optional()
  }),
  campaignLogo: z.string().optional(),
  timestamp: z.number()
});

export const contestEventSchema = z.object({
  id: z.number().optional(),
  type: z.literal("contest"),
  broadcastId: z.string().optional(),
  data: z.object({
    id: z.string(),
    name: z.string(),
    prize: z.string(),
    deadline: z.string(),
    maxParticipants: z.number()
  }),
  campaignLogo: z.string().optional(),
  timestamp: z.number()
});

export const webSocketEventSchema = z.union([
  productEventSchema,
  pollEventSchema,
  contestEventSchema
]);

// Types
export type PollOption = z.infer<typeof pollOptionSchema>;
export type ProductEvent = z.infer<typeof productEventSchema>;
export type PollEvent = z.infer<typeof pollEventSchema>;
export type ContestEvent = z.infer<typeof contestEventSchema>;
export type WebSocketEvent = z.infer<typeof webSocketEventSchema>;

// Connection status type
export type ConnectionStatus = 'connected' | 'disconnected' | 'connecting';

// Scheduled Component Schemas
export const carouselComponentSchema = z.object({
  type: z.literal("carousel"),
  productIds: z.array(z.string()), // IDs de productos de Reachu
  autoRotate: z.boolean().default(true),
  intervalSeconds: z.number().default(5)
});

export const storeViewComponentSchema = z.object({
  type: z.literal("store_view"),
  categoryId: z.string().optional(),
  layout: z.enum(["grid", "list"]).default("grid"),
  maxItems: z.number().default(20)
});

export const productSpotlightComponentSchema = z.object({
  type: z.literal("product_spotlight"),
  productId: z.string(),
  highlightText: z.string().optional(),
  durationSeconds: z.number().default(30)
});

export const liveshowTriggerComponentSchema = z.object({
  type: z.literal("liveshow_trigger"),
  liveshowId: z.string(),
  autoStart: z.boolean().default(true)
});

export const customComponentSchema = z.object({
  type: z.literal("custom_component"),
  componentId: z.string() // References components table
});

export const scheduledComponentDataSchema = z.union([
  carouselComponentSchema,
  storeViewComponentSchema,
  productSpotlightComponentSchema,
  liveshowTriggerComponentSchema,
  customComponentSchema
]);

// Scheduled Component Types
export type CarouselComponent = z.infer<typeof carouselComponentSchema>;
export type StoreViewComponent = z.infer<typeof storeViewComponentSchema>;
export type ProductSpotlightComponent = z.infer<typeof productSpotlightComponentSchema>;
export type LiveshowTriggerComponent = z.infer<typeof liveshowTriggerComponentSchema>;
export type CustomComponent = z.infer<typeof customComponentSchema>;
export type ScheduledComponentData = z.infer<typeof scheduledComponentDataSchema>;


// Reachu Channel Schema (for API responses)
export const reachuChannelSchema = z.object({
  id: z.string(),
  name: z.string(),
  productCount: z.number()
});

export type ReachuChannel = z.infer<typeof reachuChannelSchema>;

// Dynamic Component Config Schemas
export const bannerComponentConfigSchema = z.object({
  imageUrl: z.string().url(),
  title: z.string(),
  subtitle: z.string().optional(),
  ctaText: z.string().optional(),
  ctaLink: z.string().url().optional()
});

export const countdownComponentConfigSchema = z.object({
  // Core (requeridos)
  endDate: z.string(), // ISO timestamp
  title: z.string(),
  
  // Visuales (opcionales)
  logoUrl: z.string().url().optional(),
  subtitle: z.string().optional(),
  backgroundImageUrl: z.string().url().optional(),
  backgroundColor: z.string().default("#FF6F61").optional(), // Default coral color
  discountBadgeText: z.string().optional(),
  ctaText: z.string().optional(),
  ctaLink: z.string().url().optional(),
  deeplink: z.string().optional(), // Priority over ctaLink for in-app navigation
  overlayOpacity: z.number().min(0).max(1).default(0.6).optional(),
  buttonColor: z.string().default("#FFFFFF").optional() // Default white
});

export const carouselAutoComponentConfigSchema = z.object({
  channelId: z.string(), // Reachu channel ID
  displayCount: z.number().default(5)
});

export const carouselManualComponentConfigSchema = z.object({
  productIds: z.array(z.string()),
  displayCount: z.number().default(5)
});

export const productSpotlightConfigSchema = z.object({
  productId: z.string(),
  highlightText: z.string().optional(),
  // Operator-controllable header (Sprint 2026-04-28 PM polish parity
  // with VProductCarousel). Both opt-in via the dashboard's
  // customConfig — when absent, no header strip renders and the
  // existing legacy layout is preserved bit-for-bit.
  title: z.string().optional(),
  showSponsorLogo: z.boolean().optional(),
  // Layout override — picks `VProductCard.Variant` on the SDK side.
  //   "hero"    → big featured card (legacy default)
  //   "list"    → horizontal compact (image left, info right)
  //   "minimal" → smallest, suggestion style
  //   "grid"    → vertical compact
  layout: z.enum(["hero", "list", "minimal", "grid"]).optional()
});

export const offerBadgeConfigSchema = z.object({
  text: z.string(),
  color: z.enum(["red", "blue", "green", "gold"]).default("red")
});

export const offerBannerConfigSchema = z.object({
  // logoUrl is OPTIONAL: when empty/absent the SDK auto-resolves
  // the placement's sponsor logo (sponsor.logoUrl by the row's
  // sponsorId). Operator only fills this in when they want to
  // override the sponsor branding for this specific banner.
  logoUrl: z.string().url().optional(),
  title: z.string(),
  subtitle: z.string().optional(),
  // backgroundImageUrl is the preferred way; backgroundColor is a fallback
  // for when the image fails or the operator wants a plain color.
  backgroundImageUrl: z.string().url().optional(),
  backgroundColor: z.string().optional(),
  countdownEndDate: z.string(), // ISO timestamp
  discountBadgeText: z.string(),
  ctaText: z.string(),
  ctaLink: z.string().url().optional(),
  overlayOpacity: z.number().min(0).max(1).default(0.4).optional(),
  // CTA button color (hex). When unset the SDK uses VioColors.primary.
  buttonColor: z.string().optional(),
  // Operator-controllable deeplink. The SDK's handleCTAAction priority
  // is `onNavigateToStore (host callback) > customDeeplink (init param)
  // > config.deeplinkUrl > ctaLink (external)`. So in-app hosts that
  // pass a callback win over an operator-set URL — operator's URL is a
  // fallback for hosts that don't intercept the tap.
  deeplinkUrl: z.string().optional(),
  // Semantic tag for the host-app callback to inspect (e.g.
  // "navigate_to_offers"). Useful when the host wants to route to
  // different in-app screens without parsing URL schemes.
  deeplinkAction: z.string().optional()
});

export const productCarouselConfigSchema = z.object({
  productIds: z.array(z.string()).optional(), // Optional: if empty/undefined, SDK fetches all channel products
  autoPlay: z.boolean().default(false),
  interval: z.number().default(3000),
  // Layout override the SDK accepts: "full" | "compact" | "horizontal".
  layout: z.string().optional(),
  // Operator-controllable header — see productSpotlightConfigSchema.
  title: z.string().optional(),
  showSponsorLogo: z.boolean().optional()
});

export const productBannerConfigSchema = z.object({
  // Content
  productId: z.string(),
  backgroundImageUrl: z.string().url(),
  title: z.string().optional(),
  subtitle: z.string().optional(),
  ctaText: z.string().optional(),
  ctaLink: z.string().url().optional(),
  deeplink: z.string().optional(),
  // Layout preset — adjusts banner height + font sizes in one pick.
  // Granular fields (bannerHeight, titleFontSize, etc.) override
  // the preset when explicitly set. Sprint 2026-04-28 PM Phase 2.
  layout: z.enum(["compact", "standard", "large"]).optional(),
  
  // Visual Customization (all optional with defaults)
  // Colors
  titleColor: z.string().default("#FFFFFF").optional(),
  subtitleColor: z.string().default("#F0F0F0").optional(),
  buttonBackgroundColor: z.string().default("#007AFF").optional(), // iOS blue
  buttonTextColor: z.string().default("#FFFFFF").optional(),
  backgroundColor: z.string().default("rgba(0, 0, 0, 0.3)").optional(), // Background color with alpha
  
  // Layout
  overlayOpacity: z.number().min(0).max(1).default(0.5).optional(),
  bannerHeight: z.number().default(200).optional(),
  titleFontSize: z.number().default(24).optional(),
  subtitleFontSize: z.number().default(16).optional(),
  buttonFontSize: z.number().default(14).optional(),
  
  // Alignment
  textAlignment: z.enum(["left", "center", "right"]).default("center").optional(),
  contentVerticalAlignment: z.enum(["top", "center", "bottom"]).default("center").optional(),

  // Operator opt-in: stamp the placement's sponsor logo on the
  // top-right corner of the banner (resolved by sponsorId →
  // sponsor.logoUrl). SVG-capable on the SDK side. Default off.
  showSponsorLogo: z.boolean().optional()
});

// One product entry inside a multi-sponsor store. Each entry pairs a
// productId with its owning sponsor so the SDK loads it via that
// sponsor's commerce key — letting one store surface SKUs from
// XXL + Elkjøp + Torshov in the same grid.
// Sprint 2026-04-28 PM Phase 2.
export const productStoreEntrySchema = z.object({
  productId: z.string(),
  sponsorId: z.number(),
});

export const productStoreConfigSchema = z.object({
  mode: z.enum(["all", "filtered"]).default("all"),
  // Legacy single-sponsor list — every productId fetched through the
  // placement's sponsorId (campaign_components.sponsor_id). Kept for
  // back-compat with rows authored before multi-sponsor shipped.
  productIds: z.array(z.string()).optional(),
  // Multi-sponsor curated list. When present, takes priority over
  // productIds and the SDK loads each product through its own
  // sponsor's commerce credentials. Operator builds this via the
  // dashboard's MultiSponsorProductPicker.
  products: z.array(productStoreEntrySchema).optional(),
  displayType: z.enum(["grid", "list"]).default("grid"),
  columns: z.number().default(2),
  // Operator-controllable header band rendered above the grid —
  // mirrors the carousel pattern. Both opt-in.
  title: z.string().optional(),
  showSponsorLogo: z.boolean().optional()
});

export const componentConfigSchema = z.union([
  bannerComponentConfigSchema,
  countdownComponentConfigSchema,
  carouselAutoComponentConfigSchema,
  carouselManualComponentConfigSchema,
  productSpotlightConfigSchema,
  offerBadgeConfigSchema,
  offerBannerConfigSchema,
  productCarouselConfigSchema,
  productBannerConfigSchema,
  productStoreConfigSchema
]);

// Dynamic Component Config Types
export type BannerComponentConfig = z.infer<typeof bannerComponentConfigSchema>;
export type CountdownComponentConfig = z.infer<typeof countdownComponentConfigSchema>;
export type CarouselAutoComponentConfig = z.infer<typeof carouselAutoComponentConfigSchema>;
export type CarouselManualComponentConfig = z.infer<typeof carouselManualComponentConfigSchema>;
export type ProductSpotlightConfig = z.infer<typeof productSpotlightConfigSchema>;
export type OfferBadgeConfig = z.infer<typeof offerBadgeConfigSchema>;
export type OfferBannerConfig = z.infer<typeof offerBannerConfigSchema>;
export type ProductCarouselConfig = z.infer<typeof productCarouselConfigSchema>;
export type ProductBannerConfig = z.infer<typeof productBannerConfigSchema>;
export type ProductStoreConfig = z.infer<typeof productStoreConfigSchema>;
export type ComponentConfig = z.infer<typeof componentConfigSchema>;

// Component types enum for validation
export const componentTypes = [
  'banner',
  'countdown',
  'carousel_auto',
  'carousel_manual',
  'product_spotlight',
  'offer_badge',
  'offer_banner',
  'product_carousel',
  'product_banner',
  'product_store'
] as const;

export type ComponentType = typeof componentTypes[number];

// SDK component name mapping for UI display
export const componentSDKNames: Record<ComponentType, string> = {
  'banner': 'RBanner',
  'countdown': 'RCountdown',
  'carousel_auto': 'RCarousel',
  'carousel_manual': 'RCarousel',
  'product_spotlight': 'RProductSpotlight',
  'offer_badge': 'ROfferBadge',
  'offer_banner': 'ROfferBannerDynamic',
  'product_carousel': 'RProductCarousel',
  'product_banner': 'RProductBanner',
  'product_store': 'RProductStore'
};
