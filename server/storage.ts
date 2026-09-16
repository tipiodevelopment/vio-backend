import { WebSocketEvent, Campaign, InsertCampaign, Event, InsertEvent, CampaignFormState, InsertFormState, ScheduledComponent, InsertScheduledComponent, Component, InsertComponent, CampaignComponent, InsertCampaignComponent, AppComponentLocation, InsertAppComponentLocation, AppPlacement, InsertAppPlacement, User, InsertUser, ClientApp, InsertClientApp, Channel, InsertChannel, CampaignTranslation, InsertCampaignTranslation, CampaignEngagementConfig, InsertCampaignEngagementConfig, CampaignUiConfig, InsertCampaignUiConfig, CampaignFeatureFlags, InsertCampaignFeatureFlags, SdkTranslation, InsertSdkTranslation, Broadcast, InsertBroadcast, Poll, InsertPoll, PollOptionRecord, InsertPollOption, PollVote, InsertPollVote, Contest, InsertContest, ContestParticipation, InsertContestParticipation, Sponsor, InsertSponsor, BroadcastAd, InsertBroadcastAd, BroadcastProduct, InsertBroadcastProduct, ChatMessage, InsertChatMessage, DeviceToken, InsertDeviceToken, SportmonksCache, type InsertCampaignSponsor, type InsertBroadcastSponsorSlot, type InsertShoppableAdActivation, type ShoppableAdActivation, type EndUser, type TvSession, type CartIntent, type InsertCartIntent, type TvPlatform, type SurfacePlatform } from "@shared/schema";
import { db } from "./db";
import { campaigns, events, campaignFormState, scheduledComponents, components, campaignComponents, appComponentLocations, appPlacements, users, clientApps, channels, campaignTranslations, campaignEngagementConfig, campaignUiConfig, campaignFeatureFlags, sdkTranslations, broadcasts, polls, pollOptions, pollVotes, contests, contestParticipations, sponsors, broadcastAds, broadcastProducts, chatMessages, deviceTokens, sportmonksCache, campaignSponsors, broadcastSponsorSlots, shoppableAdActivations, endUsers, tvSessions, cartIntents, surfacePlatforms } from "@shared/schema";
import { eq, desc, and, or, gte, ne, isNull, isNotNull, sql, lte, inArray, notInArray } from "drizzle-orm";
import { enqueueAdActivationMirror, enqueueCartIntentMirror, isAnalyticsMirrorEnabled } from "./events/analytics-mirror";

export interface IStorage {
  addEvent(event: WebSocketEvent): Promise<void>;
  getRecentEvents(limit?: number): Promise<WebSocketEvent[]>;
  
  // User methods
  createUser(user: InsertUser): Promise<User>;
  getUser(id: number): Promise<User | undefined>;
  getUserByReachuId(reachuUserId: string): Promise<User | undefined>;
  getUserByFirebaseUid(firebaseUid: string): Promise<User | undefined>;
  getUserByEmailInsensitive(email: string): Promise<User | undefined>;
  getAllUsers(): Promise<User[]>;
  updateUser(id: number, user: Partial<InsertUser>): Promise<User | undefined>;
  deleteUser(id: number): Promise<void>;
  
  // Client App methods
  createClientApp(clientApp: InsertClientApp): Promise<ClientApp>;
  getClientApp(id: number): Promise<ClientApp | undefined>;
  getClientAppByApiKey(apiKey: string): Promise<ClientApp | undefined>;
  getClientAppByBundleId(bundleId: string): Promise<ClientApp | undefined>;
  getUserClientApps(userId: number): Promise<ClientApp[]>;
  getAllClientApps(): Promise<ClientApp[]>;
  getSurfacePlatforms(surfaceId: number): Promise<SurfacePlatform[]>;
  getPlatformsForSurfaces(surfaceIds: number[]): Promise<Map<number, SurfacePlatform[]>>;
  setSurfacePlatforms(
    surfaceId: number,
    platforms: Array<{ kind: string; identifier?: string | null; enabled?: boolean }>,
  ): Promise<SurfacePlatform[]>;
  updateClientApp(id: number, clientApp: Partial<InsertClientApp>): Promise<ClientApp | undefined>;
  deleteClientApp(id: number): Promise<void>;
  
  // Sponsor methods
  createSponsor(sponsor: InsertSponsor): Promise<Sponsor>;
  /** Auto-provisioning of a Commerce business: user (role sponsor) + its sponsor, in one transaction. */
  createBusinessOperator(data: {
    email: string | null;
    name: string | null;
    firebaseUid: string;
    reachuUserId: string | null;
    sponsorName: string;
  }): Promise<User>;
  findClaimableSponsorIds(channelApiKeys: string[]): Promise<number[]>;
  createOperatorForSponsor(data: {
    email: string | null;
    name: string | null;
    firebaseUid: string;
    reachuUserId: string | null;
    sponsorId: number;
  }): Promise<User | null>;
  getSponsor(id: number): Promise<Sponsor | undefined>;
  getUserSponsors(userId: number): Promise<Sponsor[]>;
  getAllSponsors(): Promise<Sponsor[]>;
  getSponsorUsage(sponsorId: number): Promise<{
    campaigns: Array<{ id: number; name: string; role: 'primary' | 'secondary'; surface: { id: number; name: string } | null }>;
    surfaces: Array<{ id: number; name: string }>;
    placements: number;
  }>;
  getSponsorStats(sponsorId: number): Promise<{ dispatches: number; cartIntents: number; sponsorSlots: number }>;
  updateSponsor(id: number, sponsor: Partial<InsertSponsor>): Promise<Sponsor | undefined>;
  deleteSponsor(id: number): Promise<void>;

  // Channel methods
  createChannel(channel: InsertChannel): Promise<Channel>;
  getChannel(id: number): Promise<Channel | undefined>;
  getClientAppChannels(clientAppId: number): Promise<Channel[]>;
  getUserChannels(userId: number): Promise<Channel[]>;
  getAllChannels(): Promise<Channel[]>;
  updateChannel(id: number, channel: Partial<InsertChannel>): Promise<Channel | undefined>;
  deleteChannel(id: number): Promise<void>;
  
  // Campaign methods
  createCampaign(campaign: InsertCampaign): Promise<Campaign>;
  getCampaign(id: number): Promise<Campaign | undefined>;
  getAllCampaigns(): Promise<Campaign[]>;
  getChannelCampaigns(channelId: number): Promise<Campaign[]>;
  getClientAppCampaigns(clientAppId: number): Promise<Campaign[]>;
  getUserCampaigns(userId: number): Promise<Campaign[]>;
  getSponsorsByApiKey(apiKey: string): Promise<Sponsor[]>;
  updateSponsorPaymentMethods(id: number, paymentMethods: string[]): Promise<Sponsor | undefined>;
  updateCampaign(id: number, campaign: Partial<InsertCampaign>): Promise<Campaign | undefined>;
  deleteCampaign(id: number): Promise<void>;
  
  // Campaign events methods
  addCampaignEvent(event: InsertEvent): Promise<Event>;
  getCampaignEvents(campaignId: number, limit?: number): Promise<Event[]>;
  
  // Form state methods
  saveFormState(state: InsertFormState): Promise<CampaignFormState>;
  getFormState(campaignId: number, formType: string): Promise<CampaignFormState | undefined>;
  getAllFormStates(campaignId: number): Promise<CampaignFormState[]>;
  
  // Scheduled component methods
  createScheduledComponent(component: InsertScheduledComponent): Promise<ScheduledComponent>;
  getScheduledComponent(id: number): Promise<ScheduledComponent | undefined>;
  getCampaignScheduledComponents(campaignId: number): Promise<ScheduledComponent[]>;
  getPendingScheduledComponents(campaignId: number): Promise<ScheduledComponent[]>;
  updateScheduledComponent(id: number, component: Partial<InsertScheduledComponent>): Promise<ScheduledComponent | undefined>;
  deleteScheduledComponent(id: number): Promise<void>;
  
  // Dynamic component methods
  createComponent(component: InsertComponent): Promise<Component>;
  getComponents(): Promise<Component[]>;
  getComponentById(id: string): Promise<Component | undefined>;
  updateComponent(id: string, component: Partial<InsertComponent>): Promise<Component | undefined>;
  deleteComponent(id: string): Promise<void>;
  getComponentUsage(): Promise<Record<string, Array<{ campaignId: number; campaignName: string }>>>;
  
  // Campaign component methods
  getCampaignComponents(campaignId: number): Promise<Array<CampaignComponent & { component: Component } & { sponsor: any }>>;
  getComponentCountsForCampaigns(campaignIds: number[]): Promise<Map<number, number>>;
  addComponentToCampaign(campaignComponent: InsertCampaignComponent): Promise<CampaignComponent>;
  updateCampaignComponentStatus(campaignId: number, componentId: string, status: 'active' | 'inactive'): Promise<CampaignComponent | undefined>;
  updateCampaignComponentLocationId(campaignId: number, componentId: string, locationId: string | null): Promise<CampaignComponent | undefined>;
  updateCampaignComponentConfig(campaignId: number, componentId: string, customConfig: any): Promise<CampaignComponent | undefined>;
  removeComponentFromCampaign(campaignId: number, componentId: string): Promise<void>;
  validateComponentAvailability(componentId: string, isTemplate: boolean, campaignId?: number): Promise<{ available: boolean; activeCampaignId?: number }>;
  
  /** Resolve `is_template=true` template id by type. Returns null if no
   *  template exists for that type. Used by dashboard "Add from library"
   *  to validate the operator's selection. */
  getCanonicalComponentByType(type: string): Promise<Component | null>;
  /** All read-only library templates (`is_template = true`). Source of the
   *  dashboard's library picker. */
  getCanonicalLibraryTemplates(): Promise<Component[]>;

  // App component locations — declared by SDK manifest (slots the dev's
  // app exposes). Sync semantics: locations not in a new manifest payload
  // get `deprecated_at = now()` instead of being deleted.
  getAppComponentLocations(clientAppId: number, includeDeprecated?: boolean): Promise<AppComponentLocation[]>;
  /** Idempotent upsert by (client_app_id, location_id). Updates display_name +
   *  updated_at + clears deprecated_at if row exists. */
  upsertAppComponentLocation(clientAppId: number, locationId: string, displayName: string | null): Promise<AppComponentLocation>;
  /** Soft-delete locations not present in the latest manifest payload. */
  deprecateAppComponentLocationsNotIn(clientAppId: number, keepLocationIds: string[]): Promise<number>;

  // App placements — named (template, location) instances created by the
  // operator via the dashboard `/apps/:id` "Add from library" form.
  /** List placements for a clientApp, joined with template metadata. */
  getAppPlacements(clientAppId: number, includeDeprecated?: boolean): Promise<Array<AppPlacement & { component: Component }>>;
  /** Lookup by id (joined). Used to validate dashboard picker selections. */
  getAppPlacementById(id: number): Promise<(AppPlacement & { component: Component }) | null>;
  /** Create a named placement. Validates: location is not deprecated, template is canonical. */
  createAppPlacement(args: {
    clientAppId: number;
    componentId: string;
    locationId: string;
    name: string;
    customConfig?: any;
    createdBy?: number;
  }): Promise<AppPlacement>;
  /** Soft-delete a placement (sets deprecated_at = now()). Existing
   *  campaign_components keep rendering with a dashboard warning. */
  deprecateAppPlacement(id: number): Promise<AppPlacement>;

  // Campaign translation methods
  getCampaignTranslations(campaignId: number): Promise<CampaignTranslation[]>;
  upsertCampaignTranslation(translation: InsertCampaignTranslation): Promise<CampaignTranslation>;
  deleteCampaignTranslation(campaignId: number, languageCode: string): Promise<void>;
  
  // Campaign engagement config methods
  getCampaignEngagementConfig(campaignId: number): Promise<CampaignEngagementConfig | undefined>;
  upsertCampaignEngagementConfig(config: InsertCampaignEngagementConfig): Promise<CampaignEngagementConfig>;
  
  // Campaign UI config methods
  getCampaignUiConfig(campaignId: number): Promise<CampaignUiConfig | undefined>;
  upsertCampaignUiConfig(config: InsertCampaignUiConfig): Promise<CampaignUiConfig>;
  
