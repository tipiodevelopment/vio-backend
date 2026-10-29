import { useQueries, useQuery } from '@tanstack/react-query';
import { Link } from 'wouter';
import { Button } from '@/components/ui/button';
import { useUser } from '@/contexts/UserContext';
import { AppLayout } from '@/components/AppLayout';
import type { ClientApp, Campaign, Broadcast, Channel } from '@shared/schema';
import { formatPct } from '@/lib/rates';
import {
  BarChart3,
  Megaphone,
  Radio,
  Plus,
  ChevronRight,
  Users,
  TrendingUp,
  Activity,
  MoreVertical,
} from 'lucide-react';

function formatNumber(num: number): string {
  if (num >= 1000000) return (num / 1000000).toFixed(1) + 'M';
  if (num >= 1000) return (num / 1000).toFixed(0) + 'K';
  return num.toString();
}

function getDaysUntil(date: Date): string {
  const now = new Date();
  const diff = date.getTime() - now.getTime();
  const days = Math.ceil(diff / (1000 * 60 * 60 * 24));
  if (days <= 0) return 'Today';
  if (days === 1) return 'In 1 day';
  return `In ${days} days`;
}

function getAppPlaceholder(name: string) {
  const initials = name
    .split(' ')
    .map(n => n[0])
    .join('')
    .toUpperCase()
    .slice(0, 2);
  
  // Deterministic background color based on name
  const colors = [
    'bg-blue-500',
    'bg-emerald-500',
    'bg-indigo-500',
    'bg-violet-500',
    'bg-amber-500',
    'bg-rose-500',
    'bg-cyan-500',
    'bg-teal-500',
  ];
  
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = name.charCodeAt(i) + ((hash << 5) - hash);
  }
  const colorIndex = Math.abs(hash) % colors.length;
  
  return (
    <div className={`w-full h-full ${colors[colorIndex]} flex items-center justify-center text-white text-2xl font-bold`}>
      {initials}
    </div>
  );
}

/**
 * Click rate across every surface the account owns, last 7 days.
 *
 * The collector answers one surface at a time, so the totals are summed here — fine for
 * the handful of surfaces an operator has today. An account with dozens would want this
 * as a single query in the collector instead of N requests from the home page.
 */
function useClickRate(clientApps: ClientApp[], userId: number | null | undefined) {
  const results = useQueries({
    queries: clientApps.map((app) => ({
      queryKey: ['/api/analytics/vio/bundle', app.id, userId, '7d'],
      queryFn: async () => {
        const res = await fetch(`/api/analytics/vio/bundle?userId=${userId}&clientAppId=${app.id}&range=7d`);
        if (!res.ok) throw new Error('bundle unavailable');
        return res.json();
      },
      enabled: !!userId,
    })),
  });

  let impressions = 0;
  let clicks = 0;
  for (const result of results) {
    const k = (result.data as any)?.kpis;
    impressions += Number(k?.impressions?.value ?? 0);
    clicks += Number(k?.clicks?.value ?? 0);
  }
  return { impressions, clicks };
}

