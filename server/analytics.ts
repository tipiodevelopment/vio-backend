import type { Express } from "express";
import { db } from "./db";
import {
  clientApps,
  channels,
  campaigns,
  broadcasts,
  polls,
  pollOptions,
  pollVotes,
  contests,
  contestParticipations,
  campaignComponents,
  components,
  scheduledComponents,
  sponsors,
  campaignFeatureFlags,
} from "@shared/schema";
import { eq, sql, count, countDistinct, sum, and, inArray, desc, asc, gte, lte } from "drizzle-orm";

export function registerAnalyticsRoutes(app: Express) {


  // Get analytics deltas for the dashboard
  app.get("/api/analytics/deltas", async (_req, res) => {
    try {
      const now = new Date();
      const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
      const fourteenDaysAgo = new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000);

      // Current period stats
      const [currentViewers] = await db.select({ total: sql<number>`coalesce(sum(${broadcasts.viewerCount}), 0)` })
        .from(broadcasts)
        .where(and(gte(broadcasts.createdAt, sevenDaysAgo), lte(broadcasts.createdAt, now)));

      const [currentVotes] = await db.select({ total: count() })
        .from(pollVotes)
        .where(and(gte(pollVotes.createdAt, sevenDaysAgo), lte(pollVotes.createdAt, now)));

      const [currentParticipations] = await db.select({ total: count() })
        .from(contestParticipations)
        .where(and(gte(contestParticipations.createdAt, sevenDaysAgo), lte(contestParticipations.createdAt, now)));

      // Previous period stats
      const [prevViewers] = await db.select({ total: sql<number>`coalesce(sum(${broadcasts.viewerCount}), 0)` })
        .from(broadcasts)
        .where(and(gte(broadcasts.createdAt, fourteenDaysAgo), lte(broadcasts.createdAt, sevenDaysAgo)));

      const [prevVotes] = await db.select({ total: count() })
        .from(pollVotes)
        .where(and(gte(pollVotes.createdAt, fourteenDaysAgo), lte(pollVotes.createdAt, sevenDaysAgo)));

      const [prevParticipations] = await db.select({ total: count() })
        .from(contestParticipations)
        .where(and(gte(contestParticipations.createdAt, fourteenDaysAgo), lte(contestParticipations.createdAt, sevenDaysAgo)));

      const currentEngagement = Number(currentVotes.total) + Number(currentParticipations.total);
      const prevEngagement = Number(prevVotes.total) + Number(prevParticipations.total);
      const currentViewersVal = Number(currentViewers.total);
      const prevViewersVal = Number(prevViewers.total);

      const calculateDelta = (current: number, previous: number) => {
        if (previous === 0) return current > 0 ? 100 : 0;
        return Math.round(((current - previous) / previous) * 100);
      };

      res.json({
        viewersDelta: calculateDelta(currentViewersVal, prevViewersVal),
        engagementDelta: calculateDelta(currentEngagement, prevEngagement),
      });
    } catch (error) {
      console.error('Error fetching analytics deltas:', error);
      res.status(500).json({ message: 'Error fetching analytics deltas' });
    }
  });

  app.get('/api/analytics/overview', async (_req, res) => {
    try {
      const [appsResult] = await db.select({ total: count(), active: sql<number>`count(*) filter (where ${clientApps.status} = 'active')` }).from(clientApps);

      const [campaignsResult] = await db.select({
        total: count(),
        active: sql<number>`count(*) filter (where ${campaigns.isPaused} = 'false' and (${campaigns.endDate} is null or ${campaigns.endDate} > now()) and (${campaigns.startDate} is null or ${campaigns.startDate} <= now()))`,
        paused: sql<number>`count(*) filter (where ${campaigns.isPaused} = 'true')`,
        ended: sql<number>`count(*) filter (where ${campaigns.endDate} is not null and ${campaigns.endDate} <= now())`,
      }).from(campaigns);

      const [broadcastsResult] = await db.select({
        total: count(),
        live: sql<number>`count(*) filter (where ${broadcasts.status} = 'live')`,
        upcoming: sql<number>`count(*) filter (where ${broadcasts.status} = 'upcoming')`,
        ended: sql<number>`count(*) filter (where ${broadcasts.status} = 'ended')`,
      }).from(broadcasts);

      const [uniqueVoters] = await db.select({ count: countDistinct(pollVotes.userId) }).from(pollVotes);
      const [uniqueParticipants] = await db.select({ count: countDistinct(contestParticipations.userId) }).from(contestParticipations);

      const uniqueEngagedRaw = await db.execute(sql`
        SELECT count(DISTINCT user_id) as count FROM (
          SELECT user_id FROM poll_votes
          UNION
          SELECT user_id FROM contest_participations
        ) combined
      `);
      const uniqueEngaged = Number(uniqueEngagedRaw.rows?.[0]?.count ?? 0);

      const [totalVotes] = await db.select({ total: sql<number>`coalesce(sum(${polls.totalVotes}), 0)` }).from(polls);
      const [totalParticipations] = await db.select({ total: count() }).from(contestParticipations);

      const [pollsCount] = await db.select({ total: count() }).from(polls);
      const [contestsCount] = await db.select({ total: count() }).from(contests);
      const [componentsCount] = await db.select({ total: count() }).from(components);
      const [sponsorsCount] = await db.select({ total: count() }).from(sponsors);

      res.json({
        apps: { total: appsResult.total, active: Number(appsResult.active) },
        campaigns: {
          total: campaignsResult.total,
          active: Number(campaignsResult.active),
          paused: Number(campaignsResult.paused),
          ended: Number(campaignsResult.ended),
        },
        broadcasts: {
          total: broadcastsResult.total,
          live: Number(broadcastsResult.live),
          upcoming: Number(broadcastsResult.upcoming),
          ended: Number(broadcastsResult.ended),
        },
        engagement: {
          uniqueUsers: uniqueEngaged,
          uniqueVoters: uniqueVoters.count,
          uniqueParticipants: uniqueParticipants.count,
          totalVotes: Number(totalVotes.total),
          totalParticipations: totalParticipations.total,
        },
        totals: {
          polls: pollsCount.total,
          contests: contestsCount.total,
          components: componentsCount.total,
          sponsors: sponsorsCount.total,
        },
      });
    } catch (error) {
      console.error('Error fetching analytics overview:', error);
      res.status(500).json({ message: 'Error fetching analytics overview' });
    }
  });

  app.get('/api/analytics/engagement', async (_req, res) => {
    try {
      const topCampaignsRaw = await db.execute(sql`
        SELECT
          c.id,
          c.name,
          ca.name as client_app_name,
          (SELECT count(*) FROM polls p JOIN broadcasts b ON p.broadcast_id = b.broadcast_id WHERE b.campaign_id = c.id) as total_polls,
          (SELECT count(*) FROM contests ct JOIN broadcasts b ON ct.broadcast_id = b.broadcast_id WHERE b.campaign_id = c.id) as total_contests,
          (SELECT coalesce(sum(p.total_votes), 0) FROM polls p JOIN broadcasts b ON p.broadcast_id = b.broadcast_id WHERE b.campaign_id = c.id) as total_votes,
          (SELECT count(*) FROM contest_participations cp JOIN contests ct ON cp.contest_id = ct.id JOIN broadcasts b ON ct.broadcast_id = b.broadcast_id WHERE b.campaign_id = c.id) as total_participations
        FROM campaigns c
        LEFT JOIN client_apps ca ON c.client_app_id = ca.id
        ORDER BY (
          (SELECT coalesce(sum(p.total_votes), 0) FROM polls p JOIN broadcasts b ON p.broadcast_id = b.broadcast_id WHERE b.campaign_id = c.id) +
          (SELECT count(*) FROM contest_participations cp JOIN contests ct ON cp.contest_id = ct.id JOIN broadcasts b ON ct.broadcast_id = b.broadcast_id WHERE b.campaign_id = c.id)
        ) DESC
        LIMIT 10
      `);

      const topComponentsRaw = await db.execute(sql`
        SELECT
          co.type,
          co.name,
          count(cc.id) as campaign_count
        FROM components co
        -- Since migration 0004 a campaign binds an app_placement, not a
        -- component directly; the template is reached through it.
        JOIN app_placements ap ON ap.component_id = co.id
        JOIN campaign_components cc ON cc.app_placement_id = ap.id
        GROUP BY co.id, co.type, co.name
        ORDER BY campaign_count DESC
        LIMIT 10
      `);

      const activityRaw = await db.execute(sql`
        SELECT
          date_trunc('day', created_at)::date as date,
          count(*) as broadcast_count
        FROM broadcasts
        WHERE created_at >= now() - interval '30 days'
        GROUP BY date_trunc('day', created_at)
        ORDER BY date ASC
      `);

      res.json({
        topCampaigns: topCampaignsRaw.rows.map((r: any) => ({
          id: r.id,
          name: r.name,
          clientAppName: r.client_app_name,
          totalPolls: Number(r.total_polls),
          totalContests: Number(r.total_contests),
          totalVotes: Number(r.total_votes),
          totalParticipations: Number(r.total_participations),
          totalEngagement: Number(r.total_votes) + Number(r.total_participations),
        })),
        topComponents: topComponentsRaw.rows.map((r: any) => ({
          type: r.type,
          name: r.name,
          campaignCount: Number(r.campaign_count),
        })),
        broadcastActivity: activityRaw.rows.map((r: any) => ({
          date: r.date,
          count: Number(r.broadcast_count),
        })),
      });
    } catch (error) {
      console.error('Error fetching analytics engagement:', error);
      res.status(500).json({ message: 'Error fetching analytics engagement' });
    }
  });

  app.get('/api/analytics/geographic', async (_req, res) => {
    try {
      const geoRaw = await db.execute(sql`
        SELECT
          unnest(target_countries) as country,
          count(*) as campaign_count
        FROM campaigns
        WHERE target_countries IS NOT NULL AND array_length(target_countries, 1) > 0
        GROUP BY unnest(target_countries)
        ORDER BY campaign_count DESC
      `);

      res.json({
        countries: geoRaw.rows.map((r: any) => ({
          country: r.country,
          campaignCount: Number(r.campaign_count),
        })),
      });
    } catch (error) {
      console.error('Error fetching geographic analytics:', error);
      res.status(500).json({ message: 'Error fetching geographic analytics' });
    }
  });

  app.get('/api/analytics/apps/:id', async (req, res) => {
    try {
      const appId = parseInt(req.params.id);
      if (isNaN(appId)) return res.status(400).json({ message: 'Invalid app id' });

      const appDataRaw = await db.execute(sql`
        SELECT
          ca.id, ca.name, ca.bundle_id, ca.status, ca.created_at,
          (SELECT count(*) FROM channels ch WHERE ch.client_app_id = ca.id) as channel_count,
          (SELECT count(*) FROM campaigns c WHERE c.client_app_id = ca.id) as campaign_count,
          (SELECT count(*) FROM campaigns c WHERE c.client_app_id = ca.id AND c.is_paused = 'false' AND (c.end_date IS NULL OR c.end_date > now())) as active_campaigns,
          (SELECT count(*) FROM app_components ac WHERE ac.client_app_id = ca.id) as app_component_count,
          (SELECT count(*) FROM broadcasts b JOIN campaigns c ON b.campaign_id = c.id WHERE c.client_app_id = ca.id) as broadcast_count,
          (SELECT count(DISTINCT pv.user_id) FROM poll_votes pv JOIN polls p ON pv.poll_id = p.id JOIN broadcasts b ON p.broadcast_id = b.broadcast_id JOIN campaigns c ON b.campaign_id = c.id WHERE c.client_app_id = ca.id) as unique_voters,
          (SELECT coalesce(sum(p.total_votes), 0) FROM polls p JOIN broadcasts b ON p.broadcast_id = b.broadcast_id JOIN campaigns c ON b.campaign_id = c.id WHERE c.client_app_id = ca.id) as total_votes,
          (SELECT count(*) FROM contest_participations cp JOIN contests ct ON cp.contest_id = ct.id JOIN broadcasts b ON ct.broadcast_id = b.broadcast_id JOIN campaigns c ON b.campaign_id = c.id WHERE c.client_app_id = ca.id) as total_participations
        FROM client_apps ca
        WHERE ca.id = ${appId}
      `);

      if (!appDataRaw.rows.length) return res.status(404).json({ message: 'App not found' });

      const appData = appDataRaw.rows[0] as any;

      const campaignsRaw = await db.execute(sql`
        SELECT
          c.id, c.name, c.is_paused, c.start_date, c.end_date,
          (SELECT coalesce(sum(p.total_votes), 0) FROM polls p JOIN broadcasts b ON p.broadcast_id = b.broadcast_id WHERE b.campaign_id = c.id) as total_votes,
          (SELECT count(*) FROM contest_participations cp JOIN contests ct ON cp.contest_id = ct.id JOIN broadcasts b ON ct.broadcast_id = b.broadcast_id WHERE b.campaign_id = c.id) as total_participations
        FROM campaigns c
        WHERE c.client_app_id = ${appId}
        ORDER BY c.created_at DESC
      `);

      res.json({
        app: {
          id: appData.id,
          name: appData.name,
          bundleId: appData.bundle_id,
          status: appData.status,
          createdAt: appData.created_at,
        },
        kpis: {
          channelCount: Number(appData.channel_count),
          campaignCount: Number(appData.campaign_count),
          activeCampaigns: Number(appData.active_campaigns),
          appComponentCount: Number(appData.app_component_count),
          broadcastCount: Number(appData.broadcast_count),
          uniqueVoters: Number(appData.unique_voters),
          totalVotes: Number(appData.total_votes),
          totalParticipations: Number(appData.total_participations),
        },
        campaigns: campaignsRaw.rows.map((r: any) => ({
          id: r.id,
          name: r.name,
          isPaused: r.is_paused,
          startDate: r.start_date,
          endDate: r.end_date,
          totalVotes: Number(r.total_votes),
          totalParticipations: Number(r.total_participations),
          totalEngagement: Number(r.total_votes) + Number(r.total_participations),
        })),
      });
    } catch (error) {
      console.error('Error fetching app analytics:', error);
      res.status(500).json({ message: 'Error fetching app analytics' });
    }
  });

  app.get('/api/analytics/campaigns/:id', async (req, res) => {
    try {
      const campaignId = parseInt(req.params.id);
      if (isNaN(campaignId)) return res.status(400).json({ message: 'Invalid campaign id' });

      const campaignRaw = await db.execute(sql`
        SELECT
          c.*,
          ca.name as client_app_name,
          ch.name as channel_name,
          s.name as sponsor_name,
          s.logo_url as sponsor_logo,
          (SELECT count(*) FROM broadcasts b WHERE b.campaign_id = c.id) as broadcast_count,
          (SELECT count(*) FROM polls p JOIN broadcasts b ON p.broadcast_id = b.broadcast_id WHERE b.campaign_id = c.id) as poll_count,
          (SELECT count(*) FROM contests ct JOIN broadcasts b ON ct.broadcast_id = b.broadcast_id WHERE b.campaign_id = c.id) as contest_count,
          (SELECT coalesce(sum(p.total_votes), 0) FROM polls p JOIN broadcasts b ON p.broadcast_id = b.broadcast_id WHERE b.campaign_id = c.id) as total_votes,
          (SELECT count(*) FROM contest_participations cp JOIN contests ct ON cp.contest_id = ct.id JOIN broadcasts b ON ct.broadcast_id = b.broadcast_id WHERE b.campaign_id = c.id) as total_participations,
          (SELECT count(*) FROM campaign_components cc WHERE cc.campaign_id = c.id AND cc.status = 'active') as active_components
        FROM campaigns c
        LEFT JOIN client_apps ca ON c.client_app_id = ca.id
        LEFT JOIN channels ch ON c.channel_id = ch.id
        LEFT JOIN sponsors s ON c.sponsor_id = s.id
        WHERE c.id = ${campaignId}
      `);

      if (!campaignRaw.rows.length) return res.status(404).json({ message: 'Campaign not found' });
      const cd = campaignRaw.rows[0] as any;

      const pollsRaw = await db.execute(sql`
        SELECT
          p.id, p.question, p.is_active, p.total_votes, p.start_time, p.end_time,
          p.scheduled_start_time, p.scheduled_end_time, p.video_start_time, p.video_end_time,
          b.broadcast_name, b.broadcast_id,
          json_agg(json_build_object('id', po.id, 'text', po.text, 'voteCount', po.vote_count, 'displayOrder', po.display_order) ORDER BY po.display_order) as options
        FROM polls p
        JOIN broadcasts b ON p.broadcast_id = b.broadcast_id
        LEFT JOIN poll_options po ON po.poll_id = p.id
        WHERE b.campaign_id = ${campaignId}
        GROUP BY p.id, b.broadcast_name, b.broadcast_id
        ORDER BY p.created_at DESC
      `);

      const contestsRaw = await db.execute(sql`
        SELECT
          ct.id, ct.title, ct.description, ct.prize, ct.contest_type, ct.is_active,
          ct.start_time, ct.end_time,
          b.broadcast_name, b.broadcast_id,
          (SELECT count(*) FROM contest_participations cp WHERE cp.contest_id = ct.id) as participation_count
        FROM contests ct
        JOIN broadcasts b ON ct.broadcast_id = b.broadcast_id
        WHERE b.campaign_id = ${campaignId}
        ORDER BY ct.created_at DESC
      `);

      const componentsRaw = await db.execute(sql`
        SELECT
          cc.id, ap.component_id, cc.instance_name, cc.status, cc.activated_at,
          cc.scheduled_time, cc.end_time, cc.match_id,
          co.type, co.name as component_name
        FROM campaign_components cc
        JOIN app_placements ap ON cc.app_placement_id = ap.id
        JOIN components co ON ap.component_id = co.id
        WHERE cc.campaign_id = ${campaignId}
        ORDER BY cc.updated_at DESC
      `);

      const featureFlagsRaw = await db.select().from(campaignFeatureFlags).where(eq(campaignFeatureFlags.campaignId, campaignId));

      const voteTimelineRaw = await db.execute(sql`
        SELECT
          date_trunc('day', pv.created_at)::date as date,
          count(*) as vote_count
        FROM poll_votes pv
        JOIN polls p ON pv.poll_id = p.id
        JOIN broadcasts b ON p.broadcast_id = b.broadcast_id
        WHERE b.campaign_id = ${campaignId}
        GROUP BY date_trunc('day', pv.created_at)
        ORDER BY date ASC
      `);

      const participationTimelineRaw = await db.execute(sql`
        SELECT
          date_trunc('day', cp.created_at)::date as date,
          count(*) as participation_count
        FROM contest_participations cp
        JOIN contests ct ON cp.contest_id = ct.id
        JOIN broadcasts b ON ct.broadcast_id = b.broadcast_id
        WHERE b.campaign_id = ${campaignId}
        GROUP BY date_trunc('day', cp.created_at)
        ORDER BY date ASC
      `);

      res.json({
        campaign: {
          id: cd.id,
          name: cd.name,
          description: cd.description,
          startDate: cd.start_date,
          endDate: cd.end_date,
          isPaused: cd.is_paused,
          // The collector is addressed per surface, so the commerce rates in the
          // dashboard need the id, not just the name.
          clientAppId: cd.client_app_id,
          clientAppName: cd.client_app_name,
          channelName: cd.channel_name,
          sponsorName: cd.sponsor_name,
          sponsorLogo: cd.sponsor_logo,
          matchId: cd.match_id,
          matchName: cd.match_name,
          targetCountries: cd.target_countries,
          isSegmented: cd.is_segmented,
          targetPercentage: cd.target_percentage,
        },
        kpis: {
          broadcastCount: Number(cd.broadcast_count),
          pollCount: Number(cd.poll_count),
          contestCount: Number(cd.contest_count),
          totalVotes: Number(cd.total_votes),
          totalParticipations: Number(cd.total_participations),
          activeComponents: Number(cd.active_components),
        },
        polls: pollsRaw.rows.map((r: any) => ({
          id: r.id,
          question: r.question,
          isActive: r.is_active,
          totalVotes: r.total_votes,
          startTime: r.start_time,
          endTime: r.end_time,
          scheduledStartTime: r.scheduled_start_time,
          scheduledEndTime: r.scheduled_end_time,
          videoStartTime: r.video_start_time,
          videoEndTime: r.video_end_time,
          broadcastName: r.broadcast_name,
          broadcastId: r.broadcast_id,
          options: r.options || [],
        })),
        contests: contestsRaw.rows.map((r: any) => ({
          id: r.id,
          title: r.title,
          description: r.description,
          prize: r.prize,
          contestType: r.contest_type,
          isActive: r.is_active,
          startTime: r.start_time,
          endTime: r.end_time,
          broadcastName: r.broadcast_name,
          broadcastId: r.broadcast_id,
          participationCount: Number(r.participation_count),
        })),
        components: componentsRaw.rows.map((r: any) => ({
          id: r.id,
          componentId: r.component_id,
          instanceName: r.instance_name,
          status: r.status,
          activatedAt: r.activated_at,
          scheduledTime: r.scheduled_time,
          endTime: r.end_time,
          matchId: r.match_id,
          type: r.type,
          componentName: r.component_name,
        })),
        featureFlags: featureFlagsRaw[0] || null,
        engagementTimeline: {
          votes: voteTimelineRaw.rows.map((r: any) => ({ date: r.date, count: Number(r.vote_count) })),
          participations: participationTimelineRaw.rows.map((r: any) => ({ date: r.date, count: Number(r.participation_count) })),
        },
      });
    } catch (error) {
      console.error('Error fetching campaign analytics:', error);
      res.status(500).json({ message: 'Error fetching campaign analytics' });
    }
  });

  app.get('/api/analytics/broadcasts/:id', async (req, res) => {
    try {
      const broadcastId = req.params.id;

      const broadcastRaw = await db.execute(sql`
        SELECT
          b.*,
          c.name as campaign_name,
          ch.name as channel_name,
          (SELECT count(*) FROM polls p WHERE p.broadcast_id = b.broadcast_id) as poll_count,
          (SELECT count(*) FROM contests ct WHERE ct.broadcast_id = b.broadcast_id) as contest_count,
          (SELECT coalesce(sum(p.total_votes), 0) FROM polls p WHERE p.broadcast_id = b.broadcast_id) as total_votes,
          (SELECT count(*) FROM contest_participations cp JOIN contests ct ON cp.contest_id = ct.id WHERE ct.broadcast_id = b.broadcast_id) as total_participations,
          (SELECT count(DISTINCT combined.user_id) FROM (
            SELECT pv.user_id FROM poll_votes pv WHERE pv.broadcast_id = b.broadcast_id
            UNION
            SELECT cp.user_id FROM contest_participations cp WHERE cp.broadcast_id = b.broadcast_id
          ) combined) as unique_users
        FROM broadcasts b
        LEFT JOIN campaigns c ON b.campaign_id = c.id
        LEFT JOIN channels ch ON b.channel_id = ch.id
        WHERE b.broadcast_id = ${broadcastId}
      `);

      if (!broadcastRaw.rows.length) return res.status(404).json({ message: 'Broadcast not found' });
      const bd = broadcastRaw.rows[0] as any;

      const pollsRaw = await db.execute(sql`
        SELECT
          p.id, p.question, p.is_active, p.total_votes, p.start_time, p.end_time,
          p.scheduled_start_time, p.scheduled_end_time, p.video_start_time, p.video_end_time,
          (SELECT count(DISTINCT pv.user_id) FROM poll_votes pv WHERE pv.poll_id = p.id) as unique_voters,
          json_agg(json_build_object('id', po.id, 'text', po.text, 'voteCount', po.vote_count, 'displayOrder', po.display_order) ORDER BY po.display_order) as options
        FROM polls p
        LEFT JOIN poll_options po ON po.poll_id = p.id
        WHERE p.broadcast_id = ${broadcastId}
        GROUP BY p.id
        ORDER BY p.created_at DESC
      `);

      const contestsRaw = await db.execute(sql`
        SELECT
          ct.id, ct.title, ct.description, ct.prize, ct.contest_type, ct.is_active,
          ct.start_time, ct.end_time,
          ct.scheduled_start_time, ct.scheduled_end_time,
          (SELECT count(*) FROM contest_participations cp WHERE cp.contest_id = ct.id) as participation_count,
          (SELECT count(DISTINCT cp.user_id) FROM contest_participations cp WHERE cp.contest_id = ct.id) as unique_participants
        FROM contests ct
        WHERE ct.broadcast_id = ${broadcastId}
        ORDER BY ct.created_at DESC
      `);

      const voteTimelineRaw = await db.execute(sql`
        SELECT
          date_trunc('hour', pv.created_at) as time_bucket,
          count(*) as vote_count
        FROM poll_votes pv
        WHERE pv.broadcast_id = ${broadcastId}
        GROUP BY date_trunc('hour', pv.created_at)
        ORDER BY time_bucket ASC
      `);

      res.json({
        broadcast: {
          broadcastId: bd.broadcast_id,
          broadcastName: bd.broadcast_name,
          description: bd.description,
          status: bd.status,
          startTime: bd.start_time,
          endTime: bd.end_time,
          campaignName: bd.campaign_name,
          channelName: bd.channel_name,
          metadata: bd.metadata,
        },
        kpis: {
          pollCount: Number(bd.poll_count),
          contestCount: Number(bd.contest_count),
          totalVotes: Number(bd.total_votes),
          totalParticipations: Number(bd.total_participations),
          uniqueUsers: Number(bd.unique_users),
        },
        polls: pollsRaw.rows.map((r: any) => ({
          id: r.id,
          question: r.question,
          isActive: r.is_active,
          totalVotes: r.total_votes,
          uniqueVoters: Number(r.unique_voters),
          startTime: r.start_time,
          endTime: r.end_time,
          scheduledStartTime: r.scheduled_start_time,
          scheduledEndTime: r.scheduled_end_time,
          videoStartTime: r.video_start_time,
          videoEndTime: r.video_end_time,
          options: r.options || [],
        })),
        contests: contestsRaw.rows.map((r: any) => ({
          id: r.id,
          title: r.title,
          description: r.description,
          prize: r.prize,
          contestType: r.contest_type,
          isActive: r.is_active,
          startTime: r.start_time,
          endTime: r.end_time,
          scheduledStartTime: r.scheduled_start_time,
          scheduledEndTime: r.scheduled_end_time,
          participationCount: Number(r.participation_count),
          uniqueParticipants: Number(r.unique_participants),
        })),
        engagementTimeline: voteTimelineRaw.rows.map((r: any) => ({
          time: r.time_bucket,
          votes: Number(r.vote_count),
        })),
      });
    } catch (error) {
      console.error('Error fetching broadcast analytics:', error);
      res.status(500).json({ message: 'Error fetching broadcast analytics' });
    }
  });

  app.get('/api/analytics/sponsors', async (_req, res) => {
    try {
      // "this campaign involves this sponsor" — primary or secondary.
      const belongs = sql`(c.primary_sponsor_id = s.id OR EXISTS (
        SELECT 1 FROM campaign_sponsors cs WHERE cs.campaign_id = c.id AND cs.sponsor_id = s.id))`;
      const sponsorsRaw = await db.execute(sql`
        SELECT
          s.id, s.name, s.logo_url,
          -- campaigns.sponsor_id became primary_sponsor_id in the multi-sponsor
          -- redesign, and a sponsor also takes part as a secondary via
          -- campaign_sponsors — counting only the primary would undercount
          -- every brand that shares a campaign.
          (SELECT count(*) FROM campaigns c WHERE ${belongs}) as campaign_count,
          (SELECT coalesce(sum(p.total_votes), 0) FROM polls p JOIN broadcasts b ON p.broadcast_id = b.broadcast_id JOIN campaigns c ON b.campaign_id = c.id WHERE ${belongs}) as total_votes,
          (SELECT count(*) FROM contest_participations cp JOIN contests ct ON cp.contest_id = ct.id JOIN broadcasts b ON ct.broadcast_id = b.broadcast_id JOIN campaigns c ON b.campaign_id = c.id WHERE ${belongs}) as total_participations,
          (SELECT count(*) FROM broadcasts b JOIN campaigns c ON b.campaign_id = c.id WHERE ${belongs}) as broadcast_count
        FROM sponsors s
        ORDER BY campaign_count DESC
      `);

      res.json({
        sponsors: sponsorsRaw.rows.map((r: any) => ({
          id: r.id,
          name: r.name,
          logoUrl: r.logo_url,
          campaignCount: Number(r.campaign_count),
          broadcastCount: Number(r.broadcast_count),
          totalVotes: Number(r.total_votes),
          totalParticipations: Number(r.total_participations),
          totalEngagement: Number(r.total_votes) + Number(r.total_participations),
          avgEngagement: Number(r.campaign_count) > 0
            ? Math.round((Number(r.total_votes) + Number(r.total_participations)) / Number(r.campaign_count))
            : 0,
        })),
      });
    } catch (error) {
      console.error('Error fetching sponsor analytics:', error);
      res.status(500).json({ message: 'Error fetching sponsor analytics' });
    }
  });

  app.get('/api/analytics/compare', async (req, res) => {
    try {
      const type = req.query.type as string;
      const idsParam = req.query.ids as string;

      if (!type || !idsParam) {
        return res.status(400).json({ message: 'type and ids query parameters are required' });
      }

      const ids = idsParam.split(',').map(id => id.trim());

      if (type === 'campaigns') {
        const numericIds = ids.map(Number).filter(n => !isNaN(n));
        if (!numericIds.length) return res.status(400).json({ message: 'Invalid campaign ids' });

        const results = await Promise.all(numericIds.map(async (campaignId) => {
          const row = await db.execute(sql`
            SELECT
              c.id, c.name,
              (SELECT count(*) FROM broadcasts b WHERE b.campaign_id = c.id) as broadcast_count,
              (SELECT count(*) FROM polls p JOIN broadcasts b ON p.broadcast_id = b.broadcast_id WHERE b.campaign_id = c.id) as poll_count,
              (SELECT count(*) FROM contests ct JOIN broadcasts b ON ct.broadcast_id = b.broadcast_id WHERE b.campaign_id = c.id) as contest_count,
              (SELECT coalesce(sum(p.total_votes), 0) FROM polls p JOIN broadcasts b ON p.broadcast_id = b.broadcast_id WHERE b.campaign_id = c.id) as total_votes,
              (SELECT count(*) FROM contest_participations cp JOIN contests ct ON cp.contest_id = ct.id JOIN broadcasts b ON ct.broadcast_id = b.broadcast_id WHERE b.campaign_id = c.id) as total_participations
            FROM campaigns c WHERE c.id = ${campaignId}
          `);
          if (!row.rows.length) return null;
          const r = row.rows[0] as any;
          return {
            id: r.id,
            name: r.name,
            broadcastCount: Number(r.broadcast_count),
            pollCount: Number(r.poll_count),
            contestCount: Number(r.contest_count),
            totalVotes: Number(r.total_votes),
            totalParticipations: Number(r.total_participations),
            totalEngagement: Number(r.total_votes) + Number(r.total_participations),
          };
        }));

        res.json({ type: 'campaigns', items: results.filter(Boolean) });
      } else if (type === 'broadcasts') {
        const results = await Promise.all(ids.map(async (broadcastId) => {
          const row = await db.execute(sql`
            SELECT
              b.broadcast_id, b.broadcast_name, b.status,
              (SELECT count(*) FROM polls p WHERE p.broadcast_id = b.broadcast_id) as poll_count,
              (SELECT count(*) FROM contests ct WHERE ct.broadcast_id = b.broadcast_id) as contest_count,
              (SELECT coalesce(sum(p.total_votes), 0) FROM polls p WHERE p.broadcast_id = b.broadcast_id) as total_votes,
              (SELECT count(*) FROM contest_participations cp JOIN contests ct ON cp.contest_id = ct.id WHERE ct.broadcast_id = b.broadcast_id) as total_participations
            FROM broadcasts b WHERE b.broadcast_id = ${broadcastId}
          `);
          if (!row.rows.length) return null;
          const r = row.rows[0] as any;
          return {
            broadcastId: r.broadcast_id,
            broadcastName: r.broadcast_name,
            status: r.status,
            pollCount: Number(r.poll_count),
            contestCount: Number(r.contest_count),
            totalVotes: Number(r.total_votes),
            totalParticipations: Number(r.total_participations),
            totalEngagement: Number(r.total_votes) + Number(r.total_participations),
          };
        }));

        res.json({ type: 'broadcasts', items: results.filter(Boolean) });
      } else {
        res.status(400).json({ message: 'type must be "campaigns" or "broadcasts"' });
      }
    } catch (error) {
      console.error('Error fetching comparison analytics:', error);
      res.status(500).json({ message: 'Error fetching comparison analytics' });
    }
  });
}