  // Campaign feature flags methods
  getCampaignFeatureFlags(campaignId: number): Promise<CampaignFeatureFlags | undefined>;
  upsertCampaignFeatureFlags(flags: InsertCampaignFeatureFlags): Promise<CampaignFeatureFlags>;
  
  // SDK translations methods
  getSdkTranslations(languageCode: string, campaignId?: number, matchId?: string): Promise<SdkTranslation[]>;
  upsertSdkTranslation(translation: InsertSdkTranslation): Promise<SdkTranslation>;
  deleteSdkTranslation(id: number): Promise<void>;
  
  // Full campaign config for SDK endpoints
  getFullCampaignConfig(campaignId: number): Promise<{
    campaign: Campaign;
    translations: CampaignTranslation[];
    engagementConfig: CampaignEngagementConfig | null;
    uiConfig: CampaignUiConfig | null;
    featureFlags: CampaignFeatureFlags | null;
  } | null>;
  
  // Broadcast methods
  createBroadcast(broadcast: InsertBroadcast): Promise<Broadcast>;
  getBroadcast(broadcastId: string): Promise<Broadcast | undefined>;
  getBroadcastByExternalId(externalId: string, clientAppId: number): Promise<Broadcast | undefined>;
  getAllBroadcasts(filters?: { status?: string; campaignId?: number }): Promise<Broadcast[]>;
  getCampaignBroadcasts(campaignId: number): Promise<Broadcast[]>;
  updateBroadcast(broadcastId: string, data: Partial<InsertBroadcast>): Promise<Broadcast | undefined>;
  deleteBroadcast(broadcastId: string): Promise<void>;
  getBroadcastsByStatus(status: string): Promise<Broadcast[]>;

  // Poll methods  
  createPoll(poll: InsertPoll): Promise<Poll>;
  getPoll(id: number): Promise<Poll | undefined>;
  getBroadcastPolls(broadcastId: string): Promise<Array<Poll & { options: PollOptionRecord[] }>>;
  updatePoll(id: number, data: Partial<InsertPoll>): Promise<Poll | undefined>;
  deletePoll(id: number): Promise<void>;

  // Poll option methods
  createPollOption(option: InsertPollOption): Promise<PollOptionRecord>;
  updatePollOptionVoteCount(optionId: number, increment: number): Promise<void>;

  // Poll vote methods
  createPollVote(vote: InsertPollVote): Promise<PollVote>;
  createPollVoteWithCountUpdate(vote: InsertPollVote, optionId: number): Promise<PollVote>;
  hasUserVoted(pollId: number, userId: string): Promise<boolean>;
  getPollResults(pollId: number): Promise<{ poll: Poll; options: PollOptionRecord[] } | null>;

  // Contest methods
  createContest(contest: InsertContest): Promise<Contest>;
  getContest(id: number): Promise<Contest | undefined>;
  getBroadcastContests(broadcastId: string): Promise<Contest[]>;
  getScheduledPollsForLiveBroadcasts(): Promise<Array<Poll & { campaignId: number | null }>>;
  getScheduledContestsForLiveBroadcasts(): Promise<Array<Contest & { campaignId: number | null }>>;
  updateContest(id: number, data: Partial<InsertContest>): Promise<Contest | undefined>;
  deleteContest(id: number): Promise<void>;

  // Contest participation methods
  createContestParticipation(participation: InsertContestParticipation): Promise<ContestParticipation>;
  createContestParticipationAtomic(participation: InsertContestParticipation): Promise<ContestParticipation>;
  hasUserParticipated(contestId: number, userId: string): Promise<boolean>;
  getContestParticipations(contestId: number): Promise<ContestParticipation[]>;

  // Pagination support
  getBroadcastPollsPaginated(broadcastId: string, options: { limit: number; offset: number }): Promise<Array<Poll & { options: PollOptionRecord[] }>>;
  getBroadcastPollsCount(broadcastId: string): Promise<number>;
  getBroadcastContestsPaginated(broadcastId: string, options: { limit: number; offset: number }): Promise<Contest[]>;
  getBroadcastContestsCount(broadcastId: string): Promise<number>;

  // Enrichment: poll/contest counts for multiple broadcasts
  getBroadcastEngagementCounts(broadcastIds: string[]): Promise<Map<string, { pollCount: number; activePollCount: number; contestCount: number }>>;
  getCampaignEngagementTotals(campaignIds: number[]): Promise<Map<number, number>>;

  // Broadcast Ads methods
  getBroadcastAds(broadcastId: string): Promise<BroadcastAd[]>;
  createBroadcastAd(ad: InsertBroadcastAd): Promise<BroadcastAd>;
  updateBroadcastAd(id: number, data: Partial<InsertBroadcastAd>): Promise<BroadcastAd | undefined>;
  deleteBroadcastAd(id: number): Promise<void>;

  // Broadcast Products methods
  getBroadcastProducts(broadcastId: string): Promise<BroadcastProduct[]>;
  createBroadcastProduct(product: InsertBroadcastProduct): Promise<BroadcastProduct>;
  updateBroadcastProduct(id: number, data: Partial<InsertBroadcastProduct>): Promise<BroadcastProduct | undefined>;
  deleteBroadcastProduct(id: number): Promise<void>;

  // Chat Messages methods
  getChatMessages(broadcastId: string, limit?: number): Promise<ChatMessage[]>;
  createChatMessage(message: InsertChatMessage): Promise<ChatMessage>;
  deleteChatMessage(id: number): Promise<void>;
  seedPollVotes(pollId: number, options: { id: number; voteCount: number }[]): Promise<Poll | undefined>;

  // Device Token methods
  upsertDeviceToken(campaignId: number, userId: string, deviceToken: string, platform: string): Promise<DeviceToken>;
  getDeviceToken(campaignId: number, userId: string): Promise<DeviceToken | undefined>;
  getDeviceTokens(campaignId: number, userId: string): Promise<DeviceToken[]>;

  // Sportmonks cache methods
  getSportmonksCache(cacheType: string, leagueId?: number | null, dateFrom?: string | null, dateTo?: string | null): Promise<SportmonksCache | undefined>;
  upsertSportmonksCache(cacheType: string, data: any, leagueId?: number | null, dateFrom?: string | null, dateTo?: string | null): Promise<SportmonksCache>;

  // Campaign Sponsors methods
  getCampaignSponsors(campaignId: number): Promise<Array<{ id: number; sponsorId: number; campaignId: number; role: string; name: string; logoUrl: string | null; primaryColor: string | null; secondaryColor: string | null }>>;
  addCampaignSponsor(data: { campaignId: number; sponsorId: number; role: string }): Promise<any>;
  removeCampaignSponsor(campaignId: number, sponsorId: number): Promise<void>;

  // Broadcast Sponsor Slots methods
  getBroadcastSponsorSlots(broadcastId: string): Promise<any[]>;
  getBroadcastSponsorSlot(id: number): Promise<any | undefined>;
  createBroadcastSponsorSlot(data: any): Promise<any>;
  updateBroadcastSponsorSlot(id: number, data: any): Promise<any | undefined>;
  deleteBroadcastSponsorSlot(id: number): Promise<void>;

  // Shoppable Ad Activations methods (one row per shoppable_ad dispatch)
  createShoppableAdActivation(data: InsertShoppableAdActivation): Promise<ShoppableAdActivation>;
  getShoppableAdActivation(id: number): Promise<ShoppableAdActivation | undefined>;
  listShoppableAdActivationsByBroadcast(broadcastId: string, options?: { limit?: number; offset?: number; sponsorId?: number; source?: string }): Promise<ShoppableAdActivation[]>;
  listShoppableAdActivationsByCampaign(campaignId: number, options?: { limit?: number; offset?: number; sponsorId?: number; source?: string }): Promise<ShoppableAdActivation[]>;

  // End users (SDK viewers) — opaque id per partner, unique per client_app
  ensureEndUser(clientAppId: number, externalUserId: string): Promise<EndUser>;
  getEndUser(clientAppId: number, externalUserId: string): Promise<EndUser | undefined>;
  touchEndUser(endUserId: number): Promise<void>;

  // TV sessions — one active session per (clientApp, user, platform)
  upsertTvSession(data: { clientAppId: number; endUserId: number; platform: TvPlatform; tvDeviceId?: string | null }): Promise<TvSession>;
  getActiveTvSession(clientAppId: number, endUserId: number, platform: TvPlatform): Promise<TvSession | undefined>;
  touchTvSession(sessionId: number): Promise<void>;
  endTvSession(sessionId: number): Promise<void>;

  // Cart intents — persistent log of user click-to-buy events with attribution
  createCartIntent(data: InsertCartIntent): Promise<CartIntent>;
  listCartIntentsByBroadcast(broadcastId: string, options?: { limit?: number; offset?: number }): Promise<CartIntent[]>;
  listCartIntentsByCampaign(campaignId: number, options?: { limit?: number; offset?: number }): Promise<CartIntent[]>;

  // Secondary sponsors — manage the M:N list (primary lives on campaigns.primary_sponsor_id)
  listSecondarySponsors(campaignId: number): Promise<Sponsor[]>;
  addSecondarySponsor(campaignId: number, sponsorId: number): Promise<void>;
  removeSecondarySponsor(campaignId: number, sponsorId: number): Promise<void>;

  // Convenience: returns `[primary, ...secondaries]` for callers that need to
  // iterate every sponsor of a campaign (e.g. commerce key resolution by
  // campaign-only fallback). The primary comes first so consumers picking
  // "first sponsor with X" naturally prefer the primary. If the campaign has
  // no primary or the primary points at a missing sponsor, the result is just
  // the secondaries — never throws.
  getAllCampaignSponsors(campaignId: number): Promise<Sponsor[]>;

  // Validation: a sponsor must be the campaign's primary or in its secondary list
  isSponsorAllowedForCampaign(sponsorId: number, campaignId: number): Promise<boolean>;

  // Check whether changing the primary sponsor is still allowed (no child rows yet)
  canChangePrimarySponsor(campaignId: number): Promise<boolean>;

  // getBroadcastsByCampaign alias
  getBroadcastsByCampaign(campaignId: number): Promise<Broadcast[]>;
}

export class MemStorage implements IStorage {
  private events: WebSocketEvent[] = [];

  async addEvent(event: WebSocketEvent): Promise<void> {
    this.events.unshift(event);
    // Keep only last 100 events
    if (this.events.length > 100) {
      this.events = this.events.slice(0, 100);
    }
  }

  async getRecentEvents(limit: number = 50): Promise<WebSocketEvent[]> {
    return this.events.slice(0, limit);
  }

  // User methods (database-backed)
  async createUser(user: InsertUser): Promise<User> {
    const [newUser] = await db.insert(users).values(user).returning();
    return newUser;
  }

  async getUser(id: number): Promise<User | undefined> {
    const [user] = await db.select().from(users).where(eq(users.id, id));
    return user || undefined;
  }

  async getUserByReachuId(reachuUserId: string): Promise<User | undefined> {
    const [user] = await db.select().from(users).where(eq(users.reachuUserId, reachuUserId));
    return user || undefined;
  }

  async getUserByFirebaseUid(firebaseUid: string): Promise<User | undefined> {
    const [user] = await db.select().from(users).where(eq(users.firebaseUid, firebaseUid));
    return user || undefined;
  }

  async getUserByEmailInsensitive(email: string): Promise<User | undefined> {
    const [user] = await db.select().from(users)
      .where(sql`lower(${users.email}) = ${email.toLowerCase()}`);
    return user || undefined;
  }

  async getAllUsers(): Promise<User[]> {
    return await db.select().from(users).orderBy(desc(users.createdAt));
  }

  async updateUser(id: number, user: Partial<InsertUser>): Promise<User | undefined> {
    const [updated] = await db.update(users)
      .set(user)
      .where(eq(users.id, id))
      .returning();
    return updated || undefined;
  }

  async deleteUser(id: number): Promise<void> {
    await db.delete(users).where(eq(users.id, id));
  }

  // Client App methods (database-backed)
  async createClientApp(clientApp: InsertClientApp): Promise<ClientApp> {
    const [newClientApp] = await db.insert(clientApps).values(clientApp).returning();
    return newClientApp;
  }

  async getClientApp(id: number): Promise<ClientApp | undefined> {
    const [clientApp] = await db.select().from(clientApps).where(eq(clientApps.id, id));
    return clientApp || undefined;
  }