export default function DashboardPage() {
  const { userId } = useUser();

  const { data: clientApps = [] } = useQuery<ClientApp[]>({
    queryKey: ['/api/client-apps', userId],
    queryFn: async () => {
      const res = await fetch(`/api/client-apps?userId=${userId}`);
      if (!res.ok) throw new Error('Failed');
      return res.json();
    },
    enabled: !!userId,
  });

  const clickRate = useClickRate(clientApps, userId);

  const { data: campaigns = [] } = useQuery<Campaign[]>({
    queryKey: ['/api/campaigns', userId],
    queryFn: async () => {
      const res = await fetch(`/api/campaigns?userId=${userId}`);
      if (!res.ok) throw new Error('Failed');
      return res.json();
    },
    enabled: !!userId,
  });

  const { data: broadcasts = [] } = useQuery<Broadcast[]>({
    queryKey: ['/api/broadcasts', 'all'],
    queryFn: async () => {
      const res = await fetch('/api/broadcasts');
      if (!res.ok) throw new Error('Failed');
      return res.json();
    },
    enabled: !!userId,
  });

  const { data: channels = [] } = useQuery<Channel[]>({
    queryKey: ['/api/channels', userId],
    queryFn: async () => {
      const res = await fetch(`/api/channels?userId=${userId}`);
      if (!res.ok) throw new Error('Failed');
      return res.json();
    },
    enabled: !!userId,
  });

  const { data: analyticsDeltas = { viewersDelta: 0, engagementDelta: 0 } } = useQuery<{ viewersDelta: number, engagementDelta: number }>({
    queryKey: ['/api/analytics/deltas'],
    queryFn: async () => {
      const res = await fetch('/api/analytics/deltas');
      if (!res.ok) throw new Error('Failed');
      return res.json();
    },
    enabled: !!userId,
  });

  const activeCampaigns = campaigns.filter(c => c.isPaused !== 'true');
  const liveBroadcasts = broadcasts.filter(b => b.status === 'live');
  const activeViewers = liveBroadcasts.reduce((sum, b) => sum + ((b as any).viewerCount || 0), 0);
  const upcomingCampaigns = campaigns.filter(c => {
    if (!c.startDate) return false;
    const start = new Date(c.startDate);
    const now = new Date();
    const weekFromNow = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
    return start > now && start <= weekFromNow;
  });

  const campaignMap = new Map(campaigns.map(c => [c.id, c]));
  const channelMap = new Map(channels.map(ch => [ch.id, ch]));

  const getCampaignsForApp = (appId: number) => {
    const appChannels = channels.filter(ch => ch.clientAppId === appId);
    const channelIds = new Set(appChannels.map(ch => ch.id));
    return campaigns.filter(c => c.channelId && channelIds.has(c.channelId));
  };

  const getBroadcastsForApp = (appId: number) => {
    const appCampaignIds = new Set(getCampaignsForApp(appId).map(c => c.id));
    return broadcasts.filter(b => b.campaignId && appCampaignIds.has(b.campaignId));
  };

  return (
    <AppLayout
      headerBreadcrumb="All surfaces"
      headerBreadcrumbHref="/apps"
      actions={
        <Link href="/campaigns/new">
          <Button size="sm" className="gap-1.5 bg-[#3d8b7a] hover:bg-[#2f7365] text-white dark:bg-white dark:hover:bg-gray-200 dark:text-[#0a0e1a] h-9 px-4" data-testid="button-new-campaign">
            <Plus className="w-4 h-4" /> New Campaign
          </Button>
        </Link>
      }
    >
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-12">
        <StatCard
          icon={<Radio className="w-5 h-5" />}
          iconBg="bg-[#3d8b7a]/10 dark:bg-white/10"
          iconColor="text-[#3d8b7a] dark:text-gray-300"
          value={liveBroadcasts.length}
          label="Live Broadcasts"
          change={0}
          testId="stat-live-broadcasts"
        />
        <StatCard
          icon={<Megaphone className="w-5 h-5" />}
          iconBg="bg-[#3d8b7a]/10 dark:bg-white/10"
          iconColor="text-[#3d8b7a] dark:text-gray-300"
          value={activeCampaigns.length}
          label="Active Campaigns"
          change={0}
          testId="stat-active-campaigns"
        />
        <StatCard
          icon={<Users className="w-5 h-5" />}
          iconBg="bg-[#3d8b7a]/10 dark:bg-white/10"
          iconColor="text-[#3d8b7a] dark:text-gray-300"
          value={activeViewers}
          formattedValue={activeViewers > 0 ? activeViewers.toLocaleString() : (liveBroadcasts.length === 0 ? '--' : '0')}
          label="Active Viewers"
          change={analyticsDeltas.viewersDelta}
          testId="stat-active-viewers"
        />
        <StatCard
          icon={<BarChart3 className="w-5 h-5" />}
          iconBg="bg-[#3d8b7a]/10 dark:bg-white/10"
          iconColor="text-[#3d8b7a] dark:text-gray-300"
          value={0}
          formattedValue={clickRate.impressions > 0 ? formatPct((clickRate.clicks / clickRate.impressions) * 100) : '--'}
          label={clickRate.impressions > 0 ? `Click Rate · ${clickRate.clicks.toLocaleString()} clicks, 7d` : 'Click Rate · 7d'}
          change={0}
          testId="stat-click-rate"
        />
      </div>

      <div className="mb-8">
        <div className="flex items-center justify-between mb-4">
          <div>
            <h2 className="text-lg font-semibold text-gray-900 dark:text-white" data-testid="text-client-apps-title">Surfaces</h2>
            <p className="text-sm text-gray-400 dark:text-white/40">Where Vio runs — your sites, apps and TV channels</p>
          </div>
          <Link href="/apps">
            <Button variant="outline" size="sm" className="gap-1.5 border-gray-200 dark:border-white/10 text-gray-600 dark:text-white/70 hover:text-gray-900 dark:hover:text-white hover:bg-gray-100 dark:hover:bg-white/5" data-testid="button-new-client-app">
              <Plus className="w-4 h-4" /> New Client App
            </Button>
          </Link>
        </div>

        {clientApps.length === 0 ? (
          <div className="rounded-xl border border-gray-200 dark:border-white/5 bg-white dark:bg-white/[0.02] p-8 text-center">
            <div className="w-12 h-12 rounded-xl bg-[#3d8b7a]/10 dark:bg-white/10 flex items-center justify-center mx-auto mb-3">
              <Activity className="w-6 h-6 text-[#3d8b7a] dark:text-gray-300" />
            </div>
            <p className="text-gray-500 dark:text-white/50 text-sm mb-4">No client apps yet. Create your first app to get started.</p>
            <Link href="/apps">
              <Button size="sm" className="gap-1.5 bg-[#3d8b7a] hover:bg-[#2f7365] text-white dark:bg-white dark:hover:bg-gray-200 dark:text-[#0a0e1a]">
                <Plus className="w-4 h-4" /> Create App
              </Button>
            </Link>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {clientApps.map((app) => {
              const appCampaigns = getCampaignsForApp(app.id);
              const appBroadcasts = getBroadcastsForApp(app.id);
              const activeBroadcasts = appBroadcasts.filter(b => b.status === 'live');
              const totalViewers = appBroadcasts.reduce((sum, b) => sum + ((b as any).viewerCount || 0), 0);

              return (
                <Link key={app.id} href={`/apps/${app.id}`}>
                  <div
                    className="rounded-xl overflow-hidden cursor-pointer group transition-all hover:scale-[1.02] hover:shadow-xl"
                    data-testid={`card-app-${app.id}`}
                  >
                    <div className="h-32 relative">
                      {(app.iconUrl || app.bannerUrl) ? (
                        <img 
                          src={(app.bannerUrl || app.iconUrl) as string} 
                          alt={app.name} 
                          className="w-full h-full object-cover"
                        />
                      ) : (
                        getAppPlaceholder(app.name)
                      )}
                      <div className="absolute top-3 right-3">
                        <span className="px-2.5 py-1 rounded-full bg-black/40 text-xs font-medium text-white backdrop-blur-sm border border-white/10">
                          {appCampaigns.length} Campaign{appCampaigns.length !== 1 ? 's' : ''}
                        </span>
                      </div>
                      <div className="absolute inset-x-0 bottom-0 p-4 bg-gradient-to-t from-black/80 to-transparent">
                        <h3 className="text-white font-semibold text-base leading-tight">{app.name}</h3>
                        <p className="text-white/60 text-[10px] mt-0.5">{app.bundleId}</p>
                      </div>
                    </div>
                    <div className="bg-white dark:bg-[#141824] p-4 border border-gray-200 dark:border-white/5 border-t-0 rounded-b-xl">
                      <div className="flex items-center justify-between">
                        <div>
                          <p className="text-[10px] text-gray-400 dark:text-white/30 uppercase tracking-wider">Active Broadcasts</p>
                          <p className="text-lg font-bold text-gray-900 dark:text-white">{activeBroadcasts.length}</p>
                        </div>
                        <div className="text-right">
                          <p className="text-[10px] text-gray-400 dark:text-white/30 uppercase tracking-wider">Total Viewers</p>
                          <p className="text-lg font-bold text-gray-900 dark:text-white">{totalViewers > 0 ? formatNumber(totalViewers) : '--'}</p>
                        </div>
                      </div>
                      <div className="mt-3">
                        <div className="flex justify-between items-center mb-1">
                           <span className="text-[10px] text-gray-400 dark:text-white/30">Completion</span>
                           <span className="text-[10px] text-gray-400 dark:text-white/30">{Math.min(appCampaigns.length * 15, 100)}%</span>
                        </div>
                        <div className="w-full bg-gray-200 dark:bg-white/10 rounded-full h-1.5">
                          <div
                            className="bg-[#3d8b7a] dark:bg-white h-1.5 rounded-full transition-all"
                            style={{ width: `${Math.min(appCampaigns.length * 15, 100)}%` }}
                          />
                        </div>
                      </div>
                    </div>
                  </div>
                </Link>
              );
            })}
          </div>
        )}
      </div>

      <div className="mb-8">
        <div className="flex items-center justify-between mb-4">
          <div>
            <h2 className="text-lg font-semibold text-gray-900 dark:text-white" data-testid="text-live-broadcasts-title">Live Broadcasts</h2>
            <p className="text-sm text-gray-400 dark:text-white/40">Currently streaming events</p>
          </div>
        </div>

        <div className="rounded-xl border border-gray-200 dark:border-white/5 overflow-hidden bg-white dark:bg-white/[0.02]">
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b border-gray-200 dark:border-white/5">
                  <th className="text-left text-[10px] text-gray-400 dark:text-white/30 uppercase tracking-wider py-3 px-4 font-medium">Broadcast</th>
                  <th className="text-left text-[10px] text-gray-400 dark:text-white/30 uppercase tracking-wider py-3 px-4 font-medium">Campaign</th>
                  <th className="text-left text-[10px] text-gray-400 dark:text-white/30 uppercase tracking-wider py-3 px-4 font-medium">Status</th>
                  <th className="text-left text-[10px] text-gray-400 dark:text-white/30 uppercase tracking-wider py-3 px-4 font-medium">Viewers</th>
                  <th className="text-left text-[10px] text-gray-400 dark:text-white/30 uppercase tracking-wider py-3 px-4 font-medium">Engagement</th>
                  <th className="text-left text-[10px] text-gray-400 dark:text-white/30 uppercase tracking-wider py-3 px-4 font-medium">Duration</th>
                  <th className="text-left text-[10px] text-gray-400 dark:text-white/30 uppercase tracking-wider py-3 px-4 font-medium">Actions</th>
                </tr>
              </thead>
              <tbody>
            {liveBroadcasts.length === 0 ? (
                  <tr>
                    <td colSpan={7} className="text-center py-5">
                      <div className="flex flex-col items-center justify-center gap-2 text-gray-400 dark:text-white/30">
                        <Radio className="w-6 h-6 mb-1 opacity-50" />
                        <span className="text-sm">No live broadcasts right now</span>
                        <Link href="/broadcasts">
                          <Button variant="link" size="sm" className="text-xs text-[#3d8b7a] dark:text-[#5eff9e] p-0 h-auto">
                            Start one
                          </Button>
                        </Link>
                      </div>
                    </td>
                  </tr>
                ) : (
                  liveBroadcasts.map((broadcast) => {
                    const campaign = broadcast.campaignId ? campaignMap.get(broadcast.campaignId) : null;
                    const duration = broadcast.startTime
                      ? Math.floor((new Date().getTime() - new Date(broadcast.startTime).getTime()) / 60000)
                      : 0;
                    const hours = Math.floor(duration / 60);
                    const mins = duration % 60;

                    return (
                      <tr key={broadcast.broadcastId} className="border-b border-gray-200 dark:border-white/5 hover:bg-gray-50 dark:hover:bg-white/[0.02] transition-colors" data-testid={`row-broadcast-${broadcast.broadcastId}`}>
                        <td className="py-3 px-4">
                          <div className="flex items-center gap-3">
                            <div className="w-2 h-2 rounded-full bg-red-500 animate-pulse" />
                            <div>
                              <p className="text-sm font-medium text-gray-900 dark:text-white">{broadcast.broadcastName}</p>
                              <p className="text-xs text-gray-400 dark:text-white/30">{broadcast.broadcastId}</p>
                            </div>
                          </div>
                        </td>
                        <td className="py-3 px-4">
                          <p className="text-sm text-gray-600 dark:text-white/70">{campaign?.name || '--'}</p>
                          <p className="text-xs text-gray-400 dark:text-white/30">{campaign?.description?.slice(0, 30) || ''}</p>
                        </td>
                        <td className="py-3 px-4">
                          <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-green-500/20 text-green-400 text-xs font-medium">
                            <span className="w-1.5 h-1.5 rounded-full bg-green-400 animate-pulse" />
                            Live
                          </span>
                        </td>
                        <td className="py-3 px-4">
                          <p className="text-sm font-semibold text-gray-900 dark:text-white">{(broadcast as any).viewerCount ? Number((broadcast as any).viewerCount).toLocaleString() : '0'}</p>
                        </td>
                        <td className="py-3 px-4">
                          <p className="text-sm text-gray-500 dark:text-white/50">{(broadcast as any).totalVotes ? Number((broadcast as any).totalVotes).toLocaleString() + ' votes' : '--'}</p>
                        </td>
                        <td className="py-3 px-4">
                          <p className="text-sm text-gray-600 dark:text-white/70">{hours > 0 ? `${hours}h ${mins}m` : `${mins}m`}</p>
                        </td>
                        <td className="py-3 px-4">
                          <Link href={`/broadcasts/${broadcast.broadcastId}`}>
                            <Button size="sm" variant="outline" className="border-gray-200 dark:border-white/20 text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-white/10 text-xs h-7 px-3" data-testid={`button-manage-broadcast-${broadcast.broadcastId}`}>
                              Manage
                            </Button>
                          </Link>
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      {(upcomingCampaigns.length > 0 || campaigns.length > 0) && (
        <div>
          <div className="flex items-center justify-between mb-4">
            <div>
              <h2 className="text-lg font-semibold text-gray-900 dark:text-white" data-testid="text-upcoming-campaigns-title">
                {upcomingCampaigns.length > 0 ? 'Upcoming Campaigns' : 'Recent Campaigns'}
              </h2>
              {upcomingCampaigns.length === 0 ? (
                <p className="text-sm text-gray-400 dark:text-white/40">No upcoming campaigns scheduled</p>
              ) : (
                <p className="text-sm text-gray-400 dark:text-white/40">Scheduled campaigns for the next 7 days</p>
              )}
            </div>
            <Link href="/campaigns">
              <Button variant="ghost" size="sm" className="gap-1 text-gray-500 dark:text-gray-300 hover:text-gray-700 dark:hover:text-gray-200 text-xs" data-testid="link-view-all-campaigns">
                View All <ChevronRight className="w-3.5 h-3.5" />
              </Button>
            </Link>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {(upcomingCampaigns.length > 0 ? upcomingCampaigns : campaigns.slice(0, 3)).map((campaign) => {
              const channel = campaign.channelId ? channelMap.get(campaign.channelId) : null;
              const app = channel ? clientApps.find(a => a.id === channel.clientAppId) : null;
              const campaignBroadcasts = broadcasts.filter(b => b.campaignId === campaign.id);
              
              const initials = campaign.name
                .split(' ')
                .map(n => n[0])
                .join('')
                .toUpperCase()
                .slice(0, 2);

              return (
                <div
                  key={campaign.id}
                  className="rounded-xl border border-gray-200 dark:border-white/5 bg-white dark:bg-white/[0.02] overflow-hidden"
                  data-testid={`card-campaign-${campaign.id}`}
                >
                  <div className="p-4">
                    <div className="flex items-start justify-between mb-3">
                      <div className="flex items-center gap-3">
                        <div className="w-10 h-10 rounded-lg bg-[#3d8b7a]/10 flex items-center justify-center text-[#3d8b7a] font-bold text-xs">
                          {campaign.logo ? (
                            <img src={campaign.logo} alt="" className="w-full h-full object-cover rounded-lg" />
                          ) : initials}
                        </div>
                        <div>
                          <h3 className="text-sm font-semibold text-gray-900 dark:text-white">{campaign.name}</h3>
                          <p className="text-xs text-gray-400 dark:text-white/40">{app?.name || 'No surface'}</p>
                        </div>
                      </div>
                      {campaign.startDate && (
                        <span className={`px-2 py-0.5 rounded-full text-[10px] font-medium ${
                          new Date(campaign.startDate) > new Date()
                            ? 'bg-orange-500/20 text-orange-400'
                            : 'bg-green-500/20 text-green-400'
                        }`}>
                          {new Date(campaign.startDate) > new Date()
                            ? getDaysUntil(new Date(campaign.startDate))
                            : 'Active'}
                        </span>
                      )}
                    </div>
                    <div className="grid grid-cols-3 gap-3 mb-4">
                      <div>
                        <p className="text-[10px] text-gray-400 dark:text-white/30 uppercase tracking-wider">Start Date</p>
                        <p className="text-xs text-gray-600 dark:text-white/70 mt-0.5">
                          {campaign.startDate ? new Date(campaign.startDate).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '--'}
                        </p>
                      </div>
                      <div>
                        <p className="text-[10px] text-gray-400 dark:text-white/30 uppercase tracking-wider">Broadcasts</p>
                        <p className="text-xs text-gray-600 dark:text-white/70 mt-0.5">{campaignBroadcasts.length} scheduled</p>
                      </div>
                      <div>
                        <p className="text-[10px] text-gray-400 dark:text-white/30 uppercase tracking-wider">Components</p>
                        <p className="text-xs text-gray-600 dark:text-white/70 mt-0.5">{(campaign as any).componentCount ?? '--'}</p>
                      </div>
                    </div>
                  </div>
                  <div className="px-4 pb-4 flex items-center gap-2">
                    <Link href={`/campaigns/${campaign.id}`} className="flex-1">
                      <Button className="w-full bg-[#3d8b7a] hover:bg-[#2f7365] text-white dark:bg-white dark:hover:bg-gray-200 dark:text-[#0a0e1a] text-xs h-9" data-testid={`button-configure-campaign-${campaign.id}`}>
                        Configure
                      </Button>
                    </Link>
                    <Button variant="ghost" size="icon" className="text-gray-400 dark:text-white/30 hover:text-gray-600 dark:hover:text-white/60 h-9 w-9" data-testid={`button-more-campaign-${campaign.id}`}>
                      <MoreVertical className="w-4 h-4" />
                    </Button>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </AppLayout>
  );
}

function StatCard({
  icon,
  iconBg,
  iconColor,
  value,
  formattedValue,
  label,
  change,
  suffix = '',
  testId,
}: {
  icon: React.ReactNode;
  iconBg: string;
  iconColor: string;
  value: number;
  formattedValue?: string;
  label: string;
  change: number;
  suffix?: string;
  testId: string;
}) {
  return (
    <div className="rounded-xl border border-gray-200 dark:border-white/5 bg-white dark:bg-white/[0.02] p-4 hover:bg-gray-50 dark:hover:bg-white/[0.04] transition-all" data-testid={testId}>
      <div className="flex items-start justify-between mb-3">
        <div className={`w-10 h-10 rounded-xl ${iconBg} flex items-center justify-center ${iconColor}`}>
          {icon}
        </div>
        {change > 0 && (
          <div className="flex items-center gap-1 text-emerald-400 text-xs">
            <TrendingUp className="w-3 h-3" />
            <span>↑ {change}%</span>
          </div>
        )}
      </div>
      <p className="text-2xl font-bold text-gray-900 dark:text-white">{formattedValue || formatNumber(value)}{suffix}</p>
      <p className="text-xs text-gray-400 dark:text-white/40 mt-0.5">{label}</p>
    </div>
  );
}