  async getClientAppByApiKey(apiKey: string): Promise<ClientApp | undefined> {
    const [clientApp] = await db.select().from(clientApps).where(eq(clientApps.apiKey, apiKey));
    return clientApp || undefined;
  }

  async getClientAppByBundleId(bundleId: string): Promise<ClientApp | undefined> {
    const [clientApp] = await db.select().from(clientApps).where(eq(clientApps.bundleId, bundleId));
    return clientApp || undefined;
  }

  async getUserClientApps(userId: number): Promise<ClientApp[]> {
    return await db.select().from(clientApps)
      .where(eq(clientApps.userId, userId))
      .orderBy(desc(clientApps.createdAt));
  }

  // ── Surface platforms (migration 0010) ─────────────────────────────────
  // A surface (client_apps row) spans web/iOS/Android/Vev/TV; identifiers are
  // per platform, so they live here rather than on the surface.

  async getSurfacePlatforms(surfaceId: number): Promise<SurfacePlatform[]> {
    return await db.select().from(surfacePlatforms)
      .where(eq(surfacePlatforms.surfaceId, surfaceId))
      .orderBy(surfacePlatforms.id);
  }

  /** Platforms for many surfaces at once — avoids N+1 when listing surfaces. */
  async getPlatformsForSurfaces(surfaceIds: number[]): Promise<Map<number, SurfacePlatform[]>> {
    const out = new Map<number, SurfacePlatform[]>();
    if (surfaceIds.length === 0) return out;
    const rows = await db.select().from(surfacePlatforms)
      .where(inArray(surfacePlatforms.surfaceId, surfaceIds))
      .orderBy(surfacePlatforms.id);
    for (const r of rows) {
      const list = out.get(r.surfaceId);
      if (list) list.push(r); else out.set(r.surfaceId, [r]);
    }
    return out;
  }

  /** Replace the whole platform set of a surface (what the dashboard form posts). */
  async setSurfacePlatforms(
    surfaceId: number,
    platforms: Array<{ kind: string; identifier?: string | null; enabled?: boolean }>,
  ): Promise<SurfacePlatform[]> {
    await db.delete(surfacePlatforms).where(eq(surfacePlatforms.surfaceId, surfaceId));
    if (platforms.length === 0) return [];
    await db.insert(surfacePlatforms).values(platforms.map((p) => ({
      surfaceId,
      kind: p.kind,
      identifier: p.identifier?.trim() ? p.identifier.trim() : null,
      enabled: p.enabled ?? true,
    })));
    return this.getSurfacePlatforms(surfaceId);
  }

  async getAllClientApps(): Promise<ClientApp[]> {
    return await db.select().from(clientApps).orderBy(desc(clientApps.createdAt));
  }

  async updateClientApp(id: number, clientApp: Partial<InsertClientApp>): Promise<ClientApp | undefined> {
    const [updated] = await db.update(clientApps)
      .set(clientApp)
      .where(eq(clientApps.id, id))
      .returning();
    return updated || undefined;
  }

  async deleteClientApp(id: number): Promise<void> {
    await db.delete(clientApps).where(eq(clientApps.id, id));
  }

  // Sponsor methods (database-backed)
  async createSponsor(sponsor: InsertSponsor): Promise<Sponsor> {
    const [newSponsor] = await db.insert(sponsors).values(sponsor).returning();
    return newSponsor;
  }

  async createBusinessOperator(data: {
    email: string | null;
    name: string | null;
    firebaseUid: string;
    reachuUserId: string | null;
    sponsorName: string;
  }): Promise<User> {
    return db.transaction(async (tx) => {
      const [user] = await tx.insert(users).values({
        email: data.email,
        name: data.name,
        firebaseUid: data.firebaseUid,
        reachuUserId: data.reachuUserId,
        role: "sponsor",
      }).returning();
      // The brand owns its own sponsor row (it is its own tenant).
      const [sponsor] = await tx.insert(sponsors).values({
        userId: user.id,
        name: data.sponsorName,
        commerceUserUid: data.firebaseUid,
      }).returning();
      const [linked] = await tx.update(users)
        .set({ sponsorId: sponsor.id })
        .where(eq(users.id, user.id))
        .returning();
      return linked;
    });
  }

  async findClaimableSponsorIds(channelApiKeys: string[]): Promise<number[]> {
    if (channelApiKeys.length === 0) return [];
    const rows = await db.select({ id: sponsors.id }).from(sponsors)
      .where(and(
        isNull(sponsors.commerceUserUid),
        inArray(sql`trim(${sponsors.commerceApiKey})`, channelApiKeys),
      ))
      .orderBy(sponsors.id);
    return rows.map((r) => r.id);
  }

  async createOperatorForSponsor(data: {
    email: string | null;
    name: string | null;
    firebaseUid: string;
    reachuUserId: string | null;
    sponsorId: number;
  }): Promise<User | null> {
    return db.transaction(async (tx) => {
      // Guarded claim: only if still unclaimed (a concurrent claim wins once).
      const claimed = await tx.update(sponsors)
        .set({ commerceUserUid: data.firebaseUid })
        .where(and(eq(sponsors.id, data.sponsorId), isNull(sponsors.commerceUserUid)))
        .returning({ id: sponsors.id });
      if (claimed.length === 0) return null;
      const [user] = await tx.insert(users).values({
        email: data.email,
        name: data.name,
        firebaseUid: data.firebaseUid,
        reachuUserId: data.reachuUserId,
        role: "sponsor",
        sponsorId: data.sponsorId,
      }).returning();
      return user;
    });
  }

  async getSponsor(id: number): Promise<Sponsor | undefined> {
    const [sponsor] = await db.select().from(sponsors).where(eq(sponsors.id, id));
    return sponsor || undefined;
  }

  async getUserSponsors(userId: number): Promise<Sponsor[]> {
    return await db.select().from(sponsors)
      .where(eq(sponsors.userId, userId))
      .orderBy(desc(sponsors.createdAt));
  }

  async getAllSponsors(): Promise<Sponsor[]> {
    return await db.select().from(sponsors).orderBy(desc(sponsors.createdAt));
  }

  // Sponsor "footprint" — where this brand is used (campaigns + surfaces +
  // placements). Powers the self-scoped /api/sponsor/me/usage view.
  async getSponsorUsage(sponsorId: number): Promise<{
    campaigns: Array<{ id: number; name: string; role: 'primary' | 'secondary'; surface: { id: number; name: string } | null }>;
    surfaces: Array<{ id: number; name: string }>;
    placements: number;
  }> {
    const rows = await db.select({
      id: campaigns.id,
      name: campaigns.name,
      primarySponsorId: campaigns.primarySponsorId,
      appId: campaigns.clientAppId,
      appName: clientApps.name,
    }).from(campaigns)
      .leftJoin(clientApps, eq(clientApps.id, campaigns.clientAppId))
      .where(or(
        eq(campaigns.primarySponsorId, sponsorId),
        inArray(campaigns.id,
          db.select({ id: campaignSponsors.campaignId }).from(campaignSponsors).where(eq(campaignSponsors.sponsorId, sponsorId))),
      ))
      .orderBy(campaigns.id);

    const campaignsOut = rows.map((r) => ({
      id: r.id,
      name: r.name,
      role: (r.primarySponsorId === sponsorId ? 'primary' : 'secondary') as 'primary' | 'secondary',
      surface: r.appId != null ? { id: r.appId, name: r.appName ?? `#${r.appId}` } : null,
    }));

    const surfacesMap = new Map<number, string>();
    for (const c of campaignsOut) if (c.surface) surfacesMap.set(c.surface.id, c.surface.name);
    const surfaces = Array.from(surfacesMap.entries(), ([id, name]) => ({ id, name }));

    const [pc] = await db.select({ n: sql<number>`count(*)::int` })
      .from(campaignComponents).where(eq(campaignComponents.sponsorId, sponsorId));

    return { campaigns: campaignsOut, surfaces, placements: pc?.n ?? 0 };
  }

  // Sponsor "data" — DB-side metrics for this brand (impressions/clicks live in
  // Mixpanel, not here). Powers /api/sponsor/me/stats.
  async getSponsorStats(sponsorId: number): Promise<{ dispatches: number; cartIntents: number; sponsorSlots: number }> {
    const [d] = await db.select({ n: sql<number>`count(*)::int` }).from(shoppableAdActivations).where(eq(shoppableAdActivations.sponsorId, sponsorId));
    const [c] = await db.select({ n: sql<number>`count(*)::int` }).from(cartIntents).where(eq(cartIntents.sponsorId, sponsorId));
    const [s] = await db.select({ n: sql<number>`count(*)::int` }).from(broadcastSponsorSlots).where(eq(broadcastSponsorSlots.sponsorId, sponsorId));
    return { dispatches: d?.n ?? 0, cartIntents: c?.n ?? 0, sponsorSlots: s?.n ?? 0 };
  }

  async updateSponsor(id: number, data: Partial<InsertSponsor>): Promise<Sponsor | undefined> {
    const [updated] = await db.update(sponsors)
      .set(data)
      .where(eq(sponsors.id, id))
      .returning();
    return updated || undefined;
  }

  async deleteSponsor(id: number): Promise<void> {
    await db.delete(sponsors).where(eq(sponsors.id, id));
  }

  // Channel methods (database-backed)
  async createChannel(channel: InsertChannel): Promise<Channel> {
    const [newChannel] = await db.insert(channels).values(channel).returning();
    return newChannel;
  }

  async getChannel(id: number): Promise<Channel | undefined> {
    const [channel] = await db.select().from(channels).where(eq(channels.id, id));
    return channel || undefined;
  }

  async getClientAppChannels(clientAppId: number): Promise<Channel[]> {
    return await db.select().from(channels)
      .where(eq(channels.clientAppId, clientAppId))
      .orderBy(desc(channels.createdAt));
  }

  async getUserChannels(userId: number): Promise<Channel[]> {
    const userApps = await db.select().from(clientApps)
      .where(eq(clientApps.userId, userId));
    const appIds = userApps.map(app => app.id);
    if (appIds.length === 0) return [];
    
    const results = await db.select().from(channels)
      .orderBy(desc(channels.createdAt));
    return results.filter(ch => appIds.includes(ch.clientAppId));
  }

  async getAllChannels(): Promise<Channel[]> {
    return await db.select().from(channels).orderBy(desc(channels.createdAt));
  }

  async updateChannel(id: number, channel: Partial<InsertChannel>): Promise<Channel | undefined> {
    const [updated] = await db.update(channels)
      .set(channel)
      .where(eq(channels.id, id))
      .returning();
    return updated || undefined;
  }

  async deleteChannel(id: number): Promise<void> {
    await db.delete(channels).where(eq(channels.id, id));
  }

  // Campaign methods (database-backed)
  async createCampaign(campaign: InsertCampaign): Promise<Campaign> {
    const [newCampaign] = await db.insert(campaigns).values(campaign).returning();
    return newCampaign;
  }

  async getCampaign(id: number): Promise<Campaign | undefined> {
    const [campaign] = await db.select().from(campaigns).where(eq(campaigns.id, id));
    return campaign || undefined;
  }

  async getAllCampaigns(): Promise<Campaign[]> {
    return await db.select().from(campaigns).orderBy(desc(campaigns.createdAt));
  }

  async getChannelCampaigns(channelId: number): Promise<Campaign[]> {
    return await db.select().from(campaigns)
      .where(eq(campaigns.channelId, channelId))
      .orderBy(desc(campaigns.createdAt));
  }

  async getClientAppCampaigns(clientAppId: number): Promise<Campaign[]> {
    return await db.select().from(campaigns)
      .where(eq(campaigns.clientAppId, clientAppId))
      .orderBy(desc(campaigns.createdAt));
  }

  async getUserCampaigns(userId: number): Promise<Campaign[]> {
    return await db.select().from(campaigns)
      .where(eq(campaigns.userId, userId))
      .orderBy(desc(campaigns.createdAt));
  }

  async getSponsorsByApiKey(apiKey: string): Promise<Sponsor[]> {
    const sponsorsList = await db.select().from(sponsors).where(eq(sponsors.commerceApiKey, apiKey));
    return sponsorsList || [];
  }

  async updateSponsorPaymentMethods(id: number, paymentMethods: string[]): Promise<Sponsor | undefined> {
    const [updated] = await db.update(sponsors)
      .set({ paymentMethods })
      .where(eq(sponsors.id, id))
      .returning();
    return updated || undefined;
  }

  async getBroadcastCountsForCampaigns(campaignIds: number[]): Promise<Map<number, number>> {
    if (campaignIds.length === 0) return new Map();
    const rows = await db
      .select({ campaignId: broadcasts.campaignId, count: sql<number>`count(*)::int` })
      .from(broadcasts)
      .where(inArray(broadcasts.campaignId, campaignIds))
      .groupBy(broadcasts.campaignId);
    return new Map(rows.map(r => [r.campaignId!, r.count]));
  }

  async updateCampaign(id: number, campaign: Partial<InsertCampaign>): Promise<Campaign | undefined> {
    const [updated] = await db.update(campaigns)
      .set(campaign)
      .where(eq(campaigns.id, id))
      .returning();
    return updated || undefined;
  }

  async deleteCampaign(id: number): Promise<void> {
    await db.delete(campaigns).where(eq(campaigns.id, id));
  }

  // Campaign events methods (database-backed)
  async addCampaignEvent(event: InsertEvent): Promise<Event> {
    const [newEvent] = await db.insert(events).values(event).returning();
    return newEvent;
  }

  async getCampaignEvents(campaignId: number, limit: number = 50): Promise<Event[]> {
    return await db.select()
      .from(events)
      .where(eq(events.campaignId, campaignId))
      .orderBy(desc(events.timestamp))
      .limit(limit);
  }

  // Form state methods (database-backed)
  async saveFormState(state: InsertFormState): Promise<CampaignFormState> {
    // Check if form state already exists
    const [existing] = await db.select()
      .from(campaignFormState)
      .where(
        and(
          eq(campaignFormState.campaignId, state.campaignId),
          eq(campaignFormState.formType, state.formType)
        )
      );

    if (existing) {
      // Update existing
      const [updated] = await db.update(campaignFormState)
        .set({ formData: state.formData, updatedAt: new Date() })
        .where(
          and(
            eq(campaignFormState.campaignId, state.campaignId),
            eq(campaignFormState.formType, state.formType)
          )
        )
        .returning();
      return updated;
    } else {
      // Create new
      const [newState] = await db.insert(campaignFormState).values(state).returning();
      return newState;
    }
  }

  async getFormState(campaignId: number, formType: string): Promise<CampaignFormState | undefined> {
    const [state] = await db.select()
      .from(campaignFormState)
      .where(
        and(
          eq(campaignFormState.campaignId, campaignId),
          eq(campaignFormState.formType, formType)
        )
      );
    return state || undefined;
  }

  async getAllFormStates(campaignId: number): Promise<CampaignFormState[]> {
    return await db.select()
      .from(campaignFormState)
      .where(eq(campaignFormState.campaignId, campaignId));
  }

  // Scheduled component methods (database-backed)
  async createScheduledComponent(component: InsertScheduledComponent): Promise<ScheduledComponent> {
    const [newComponent] = await db.insert(scheduledComponents).values(component).returning();
    return newComponent;
  }

  async getScheduledComponent(id: number): Promise<ScheduledComponent | undefined> {
    const [component] = await db.select().from(scheduledComponents).where(eq(scheduledComponents.id, id));
    return component || undefined;
  }

  async getCampaignScheduledComponents(campaignId: number): Promise<ScheduledComponent[]> {
    return await db.select()
      .from(scheduledComponents)
      .where(eq(scheduledComponents.campaignId, campaignId))
      .orderBy(scheduledComponents.scheduledTime);
  }

  async getPendingScheduledComponents(campaignId: number): Promise<ScheduledComponent[]> {
    const now = new Date();
    return await db.select()
      .from(scheduledComponents)
      .where(
        and(
          eq(scheduledComponents.campaignId, campaignId),
          eq(scheduledComponents.status, 'pending'),
          gte(scheduledComponents.scheduledTime, now)
        )
      )
      .orderBy(scheduledComponents.scheduledTime);
  }

  async updateScheduledComponent(id: number, component: Partial<InsertScheduledComponent>): Promise<ScheduledComponent | undefined> {
    const [updated] = await db.update(scheduledComponents)
      .set(component)
      .where(eq(scheduledComponents.id, id))
      .returning();
    return updated || undefined;
  }

  async deleteScheduledComponent(id: number): Promise<void> {
    await db.delete(scheduledComponents).where(eq(scheduledComponents.id, id));
  }

  // Dynamic component methods (database-backed)
  async createComponent(component: InsertComponent): Promise<Component> {
    const [newComponent] = await db.insert(components).values(component).returning();
    return newComponent;
  }

  async getComponents(): Promise<Component[]> {
    return await db.select().from(components).orderBy(desc(components.createdAt));
  }

  async getComponentById(id: string): Promise<Component | undefined> {
    const [component] = await db.select().from(components).where(eq(components.id, id));
    return component || undefined;
  }

  async updateComponent(id: string, component: Partial<InsertComponent>): Promise<Component | undefined> {
    const [updated] = await db.update(components)
      .set(component)
      .where(eq(components.id, id))
      .returning();
    return updated || undefined;
  }

  async deleteComponent(id: string): Promise<void> {
    await db.delete(components).where(eq(components.id, id));
  }

  /**
   * Component usage by template — for the library page's "used in N
   * campaigns" badge. Walks campaign_components → app_placements →
   * components since campaign_components no longer carries component_id
   * directly (post-migration 0004).
   */
  async getComponentUsage(): Promise<Record<string, Array<{ campaignId: number; campaignName: string }>>> {
    const results = await db.select({
      componentId: appPlacements.componentId,
      campaignId: campaigns.id,
      campaignName: campaigns.name
    })
      .from(campaignComponents)
      .innerJoin(appPlacements, eq(campaignComponents.appPlacementId, appPlacements.id))
      .innerJoin(campaigns, eq(campaignComponents.campaignId, campaigns.id));

    const usage: Record<string, Array<{ campaignId: number; campaignName: string }>> = {};
    for (const row of results) {
      if (!usage[row.componentId]) {
        usage[row.componentId] = [];
      }
      usage[row.componentId].push({
        campaignId: row.campaignId,
        campaignName: row.campaignName
      });
    }
    return usage;
  }

  /**
   * Campaign placements with the canonical template + named placement
   * + sponsor block joined in. Synthesizes the legacy `componentId` and
   * `locationId` fields on each row (sourced from `app_placements`) so
   * callers that predate migration 0004 keep working without rewrites.
   * Sponsor is shipped pre-formatted (helper below) so route handlers
   * can reuse the canonical shape — pattern introduced by Alan's
   * commits c49ebca + acaa3e8 on develop and preserved through the
   * placements merge.
   */
  async getCampaignComponents(campaignId: number): Promise<Array<CampaignComponent & { component: Component; componentId: string; locationId: string | null; appPlacement: AppPlacement; sponsor: any }>> {
    const results = await db.select()
      .from(campaignComponents)
      .innerJoin(appPlacements, eq(campaignComponents.appPlacementId, appPlacements.id))
      .innerJoin(components, eq(appPlacements.componentId, components.id))
      .leftJoin(sponsors, eq(campaignComponents.sponsorId, sponsors.id))
      .where(eq(campaignComponents.campaignId, campaignId));

    const formatSponsor = (sponsor: any): any => {
      return sponsor ? {
        id: sponsor.id,
        name: sponsor.name,
        avatarUrl: sponsor.avatarUrl,
        logoUrl: sponsor.logoUrl,
        primaryColor: sponsor.primaryColor,
        secondaryColor: sponsor.secondaryColor,
        commerce: {
          apiKey: sponsor.commerceApiKey,
          channelId: sponsor.commerceChannelId,
          paymentMethods: sponsor.paymentMethods ?? [],
        }
      } : null;
    };

    return results.map(row => ({
      ...row.campaign_components,
      // Legacy synthesized fields — column dropped from campaign_components
      // in migration 0004; values now sourced from app_placements.
      componentId: row.app_placements.componentId,
      locationId: row.app_placements.locationId,
      component: row.components,
      appPlacement: row.app_placements,
      sponsor: formatSponsor(row.sponsors),
    }));
  }

  async getComponentCountsForCampaigns(campaignIds: number[]): Promise<Map<number, number>> {
    if (campaignIds.length === 0) return new Map();
    const rows = await db
      .select({ campaignId: campaignComponents.campaignId, count: sql<number>`count(*)::int` })
      .from(campaignComponents)
      .where(inArray(campaignComponents.campaignId, campaignIds))
      .groupBy(campaignComponents.campaignId);
    return new Map(rows.map(r => [r.campaignId!, r.count]));
  }

  async addComponentToCampaign(campaignComponent: InsertCampaignComponent): Promise<CampaignComponent> {
    const [newCampaignComponent] = await db.insert(campaignComponents).values(campaignComponent).returning();
    return newCampaignComponent;
  }

  /**
   * Status toggle. The `componentId` parameter is the campaign_components
   * row PK (numeric, passed as a string from `req.params`). Pre-migration
   * the same parameter was the FK to `components.id`; the column is gone
   * post-migration 0004 so we look up by row PK now.
   */
  async updateCampaignComponentStatus(campaignId: number, componentId: string, status: 'active' | 'inactive'): Promise<CampaignComponent | undefined> {
    const rowId = parseInt(componentId);
    if (Number.isNaN(rowId)) return undefined;
    const updateData: any = {
      status,
      updatedAt: new Date()
    };
    if (status === 'active') {
      updateData.activatedAt = new Date();
    }
    const [updated] = await db.update(campaignComponents)
      .set(updateData)
      .where(
        and(
          eq(campaignComponents.campaignId, campaignId),
          eq(campaignComponents.id, rowId)
        )
      )
      .returning();
    return updated || undefined;
  }

  /**
   * NO-OP shim. `location_id` was dropped from `campaign_components` in
   * migration 0004 — the location now lives on the linked `app_placements`
   * row and is immutable from the campaign-side. Kept as a safety net for
   * callers that haven't been migrated yet; returns the row unchanged.
   */
  async updateCampaignComponentLocationId(campaignId: number, componentId: string, _locationId: string | null): Promise<CampaignComponent | undefined> {
    const rowId = parseInt(componentId);
    if (Number.isNaN(rowId)) return undefined;
    const [row] = await db.select()
      .from(campaignComponents)
      .where(and(
        eq(campaignComponents.campaignId, campaignId),
        eq(campaignComponents.id, rowId)
      ))
      .limit(1);
    return row || undefined;
  }

  async updateCampaignComponentConfig(campaignId: number, componentId: string, customConfig: any): Promise<CampaignComponent | undefined> {
    const rowId = parseInt(componentId);
    if (Number.isNaN(rowId)) return undefined;
    const [updated] = await db.update(campaignComponents)
      .set({
        customConfig,
        updatedAt: new Date()
      })
      .where(
        and(
          eq(campaignComponents.campaignId, campaignId),
          eq(campaignComponents.id, rowId)
        )
      )
      .returning();
    return updated || undefined;
  }

  async removeComponentFromCampaign(campaignId: number, componentId: string): Promise<void> {
    // componentId is actually the campaign component instance ID (from campaignComponents.id)
    await db.delete(campaignComponents)
      .where(
        and(
          eq(campaignComponents.campaignId, campaignId),
          eq(campaignComponents.id, parseInt(componentId))
        )
      );
  }

  /**
   * No longer enforced — kept as a stub for callers that predate migration
   * 0004. The new model allows the same template to be reused across
   * campaigns through different `app_placements` (different per-app named
   * instances), so the old "one-active-elsewhere" rule doesn't apply.
   * The partial UNIQUE index on `campaign_components` already enforces
   * "one active per (campaign, app_placement)".
   */
  async validateComponentAvailability(_componentId: string, _isTemplate: boolean, _campaignId?: number): Promise<{ available: boolean; activeCampaignId?: number }> {
    return { available: true };
  }
  
  /**
   * Resolve canonical (`is_template=true`) component template by type.
   * Used by the dashboard's "Add from library" form to validate operator
   * picks against the read-only library.
   */
  async getCanonicalComponentByType(type: string): Promise<Component | null> {
    const rows = await db.select()
      .from(components)
      .where(and(
        eq(components.type, type),
        eq(components.isTemplate, true)
      ))
      .limit(1);
    return rows[0] ?? null;
  }

  /** Read-only library: all canonical templates (`is_template=true`). */
  async getCanonicalLibraryTemplates(): Promise<Component[]> {
    return db.select()
      .from(components)
      .where(eq(components.isTemplate, true))
      .orderBy(components.type, components.name);
  }

  // App component location methods (manifest registry — sync semantics)
  async getAppComponentLocations(clientAppId: number, includeDeprecated: boolean = false): Promise<AppComponentLocation[]> {
    const conditions: any[] = [eq(appComponentLocations.clientAppId, clientAppId)];
    if (!includeDeprecated) {
      conditions.push(isNull(appComponentLocations.deprecatedAt));
    }
    return db.select()
      .from(appComponentLocations)
      .where(and(...conditions))
      .orderBy(appComponentLocations.locationId);
  }

  /**
   * Soft-delete locations not present in the latest manifest payload. Sets
   * deprecated_at = now() on rows that are not in `keepLocationIds`. Returns
   * the number of rows deprecated.
   *
   * Idempotent: previously-deprecated rows that come back in a new payload
   * will have their deprecated_at cleared by `upsertAppComponentLocation`.
   */
  async deprecateAppComponentLocationsNotIn(clientAppId: number, keepLocationIds: string[]): Promise<number> {
    const conditions: any[] = [
      eq(appComponentLocations.clientAppId, clientAppId),
      isNull(appComponentLocations.deprecatedAt),
    ];
    if (keepLocationIds.length > 0) {
      conditions.push(notInArray(appComponentLocations.locationId, keepLocationIds));
    }
    const result = await db
      .update(appComponentLocations)
      .set({ deprecatedAt: new Date(), updatedAt: new Date() })
      .where(and(...conditions))
      .returning({ id: appComponentLocations.id });
    return result.length;
  }

  /**
   * Idempotent upsert keyed by (client_app_id, location_id). If the row
   * already exists, refreshes `display_name` + `updated_at` and returns the
   * updated row. Otherwise inserts a new row.
   *
   * The unique index on (client_app_id, location_id) protects against race
   * conditions if two SDK boots overlap.
   */
  async upsertAppComponentLocation(
    clientAppId: number,
    locationId: string,
    displayName: string | null
  ): Promise<AppComponentLocation> {
    const [row] = await db
      .insert(appComponentLocations)
      .values({ clientAppId, locationId, displayName })
      .onConflictDoUpdate({
        target: [appComponentLocations.clientAppId, appComponentLocations.locationId],
        set: {
          displayName,
          updatedAt: new Date(),
          // Clear deprecated_at on re-upload — location is back in the
          // manifest, so it's no longer deprecated.
          deprecatedAt: null,
        },
      })
      .returning();
    return row;
  }

  // App placements (named instances — created by dashboard `/apps/:id`
  // "Add from library" form; the SDK does NOT create these directly).
  async getAppPlacements(clientAppId: number, includeDeprecated: boolean = false): Promise<Array<AppPlacement & { component: Component }>> {
    const conditions: any[] = [eq(appPlacements.clientAppId, clientAppId)];
    if (!includeDeprecated) {
      conditions.push(isNull(appPlacements.deprecatedAt));
    }
    const rows = await db.select()
      .from(appPlacements)
      .innerJoin(components, eq(appPlacements.componentId, components.id))
      .where(and(...conditions))
      .orderBy(appPlacements.name);
    return rows.map(r => ({ ...r.app_placements, component: r.components }));
  }

  async getAppPlacementById(id: number): Promise<(AppPlacement & { component: Component }) | null> {
    const [row] = await db.select()
      .from(appPlacements)
      .innerJoin(components, eq(appPlacements.componentId, components.id))
      .where(eq(appPlacements.id, id))
      .limit(1);
    if (!row) return null;
    return { ...row.app_placements, component: row.components };
  }

  /**
   * Operator-driven creation. Validates:
   *   - location exists for this client app and is not deprecated
   *   - template is canonical (`is_template = true`)
   *   - dual-UNIQUE not violated (name unique per app, slot unique per app)
   *
   * Throws with `code` in {PLACEMENT_LOCATION_INVALID, PLACEMENT_TEMPLATE_INVALID,
   * PLACEMENT_NAME_COLLISION, PLACEMENT_SLOT_COLLISION} so the dashboard
   * can render specific UX per case.
   */
  async createAppPlacement(args: {
    clientAppId: number;
    componentId: string;
    locationId: string;
    name: string;
    customConfig?: any;
    createdBy?: number;
  }): Promise<AppPlacement> {
    const { clientAppId, componentId, locationId, name, customConfig, createdBy } = args;

    // 1. Validate location is declared + not deprecated.
    const [loc] = await db.select().from(appComponentLocations).where(and(
      eq(appComponentLocations.clientAppId, clientAppId),
      eq(appComponentLocations.locationId, locationId),
      isNull(appComponentLocations.deprecatedAt),
    )).limit(1);
    if (!loc) {
      const err: any = new Error(`location '${locationId}' not declared by app ${clientAppId} (or deprecated)`);
      err.code = 'PLACEMENT_LOCATION_INVALID';
      throw err;
    }

    // 2. Validate template is canonical (read-only library).
    const [tpl] = await db.select().from(components).where(and(
      eq(components.id, componentId),
      eq(components.isTemplate, true),
    )).limit(1);
    if (!tpl) {
      const err: any = new Error(`template '${componentId}' not in canonical library`);
      err.code = 'PLACEMENT_TEMPLATE_INVALID';
      throw err;
    }

    // 3. Validate name + slot uniqueness among non-deprecated rows.
    //    DB-level UNIQUE indexes also enforce (defense-in-depth) but this
    //    gives nicer errors with stable error codes.
    const [byName] = await db.select().from(appPlacements).where(and(
      eq(appPlacements.clientAppId, clientAppId),
      eq(appPlacements.name, name),
      isNull(appPlacements.deprecatedAt),
    )).limit(1);
    if (byName) {
      const err: any = new Error(`name '${name}' already used by app placement ${byName.id}`);
      err.code = 'PLACEMENT_NAME_COLLISION';
      throw err;
    }
    const [bySlot] = await db.select().from(appPlacements).where(and(
      eq(appPlacements.clientAppId, clientAppId),
      eq(appPlacements.componentId, componentId),
      eq(appPlacements.locationId, locationId),
      isNull(appPlacements.deprecatedAt),
    )).limit(1);
    if (bySlot) {
      const err: any = new Error(`slot (componentId=${componentId}, locationId=${locationId}) already claimed by placement '${bySlot.name}'`);
      err.code = 'PLACEMENT_SLOT_COLLISION';
      throw err;
    }

    const [row] = await db
      .insert(appPlacements)
      .values({
        clientAppId,
        componentId,
        locationId,
        name,
        customConfig: customConfig ?? null,
        createdBy: createdBy ?? null,
      })
      .returning();
    return row;
  }

  /**
   * Soft-delete: sets `deprecated_at = now()`. Existing campaign_components
   * referencing this placement keep rendering — the dashboard surfaces the
   * deprecated state with a warning so operators can clean up at their own pace.
   */
  async deprecateAppPlacement(id: number): Promise<AppPlacement> {
    const [row] = await db
      .update(appPlacements)
      .set({ deprecatedAt: new Date(), updatedAt: new Date() })
      .where(eq(appPlacements.id, id))
      .returning();
    if (!row) {
      const err: any = new Error(`app placement ${id} not found`);
      err.code = 'PLACEMENT_NOT_FOUND';
      throw err;
    }
    return row;
  }

  // Campaign translation methods
  async getCampaignTranslations(campaignId: number): Promise<CampaignTranslation[]> {
    return db.select()
      .from(campaignTranslations)
      .where(eq(campaignTranslations.campaignId, campaignId));
  }
  
  async upsertCampaignTranslation(translation: InsertCampaignTranslation): Promise<CampaignTranslation> {
    const existing = await db.select()
      .from(campaignTranslations)
      .where(and(
        eq(campaignTranslations.campaignId, translation.campaignId),
        eq(campaignTranslations.languageCode, translation.languageCode)
      ))
      .limit(1);
    
    if (existing.length > 0) {
      const [updated] = await db.update(campaignTranslations)
        .set(translation)
        .where(eq(campaignTranslations.id, existing[0].id))
        .returning();
      return updated;
    }
    
    const [created] = await db.insert(campaignTranslations).values(translation).returning();
    return created;
  }
  
  async deleteCampaignTranslation(campaignId: number, languageCode: string): Promise<void> {
    await db.delete(campaignTranslations)
      .where(and(
        eq(campaignTranslations.campaignId, campaignId),
        eq(campaignTranslations.languageCode, languageCode)
      ));
  }
  
  // Campaign engagement config methods
  async getCampaignEngagementConfig(campaignId: number): Promise<CampaignEngagementConfig | undefined> {
    const [config] = await db.select()
      .from(campaignEngagementConfig)
      .where(eq(campaignEngagementConfig.campaignId, campaignId))
      .limit(1);
    return config;
  }
  
  async upsertCampaignEngagementConfig(config: InsertCampaignEngagementConfig): Promise<CampaignEngagementConfig> {
    const existing = await db.select()
      .from(campaignEngagementConfig)
      .where(eq(campaignEngagementConfig.campaignId, config.campaignId))
      .limit(1);
    
    if (existing.length > 0) {
      const [updated] = await db.update(campaignEngagementConfig)
        .set(config)
        .where(eq(campaignEngagementConfig.id, existing[0].id))
        .returning();
      return updated;
    }
    
    const [created] = await db.insert(campaignEngagementConfig).values(config).returning();
    return created;
  }
  
  // Campaign UI config methods
  async getCampaignUiConfig(campaignId: number): Promise<CampaignUiConfig | undefined> {
    const [config] = await db.select()
      .from(campaignUiConfig)
      .where(eq(campaignUiConfig.campaignId, campaignId))
      .limit(1);
    return config;
  }
  
  async upsertCampaignUiConfig(config: InsertCampaignUiConfig): Promise<CampaignUiConfig> {
    const existing = await db.select()
      .from(campaignUiConfig)
      .where(eq(campaignUiConfig.campaignId, config.campaignId))
      .limit(1);
    
    if (existing.length > 0) {
      const [updated] = await db.update(campaignUiConfig)
        .set(config)
        .where(eq(campaignUiConfig.id, existing[0].id))
        .returning();
      return updated;
    }
    
    const [created] = await db.insert(campaignUiConfig).values(config).returning();
    return created;
  }
  
  // Campaign feature flags methods
  async getCampaignFeatureFlags(campaignId: number): Promise<CampaignFeatureFlags | undefined> {
    const [flags] = await db.select()
      .from(campaignFeatureFlags)
      .where(eq(campaignFeatureFlags.campaignId, campaignId))
      .limit(1);
    return flags;
  }
  
  async upsertCampaignFeatureFlags(flags: InsertCampaignFeatureFlags): Promise<CampaignFeatureFlags> {
    const existing = await db.select()
      .from(campaignFeatureFlags)
      .where(eq(campaignFeatureFlags.campaignId, flags.campaignId))
      .limit(1);
    
    if (existing.length > 0) {
      const [updated] = await db.update(campaignFeatureFlags)
        .set(flags)
        .where(eq(campaignFeatureFlags.id, existing[0].id))
        .returning();
      return updated;
    }
    
    const [created] = await db.insert(campaignFeatureFlags).values(flags).returning();
    return created;
  }
  
  // SDK translations methods - with priority: match > campaign > global
  async getSdkTranslations(languageCode: string, campaignId?: number, matchId?: string): Promise<SdkTranslation[]> {
    let translations: SdkTranslation[] = [];
    
    // First get global translations (where campaignId and matchId are null)
    const globalTranslations = await db.select()
      .from(sdkTranslations)
      .where(and(
        eq(sdkTranslations.languageCode, languageCode),
        isNull(sdkTranslations.campaignId),
        isNull(sdkTranslations.matchId)
      ));
    translations = globalTranslations;
    
    // Then get campaign-specific translations if campaignId provided
    if (campaignId) {
      const campaignTranslationsResult = await db.select()
        .from(sdkTranslations)
        .where(and(
          eq(sdkTranslations.languageCode, languageCode),
          eq(sdkTranslations.campaignId, campaignId),
          isNull(sdkTranslations.matchId)
        ));
      
      // Merge campaign translations (override global)
      for (const ct of campaignTranslationsResult) {
        const idx = translations.findIndex(t => t.translationKey === ct.translationKey);
        if (idx >= 0) {
          translations[idx] = ct;
        } else {
          translations.push(ct);
        }
      }
    }
    
    // Finally get match-specific translations if matchId provided
    if (matchId && campaignId) {
      const matchTranslations = await db.select()
        .from(sdkTranslations)
        .where(and(
          eq(sdkTranslations.languageCode, languageCode),
          eq(sdkTranslations.campaignId, campaignId),
          eq(sdkTranslations.matchId, matchId)
        ));
      
      // Merge match translations (override campaign and global)
      for (const mt of matchTranslations) {
        const idx = translations.findIndex(t => t.translationKey === mt.translationKey);
        if (idx >= 0) {
          translations[idx] = mt;
        } else {
          translations.push(mt);
        }
      }
    }
    
    return translations;
  }
  
  async upsertSdkTranslation(translation: InsertSdkTranslation): Promise<SdkTranslation> {
    // Build conditions for finding existing translation
    const conditions = [
      eq(sdkTranslations.languageCode, translation.languageCode),
      eq(sdkTranslations.translationKey, translation.translationKey)
    ];
    
    if (translation.campaignId) {
      conditions.push(eq(sdkTranslations.campaignId, translation.campaignId));
    } else {
      conditions.push(isNull(sdkTranslations.campaignId));
    }
    
    if (translation.matchId) {
      conditions.push(eq(sdkTranslations.matchId, translation.matchId));
    } else {
      conditions.push(isNull(sdkTranslations.matchId));
    }
    
    const existing = await db.select()
      .from(sdkTranslations)
      .where(and(...conditions))
      .limit(1);
    
    if (existing.length > 0) {
      const [updated] = await db.update(sdkTranslations)
        .set(translation)
        .where(eq(sdkTranslations.id, existing[0].id))
        .returning();
      return updated;
    }
    
    const [created] = await db.insert(sdkTranslations).values(translation).returning();
    return created;
  }
  
  async deleteSdkTranslation(id: number): Promise<void> {
    await db.delete(sdkTranslations).where(eq(sdkTranslations.id, id));
  }
  
  // Full campaign config for SDK endpoints
  async getFullCampaignConfig(campaignId: number): Promise<{
    campaign: Campaign;
    translations: CampaignTranslation[];
    engagementConfig: CampaignEngagementConfig | null;
    uiConfig: CampaignUiConfig | null;
    featureFlags: CampaignFeatureFlags | null;
  } | null> {
    const campaign = await this.getCampaign(campaignId);
    if (!campaign) return null;
    
    const [translations, engagementConfig, uiConfig, featureFlagsResult] = await Promise.all([
      this.getCampaignTranslations(campaignId),
      this.getCampaignEngagementConfig(campaignId),
      this.getCampaignUiConfig(campaignId),
      this.getCampaignFeatureFlags(campaignId)
    ]);
    
    return {
      campaign,
      translations,
      engagementConfig: engagementConfig || null,
      uiConfig: uiConfig || null,
      featureFlags: featureFlagsResult || null
    };
  }

  // Broadcast methods (database-backed)
  async createBroadcast(broadcast: InsertBroadcast): Promise<Broadcast> {
    const [newBroadcast] = await db.insert(broadcasts).values(broadcast).returning();
    return newBroadcast;
  }

  async getBroadcast(broadcastId: string): Promise<Broadcast | undefined> {
    const [broadcast] = await db.select().from(broadcasts).where(eq(broadcasts.broadcastId, broadcastId));
    return broadcast || undefined;
  }

  async getBroadcastByExternalId(externalId: string, clientAppId: number): Promise<Broadcast | undefined> {
    const result = await db
      .select({ broadcast: broadcasts })
      .from(broadcasts)
      .innerJoin(campaigns, eq(broadcasts.campaignId, campaigns.id))
      .leftJoin(channels, eq(campaigns.channelId, channels.id))
      .where(and(
        eq(broadcasts.externalId, externalId),
        or(
          eq(channels.clientAppId, clientAppId),
          eq(campaigns.clientAppId, clientAppId)
        )
      ))
      .limit(1);
    return result[0]?.broadcast || undefined;
  }

  async getAllBroadcasts(filters?: { status?: string; campaignId?: number }): Promise<Broadcast[]> {
    const conditions: any[] = [];
    if (filters?.status) {
      conditions.push(eq(broadcasts.status, filters.status));
    }
    if (filters?.campaignId) {
      conditions.push(eq(broadcasts.campaignId, filters.campaignId));
    }
    if (conditions.length > 0) {
      return await db.select().from(broadcasts).where(and(...conditions)).orderBy(desc(broadcasts.createdAt));
    }
    return await db.select().from(broadcasts).orderBy(desc(broadcasts.createdAt));
  }

  async getCampaignBroadcasts(campaignId: number): Promise<Broadcast[]> {
    return await db.select().from(broadcasts)
      .where(eq(broadcasts.campaignId, campaignId))
      .orderBy(desc(broadcasts.createdAt));
  }

  async updateBroadcast(broadcastId: string, data: Partial<InsertBroadcast>): Promise<Broadcast | undefined> {
    const [updated] = await db.update(broadcasts)
      .set({ ...data, updatedAt: new Date() })
      .where(eq(broadcasts.broadcastId, broadcastId))
      .returning();
    return updated || undefined;
  }

  async deleteBroadcast(broadcastId: string): Promise<void> {
    await db.delete(broadcasts).where(eq(broadcasts.broadcastId, broadcastId));
  }

  async getBroadcastsByStatus(status: string): Promise<Broadcast[]> {
    return await db.select().from(broadcasts)
      .where(eq(broadcasts.status, status))
      .orderBy(desc(broadcasts.createdAt));
  }

  // Poll methods (database-backed)
  async createPoll(poll: InsertPoll): Promise<Poll> {
    const [newPoll] = await db.insert(polls).values(poll).returning();
    return newPoll;
  }

  async getPoll(id: number): Promise<Poll | undefined> {
    const [poll] = await db.select().from(polls).where(eq(polls.id, id));
    return poll || undefined;
  }

  async getBroadcastPolls(broadcastId: string): Promise<Array<Poll & { options: PollOptionRecord[] }>> {
    const broadcastPolls = await db.select().from(polls)
      .where(eq(polls.broadcastId, broadcastId))
      .orderBy(desc(polls.createdAt));
    
    const result: Array<Poll & { options: PollOptionRecord[] }> = [];
    for (const poll of broadcastPolls) {
      const options = await db.select().from(pollOptions)
        .where(eq(pollOptions.pollId, poll.id))
        .orderBy(pollOptions.displayOrder);
      result.push({ ...poll, options });
    }
    return result;
  }

  async updatePoll(id: number, data: Partial<InsertPoll>): Promise<Poll | undefined> {
    const [updated] = await db.update(polls)
      .set({ ...data, updatedAt: new Date() })
      .where(eq(polls.id, id))
      .returning();
    return updated || undefined;
  }

  async deletePoll(id: number): Promise<void> {
    await db.delete(polls).where(eq(polls.id, id));
  }

  // Poll option methods (database-backed)
  async createPollOption(option: InsertPollOption): Promise<PollOptionRecord> {
    const [newOption] = await db.insert(pollOptions).values(option).returning();
    return newOption;
  }

  async updatePollOptionVoteCount(optionId: number, increment: number): Promise<void> {
    await db.update(pollOptions)
      .set({ voteCount: sql`${pollOptions.voteCount} + ${increment}` })
      .where(eq(pollOptions.id, optionId));
  }

  // Poll vote methods (database-backed)
  async createPollVote(vote: InsertPollVote): Promise<PollVote> {
    const [newVote] = await db.insert(pollVotes).values(vote).returning();
    await db.update(polls)
      .set({ totalVotes: sql`${polls.totalVotes} + 1` })
      .where(eq(polls.id, vote.pollId));
    return newVote;
  }

  async createPollVoteWithCountUpdate(vote: InsertPollVote, optionId: number): Promise<PollVote> {
    return await db.transaction(async (tx) => {
      // 1. Check duplicate inside transaction to prevent race conditions
      const [existing] = await tx.select().from(pollVotes)
        .where(and(eq(pollVotes.pollId, vote.pollId), eq(pollVotes.userId, vote.userId!)))
        .limit(1);
      if (existing) {
        throw new Error('User has already voted on this poll');
      }
      // 2. Insert vote
      const [newVote] = await tx.insert(pollVotes).values(vote).returning();
      // 3. Increment option count
      await tx.update(pollOptions)
        .set({ voteCount: sql`${pollOptions.voteCount} + 1` })
        .where(eq(pollOptions.id, optionId));
      // 4. Increment poll total
      await tx.update(polls)
        .set({ totalVotes: sql`${polls.totalVotes} + 1` })
        .where(eq(polls.id, vote.pollId));
      return newVote;
    });
  }

  async hasUserVoted(pollId: number, userId: string): Promise<boolean> {
    const [vote] = await db.select().from(pollVotes)
      .where(and(
        eq(pollVotes.pollId, pollId),
        eq(pollVotes.userId, userId)
      ))
      .limit(1);
    return !!vote;
  }

  async getPollResults(pollId: number): Promise<{ poll: Poll; options: PollOptionRecord[] } | null> {
    const [poll] = await db.select().from(polls).where(eq(polls.id, pollId));
    if (!poll) return null;
    const options = await db.select().from(pollOptions)
      .where(eq(pollOptions.pollId, pollId))
      .orderBy(pollOptions.displayOrder);
    return { poll, options };
  }

  // Contest methods (database-backed)
  async createContest(contest: InsertContest): Promise<Contest> {
    const [newContest] = await db.insert(contests).values(contest).returning();
    return newContest;
  }

  async getContest(id: number): Promise<Contest | undefined> {
    const [contest] = await db.select().from(contests).where(eq(contests.id, id));
    return contest || undefined;
  }

  async getBroadcastContests(broadcastId: string): Promise<Contest[]> {
    return await db.select().from(contests)
      .where(eq(contests.broadcastId, broadcastId))
      .orderBy(desc(contests.createdAt));
  }

  async getScheduledPollsForLiveBroadcasts(): Promise<Array<Poll & { campaignId: number | null }>> {
    const rows = await db
      .select({ poll: polls, campaignId: broadcasts.campaignId })
      .from(polls)
      .innerJoin(broadcasts, eq(polls.broadcastId, broadcasts.broadcastId))
      .where(and(eq(broadcasts.status, 'live'), isNotNull(polls.scheduledStartTime)));
    return rows.map(r => ({ ...r.poll, campaignId: r.campaignId }));
  }

  async getScheduledContestsForLiveBroadcasts(): Promise<Array<Contest & { campaignId: number | null }>> {
    const rows = await db
      .select({ contest: contests, campaignId: broadcasts.campaignId })
      .from(contests)
      .innerJoin(broadcasts, eq(contests.broadcastId, broadcasts.broadcastId))
      .where(and(eq(broadcasts.status, 'live'), isNotNull(contests.scheduledStartTime)));
    return rows.map(r => ({ ...r.contest, campaignId: r.campaignId }));
  }

  async updateContest(id: number, data: Partial<InsertContest>): Promise<Contest | undefined> {
    const [updated] = await db.update(contests)
      .set({ ...data, updatedAt: new Date() })
      .where(eq(contests.id, id))
      .returning();
    return updated || undefined;
  }

  async deleteContest(id: number): Promise<void> {
    await db.delete(contests).where(eq(contests.id, id));
  }

  // Contest participation methods (database-backed)
  async createContestParticipation(participation: InsertContestParticipation): Promise<ContestParticipation> {
    const [newParticipation] = await db.insert(contestParticipations).values(participation).returning();
    return newParticipation;
  }

  async createContestParticipationAtomic(participation: InsertContestParticipation): Promise<ContestParticipation> {
    return await db.transaction(async (tx) => {
      const [newParticipation] = await tx.insert(contestParticipations).values(participation).returning();
      return newParticipation;
    });
  }

  async hasUserParticipated(contestId: number, userId: string): Promise<boolean> {
    const [participation] = await db.select().from(contestParticipations)
      .where(and(
        eq(contestParticipations.contestId, contestId),
        eq(contestParticipations.userId, userId)
      ))
      .limit(1);
    return !!participation;
  }

  async getContestParticipations(contestId: number): Promise<ContestParticipation[]> {
    return await db.select().from(contestParticipations)
      .where(eq(contestParticipations.contestId, contestId))
      .orderBy(desc(contestParticipations.createdAt));
  }

  // Pagination support methods
  async getBroadcastPollsPaginated(broadcastId: string, options: { limit: number; offset: number }): Promise<Array<Poll & { options: PollOptionRecord[] }>> {
    const broadcastPolls = await db.select().from(polls)
      .where(eq(polls.broadcastId, broadcastId))
      .orderBy(desc(polls.createdAt))
      .limit(options.limit)
      .offset(options.offset);

    const result: Array<Poll & { options: PollOptionRecord[] }> = [];
    for (const poll of broadcastPolls) {
      const opts = await db.select().from(pollOptions)
        .where(eq(pollOptions.pollId, poll.id))
        .orderBy(pollOptions.displayOrder);
      result.push({ ...poll, options: opts });
    }
    return result;
  }

  async getBroadcastPollsCount(broadcastId: string): Promise<number> {
    const [result] = await db.select({ count: sql<number>`count(*)::int` })
      .from(polls)
      .where(eq(polls.broadcastId, broadcastId));
    return result?.count ?? 0;
  }

  async getBroadcastContestsPaginated(broadcastId: string, options: { limit: number; offset: number }): Promise<Contest[]> {
    return await db.select().from(contests)
      .where(eq(contests.broadcastId, broadcastId))
      .orderBy(desc(contests.createdAt))
      .limit(options.limit)
      .offset(options.offset);
  }

  async getBroadcastContestsCount(broadcastId: string): Promise<number> {
    const [result] = await db.select({ count: sql<number>`count(*)::int` })
      .from(contests)
      .where(eq(contests.broadcastId, broadcastId));
    return result?.count ?? 0;
  }

  async getBroadcastEngagementCounts(broadcastIds: string[]): Promise<Map<string, { pollCount: number; activePollCount: number; contestCount: number }>> {
    const result = new Map<string, { pollCount: number; activePollCount: number; contestCount: number }>();
    if (broadcastIds.length === 0) return result;

    const pollCounts = await db
      .select({
        broadcastId: polls.broadcastId,
        total: sql<number>`count(*)::int`,
        active: sql<number>`count(*) filter (where ${polls.isActive} = true)::int`,
      })
      .from(polls)
      .where(inArray(polls.broadcastId, broadcastIds))
      .groupBy(polls.broadcastId);

    const contestCounts = await db
      .select({
        broadcastId: contests.broadcastId,
        total: sql<number>`count(*)::int`,
      })
      .from(contests)
      .where(inArray(contests.broadcastId, broadcastIds))
      .groupBy(contests.broadcastId);

    const contestMap = new Map(contestCounts.map(c => [c.broadcastId, c.total]));

    for (const id of broadcastIds) {
      const pollRow = pollCounts.find(p => p.broadcastId === id);
      result.set(id, {
        pollCount: pollRow?.total ?? 0,
        activePollCount: pollRow?.active ?? 0,
        contestCount: contestMap.get(id) ?? 0,
      });
    }

    return result;
  }

  async getCampaignEngagementTotals(campaignIds: number[]): Promise<Map<number, number>> {
    const result = new Map<number, number>();
    if (campaignIds.length === 0) return result;

    // Get votes per campaign (via broadcasts and polls)
    const votesCount = await db
      .select({
        campaignId: broadcasts.campaignId,
        total: sql<number>`count(${pollVotes.id})::int`,
      })
      .from(pollVotes)
      .innerJoin(polls, eq(pollVotes.pollId, polls.id))
      .innerJoin(broadcasts, eq(polls.broadcastId, broadcasts.broadcastId))
      .where(inArray(broadcasts.campaignId, campaignIds))
      .groupBy(broadcasts.campaignId);

    // Get participations per campaign (via broadcasts and contests)
    const participationCount = await db
      .select({
        campaignId: broadcasts.campaignId,
        total: sql<number>`count(${contestParticipations.id})::int`,
      })
      .from(contestParticipations)
      .innerJoin(contests, eq(contestParticipations.contestId, contests.id))
      .innerJoin(broadcasts, eq(contests.broadcastId, broadcasts.broadcastId))
      .where(inArray(broadcasts.campaignId, campaignIds))
      .groupBy(broadcasts.campaignId);

    for (const id of campaignIds) {
      const v = votesCount.find(r => r.campaignId === id)?.total ?? 0;
      const p = participationCount.find(r => r.campaignId === id)?.total ?? 0;
      result.set(id, v + p);
    }

    return result;
  }

  // Broadcast Ads
  async getBroadcastAds(broadcastId: string): Promise<BroadcastAd[]> {
    return db.select().from(broadcastAds)
      .where(eq(broadcastAds.broadcastId, broadcastId))
      .orderBy(broadcastAds.displayOrder, broadcastAds.createdAt);
  }

  async createBroadcastAd(ad: InsertBroadcastAd): Promise<BroadcastAd> {
    const [created] = await db.insert(broadcastAds).values(ad).returning();
    return created;
  }

  async updateBroadcastAd(id: number, data: Partial<InsertBroadcastAd>): Promise<BroadcastAd | undefined> {
    const [updated] = await db.update(broadcastAds).set(data).where(eq(broadcastAds.id, id)).returning();
    return updated;
  }

  async deleteBroadcastAd(id: number): Promise<void> {
    await db.delete(broadcastAds).where(eq(broadcastAds.id, id));
  }

  // Broadcast Products
  async getBroadcastProducts(broadcastId: string): Promise<BroadcastProduct[]> {
    return db.select().from(broadcastProducts)
      .where(eq(broadcastProducts.broadcastId, broadcastId))
      .orderBy(broadcastProducts.displayOrder, broadcastProducts.createdAt);
  }

  async createBroadcastProduct(product: InsertBroadcastProduct): Promise<BroadcastProduct> {
    const [created] = await db.insert(broadcastProducts).values(product).returning();
    return created;
  }

  async updateBroadcastProduct(id: number, data: Partial<InsertBroadcastProduct>): Promise<BroadcastProduct | undefined> {
    const [updated] = await db.update(broadcastProducts).set(data).where(eq(broadcastProducts.id, id)).returning();
    return updated;
  }

  async deleteBroadcastProduct(id: number): Promise<void> {
    await db.delete(broadcastProducts).where(eq(broadcastProducts.id, id));
  }

  // Chat Messages
  async getChatMessages(broadcastId: string, limit = 50): Promise<ChatMessage[]> {
    const messages = await db.select().from(chatMessages)
      .where(eq(chatMessages.broadcastId, broadcastId))
      .orderBy(desc(chatMessages.createdAt))
      .limit(limit);
    return messages.reverse();
  }

  async createChatMessage(message: InsertChatMessage): Promise<ChatMessage> {
    const [created] = await db.insert(chatMessages).values(message).returning();
    return created;
  }

  async deleteChatMessage(id: number): Promise<void> {
    await db.delete(chatMessages).where(eq(chatMessages.id, id));
  }

  async seedPollVotes(pollId: number, options: { id: number; voteCount: number }[]): Promise<Poll | undefined> {
    for (const opt of options) {
      await db.update(pollOptions)
        .set({ voteCount: opt.voteCount })
        .where(eq(pollOptions.id, opt.id));
    }
    const totalVotes = options.reduce((sum, o) => sum + o.voteCount, 0);
    const [updated] = await db.update(polls)
      .set({ totalVotes })
      .where(eq(polls.id, pollId))
      .returning();
    return updated;
  }

  // Device Tokens (APNs push notifications)
  async upsertDeviceToken(campaignId: number, userId: string, deviceToken: string, platform: string): Promise<DeviceToken> {
    const deviceId = deviceToken.length <= 255 ? deviceToken : deviceToken.slice(0, 255);
    const [result] = await db.insert(deviceTokens)
      .values({ campaignId, userId, deviceId, deviceToken, platform, updatedAt: new Date() })
      .onConflictDoUpdate({
        target: [deviceTokens.campaignId, deviceTokens.userId],
        set: { deviceId, deviceToken, platform, updatedAt: new Date() },
      })
      .returning();
    return result;
  }

  async getDeviceToken(campaignId: number, userId: string): Promise<DeviceToken | undefined> {
    const [token] = await db.select().from(deviceTokens)
      .where(and(eq(deviceTokens.campaignId, campaignId), eq(deviceTokens.userId, userId)));
    return token;
  }

  async getDeviceTokens(campaignId: number, userId: string): Promise<DeviceToken[]> {
    return await db
      .select()
      .from(deviceTokens)
      .where(
        and(
          eq(deviceTokens.campaignId, campaignId),
          eq(deviceTokens.userId, userId)
        )
      );
  }

  async getSportmonksCache(cacheType: string, leagueId?: number | null, dateFrom?: string | null, dateTo?: string | null): Promise<SportmonksCache | undefined> {
    const conditions = [eq(sportmonksCache.cacheType, cacheType)];
    if (leagueId != null) conditions.push(eq(sportmonksCache.leagueId, leagueId));
    if (dateFrom != null) conditions.push(eq(sportmonksCache.dateFrom, dateFrom));
    if (dateTo != null) conditions.push(eq(sportmonksCache.dateTo, dateTo));
    const [row] = await db.select().from(sportmonksCache).where(and(...conditions));
    return row;
  }

  async upsertSportmonksCache(cacheType: string, data: any, leagueId?: number | null, dateFrom?: string | null, dateTo?: string | null): Promise<SportmonksCache> {
    const existing = await this.getSportmonksCache(cacheType, leagueId, dateFrom, dateTo);
    if (existing) {
      const [updated] = await db.update(sportmonksCache)
        .set({ data, updatedAt: new Date() })
        .where(eq(sportmonksCache.id, existing.id))
        .returning();
      return updated;
    }
    const [created] = await db.insert(sportmonksCache)
      .values({ cacheType, leagueId: leagueId ?? null, dateFrom: dateFrom ?? null, dateTo: dateTo ?? null, data })
      .returning();
    return created;
  }

  async getCampaignSponsors(campaignId: number) {
    const rows = await db
      .select({
        id: campaignSponsors.id,
        sponsorId: campaignSponsors.sponsorId,
        campaignId: campaignSponsors.campaignId,
        role: campaignSponsors.role,
        name: sponsors.name,
        logoUrl: sponsors.logoUrl,
        primaryColor: sponsors.primaryColor,
        secondaryColor: sponsors.secondaryColor,
      })
      .from(campaignSponsors)
      .innerJoin(sponsors, eq(campaignSponsors.sponsorId, sponsors.id))
      .where(eq(campaignSponsors.campaignId, campaignId));
    return rows;
  }

  async addCampaignSponsor(data: { campaignId: number; sponsorId: number; role: string }) {
    const [row] = await db.insert(campaignSponsors).values(data).returning();
    return row;
  }

  async removeCampaignSponsor(campaignId: number, sponsorId: number) {
    await db.delete(campaignSponsors).where(
      and(eq(campaignSponsors.campaignId, campaignId), eq(campaignSponsors.sponsorId, sponsorId))
    );
  }

  async getBroadcastSponsorSlots(broadcastId: string) {
    const rows = await db
      .select({
        id: broadcastSponsorSlots.id,
        broadcastId: broadcastSponsorSlots.broadcastId,
        sponsorId: broadcastSponsorSlots.sponsorId,
        campaignId: broadcastSponsorSlots.campaignId,
        role: broadcastSponsorSlots.role,
        type: broadcastSponsorSlots.type,
        config: broadcastSponsorSlots.config,
        triggerType: broadcastSponsorSlots.triggerType,
        triggerValue: broadcastSponsorSlots.triggerValue,
        autoExecute: broadcastSponsorSlots.autoExecute,
        productIds: broadcastSponsorSlots.productIds,
        status: broadcastSponsorSlots.status,
        executedAt: broadcastSponsorSlots.executedAt,
        createdAt: broadcastSponsorSlots.createdAt,
        sponsorName: sponsors.name,
        sponsorLogoUrl: sponsors.logoUrl,
        sponsorPrimaryColor: sponsors.primaryColor,
      })
      .from(broadcastSponsorSlots)
      .innerJoin(sponsors, eq(broadcastSponsorSlots.sponsorId, sponsors.id))
      .where(eq(broadcastSponsorSlots.broadcastId, broadcastId))
      .orderBy(broadcastSponsorSlots.createdAt);
    return rows;
  }

  async getBroadcastSponsorSlot(id: number) {
    const [row] = await db
      .select({
        id: broadcastSponsorSlots.id,
        broadcastId: broadcastSponsorSlots.broadcastId,
        sponsorId: broadcastSponsorSlots.sponsorId,
        campaignId: broadcastSponsorSlots.campaignId,
        role: broadcastSponsorSlots.role,
        type: broadcastSponsorSlots.type,
        config: broadcastSponsorSlots.config,
        triggerType: broadcastSponsorSlots.triggerType,
        triggerValue: broadcastSponsorSlots.triggerValue,
        autoExecute: broadcastSponsorSlots.autoExecute,
        productIds: broadcastSponsorSlots.productIds,
        status: broadcastSponsorSlots.status,
        executedAt: broadcastSponsorSlots.executedAt,
        createdAt: broadcastSponsorSlots.createdAt,
        sponsorName: sponsors.name,
        sponsorLogoUrl: sponsors.logoUrl,
        sponsorPrimaryColor: sponsors.primaryColor,
      })
      .from(broadcastSponsorSlots)
      .innerJoin(sponsors, eq(broadcastSponsorSlots.sponsorId, sponsors.id))
      .where(eq(broadcastSponsorSlots.id, id));
    return row;
  }

  async createBroadcastSponsorSlot(data: InsertBroadcastSponsorSlot) {
    const [row] = await db.insert(broadcastSponsorSlots).values(data).returning();
    return row;
  }

  async updateBroadcastSponsorSlot(id: number, data: Partial<InsertBroadcastSponsorSlot>) {
    const [row] = await db.update(broadcastSponsorSlots).set(data).where(eq(broadcastSponsorSlots.id, id)).returning();
    return row;
  }

  async deleteBroadcastSponsorSlot(id: number) {
    await db.delete(broadcastSponsorSlots).where(eq(broadcastSponsorSlots.id, id));
  }

  async getBroadcastsByCampaign(campaignId: number): Promise<Broadcast[]> {
    return this.getCampaignBroadcasts(campaignId);
  }

  // Shoppable Ad Activations (dispatch log) ------------------------------
  async createShoppableAdActivation(data: InsertShoppableAdActivation): Promise<ShoppableAdActivation> {
    // Transaction so the analytics mirror (outbox row) exists iff the
    // activation committed. When mirroring is off this collapses to the
    // plain insert. See server/events/analytics-mirror.ts (F4).
    return await db.transaction(async (tx) => {
      const [row] = await tx.insert(shoppableAdActivations).values(data).returning();
      if (isAnalyticsMirrorEnabled()) {
        let fallbackClientAppId: number | null = null;
        if (!row.clientAppId) {
          // Legacy dispatch paths don't set clientAppId — attribute via campaign.
          const [campaign] = await tx
            .select({ clientAppId: campaigns.clientAppId })
            .from(campaigns)
            .where(eq(campaigns.id, row.campaignId));
          fallbackClientAppId = campaign?.clientAppId ?? null;
        }
        await enqueueAdActivationMirror(tx, row, fallbackClientAppId);
      }
      return row;
    });
  }

  /// Lookup an activation row by id. Used by `/api/sdk/tv/cart-intent` to
  /// derive campaignId + sponsorId from the originating shoppable_ad so the
  /// SDK only has to ship `{ externalUserId, productId, activationId }`.
  async getShoppableAdActivation(id: number): Promise<ShoppableAdActivation | undefined> {
    const [row] = await db.select().from(shoppableAdActivations).where(eq(shoppableAdActivations.id, id));
    return row;
  }

  async listShoppableAdActivationsByBroadcast(
    broadcastId: string,
    options: { limit?: number; offset?: number; sponsorId?: number; source?: string } = {}
  ): Promise<ShoppableAdActivation[]> {
    const { limit = 50, offset = 0, sponsorId, source } = options;
    const conditions = [eq(shoppableAdActivations.broadcastId, broadcastId)];
    if (typeof sponsorId === 'number') conditions.push(eq(shoppableAdActivations.sponsorId, sponsorId));
    if (source) conditions.push(eq(shoppableAdActivations.source, source));
    return await db.select().from(shoppableAdActivations)
      .where(and(...conditions))
      .orderBy(desc(shoppableAdActivations.triggeredAt))
      .limit(limit)
      .offset(offset);
  }

  async listShoppableAdActivationsByCampaign(
    campaignId: number,
    options: { limit?: number; offset?: number; sponsorId?: number; source?: string } = {}
  ): Promise<ShoppableAdActivation[]> {
    const { limit = 50, offset = 0, sponsorId, source } = options;
    const conditions = [eq(shoppableAdActivations.campaignId, campaignId)];
    if (typeof sponsorId === 'number') conditions.push(eq(shoppableAdActivations.sponsorId, sponsorId));
    if (source) conditions.push(eq(shoppableAdActivations.source, source));
    return await db.select().from(shoppableAdActivations)
      .where(and(...conditions))
      .orderBy(desc(shoppableAdActivations.triggeredAt))
      .limit(limit)
      .offset(offset);
  }

  // --- Multi-sponsor redesign helpers (Phase 4) ---

  async ensureEndUser(clientAppId: number, externalUserId: string): Promise<EndUser> {
    const existing = await this.getEndUser(clientAppId, externalUserId);
    if (existing) {
      await this.touchEndUser(existing.id);
      return existing;
    }
    const [created] = await db.insert(endUsers)
      .values({ clientAppId, externalUserId })
      .onConflictDoUpdate({
        target: [endUsers.clientAppId, endUsers.externalUserId],
        set: { lastSeenAt: new Date() },
      })
      .returning();
    return created;
  }

  async getEndUser(clientAppId: number, externalUserId: string): Promise<EndUser | undefined> {
    const [row] = await db.select().from(endUsers)
      .where(and(eq(endUsers.clientAppId, clientAppId), eq(endUsers.externalUserId, externalUserId)))
      .limit(1);
    return row;
  }

  async touchEndUser(endUserId: number): Promise<void> {
    await db.update(endUsers).set({ lastSeenAt: new Date() }).where(eq(endUsers.id, endUserId));
  }

  async upsertTvSession(data: { clientAppId: number; endUserId: number; platform: TvPlatform; tvDeviceId?: string | null }): Promise<TvSession> {
    const [row] = await db.insert(tvSessions)
      .values({
        clientAppId: data.clientAppId,
        endUserId: data.endUserId,
        platform: data.platform,
        tvDeviceId: data.tvDeviceId ?? null,
      })
      .onConflictDoUpdate({
        target: [tvSessions.clientAppId, tvSessions.endUserId, tvSessions.platform],
        set: {
          lastSeenAt: new Date(),
          endedAt: null,
          tvDeviceId: data.tvDeviceId ?? sql`${tvSessions.tvDeviceId}`,
        },
      })
      .returning();
    return row;
  }

  async getActiveTvSession(clientAppId: number, endUserId: number, platform: TvPlatform): Promise<TvSession | undefined> {
    const [row] = await db.select().from(tvSessions)
      .where(and(
        eq(tvSessions.clientAppId, clientAppId),
        eq(tvSessions.endUserId, endUserId),
        eq(tvSessions.platform, platform),
        isNull(tvSessions.endedAt),
      ))
      .orderBy(desc(tvSessions.lastSeenAt))
      .limit(1);
    return row;
  }

  async touchTvSession(sessionId: number): Promise<void> {
    await db.update(tvSessions).set({ lastSeenAt: new Date() }).where(eq(tvSessions.id, sessionId));
  }

  async endTvSession(sessionId: number): Promise<void> {
    await db.update(tvSessions).set({ endedAt: new Date() }).where(eq(tvSessions.id, sessionId));
  }

  async createCartIntent(data: InsertCartIntent): Promise<CartIntent> {
    // Same transactional-mirror pattern as createShoppableAdActivation.
    return await db.transaction(async (tx) => {
      const [row] = await tx.insert(cartIntents).values(data).returning();
      if (isAnalyticsMirrorEnabled()) {
        await enqueueCartIntentMirror(tx, row);
      }
      return row;
    });
  }

  async listCartIntentsByBroadcast(
    _broadcastId: string,
    options: { limit?: number; offset?: number } = {},
  ): Promise<CartIntent[]> {
    // cart_intents are scoped to campaign (not broadcast); resolve via activation or source_component
    const { limit = 50, offset = 0 } = options;
    return await db.select().from(cartIntents)
      .orderBy(desc(cartIntents.triggeredAt))
      .limit(limit)
      .offset(offset);
  }

  async listCartIntentsByCampaign(
    campaignId: number,
    options: { limit?: number; offset?: number } = {},
  ): Promise<CartIntent[]> {
    const { limit = 50, offset = 0 } = options;
    return await db.select().from(cartIntents)
      .where(eq(cartIntents.campaignId, campaignId))
      .orderBy(desc(cartIntents.triggeredAt))
      .limit(limit)
      .offset(offset);
  }

  async listSecondarySponsors(campaignId: number): Promise<Sponsor[]> {
    const rows = await db.select({ sponsor: sponsors })
      .from(campaignSponsors)
      .innerJoin(sponsors, eq(campaignSponsors.sponsorId, sponsors.id))
      .where(eq(campaignSponsors.campaignId, campaignId));
    return rows.map(r => r.sponsor);
  }

  async addSecondarySponsor(campaignId: number, sponsorId: number): Promise<void> {
    await db.insert(campaignSponsors)
      .values({ campaignId, sponsorId, role: 'secondary' })
      .onConflictDoNothing();
  }

  async removeSecondarySponsor(campaignId: number, sponsorId: number): Promise<void> {
    await db.delete(campaignSponsors)
      .where(and(eq(campaignSponsors.campaignId, campaignId), eq(campaignSponsors.sponsorId, sponsorId)));
  }

  async getAllCampaignSponsors(campaignId: number): Promise<Sponsor[]> {
    const [campaign] = await db.select({ primarySponsorId: campaigns.primarySponsorId })
      .from(campaigns).where(eq(campaigns.id, campaignId)).limit(1);
    const secondaries = await this.listSecondarySponsors(campaignId);
    if (!campaign?.primarySponsorId) return secondaries;
    const [primary] = await db.select().from(sponsors)
      .where(eq(sponsors.id, campaign.primarySponsorId)).limit(1);
    return primary ? [primary, ...secondaries] : secondaries;
  }

  async isSponsorAllowedForCampaign(sponsorId: number, campaignId: number): Promise<boolean> {
    const [campaign] = await db.select({ primary: campaigns.primarySponsorId })
      .from(campaigns).where(eq(campaigns.id, campaignId)).limit(1);
    if (!campaign) return false;
    if (campaign.primary === sponsorId) return true;
    const [secondary] = await db.select({ id: campaignSponsors.id })
      .from(campaignSponsors)
      .where(and(eq(campaignSponsors.campaignId, campaignId), eq(campaignSponsors.sponsorId, sponsorId)))
      .limit(1);
    return !!secondary;
  }

  async canChangePrimarySponsor(campaignId: number): Promise<boolean> {
    // Blocked once any child row exists that references this campaign via its primary semantics.
    const checks = await Promise.all([
      db.select({ n: sql<number>`count(*)::int` }).from(broadcasts).where(eq(broadcasts.campaignId, campaignId)),
      db.select({ n: sql<number>`count(*)::int` }).from(shoppableAdActivations).where(eq(shoppableAdActivations.campaignId, campaignId)),
      db.select({ n: sql<number>`count(*)::int` }).from(cartIntents).where(eq(cartIntents.campaignId, campaignId)),
    ]);
    return checks.every(([row]) => row.n === 0);
  }
}

export const storage = new MemStorage();
