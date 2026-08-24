import { useEffect, useMemo, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { siYoutube } from 'simple-icons';
import { api, type AnnouncementPresetId } from '../../api';
import { brand } from '../../brand';
import { Card } from '../components/Card';
import { Pill } from '../components/Pill';
import { studioIntegrationPlatforms } from '../types';
import { FanvueView } from './FanvueView';
import type {
  StudioCreator,
  StudioDeviantArtAccount,
  StudioExternalCollection,
  StudioExternalCollectionMapping,
  StudioExternalSyncJob,
  StudioUbeeqCollection,
  StudioIntegrationPlatform,
  StudioYouTubeAccount
} from '../types';
import { TumblrIntegrationPanel } from './TumblrIntegrationPanel';

const deviantArtDisplayWidths = [400, 600, 800, 900, 1024, 1280, 1600, 1920];
type MatureClassification = 'nudity' | 'sexual' | 'gore' | 'language' | 'ideology';
const matureClassificationOptions: Array<{ value: MatureClassification; label: string }> = [
  { value: 'nudity', label: 'Nudity' },
  { value: 'sexual', label: 'Sexual themes' },
  { value: 'gore', label: 'Gore' },
  { value: 'language', label: 'Strong language' },
  { value: 'ideology', label: 'Ideology' }
];

const defaultVisibleIntegrationPlatforms: StudioIntegrationPlatform[] = ['deviantart', 'fanvue', 'bluesky'];

const discordAnnouncementPresets: Array<{ id: AnnouncementPresetId; label: string; description: string }> = [
  { id: 'recommended', label: 'Recommended', description: 'Matches the announcement to each Work type.' },
  { id: 'image_showcase', label: 'Image showcase', description: 'A visual release with the primary image where available.' },
  { id: 'writing_release', label: 'Post or story', description: 'A reading-first release with a clear title and link.' },
  { id: 'video_premiere', label: 'Video premiere', description: 'A video release with a concise call to watch.' },
  { id: 'audio_release', label: 'Audio release', description: 'A track or audio release with a concise call to listen.' },
  { id: 'compact_link', label: 'Compact link', description: 'One concise announcement and a link.' },
  { id: 'text_only', label: 'Text only', description: 'No rich preview or primary media.' },
  { id: 'collection_digest', label: 'Collection digest', description: 'A grouped release for a gallery or album.' },
  { id: 'series_digest', label: 'Series digest', description: 'A grouped release for chapters or episodes.' }
];

const discordPresetLabel = (preset?: AnnouncementPresetId): string => discordAnnouncementPresets.find((option) => option.id === preset)?.label || 'Recommended';

const normalizeVisibleIntegrationPlatforms = (values?: readonly string[]): StudioIntegrationPlatform[] => {
  if (!values) return [...defaultVisibleIntegrationPlatforms];
  return studioIntegrationPlatforms
    .map((platform) => platform.id)
    .filter((platform) => values.includes(platform)) as StudioIntegrationPlatform[];
};

const integrationPlatformLabelOrder = (a: { label: string }, b: { label: string }): number =>
  a.label.localeCompare(b.label, undefined, { sensitivity: 'base' });

type CollectionResponse = {
  ubeeqCollections: StudioUbeeqCollection[];
  externalCollections: StudioExternalCollection[];
  mappings: StudioExternalCollectionMapping[];
};

type DeviantArtCredential = {
  externalPlatformCredentialId: string;
  applicationLabel?: string;
  clientId: string;
  redirectUri: string;
  updatedAt: string;
};

const formatDate = (value?: string): string => {
  if (!value) return 'Not yet';
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? 'Not yet' : date.toLocaleString();
};

const syncPhaseLabel = (type: string): string => ({
  account_import: 'account import',
  full_reconciliation: 'catalogue synchronization',
  account_scan: 'catalogue refresh',
  content_sync: 'source-file copy',
  activity_sync: 'notifications and watchers',
  engagement_sync: 'engagement and comments',
  comment_sync: 'comments',
  publish: 'publishing',
  remote_update: 'metadata update'
}[type] || type.replace(/_/g, ' '));

const formatCountdown = (value: string | undefined, now: number): string => {
  if (!value) return '';
  const remainingSeconds = Math.max(0, Math.ceil((Date.parse(value) - now) / 1000));
  if (!Number.isFinite(remainingSeconds)) return '';
  if (remainingSeconds < 60) return `${remainingSeconds}s`;
  const minutes = Math.ceil(remainingSeconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  return remainder ? `${hours}h ${remainder}m` : `${hours}h`;
};

const accountTone = (status: StudioDeviantArtAccount['connectionStatus'] | StudioYouTubeAccount['connectionStatus']): 'success' | 'warning' | 'danger' | 'default' => {
  if (status === 'connected') return 'success';
  if (status === 'authentication_required') return 'danger';
  if (status === 'rate_limited' || status === 'temporarily_unavailable') return 'warning';
  return 'default';
};

const copySyncSummary = (jobs: StudioExternalSyncJob[], catalogueJob?: StudioExternalSyncJob) => {
  const startedAt = catalogueJob?.createdAt || '';
  const parentJobId = catalogueJob?.externalSyncJobId;
  const copyJobs = jobs.filter((job) => job.type === 'content_sync' && (
    (parentJobId && job.payload?.parentJobId === parentJobId)
    || (!parentJobId || job.createdAt >= startedAt)
  ));
  if (!copyJobs.length) return null;
  // A content-sync job can complete successfully without storing anything when
  // DeviantArt does not expose a downloadable source. Use the job progress to
  // distinguish that case from an actually stored copy.
  const stored = copyJobs.filter((job) => job.status === 'successful' && (job.progress?.synchronized || 0) > 0).length;
  const unavailable = copyJobs.filter((job) => (
    ['failed', 'cancelled', 'authentication_required'].includes(job.status)
    || (job.status === 'successful' && (job.progress?.synchronized || 0) === 0)
  )).length;
  const inProgress = copyJobs.length - stored - unavailable;
  return { requested: copyJobs.length, stored, unavailable, inProgress };
};

const syncJobStatusLabel = (status: string): string => ({
  queued: 'Queued',
  processing: 'In progress',
  retry_scheduled: 'Retry scheduled',
  rate_limited: 'Paused for rate limit',
  successful: 'Complete',
  failed: 'Failed',
  cancelled: 'Cancelled',
  authentication_required: 'Needs reconnect'
}[status] || status.replace(/_/g, ' '));

export function DeviantArtView({ creators }: { creators: StudioCreator[] }) {
  const location = useLocation();
  const requestedCreatorId = new URLSearchParams(location.search).get('creatorId') || '';
  const [creatorId, setCreatorId] = useState('');
  const [configuration, setConfiguration] = useState<{
    configured: boolean;
    callbackUrl?: string;
    requiredConfiguration: string[];
    credential: null | { clientId: string; redirectUri: string; updatedAt: string };
    credentials?: DeviantArtCredential[];
  } | null>(null);
  const [blueskyConfiguration, setBlueskyConfiguration] = useState<{ configured: boolean; requiredConfiguration: string[] } | null>(null);
  const [blueskyAccounts, setBlueskyAccounts] = useState<Array<{ externalAccountId: string; externalUsername: string; externalUserId: string }>>([]);
  const [blueskyHandle, setBlueskyHandle] = useState('');
  const [youtubeConfiguration, setYoutubeConfiguration] = useState<{
    configured: boolean;
    callbackUrl?: string;
    scope?: string;
    quotaGuidance?: string;
    requiredConfiguration: string[];
  } | null>(null);
  const [youtubeAccounts, setYoutubeAccounts] = useState<StudioYouTubeAccount[]>([]);
  const [youtubeBusy, setYoutubeBusy] = useState('');
  const [discordConfiguration, setDiscordConfiguration] = useState<{
    configured: boolean;
    installations: Array<{ communityInstallationId: string; displayName: string; iconUrl?: string; status: 'connected' | 'needs_attention' | 'disabled'; lastError?: string }>;
  } | null>(null);
  const [discordDestinations, setDiscordDestinations] = useState<Array<{
    communityDestinationId: string;
    communityInstallationId: string;
    remoteChannelId: string;
    displayName: string;
    status: 'active' | 'needs_attention' | 'disabled';
    template?: string;
    defaultAnnouncementPreset?: AnnouncementPresetId;
    defaultIncludePrimaryMedia?: boolean;
    deliveries?: Array<{ status: string; updatedAt: string; sentAt?: string; errorMessage?: string }>;
  }>>([]);
  const [discordChannelsByInstallation, setDiscordChannelsByInstallation] = useState<Record<string, Array<{ id: string; name: string; type: number }>>>({});
  const [discordInstallationId, setDiscordInstallationId] = useState('');
  const [discordChannelId, setDiscordChannelId] = useState('');
  const [discordAnnouncementPreset, setDiscordAnnouncementPreset] = useState<AnnouncementPresetId>('recommended');
  const [discordIncludePrimaryMedia, setDiscordIncludePrimaryMedia] = useState(true);
  const [discordBusy, setDiscordBusy] = useState('');
  const [accounts, setAccounts] = useState<StudioDeviantArtAccount[]>([]);
  const [jobsByAccount, setJobsByAccount] = useState<Record<string, StudioExternalSyncJob[]>>({});
  const [collections, setCollections] = useState<CollectionResponse>({ ubeeqCollections: [], externalCollections: [], mappings: [] });
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const [applicationLabel, setApplicationLabel] = useState('');
  const [activeCredentialId, setActiveCredentialId] = useState('');
  const [accountApplicationFilterId, setAccountApplicationFilterId] = useState('');
  const [editingApplication, setEditingApplication] = useState(false);
  const [creatingApplication, setCreatingApplication] = useState(false);
  const [deletingApplication, setDeletingApplication] = useState(false);
  const [connectionGuideExpanded, setConnectionGuideExpanded] = useState(true);
  const [recentlyConnectedAccountId, setRecentlyConnectedAccountId] = useState('');
  const [includeSourceFilesByAccount, setIncludeSourceFilesByAccount] = useState<Record<string, boolean>>({});
  const [loading, setLoading] = useState(false);
  const [workingAccountId, setWorkingAccountId] = useState('');
  const [cancellingSyncJobId, setCancellingSyncJobId] = useState('');
  const [rateLimitClock, setRateLimitClock] = useState(() => Date.now());
  const [queuedSyncAccountId, setQueuedSyncAccountId] = useState('');
  const [destinationCreatorByAccount, setDestinationCreatorByAccount] = useState<Record<string, string>>({});
  const [movingAccountId, setMovingAccountId] = useState('');
  const [moveCreatorId, setMoveCreatorId] = useState('');
  const [presetAccountId, setPresetAccountId] = useState('');
  const [presetTags, setPresetTags] = useState('');
  const [presetGalleryIds, setPresetGalleryIds] = useState<string[]>([]);
  const [presetTargetStatus, setPresetTargetStatus] = useState<'draft' | 'published'>('published');
  const [presetDisplayResolution, setPresetDisplayResolution] = useState('');
  const [presetAllowFreeDownload, setPresetAllowFreeDownload] = useState(false);
  const [presetAddWatermark, setPresetAddWatermark] = useState(false);
  const [presetIsMature, setPresetIsMature] = useState(false);
  const [presetMatureLevel, setPresetMatureLevel] = useState<'strict' | 'moderate'>('moderate');
  const [presetMatureClassification, setPresetMatureClassification] = useState<MatureClassification[]>([]);
  const [presetIsAiGenerated, setPresetIsAiGenerated] = useState(false);
  const [presetNoAi, setPresetNoAi] = useState(false);
  const [newGalleryName, setNewGalleryName] = useState('');
  const [presetBusy, setPresetBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [connectionError, setConnectionError] = useState('');
  // Keep YouTube OAuth feedback with the integration that produced it.  The
  // general connection notice is rendered much lower in this page, which made
  // a successful (or failed) return from Google look like it had done nothing.
  const [youtubeConnectionNotice, setYoutubeConnectionNotice] = useState('');
  const [youtubeConnectionError, setYoutubeConnectionError] = useState('');
  const [visibleIntegrationPlatforms, setVisibleIntegrationPlatforms] = useState<StudioIntegrationPlatform[]>(defaultVisibleIntegrationPlatforms);
  const [visibleIntegrationPlatformsByCreator, setVisibleIntegrationPlatformsByCreator] = useState<Record<string, StudioIntegrationPlatform[]>>({});
  const [savingIntegrationVisibility, setSavingIntegrationVisibility] = useState(false);

  useEffect(() => {
    if (!creators.length) return;
    const nextCreatorId = creators.some((creator) => creator.creatorId === requestedCreatorId)
      ? requestedCreatorId
      : creators[0].creatorId;
    setCreatorId((current) => current === nextCreatorId ? current : nextCreatorId);
  }, [creators, requestedCreatorId]);

  useEffect(() => {
    if (!creatorId) return;
    const currentCreator = creators.find((creator) => creator.creatorId === creatorId);
    if (!currentCreator) return;
    const configuredPlatforms = Object.prototype.hasOwnProperty.call(visibleIntegrationPlatformsByCreator, creatorId)
      ? visibleIntegrationPlatformsByCreator[creatorId]
      : currentCreator.visibleIntegrations;
    setVisibleIntegrationPlatforms(normalizeVisibleIntegrationPlatforms(configuredPlatforms));
  }, [creatorId, creators, visibleIntegrationPlatformsByCreator]);

  // Keep the platform chooser useful as integrations grow: enabled platforms
  // are grouped first, with alphabetical ordering within each group.
  const orderedIntegrationPlatforms = useMemo(() => {
    const selected = new Set(visibleIntegrationPlatforms);
    return [...studioIntegrationPlatforms].sort((a, b) => {
      const aSelected = selected.has(a.id);
      const bSelected = selected.has(b.id);
      if (aSelected !== bSelected) return aSelected ? -1 : 1;
      return integrationPlatformLabelOrder(a, b);
    });
  }, [visibleIntegrationPlatforms]);

  const toggleIntegrationVisibility = async (platform: StudioIntegrationPlatform) => {
    if (!creatorId) return;
    const next = visibleIntegrationPlatforms.includes(platform)
      ? visibleIntegrationPlatforms.filter((item) => item !== platform)
      : [...visibleIntegrationPlatforms, platform];
    const previous = visibleIntegrationPlatforms;
    setVisibleIntegrationPlatforms(next);
    setVisibleIntegrationPlatformsByCreator((current) => ({ ...current, [creatorId]: next }));
    setSavingIntegrationVisibility(true);
    setError('');
    try {
      await api.studioUpdateCreator(creatorId, { visibleIntegrations: next });
    } catch (visibilityError) {
      setVisibleIntegrationPlatforms(previous);
      setVisibleIntegrationPlatformsByCreator((current) => ({ ...current, [creatorId]: previous }));
      setError(visibilityError instanceof Error ? visibilityError.message : 'Unable to save integration visibility.');
    } finally {
      setSavingIntegrationVisibility(false);
    }
  };

  useEffect(() => {
    const url = new URL(window.location.href);
    const connectionState = url.searchParams.get('deviantart');
    const connectedAccountId = url.searchParams.get('account') || '';
    const connectedApplicationId = url.searchParams.get('application') || '';
    const failureReason = url.searchParams.get('reason');
    const failureStage = url.searchParams.get('stage');
    const failureDetail = url.searchParams.get('detail');
    if (!connectionState) return;
    if (connectionState === 'connected_assignment_required') {
      setRecentlyConnectedAccountId(connectedAccountId);
      setActiveCredentialId(connectedApplicationId);
      setMessage(`DeviantArt account connected. Choose its ${brand.creatorName} assignment below to start the import.`);
    } else if (connectionState === 'connected_destination_defaulted') {
      setRecentlyConnectedAccountId(connectedAccountId);
      setActiveCredentialId(connectedApplicationId);
      setMessage(`DeviantArt account connected. Its destination ${brand.creatorName} was selected automatically.`);
    } else if (connectionState === 'connected') {
      setMessage('DeviantArt account connected and its import has been queued.');
    } else if (connectionState === 'cancelled') {
      setConnectionError(failureDetail
        ? `DeviantArt authorization was cancelled: ${failureDetail}`
        : 'DeviantArt authorization was cancelled before access was granted.');
    } else if (connectionState === 'failed') {
      if (failureReason === 'authentication_required' && failureStage === 'token_exchange') {
        setConnectionError('DeviantArt rejected this application during token exchange. Verify the saved client ID and client secret, and confirm the application is Confidential with this exact callback URL.');
      } else if (failureReason === 'authentication_required' && failureStage === 'account_lookup') {
        setConnectionError(`DeviantArt issued a token but did not allow account verification. ${brand.productName} has updated the requested permission; connect again to approve it.`);
      } else {
        setConnectionError(failureDetail
          ? `DeviantArt authorization did not complete: ${failureDetail}`
          : `DeviantArt authorization did not complete${failureReason ? ` (${failureReason})` : ''}. Try connecting the account again.`);
      }
    }
    url.searchParams.delete('deviantart');
    url.searchParams.delete('account');
    url.searchParams.delete('application');
    url.searchParams.delete('reason');
    url.searchParams.delete('stage');
    url.searchParams.delete('detail');
    window.history.replaceState({}, '', `${url.pathname}${url.search}${url.hash}`);
  }, []);

  useEffect(() => {
    const url = new URL(window.location.href);
    const discordState = url.searchParams.get('discord');
    if (!discordState) return;
    const detail = url.searchParams.get('message');
    url.searchParams.delete('discord');
    url.searchParams.delete('message');
    window.history.replaceState({}, '', `${url.pathname}${url.search}${url.hash}`);
    if (discordState === 'connected') setMessage('Discord server connected. Choose the Creator channels that should receive Space announcements.');
    else setConnectionError(detail || 'Discord connection could not be completed.');
  }, []);

  useEffect(() => {
    const url = new URL(window.location.href);
    const connectionState = url.searchParams.get('youtube');
    const connectedAccountId = url.searchParams.get('account') || '';
    if (!connectionState) return;
    const detail = url.searchParams.get('detail') || url.searchParams.get('reason') || '';
    const callbackStage = url.searchParams.get('stage') || '';
    const connectionSucceeded = connectionState === 'connected_destination_defaulted' || connectionState === 'connected';

    // A successful callback needs the selected Creator before its newly stored
    // channel can be loaded. Leave the callback query intact until that context
    // exists so an OAuth-return remount cannot silently discard the result.
    if (connectionSucceeded && !creatorId) return;

    let cancelled = false;
    const clearCallbackQuery = () => {
      if (cancelled) return;
      url.searchParams.delete('youtube');
      url.searchParams.delete('account');
      url.searchParams.delete('detail');
      url.searchParams.delete('reason');
      url.searchParams.delete('stage');
      window.history.replaceState({}, '', `${url.pathname}${url.search}${url.hash}`);
    };

    const refreshAfterCallback = async () => {
      if (!creatorId) return;
      // The callback writes the account before redirecting, but a local API
      // process may still be flushing its backing store when the Studio page
      // mounts. Refresh once more after a short settling interval so a valid
      // Google authorization is visible instead of looking like a no-op.
      await load(creatorId);
      if (!cancelled && connectedAccountId && !youtubeAccounts.some((account) => account.externalAccountId === connectedAccountId)) {
        await new Promise((resolve) => window.setTimeout(resolve, 350));
        if (!cancelled) await load(creatorId);
      }
    };

    setYoutubeConnectionNotice('');
    setYoutubeConnectionError('');
    if (connectionState === 'connected_destination_defaulted' || connectionState === 'connected') {
      setYoutubeConnectionNotice('YouTube channel connected. Choose Sync videos to import its catalogue for this Creator.');
      void refreshAfterCallback().catch((refreshError) => {
        if (!cancelled) setYoutubeConnectionError(refreshError instanceof Error ? refreshError.message : 'The YouTube channel connected, but Studio could not refresh its account list.');
      }).finally(clearCallbackQuery);
    } else if (connectionState === 'connected_assignment_required') {
      setYoutubeConnectionError('YouTube channel connected, but it must be assigned to a Creator before its videos can be imported.');
      void refreshAfterCallback().catch((refreshError) => {
        if (!cancelled) setYoutubeConnectionError(refreshError instanceof Error ? refreshError.message : 'Studio could not refresh the connected YouTube account.');
      }).finally(clearCallbackQuery);
    } else if (connectionState === 'cancelled') {
      setYoutubeConnectionError('YouTube authorization was cancelled before access was granted.');
      clearCallbackQuery();
    } else if (detail === 'youtube_data_api_disabled') {
      setYoutubeConnectionError('Google sign-in succeeded, but YouTube Data API v3 is not enabled for this Google Cloud project. Enable it in Google Cloud Console under APIs & Services, wait a few minutes, then connect the channel again.');
      clearCallbackQuery();
    } else if (detail === 'youtube_channel_unavailable') {
      setYoutubeConnectionError('The OAuth callback reached Eversally and Google granted access, but YouTube returned no channel for the selected Google account. Create or select a YouTube channel for that account—or reconnect with the Google or Brand identity that owns the channel—then try again.');
      clearCallbackQuery();
    } else if (detail === 'authentication_required') {
      setYoutubeConnectionError('Google authorized the request, but YouTube rejected the channel lookup. Confirm that this Google account owns the channel and try connecting it again.');
      clearCallbackQuery();
    } else {
      setYoutubeConnectionError(`YouTube authorization reached Eversally but could not be completed${callbackStage ? ` during ${callbackStage.replace(/_/g, ' ')}` : ''}. Try connecting the channel again.`);
      clearCallbackQuery();
    }

    return () => { cancelled = true; };

    // The callback state has already been validated by the API. `load` is kept
    // out of the dependency list because it is recreated for the current view.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [creatorId]);

  useEffect(() => {
    const url = new URL(window.location.href);
    const state = url.searchParams.get('state');
    const proof = url.searchParams.get('proof');
    if (url.searchParams.get('bluesky') !== 'connected' || !state || !proof) return;
    url.searchParams.delete('bluesky');
    url.searchParams.delete('state');
    url.searchParams.delete('proof');
    window.history.replaceState({}, '', `${url.pathname}${url.search}${url.hash}`);
    void api.studioCompleteBlueskyConnection(state, proof)
      .then((account) => {
        setMessage(`Bluesky account “${account.externalUsername}” is connected to this ${brand.creatorName}.`);
        return load();
      })
      .catch((connectionError) => setConnectionError(connectionError instanceof Error ? connectionError.message : 'Bluesky authorization completed, but the account could not be attached to this creator.'));
    // The state contains the selected Creator and is re-authorized by the API.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const load = async (nextCreatorId = creatorId, nextQueuedSyncAccountId = queuedSyncAccountId) => {
    if (!nextCreatorId) return;
    setLoading(true);
    setError('');
    try {
      const [nextConfiguration, nextAccounts, nextYoutubeConfiguration, nextYoutubeAccounts, nextBlueskyConfiguration, nextBlueskyAccounts, nextDiscordConfiguration, nextDiscordDestinations] = await Promise.all([
        api.studioGetDeviantArtConfiguration(),
        api.studioListDeviantArtAccounts(),
        api.studioGetYoutubeConfiguration(),
        api.studioListYoutubeAccounts(nextCreatorId),
        api.studioGetBlueskyConfiguration(),
        api.studioListBlueskyAccounts(nextCreatorId),
        api.studioGetDiscordConfiguration(),
        api.studioListDiscordDestinations(nextCreatorId)
      ]);
      const typedAccounts = (nextAccounts || []) as StudioDeviantArtAccount[];
      const nextCollections = typedAccounts.length
        ? await api.studioListDeviantArtCollections(nextCreatorId)
        : { ubeeqCollections: [], externalCollections: [], mappings: [] };
      setConfiguration(nextConfiguration);
      setAccounts(typedAccounts);
      setIncludeSourceFilesByAccount(Object.fromEntries(typedAccounts.map((account) => [
        account.externalAccountId,
        account.includeSourceFilesOnSync !== false
      ])));
      setDestinationCreatorByAccount(Object.fromEntries(typedAccounts.map((account) => [
        account.externalAccountId,
        account.primaryCreatorIdentityId || account.creatorIdentityId || nextCreatorId
      ])));
      setCollections(nextCollections as CollectionResponse);
      setYoutubeConfiguration(nextYoutubeConfiguration);
      setYoutubeAccounts((nextYoutubeAccounts || []) as StudioYouTubeAccount[]);
      setBlueskyConfiguration(nextBlueskyConfiguration);
      setBlueskyAccounts((nextBlueskyAccounts || []) as Array<{ externalAccountId: string; externalUsername: string; externalUserId: string }>);
      setDiscordConfiguration(nextDiscordConfiguration);
      setDiscordDestinations(nextDiscordDestinations || []);
      const nextJobs = await Promise.all(typedAccounts.map(async (account) => [
        account.externalAccountId,
        await api.studioListDeviantArtSyncJobs(account.externalAccountId) as StudioExternalSyncJob[]
      ] as const));
      setJobsByAccount(Object.fromEntries(nextJobs));
      if (nextQueuedSyncAccountId) {
        const queuedAccountJobs = nextJobs.find(([externalAccountId]) => externalAccountId === nextQueuedSyncAccountId)?.[1] || [];
        if (queuedAccountJobs.length && !queuedAccountJobs.some((job) => ['queued', 'processing', 'retry_scheduled', 'rate_limited'].includes(job.status))) {
          setQueuedSyncAccountId('');
          setMessage('');
        }
      }
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Unable to load DeviantArt management data.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [creatorId]);

  useEffect(() => {
    if (!configuration) return;
    const credentials = configuration?.credentials || [];
    if (!credentials.length) {
      setActiveCredentialId('');
      return;
    }
    setActiveCredentialId((currentCredentialId) => credentials.some((credential) => credential.externalPlatformCredentialId === currentCredentialId)
      ? currentCredentialId
      : credentials[0].externalPlatformCredentialId);
  }, [configuration]);

  useEffect(() => {
    const installations = discordConfiguration?.installations || [];
    setDiscordInstallationId((current) => installations.some((installation) => installation.communityInstallationId === current)
      ? current
      : installations[0]?.communityInstallationId || '');
  }, [discordConfiguration]);

  const loadDiscordChannels = async (installationId: string) => {
    if (!installationId) return;
    setDiscordBusy(`channels:${installationId}`);
    setError('');
    try {
      const result = await api.studioListDiscordChannels(installationId);
      setDiscordChannelsByInstallation((current) => ({ ...current, [installationId]: result.channels }));
      setDiscordChannelId((current) => result.channels.some((channel) => channel.id === current) ? current : result.channels[0]?.id || '');
    } catch (channelError) {
      setError(channelError instanceof Error ? channelError.message : 'Unable to load Discord channels.');
    } finally {
      setDiscordBusy('');
    }
  };

  useEffect(() => {
    if (discordInstallationId && !discordChannelsByInstallation[discordInstallationId]) void loadDiscordChannels(discordInstallationId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [discordInstallationId]);

  const activeCredential = useMemo(
    () => (configuration?.credentials || []).find((credential) => credential.externalPlatformCredentialId === activeCredentialId),
    [configuration, activeCredentialId]
  );

  useEffect(() => {
    if (!activeCredential) return;
    setClientId(activeCredential.clientId);
    setApplicationLabel(activeCredential.applicationLabel || 'DeviantArt application');
    setClientSecret('');
  }, [activeCredential?.externalPlatformCredentialId]);

  const visibleAccounts = useMemo(
    () => accounts
      .filter((account) => !accountApplicationFilterId || account.externalPlatformCredentialId === accountApplicationFilterId)
      .sort((left, right) => {
        if (left.externalAccountId === recentlyConnectedAccountId) return -1;
        if (right.externalAccountId === recentlyConnectedAccountId) return 1;
        return left.externalUsername.localeCompare(right.externalUsername, undefined, { sensitivity: 'base' });
      }),
    [accountApplicationFilterId, accounts, recentlyConnectedAccountId]
  );

  useEffect(() => {
    if (!accountApplicationFilterId) return;
    if (!(configuration?.credentials || []).some((credential) => credential.externalPlatformCredentialId === accountApplicationFilterId)) {
      setAccountApplicationFilterId('');
    }
  }, [accountApplicationFilterId, configuration]);

  useEffect(() => {
    if (accounts.length) setConnectionGuideExpanded(false);
  }, [accounts.length]);

  const hasActiveSync = useMemo(
    () => Object.values(jobsByAccount).flat().some((job) => ['queued', 'processing', 'retry_scheduled', 'rate_limited'].includes(job.status)),
    [jobsByAccount]
  );
  const hasActiveCooldown = useMemo(
    () => accounts.some((account) => account.connectionStatus === 'rate_limited'
      && Boolean(account.rateLimitedUntil)
      && Date.parse(account.rateLimitedUntil || '') > rateLimitClock),
    [accounts, rateLimitClock]
  );

  useEffect(() => {
    if (!hasActiveSync) return;
    const interval = window.setInterval(() => void load(), 2000);
    return () => window.clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasActiveSync, creatorId]);

  useEffect(() => {
    if (!hasActiveSync && !hasActiveCooldown) return;
    const interval = window.setInterval(() => setRateLimitClock(Date.now()), 1_000);
    return () => window.clearInterval(interval);
  }, [hasActiveCooldown, hasActiveSync]);

  const connect = async (credentialId: string) => {
    setError('');
    setConnectionError('');
    try {
      const result = await api.studioStartDeviantArtConnection(undefined, '/studio/workspace?section=integrations', false, credentialId);
      window.location.assign(result.authorizationUrl);
    } catch (connectError) {
      setError(connectError instanceof Error ? connectError.message : 'Unable to begin DeviantArt connection.');
    }
  };

  const connectBluesky = async () => {
    if (!creatorId || !blueskyHandle.trim()) return;
    setError('');
    setConnectionError('');
    try {
      const result = await api.studioStartBlueskyConnection(creatorId, blueskyHandle.trim(), '/studio/workspace?section=integrations');
      window.location.assign(result.authorizationUrl);
    } catch (connectError) {
      setError(connectError instanceof Error ? connectError.message : 'Unable to begin Bluesky authorization.');
    }
  };

  const connectYoutube = async () => {
    if (!creatorId) return;
    setError('');
    setYoutubeConnectionError('');
    setYoutubeConnectionNotice('');
    try {
      const result = await api.studioStartYoutubeConnection(creatorId, '/studio/workspace?section=integrations');
      window.location.assign(result.authorizationUrl);
    } catch (connectError) {
      setError(connectError instanceof Error ? connectError.message : 'Unable to begin YouTube authorization.');
    }
  };

  const syncYoutubeAccount = async (externalAccountId: string) => {
    setYoutubeBusy(`sync:${externalAccountId}`);
    setError('');
    try {
      await api.studioSyncYoutubeAccount(externalAccountId);
      setMessage('YouTube video import queued. The catalogue will refresh as the channel is scanned.');
      await load();
    } catch (syncError) {
      setError(syncError instanceof Error ? syncError.message : 'Unable to queue the YouTube video import.');
    } finally {
      setYoutubeBusy('');
    }
  };

  const refreshYoutubeAccounts = async () => {
    if (!creatorId) return;
    setYoutubeBusy('refresh');
    setError('');
    try {
      const nextAccounts = await api.studioListYoutubeAccounts(creatorId);
      setYoutubeAccounts((nextAccounts || []) as StudioYouTubeAccount[]);
      setMessage('YouTube channel list refreshed.');
    } catch (refreshError) {
      setError(refreshError instanceof Error ? refreshError.message : 'Unable to refresh YouTube channels.');
    } finally {
      setYoutubeBusy('');
    }
  };

  const removeYoutubeAccount = async (externalAccount: StudioYouTubeAccount) => {
    if (!window.confirm(`Disconnect YouTube channel “${externalAccount.channelTitle || externalAccount.externalUsername}”? Imported Works stay in the local catalogue.`)) return;
    setYoutubeBusy(`remove:${externalAccount.externalAccountId}`);
    setError('');
    try {
      await api.studioRemoveYoutubeAccount(externalAccount.externalAccountId);
      setMessage('YouTube channel disconnected. Existing imported Works were retained.');
      await load();
    } catch (removeError) {
      setError(removeError instanceof Error ? removeError.message : 'Unable to disconnect the YouTube channel.');
    } finally {
      setYoutubeBusy('');
    }
  };

  const connectDiscord = async () => {
    setError('');
    setConnectionError('');
    try {
      const result = await api.studioStartDiscordConnection('/studio/workspace?section=integrations');
      window.location.assign(result.authorizationUrl);
    } catch (connectError) {
      setError(connectError instanceof Error ? connectError.message : 'Unable to begin Discord installation.');
    }
  };

  const createDiscordDestination = async () => {
    if (!creatorId || !discordInstallationId || !discordChannelId) return;
    setDiscordBusy('create');
    setError('');
    try {
      await api.studioCreateDiscordDestination({ creatorId, communityInstallationId: discordInstallationId, remoteChannelId: discordChannelId, defaultAnnouncementPreset: discordAnnouncementPreset, defaultIncludePrimaryMedia: discordIncludePrimaryMedia });
      setMessage('Discord announcement channel saved. The recommended format can be adjusted for each release.');
      await load();
    } catch (destinationError) {
      setError(destinationError instanceof Error ? destinationError.message : 'Unable to save the Discord announcement channel.');
    } finally {
      setDiscordBusy('');
    }
  };

  const testDiscordDestination = async (destinationId: string) => {
    setDiscordBusy(`test:${destinationId}`);
    setError('');
    try {
      await api.studioTestDiscordDestination(destinationId);
      setMessage('Discord test announcement sent.');
      await load();
    } catch (testError) {
      setError(testError instanceof Error ? testError.message : 'Discord test announcement could not be sent.');
    } finally {
      setDiscordBusy('');
    }
  };

  const updateDiscordDestinationStatus = async (destinationId: string, status: 'active' | 'disabled') => {
    setDiscordBusy(`status:${destinationId}`);
    try {
      await api.studioUpdateDiscordDestination(destinationId, { status });
      await load();
    } catch (updateError) {
      setError(updateError instanceof Error ? updateError.message : 'Unable to update Discord channel.');
    } finally {
      setDiscordBusy('');
    }
  };

  const updateDiscordDestinationFormat = async (destinationId: string, payload: { defaultAnnouncementPreset?: AnnouncementPresetId; defaultIncludePrimaryMedia?: boolean }) => {
    setDiscordBusy(`format:${destinationId}`);
    setError('');
    try {
      await api.studioUpdateDiscordDestination(destinationId, payload);
      setMessage('Discord announcement defaults updated.');
      await load();
    } catch (updateError) {
      setError(updateError instanceof Error ? updateError.message : 'Unable to update Discord announcement defaults.');
    } finally {
      setDiscordBusy('');
    }
  };

  const deleteDiscordDestination = async (destinationId: string) => {
    if (!window.confirm('Remove this Discord announcement channel? Future Space publications will no longer be announced there.')) return;
    setDiscordBusy(`delete:${destinationId}`);
    try {
      await api.studioDeleteDiscordDestination(destinationId);
      setMessage('Discord announcement channel removed.');
      await load();
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : 'Unable to remove the Discord announcement channel.');
    } finally {
      setDiscordBusy('');
    }
  };

  const deleteDiscordInstallation = async (installationId: string) => {
    if (!window.confirm('Disconnect this Discord server? Its Creator channel destinations will also be removed.')) return;
    setDiscordBusy(`installation:${installationId}`);
    try {
      await api.studioDeleteDiscordInstallation(installationId);
      setMessage('Discord server disconnected.');
      await load();
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : 'Unable to disconnect the Discord server.');
    } finally {
      setDiscordBusy('');
    }
  };

  const saveCredentials = async () => {
    if (!clientId.trim()) return;
    setError('');
    try {
      const saved = await api.studioSaveDeviantArtCredentials({
        externalPlatformCredentialId: creatingApplication ? undefined : activeCredentialId || undefined,
        createNew: creatingApplication || !activeCredentialId,
        applicationLabel,
        clientId: clientId.trim(),
        clientSecret: clientSecret || undefined
      });
      setClientSecret('');
      setActiveCredentialId(saved.externalPlatformCredentialId);
      setCreatingApplication(false);
      setEditingApplication(false);
      setMessage('Your DeviantArt application has been saved.');
      await load();
    } catch (credentialError) {
      setError(credentialError instanceof Error ? credentialError.message : 'Unable to save DeviantArt application credentials.');
    }
  };

  const cancelApplicationEdit = () => {
    setApplicationLabel(activeCredential?.applicationLabel || '');
    setClientId(activeCredential?.clientId || '');
    setClientSecret('');
    setCreatingApplication(false);
    setEditingApplication(false);
    setError('');
  };

  const beginNewApplication = () => {
    setApplicationLabel('');
    setClientId('');
    setClientSecret('');
    setCreatingApplication(true);
    setEditingApplication(true);
    setError('');
  };

  const editApplication = (credential: DeviantArtCredential) => {
    setActiveCredentialId(credential.externalPlatformCredentialId);
    setClientId(credential.clientId);
    setApplicationLabel(credential.applicationLabel || 'DeviantArt application');
    setClientSecret('');
    setCreatingApplication(false);
    setEditingApplication(true);
    setError('');
  };

  const deleteApplication = async (credential: DeviantArtCredential) => {
    const connectedAccounts = accounts.filter((account) => account.externalPlatformCredentialId === credential.externalPlatformCredentialId);
    if (connectedAccounts.length) {
      setError('Remove every account connected with this application before deleting it.');
      return;
    }
    const applicationName = credential.applicationLabel || `DeviantArt app ${credential.clientId}`;
    if (!window.confirm(`Delete the DeviantArt application “${applicationName}”? Its saved client secret will be permanently removed.`)) return;
    setDeletingApplication(true);
    setError('');
    try {
      await api.studioDeleteDeviantArtCredentials(credential.externalPlatformCredentialId);
      if (activeCredentialId === credential.externalPlatformCredentialId) setActiveCredentialId('');
      setMessage(`The DeviantArt application “${applicationName}” has been deleted.`);
      await load();
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : 'Unable to delete this DeviantArt application.');
    } finally {
      setDeletingApplication(false);
    }
  };

  const sync = async (externalAccountId: string) => {
    setWorkingAccountId(externalAccountId);
    setError('');
    try {
      const account = accounts.find((candidate) => candidate.externalAccountId === externalAccountId);
      const defaultDestinationCreatorId = account && (
        destinationCreatorByAccount[externalAccountId]
        || account.primaryCreatorIdentityId
        || account.creatorIdentityId
        || creatorId
      );
      if (account && defaultDestinationCreatorId && !account.primaryCreatorIdentityId && !account.creatorIdentityId) {
        await api.studioAssignDeviantArtAccountCreators(externalAccountId, {
          creatorIdentityIds: [defaultDestinationCreatorId],
          primaryCreatorIdentityId: defaultDestinationCreatorId
        });
      }
      await api.studioSyncDeviantArtAccount(externalAccountId, includeSourceFilesByAccount[externalAccountId] === true);
      setMessage('');
      setQueuedSyncAccountId(externalAccountId);
      await load(creatorId, externalAccountId);
    } catch (syncError) {
      setError(syncError instanceof Error ? syncError.message : 'Unable to queue synchronization.');
    } finally {
      setWorkingAccountId('');
    }
  };

  const cancelSync = async (job: StudioExternalSyncJob) => {
    setCancellingSyncJobId(job.externalSyncJobId);
    setError('');
    try {
      await api.studioCancelDeviantArtSync(job.externalSyncJobId);
      setQueuedSyncAccountId('');
      await load(creatorId, '');
      setMessage('Synchronization cancelled. You can start it again whenever you are ready.');
    } catch (cancelError) {
      setError(cancelError instanceof Error ? cancelError.message : 'Unable to cancel synchronization.');
    } finally {
      setCancellingSyncJobId('');
    }
  };

  const reconnect = async (account: StudioDeviantArtAccount) => {
    setWorkingAccountId(account.externalAccountId);
    setError('');
    setConnectionError('');
    try {
      const result = await api.studioStartDeviantArtConnection(
        account.primaryCreatorIdentityId || account.creatorIdentityId,
        '/studio/workspace?section=integrations',
        false,
        account.externalPlatformCredentialId
      );
      window.location.assign(result.authorizationUrl);
    } catch (reconnectError) {
      setError(reconnectError instanceof Error ? reconnectError.message : 'Unable to begin DeviantArt reauthorization.');
      setWorkingAccountId('');
    }
  };

  const saveAccountDestination = async (account: StudioDeviantArtAccount, disconnect = false, requestedCreatorId?: string) => {
    const destinationCreatorId = disconnect
      ? ''
      : (requestedCreatorId
        || destinationCreatorByAccount[account.externalAccountId]
        || account.primaryCreatorIdentityId
        || account.creatorIdentityId
        || creatorId);
    setWorkingAccountId(account.externalAccountId);
    setError('');
    try {
      await api.studioAssignDeviantArtAccountCreators(account.externalAccountId, {
        creatorIdentityIds: destinationCreatorId ? [destinationCreatorId] : [],
        primaryCreatorIdentityId: destinationCreatorId || undefined
      });
      setMessage(destinationCreatorId
        ? 'Sync destination saved. You can start the first synchronization when you are ready.'
        : `This ${brand.creatorName.toLowerCase()} has been disconnected. The DeviantArt account remains connected, but future synchronization is stopped.`);
      await load();
      return true;
    } catch (assignmentError) {
      setError(assignmentError instanceof Error ? assignmentError.message : `Unable to save ${brand.creatorName.toLowerCase()} assignments.`);
      return false;
    } finally {
      setWorkingAccountId('');
    }
  };

  const beginMoveAccount = (account: StudioDeviantArtAccount) => {
    setMovingAccountId(account.externalAccountId);
    setMoveCreatorId(
      destinationCreatorByAccount[account.externalAccountId]
      || account.primaryCreatorIdentityId
      || account.creatorIdentityId
      || creatorId
    );
    setError('');
  };

  const moveAccount = async () => {
    const account = accounts.find((candidate) => candidate.externalAccountId === movingAccountId);
    if (!account || !moveCreatorId) return;
    const moved = await saveAccountDestination(account, false, moveCreatorId);
    if (!moved) return;
    setMovingAccountId('');
    setMoveCreatorId('');
  };

  const removeAccount = async (account: StudioDeviantArtAccount) => {
    const affectedAccountCount = 1;
    if (!window.confirm(`Remove the DeviantArt account “${account.externalUsername}”? ${affectedAccountCount} account will lose its connection and will no longer be able to sync or publish through DeviantArt.`)) return;
    setWorkingAccountId(account.externalAccountId);
    setError('');
    try {
      await api.studioRemoveDeviantArtAccount(account.externalAccountId);
      if (recentlyConnectedAccountId === account.externalAccountId) setRecentlyConnectedAccountId('');
      setMessage(`The DeviantArt account “${account.externalUsername}” has been removed.`);
      await load();
    } catch (removeError) {
      setError(removeError instanceof Error ? removeError.message : 'Unable to remove this DeviantArt account.');
    } finally {
      setWorkingAccountId('');
    }
  };

  const editPublishingPreset = (account: StudioDeviantArtAccount) => {
    const preset = account.deviantArtPublishingPreset;
    setPresetAccountId(account.externalAccountId);
    setPresetTags((preset?.defaultTags || []).join(', '));
    setPresetGalleryIds(preset?.galleryExternalCollectionIds || []);
    setPresetTargetStatus(preset?.targetStatus || 'published');
    setPresetDisplayResolution(preset?.displayResolution ? String(preset.displayResolution) : '');
    setPresetAllowFreeDownload(preset?.allowFreeDownload === true);
    setPresetAddWatermark(preset?.addWatermark === true);
    setPresetIsMature(preset?.isMature === true);
    setPresetMatureLevel(preset?.matureLevel || 'moderate');
    setPresetMatureClassification(preset?.matureClassification || []);
    setPresetIsAiGenerated(preset?.isAiGenerated === true);
    setPresetNoAi(preset?.noAi === true);
    setNewGalleryName('');
    setError('');
  };

  const savePublishingPreset = async () => {
    if (!presetAccountId) return;
    setPresetBusy(true);
    setError('');
    try {
      await api.studioSaveDeviantArtPublishingPreset(presetAccountId, {
        defaultTags: presetTags.split(',').map((tag) => tag.trim()).filter(Boolean),
        galleryExternalCollectionIds: presetGalleryIds,
        targetStatus: presetTargetStatus,
        ...(Number.parseInt(presetDisplayResolution, 10) > 0 ? { displayResolution: Number.parseInt(presetDisplayResolution, 10) } : {}),
        allowFreeDownload: presetAllowFreeDownload,
        addWatermark: presetAddWatermark,
        isMature: presetIsMature,
        matureLevel: presetMatureLevel,
        matureClassification: presetIsMature ? presetMatureClassification : [],
        isAiGenerated: presetIsAiGenerated,
        noAi: presetNoAi
      });
      setMessage('DeviantArt publishing preset saved. New destinations will start with these tags, gallery folders, content declarations, display and download settings, and target state.');
      setPresetAccountId('');
      await load();
    } catch (presetError) {
      setError(presetError instanceof Error ? presetError.message : 'Unable to save the DeviantArt publishing preset.');
    } finally {
      setPresetBusy(false);
    }
  };

  const createDeviantArtGallery = async () => {
    if (!presetAccountId || !newGalleryName.trim()) return;
    setPresetBusy(true);
    setError('');
    try {
      const created = await api.studioCreateDeviantArtGallery(presetAccountId, newGalleryName.trim()) as { externalCollectionExternalId: string; name: string };
      setPresetGalleryIds((current) => [...new Set([...current, created.externalCollectionExternalId])]);
      setNewGalleryName('');
      setMessage(`DeviantArt gallery “${created.name}” created. It is selected for this preset; save the preset to make it the default.`);
      await load();
    } catch (galleryError) {
      setError(galleryError instanceof Error ? galleryError.message : 'Unable to create the DeviantArt gallery.');
    } finally {
      setPresetBusy(false);
    }
  };

  const saveMapping = async (externalCollection: StudioExternalCollection, ubeeqCollectionId: string) => {
    if (!ubeeqCollectionId) return;
    setError('');
    try {
      await api.studioSaveDeviantArtCollectionMapping(externalCollection.externalCollectionId, {
        externalAccountId: externalCollection.externalAccountId,
        ubeeqCollectionId,
        syncMode: 'continuous'
      });
      setMessage('Gallery mapping saved. DeviantArt membership and folder hierarchy will reconcile continuously.');
      await load();
    } catch (mappingError) {
      setError(mappingError instanceof Error ? mappingError.message : 'Unable to save gallery mapping.');
    }
  };

  const updateMappingMode = async (externalCollection: StudioExternalCollection, mapping: StudioExternalCollectionMapping, syncMode: StudioExternalCollectionMapping['syncMode']) => {
    setError('');
    try {
      await api.studioSaveDeviantArtCollectionMapping(externalCollection.externalCollectionId, {
        externalAccountId: externalCollection.externalAccountId,
        ubeeqCollectionId: mapping.ubeeqCollectionId,
        syncMode
      });
      setMessage(syncMode === 'continuous'
        ? 'Continuous DeviantArt gallery reconciliation queued.'
        : syncMode === 'initial_only'
          ? 'This gallery will populate once and then remain independent.'
          : syncMode === 'manual'
            ? `Automatic gallery membership changes are paused; current ${brand.productName} works were preserved.`
            : 'This DeviantArt gallery is ignored by automatic synchronization.');
      await load();
    } catch (mappingError) {
      setError(mappingError instanceof Error ? mappingError.message : 'Unable to update gallery synchronization.');
    }
  };

  return (
    <section className="studio-integration-grid">
      <div className="studio-integration-platform-filter" aria-label="Integrations shown">
        <div>
          <p className="auth-eyebrow">Integrations shown</p>
          <p className="small">Choose which connected-platform tools appear here. You can add more platforms later.</p>
        </div>
        <div className="studio-integration-platform-filter__options">
          {orderedIntegrationPlatforms.map((platform) => {
            const selected = visibleIntegrationPlatforms.includes(platform.id);
            return <button
              type="button"
              key={platform.id}
              className="studio-integration-platform-toggle"
              aria-pressed={selected}
              aria-label={`${platform.label}: ${selected ? 'shown' : 'hidden'}`}
              data-selected={selected ? 'true' : 'false'}
              disabled={savingIntegrationVisibility}
              onClick={() => void toggleIntegrationVisibility(platform.id)}
            >
              <span className="studio-integration-platform-toggle__dot" aria-hidden="true" />
              {platform.label}
            </button>;
          })}
        </div>
      </div>
      {visibleIntegrationPlatforms.includes('youtube') && <Card
        title="YouTube video library"
        eyebrow="Platform integration"
        className="studio-integration-accounts studio-youtube-integration studio-integration-pane--youtube"
        actions={<div className="studio-youtube-card-actions">
          <span className="studio-integration-account-count">{youtubeAccounts.length} connected channel{youtubeAccounts.length === 1 ? '' : 's'}</span>
          <button type="button" className="auth-secondary-btn" disabled={!creatorId || Boolean(youtubeBusy)} onClick={() => void refreshYoutubeAccounts()}>
            {youtubeBusy === 'refresh' ? 'Refreshing…' : 'Refresh channels'}
          </button>
        </div>}
      >
        <div className="studio-youtube-introduction">
          <span className="studio-youtube-icon" aria-hidden="true">
            <svg viewBox="0 0 24 24" fill="currentColor"><path d={siYoutube.path} /></svg>
          </span>
          <div>
            <p className="studio-youtube-description">Connect a channel to bring existing YouTube videos into this Creator’s catalogue as YouTube-hosted Works. Titles, descriptions, thumbnails, and embed references are imported while the original video remains on YouTube.</p>
            <div className="studio-youtube-facts" aria-label="YouTube connection details">
              <span>Read-only access</span>
              <span>Incremental Google consent</span>
              <span>Quota-aware synchronization</span>
            </div>
            {youtubeConfiguration?.configured && <p className="studio-youtube-quota-note">{youtubeConfiguration.quotaGuidance}</p>}
          </div>
        </div>
        {youtubeConfiguration && !youtubeConfiguration.configured && <p className="studio-integration-setup-notice">YouTube is not yet configured. Add a Google OAuth web client to connect a channel.</p>}
        {youtubeConnectionNotice && <p className="success" role="status" aria-live="polite">{youtubeConnectionNotice}</p>}
        {youtubeConnectionError && <p className="error" role="alert">{youtubeConnectionError}</p>}
        {youtubeAccounts.length ? <div className="studio-integration-account-list">
          <div className="studio-youtube-connected-actions">
            <p>Connect another channel to this Creator, or manage the channels already connected below.</p>
            <button type="button" className="auth-primary-btn" disabled={!creatorId || !youtubeConfiguration?.configured || Boolean(youtubeBusy)} onClick={() => void connectYoutube()}>
              Connect another channel
            </button>
          </div>
          {youtubeAccounts.map((account) => <div key={account.externalAccountId} className="studio-integration-account">
            <div>
              <p className="auth-eyebrow">YouTube channel</p>
              <h3>{account.channelTitle || account.externalUsername}</h3>
              <p className="small">@{account.externalUsername} · Video metadata, thumbnails, and embeds import into this Creator’s catalogue.</p>
            </div>
            <div className="studio-integration-row-actions">
              <Pill tone={accountTone(account.connectionStatus)} label={account.connectionStatus.replace(/_/g, ' ')} />
              <button type="button" className="auth-secondary-btn" disabled={Boolean(youtubeBusy)} onClick={() => void syncYoutubeAccount(account.externalAccountId)}>{youtubeBusy === `sync:${account.externalAccountId}` ? 'Queueing…' : 'Sync videos'}</button>
              <button type="button" className="auth-secondary-btn" disabled={Boolean(youtubeBusy)} onClick={() => void removeYoutubeAccount(account)}>{youtubeBusy === `remove:${account.externalAccountId}` ? 'Disconnecting…' : 'Disconnect channel'}</button>
            </div>
          </div>)}
        </div> : !loading && <div className="studio-youtube-empty-state">
          <div>
            <h4>No YouTube channel connected</h4>
            <p>Choose the Google or Brand identity that owns the channel you want this Creator to manage.</p>
          </div>
          <button type="button" className="auth-primary-btn" disabled={!creatorId || !youtubeConfiguration?.configured || Boolean(youtubeBusy)} onClick={() => void connectYoutube()}>
            Connect YouTube channel
          </button>
        </div>}
        <aside className="studio-youtube-release-note">
          <strong>Available in this release</strong>
          <p>Import and embed existing videos. Video upload, publishing, and remote metadata editing will be added after the import workflow is proven.</p>
        </aside>
      </Card>}
{visibleIntegrationPlatforms.includes('fanvue') && <FanvueView creatorId={creatorId} creatorName={creators.find((creator) => creator.creatorId === creatorId)?.name || brand.creatorName} />}
{visibleIntegrationPlatforms.includes('tumblr') && <TumblrIntegrationPanel creatorId={creatorId} />}
      {visibleIntegrationPlatforms.includes('bluesky') && <Card
        title="Bluesky announcements"
        eyebrow="Platform integration"
        className="studio-integration-accounts studio-integration-pane--bluesky"
      >
        <p className="small">Connect the account that can announce eligible Space publications. The secure DPoP session stays in the OAuth service and is never stored in your browser or creator records.</p>
        <div className="studio-integration-toolbar">
          <label>
            <span>Connect for {brand.creatorName}</span>
            <select value={creatorId} onChange={(event) => setCreatorId(event.target.value)}>
              {creators.map((creator) => <option key={creator.creatorId} value={creator.creatorId}>{creator.name}</option>)}
            </select>
          </label>
          <label>
            <span>Bluesky handle</span>
            <input value={blueskyHandle} onChange={(event) => setBlueskyHandle(event.target.value)} placeholder="creator.bsky.social" autoComplete="off" />
          </label>
          <button type="button" className="auth-primary-btn" disabled={!creatorId || !blueskyHandle.trim() || !blueskyConfiguration?.configured} onClick={() => void connectBluesky()}>
            Connect Bluesky
          </button>
        </div>
        {blueskyConfiguration && !blueskyConfiguration.configured && <p className="studio-integration-setup-notice">Bluesky is not yet configured. Complete the integration setup to connect an account.</p>}
        {blueskyAccounts.length ? (
          <div className="studio-integration-account-list">
            {blueskyAccounts.map((account) => <div key={account.externalAccountId} className="studio-integration-account">
              <div><p className="auth-eyebrow">Connected account</p><h3>{account.externalUsername}</h3><p className="small">{account.externalUserId}</p></div>
              <Pill tone="success" label="Connected" />
            </div>)}
          </div>
        ) : <span></span>}
      </Card>}
      {visibleIntegrationPlatforms.includes('discord') && <Card
        title="Discord community"
        eyebrow="Community delivery"
        className="studio-integration-accounts studio-integration-pane--discord"
        actions={<span className="studio-integration-account-count">{discordConfiguration?.installations.length || 0} connected server{(discordConfiguration?.installations.length || 0) === 1 ? '' : 's'}</span>}
      >
        <p className="small studio-integration-account-availability">Install the Discord app once for a server, then choose the channels each Creator should use. Discord messages announce a Space Work; they never become a separate Work publication.</p>
        {discordConfiguration && !discordConfiguration.configured && <p className="studio-integration-setup-notice">Discord is not yet configured. Complete the deployment setup to install a server.</p>}
        {discordConfiguration?.configured && !discordConfiguration.installations.length && <div className="studio-integration-row-actions">
          <button type="button" className="auth-primary-btn" onClick={() => void connectDiscord()}>Install Discord app</button>
        </div>}
        {discordConfiguration?.installations.length ? <>
          <div className="studio-discord-installations">
            {discordConfiguration.installations.map((installation) => <div key={installation.communityInstallationId} className="studio-discord-installation">
              <div className="studio-discord-installation__heading">
                {installation.iconUrl ? <img src={installation.iconUrl} alt="" /> : <span className="studio-discord-installation__icon" aria-hidden="true">#</span>}
                <div><p className="auth-eyebrow">Discord server</p><h3>{installation.displayName}</h3>{installation.lastError && <p className="small error">{installation.lastError}</p>}</div>
              </div>
              <div className="studio-integration-row-actions">
                <Pill tone={installation.status === 'connected' ? 'success' : installation.status === 'needs_attention' ? 'warning' : 'default'} label={installation.status.replace(/_/g, ' ')} />
                <button type="button" className="auth-secondary-btn" disabled={discordBusy === `channels:${installation.communityInstallationId}`} onClick={() => void loadDiscordChannels(installation.communityInstallationId)}>{discordBusy === `channels:${installation.communityInstallationId}` ? 'Loading channels…' : 'Refresh channels'}</button>
                <button type="button" className="auth-secondary-btn" disabled={discordBusy === `installation:${installation.communityInstallationId}`} onClick={() => void deleteDiscordInstallation(installation.communityInstallationId)}>Disconnect server</button>
              </div>
            </div>)}
          </div>
          <section className="studio-discord-destination-editor" aria-label="Add Discord announcement channel">
            <div><p className="auth-eyebrow">Creator announcement channel</p><h3>Set a default release format</h3><p className="small">Choose the channel’s recommended announcement. Each Space publish can keep this default, use a different format, combine a batch into one digest, or skip the announcement.</p></div>
            <div className="studio-integration-toolbar">
              <label><span>Discord server</span><select value={discordInstallationId} onChange={(event) => { setDiscordInstallationId(event.target.value); setDiscordChannelId(''); }}>
                {(discordConfiguration?.installations || []).map((installation) => <option key={installation.communityInstallationId} value={installation.communityInstallationId}>{installation.displayName}</option>)}
              </select></label>
              <label><span>Channel</span><select value={discordChannelId} disabled={!discordInstallationId || !(discordChannelsByInstallation[discordInstallationId]?.length)} onChange={(event) => setDiscordChannelId(event.target.value)}>
                {(discordChannelsByInstallation[discordInstallationId] || []).map((channel) => <option key={channel.id} value={channel.id}>#{channel.name}</option>)}
              </select></label>
              <label className="studio-discord-template"><span>Default format</span><select value={discordAnnouncementPreset} onChange={(event) => setDiscordAnnouncementPreset(event.target.value as AnnouncementPresetId)}>{discordAnnouncementPresets.map((preset) => <option key={preset.id} value={preset.id}>{preset.label} — {preset.description}</option>)}</select></label>
              <label className="studio-discord-media-option"><input type="checkbox" checked={discordIncludePrimaryMedia} onChange={(event) => setDiscordIncludePrimaryMedia(event.target.checked)} /><span>Include primary media in supported rich previews</span></label>
              <button type="button" className="auth-primary-btn" disabled={!discordChannelId || discordBusy === 'create'} onClick={() => void createDiscordDestination()}>{discordBusy === 'create' ? 'Saving…' : 'Add channel'}</button>
            </div>
            {!discordChannelsByInstallation[discordInstallationId]?.length && discordInstallationId && <p className="small">Refresh channels after confirming the Discord app can view and send messages in the channel you want to use.</p>}
          </section>
          {discordDestinations.length ? <div className="studio-discord-destinations">
            {discordDestinations.map((destination) => {
              const lastDelivery = destination.deliveries?.[0];
              return <div key={destination.communityDestinationId} className="studio-discord-destination">
                <div><p className="auth-eyebrow">Announcement channel</p><h3>{destination.displayName}</h3><p className="small">{destination.status === 'disabled' ? 'Paused — public Space Works are not announced here.' : 'New public Space Works are announced here.'}{lastDelivery?.sentAt ? ` Last announced ${formatDate(lastDelivery.sentAt)}.` : lastDelivery?.errorMessage ? ` Last delivery needs attention: ${lastDelivery.errorMessage}` : ''}</p>
                  <div className="studio-discord-default-controls">
                    <label><span>Default format</span><select disabled={discordBusy === `format:${destination.communityDestinationId}`} value={destination.defaultAnnouncementPreset || 'recommended'} onChange={(event) => void updateDiscordDestinationFormat(destination.communityDestinationId, { defaultAnnouncementPreset: event.target.value as AnnouncementPresetId })}>{discordAnnouncementPresets.map((preset) => <option key={preset.id} value={preset.id}>{preset.label}</option>)}</select></label>
                    <label className="studio-discord-media-option"><input type="checkbox" disabled={discordBusy === `format:${destination.communityDestinationId}`} checked={destination.defaultIncludePrimaryMedia !== false} onChange={(event) => void updateDiscordDestinationFormat(destination.communityDestinationId, { defaultIncludePrimaryMedia: event.target.checked })} /><span>Include primary media in supported rich previews</span></label>
                  </div>
                </div>
                <div className="studio-integration-row-actions">
                  <Pill tone={destination.status === 'active' ? 'success' : destination.status === 'needs_attention' ? 'warning' : 'default'} label={destination.status.replace(/_/g, ' ')} />
                  <button type="button" className="auth-secondary-btn" disabled={discordBusy === `test:${destination.communityDestinationId}`} onClick={() => void testDiscordDestination(destination.communityDestinationId)}>{discordBusy === `test:${destination.communityDestinationId}` ? 'Sending…' : 'Send test'}</button>
                  <button type="button" className="auth-secondary-btn" disabled={discordBusy === `status:${destination.communityDestinationId}`} onClick={() => void updateDiscordDestinationStatus(destination.communityDestinationId, destination.status === 'disabled' ? 'active' : 'disabled')}>{destination.status === 'disabled' ? 'Resume' : 'Pause'}</button>
                  <button type="button" className="auth-secondary-btn" disabled={discordBusy === `delete:${destination.communityDestinationId}`} onClick={() => void deleteDiscordDestination(destination.communityDestinationId)}>Remove</button>
                </div>
              </div>;
            })}
          </div> : <p className="studio-empty-state">No Discord channels are configured for this Creator yet.</p>}
        </> : null}
      </Card>}
      {visibleIntegrationPlatforms.includes('deviantart') && <Card
        title="DeviantArt integration"
        eyebrow="Platform integration"
        className="studio-integration-accounts studio-integration-pane--deviantart"
        actions={<span className="studio-integration-account-count">{accounts.length} connected account{accounts.length === 1 ? '' : 's'}</span>}
      >
        <p className="small studio-integration-account-availability">DeviantArt applications and connected accounts are available for use with all creator accounts belonging to your user account.</p>
        {(configuration?.credentials || []).length > 1 && (
          <div className="studio-integration-toolbar">
            <label>
              <span>Filter connected accounts</span>
              <select value={accountApplicationFilterId} onChange={(event) => setAccountApplicationFilterId(event.target.value)}>
                <option value="">All applications</option>
                {(configuration?.credentials || []).map((credential) => <option key={credential.externalPlatformCredentialId} value={credential.externalPlatformCredentialId}>{credential.applicationLabel || `DeviantArt app ${credential.clientId}`}</option>)}
              </select>
            </label>
          </div>
        )}
        <section className="studio-da-setup-wizard" aria-label="Connect DeviantArt tutorial">
            <div className="studio-da-setup-heading">
              <div>
                <p className="auth-eyebrow">Connection guide</p>
                <h3>Connect one or more DeviantArt accounts</h3>
                {!connectionGuideExpanded && <p className="small">Application setup and account connection steps.</p>}
              </div>
              <button type="button" className="auth-secondary-btn" aria-expanded={connectionGuideExpanded} onClick={() => setConnectionGuideExpanded((expanded) => !expanded)}>
                {connectionGuideExpanded ? 'Collapse guide' : 'Show guide'}
              </button>
            </div>
            {connectionGuideExpanded && <>
              <p className="small">The application and connected accounts belong to your {brand.productName} account. Each connected account has one destination {brand.creatorName} for now.</p>
              <ol>
                <li><strong>Create your own DA OAuth application.</strong><span>{brand.productName} does not use a shared DA application; your client credentials remain encrypted at rest.</span></li>
                <li><strong>Add this callback URL to that application.</strong>{configuration?.callbackUrl && <code>{configuration.callbackUrl}</code>}</li>
                <li><strong>Save the application once.</strong><span>Use it to connect any DeviantArt accounts you manage. The secret is encrypted at rest and never returned to your browser.</span></li>
                <li><strong>Connect an account, then choose its destination {brand.creatorName}.</strong><span>Only after that choice is saved can you start synchronization.</span></li>
              </ol>
            </>}
          </section>
        {(configuration?.credentials || []).length > 0 && !editingApplication ? (
          <>
            <div className="studio-da-application-actions">
              <strong>DeviantArt applications</strong>
              <button type="button" className="auth-secondary-btn" onClick={beginNewApplication}>Add another DA application</button>
            </div>
            <div className="studio-da-application-list">
              {(configuration?.credentials || []).map((credential) => {
                const credentialAccounts = accounts.filter((account) => account.externalPlatformCredentialId === credential.externalPlatformCredentialId);
                return <section className="studio-da-application-summary" aria-label={`Saved DeviantArt application ${credential.applicationLabel || credential.clientId}`} key={credential.externalPlatformCredentialId}>
                  <div>
                    <p className="auth-eyebrow">DeviantArt Application (OAuth)</p>
                    <h3>{credential.applicationLabel || 'DeviantArt application'}</h3>
                    <p className="small">Client ID {credential.clientId} · {credentialAccounts.length} connected account{credentialAccounts.length === 1 ? '' : 's'}</p>
                  </div>
                  <div className="studio-inline-actions">
                    <button type="button" className="auth-primary-btn" onClick={() => void connect(credential.externalPlatformCredentialId)}>Connect account</button>
                    <button type="button" className="auth-secondary-btn" onClick={() => editApplication(credential)}>Edit application</button>
                    <button type="button" className="auth-secondary-btn" disabled={deletingApplication || credentialAccounts.length > 0} title={credentialAccounts.length ? 'Remove the connected DeviantArt accounts before deleting this application.' : undefined} onClick={() => void deleteApplication(credential)}>
                      {deletingApplication ? 'Deleting…' : 'Delete application'}
                    </button>
                  </div>
                </section>;
              })}
            </div>
          </>
        ) : (
          <div className="studio-integration-credential-form">
            <label><span>Application label</span><input value={applicationLabel} onChange={(event) => setApplicationLabel(event.target.value)} placeholder="My DeviantArt app" autoComplete="off" /></label>
            <label><span>DeviantArt client ID</span><input value={clientId} onChange={(event) => setClientId(event.target.value)} autoComplete="off" /></label>
            <label><span>DeviantArt client secret</span><input type="password" value={clientSecret} onChange={(event) => setClientSecret(event.target.value)} placeholder={activeCredential && !creatingApplication ? 'Saved securely; enter only to replace' : ''} autoComplete="new-password" /></label>
            <div className="studio-inline-actions">
              <button type="button" className="auth-secondary-btn" disabled={!clientId.trim()} onClick={() => void saveCredentials()}>{editingApplication && activeCredential && !creatingApplication ? 'Save changes' : 'Save application'}</button>
              {editingApplication && <button type="button" className="auth-secondary-btn" onClick={cancelApplicationEdit}>Cancel</button>}
            </div>
            {configuration?.callbackUrl && <p className="small">Callback URL: <code>{configuration.callbackUrl}</code></p>}
          </div>
        )}
        {configuration && !configuration.configured && (
          <p className="studio-integration-setup-notice">DeviantArt is not yet configured. Complete the integration setup to connect an account.</p>
        )}
        {message && <p className="studio-integration-message">{message}</p>}
        {connectionError && <p className="error">{connectionError}</p>}
        {error && <p className="error">{error}</p>}
        {visibleAccounts.length ? (
          <div className="studio-integration-account-list">
            {visibleAccounts.map((account) => {
              const accountJobs = jobsByAccount[account.externalAccountId] || [];
              const catalogueJob = accountJobs
                ?.find((job) => ['account_import', 'full_reconciliation', 'account_scan'].includes(job.type));
              const activeCatalogueJob = accountJobs
                ?.find((job) => ['account_import', 'full_reconciliation', 'account_scan'].includes(job.type)
                  && ['queued', 'processing', 'retry_scheduled', 'rate_limited'].includes(job.status));
              const rateLimitedJob = accountJobs
                .filter((job) => job.status === 'rate_limited')
                .sort((left, right) => String(left.nextAttemptAt || '').localeCompare(String(right.nextAttemptAt || '')))[0];
              const rateLimitedUntil = account.rateLimitedUntil || rateLimitedJob?.nextAttemptAt;
              const cooldownActive = Boolean(rateLimitedUntil && Date.parse(rateLimitedUntil) > rateLimitClock);
              const recoveryJob = accountJobs.find((job) => ['queued', 'processing', 'retry_scheduled', 'rate_limited'].includes(job.status));
              const recoveryInFlight = account.connectionStatus === 'rate_limited'
                && Boolean(recoveryJob && ['queued', 'processing'].includes(recoveryJob.status));
              const connectionStatusLabel = account.connectionStatus === 'rate_limited'
                ? cooldownActive
                  ? `rate limited · retry in ${formatCountdown(rateLimitedUntil, rateLimitClock)}`
                  : recoveryJob?.status === 'processing'
                    ? 'cooldown elapsed · retrying'
                    : recoveryJob
                      ? 'cooldown elapsed · retry queued'
                      : 'cooldown elapsed · ready to retry'
                : account.connectionStatus.replace(/_/g, ' ');
              const copySummary = copySyncSummary(accountJobs, catalogueJob);
              const ancillarySyncJobs = [
                { type: 'activity_sync', label: 'Activity', description: 'Notifications and watchers' },
                { type: 'engagement_sync', label: 'Engagement', description: 'Comments, favourites, and metrics' },
                { type: 'comment_sync', label: 'Comments', description: 'Comments and replies' }
              ].map((definition) => ({
                ...definition,
                job: accountJobs
                  .filter((candidate) => candidate.type === definition.type)
                  .sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0]
              })).filter((item) => Boolean(item.job) || (Boolean(activeCatalogueJob) && item.type !== 'comment_sync'));
              const ancillarySyncActive = ancillarySyncJobs.some((item) => Boolean(item.job && ['queued', 'processing', 'retry_scheduled', 'rate_limited'].includes(item.job.status)));
              const metadataDiscovered = catalogueJob?.progress?.discovered ?? 0;
              const metadataSynchronized = catalogueJob?.progress?.synchronized ?? 0;
              const metadataRemaining = catalogueJob?.progress?.remaining ?? Math.max(0, metadataDiscovered - metadataSynchronized);
              const metadataPercent = metadataDiscovered ? Math.min(100, Math.round((metadataSynchronized / metadataDiscovered) * 100)) : 0;
              const sourceRequested = copySummary?.requested ?? 0;
              const sourceStored = copySummary?.stored ?? 0;
              const sourceUnavailable = copySummary?.unavailable ?? 0;
              const sourcePercent = sourceRequested ? Math.min(100, Math.round((sourceStored / sourceRequested) * 100)) : 0;
              const sourceCopiesIncluded = includeSourceFilesByAccount[account.externalAccountId] === true;
              const sourceCopiesChecked = catalogueJob?.status === 'successful';
              const sourceCopiesNeedNoNewWork = sourceCopiesIncluded
                && sourceCopiesChecked
                && (!copySummary || sourceRequested === 0);
              const sourceCopyTitle = !sourceCopiesIncluded
                ? 'Not requested'
                : sourceCopiesNeedNoNewWork
                  ? 'Up to date'
                  : copySummary
                    ? `${sourceStored}/${sourceRequested}`
                    : 'Not checked';
              const sourceCopyDetail = !sourceCopiesIncluded
                ? 'Source files were excluded from this sync'
                : sourceCopiesNeedNoNewWork
                  ? 'No new source copies needed'
                  : copySummary
                    ? `${sourceUnavailable} unavailable`
                    : 'Waiting for catalogue sync';
              const sourceCopyPercent = sourceCopiesNeedNoNewWork ? 100 : sourcePercent;
              const savedDestinationCreatorId = destinationCreatorByAccount[account.externalAccountId]
                || account.primaryCreatorIdentityId
                || account.creatorIdentityId
                || creatorId;
              const destinationCreator = creators.find((creator) => creator.creatorId === savedDestinationCreatorId);
              const accountGalleries = collections.externalCollections.filter((collection) => collection.externalAccountId === account.externalAccountId && collection.syncStatus !== 'missing');
              const editingPreset = presetAccountId === account.externalAccountId;
              return (
                <div className="studio-integration-account-row studio-integration-account-panel" key={account.externalAccountId}>
                  <div className="studio-integration-account-summary">
                    <p className="auth-eyebrow">DeviantArt Account</p>
                    <strong>{account.externalUsername}</strong>
                    <span>Connected through {(configuration?.credentials || []).find((credential) => credential.externalPlatformCredentialId === account.externalPlatformCredentialId)?.applicationLabel || 'DeviantArt application'}</span>
                    <div className="studio-integration-account-destination">
                      <span className={destinationCreator ? undefined : 'studio-integration-assignment-needed'}>{destinationCreator ? `Sync destination: ${destinationCreator.name}` : `${brand.creatorName} assignment required before synchronization.`}</span>
                      {creators.length > 1 && <button type="button" className="studio-integration-move-account" onClick={() => beginMoveAccount(account)}>Move to Another {brand.creatorName}</button>}
                    </div>
                    {catalogueJob?.status === 'cancelled' && <span>Last synchronization was cancelled.</span>}
                    {catalogueJob?.status !== 'cancelled' && catalogueJob?.errorMessage && <span className="error">{catalogueJob.errorMessage}</span>}
                    {(account.connectionStatus === 'rate_limited' || rateLimitedJob || cooldownActive) && <span className="studio-work-metadata-warning">
                      {cooldownActive
                        ? `DeviantArt cooldown active. No account requests will be sent before ${formatDate(rateLimitedUntil)} (in ${formatCountdown(rateLimitedUntil, rateLimitClock)}).`
                        : recoveryJob?.status === 'processing'
                          ? `The DeviantArt cooldown has elapsed. Automatic recovery is checking the account now.`
                          : recoveryJob
                            ? `The DeviantArt cooldown has elapsed. Automatic recovery is waiting in the retry queue for ${syncPhaseLabel(recoveryJob.type)}.`
                            : `The DeviantArt cooldown has elapsed, but no automatic retry is currently queued. Use Sync now to verify the connection.`}
                      {rateLimitedJob?.attemptCount ? ` Attempt ${rateLimitedJob.attemptCount}.` : ''}
                    </span>}
                  </div>
                  <div className="studio-integration-account-status-column">
                    <div className="studio-integration-sync-stat studio-integration-account-last-sync studio-integration-account-last-sync-desktop">
                      <span>Last sync</span>
                      <strong>{formatDate(account.lastSuccessfulSyncAt)}</strong>
                      <small>→ {destinationCreator?.name || 'No destination'}</small>
                    </div>
                    <div className="studio-integration-account-status-pills studio-integration-account-status-pills-desktop">
                      <Pill label={connectionStatusLabel} tone={accountTone(account.connectionStatus)} />
                      {!savedDestinationCreatorId && <Pill label={`Needs ${brand.creatorName}`} tone="warning" />}
                    </div>
                  </div>
                  {activeCatalogueJob && activeCatalogueJob.status !== 'queued' && <div className="studio-integration-account-banner studio-integration-account-banner-info">
                    {activeCatalogueJob.status === 'processing'
                        ? 'Synchronization in progress. Metadata and source-copy counts will update as work completes.'
                        : activeCatalogueJob.status === 'rate_limited'
                          ? 'Synchronization is paused by DeviantArt rate limits and will resume automatically.'
                          : `Synchronization is paused and scheduled to retry${activeCatalogueJob.nextAttemptAt ? ` at ${formatDate(activeCatalogueJob.nextAttemptAt)}` : ''}.`}
                  </div>}
                  {!activeCatalogueJob && catalogueJob?.status === 'successful' && ancillarySyncActive && <div className="studio-integration-account-banner studio-integration-account-banner-info">
                    Synchronization in progress. Activity and engagement counts will update as the remaining sync phases complete.
                  </div>}
                  {!activeCatalogueJob && catalogueJob?.status === 'successful' && !ancillarySyncActive && <div className="studio-integration-account-banner studio-integration-account-banner-success">
                    Synchronization complete.
                  </div>}
                  {catalogueJob?.status === 'failed' && <div className="studio-integration-account-banner studio-integration-account-banner-error">Sync failed. Review the status above, then retry when ready.</div>}
                  {savedDestinationCreatorId && <label className="studio-da-account-source-files">
                    <input type="checkbox" checked={includeSourceFilesByAccount[account.externalAccountId] === true} onChange={(event) => setIncludeSourceFilesByAccount((current) => ({ ...current, [account.externalAccountId]: event.target.checked }))} />
                    <span><strong>Include source files in this sync</strong><small>Copies available DeviantArt source files into private {brand.workspaceFullName} storage.</small></span>
                  </label>}
                  <div className="studio-integration-row-actions">
                    {account.connectionStatus === 'authentication_required' && <button type="button" className="auth-primary-btn" disabled={workingAccountId === account.externalAccountId} onClick={() => void reconnect(account)}>
                      Reconnect & repair permissions
                    </button>}
                    {savedDestinationCreatorId && <button type="button" className="auth-primary-btn" disabled={workingAccountId === account.externalAccountId || Boolean(activeCatalogueJob) || Boolean(rateLimitedJob) || cooldownActive || recoveryInFlight} onClick={() => void sync(account.externalAccountId)}>
                      {workingAccountId === account.externalAccountId
                        ? 'Queueing…'
                        : cooldownActive
                          ? 'Waiting for cooldown'
                          : recoveryJob?.status === 'processing'
                            ? 'Retrying automatically'
                            : recoveryInFlight
                              ? 'Retry queued'
                              : rateLimitedJob
                                ? 'Resumes automatically'
                                : activeCatalogueJob
                                  ? 'Sync in progress'
                                  : account.connectionStatus === 'temporarily_unavailable'
                                    ? 'Retry sync'
                                    : account.connectionStatus === 'rate_limited'
                                      ? 'Verify with Sync now'
                                      : 'Sync now'}
                    </button>}
                    {activeCatalogueJob && <button type="button" className="auth-secondary-btn" disabled={cancellingSyncJobId === activeCatalogueJob.externalSyncJobId} onClick={() => void cancelSync(activeCatalogueJob)}>
                      {cancellingSyncJobId === activeCatalogueJob.externalSyncJobId ? 'Cancelling…' : 'Cancel sync'}
                    </button>}
                    <button type="button" className="auth-secondary-btn" disabled={workingAccountId === account.externalAccountId} onClick={() => void removeAccount(account)}>
                      {workingAccountId === account.externalAccountId ? 'Removing…' : 'Remove this DeviantArt Account'}
                    </button>
                    <button type="button" className="auth-secondary-btn" disabled={presetBusy && editingPreset} onClick={() => editPublishingPreset(account)}>
                      Publishing preset
                    </button>
                  </div>
                  <div className="studio-integration-sync-stats" aria-label={`Sync summary for ${account.externalUsername}`}>
                    <div className="studio-integration-sync-stat studio-integration-account-last-sync-mobile">
                      <span>Last sync</span>
                      <strong>{formatDate(account.lastSuccessfulSyncAt)}</strong>
                      <small>→ {destinationCreator?.name || 'No destination'}</small>
                    </div>
                    <div className="studio-integration-account-status-pills studio-integration-account-status-pills-mobile">
                      <Pill label={connectionStatusLabel} tone={accountTone(account.connectionStatus)} />
                      {!savedDestinationCreatorId && <Pill label={`Needs ${brand.creatorName}`} tone="warning" />}
                    </div>
                    <div className="studio-integration-sync-stat">
                      <span>Metadata</span>
                      <strong>{metadataSynchronized}/{metadataDiscovered}</strong>
                      <small>{metadataRemaining} remaining</small>
                      <i><b style={{ width: `${metadataPercent}%` }} /></i>
                    </div>
                    <div className="studio-integration-sync-stat">
                      <span>Source copies</span>
                      <strong>{sourceCopyTitle}</strong>
                      <small>{sourceCopyDetail}</small>
                      <i><b style={{ width: `${sourceCopyPercent}%` }} /></i>
                    </div>
                    {ancillarySyncJobs.map(({ type, label, description, job }) => {
                      const waitingForMetadata = Boolean(activeCatalogueJob);
                      const discovered = job?.progress?.discovered ?? 0;
                      const synchronized = job?.progress?.synchronized ?? 0;
                      const remaining = job?.progress?.remaining ?? Math.max(0, discovered - synchronized);
                      const percent = waitingForMetadata
                        ? 0
                        : discovered
                          ? Math.min(100, Math.round((synchronized / discovered) * 100))
                          : job?.status === 'successful' ? 100 : 0;
                      const statusLabel = waitingForMetadata
                        ? 'Waiting for metadata'
                        : job ? syncJobStatusLabel(job.status) : 'Queued';
                      return <div className="studio-integration-sync-stat" key={`${type}-${job?.externalSyncJobId || 'waiting'}`}>
                        <span>{label}</span>
                        <strong>{waitingForMetadata ? statusLabel : discovered ? `${synchronized}/${discovered}` : statusLabel}</strong>
                        <small>{description} · {waitingForMetadata ? 'Starts after metadata completes' : remaining > 0 ? `${remaining} remaining` : statusLabel}</small>
                        <i><b style={{ width: `${percent}%` }} /></i>
                      </div>;
                    })}
                  </div>
                  {account.connectionStatus === 'authentication_required' && <p className="studio-work-metadata-warning">DeviantArt needs authorization or an updated permission grant. Reconnect this same account to repair it without changing its creator assignment.</p>}
                  {editingPreset && <section className="studio-integration-credential-form" aria-label={`Publishing preset for ${account.externalUsername}`}>
                    <div>
                      <p className="auth-eyebrow">DeviantArt publishing preset</p>
                      <h3>Defaults for new destinations</h3>
                      <p className="small">New local Works use filename title case: <code>brand-name-1-v1.png</code> becomes <strong>Brand Name #1, v1</strong>. You can still edit every Work before publishing.</p>
                    </div>
                    <label><span>Default tags</span><input value={presetTags} onChange={(event) => setPresetTags(event.target.value)} placeholder="brand, illustration, series" /></label>
                    <label><span>Display size</span><select value={presetDisplayResolution} onChange={(event) => setPresetDisplayResolution(event.target.value)}><option value="">Original</option>{deviantArtDisplayWidths.map((width) => <option key={width} value={width}>Size: {width} pixels wide</option>)}</select><small>DeviantArt creates the display rendition. Original retains its normal display size.</small></label>
                    <label className="studio-work-metadata-option"><input type="checkbox" checked={presetAllowFreeDownload} onChange={(event) => setPresetAllowFreeDownload(event.target.checked)} /><span>Allow free original download</span></label>
                    <label className="studio-work-metadata-option"><input type="checkbox" checked={presetAddWatermark} disabled={!presetDisplayResolution} onChange={(event) => setPresetAddWatermark(event.target.checked)} /><span>Add DeviantArt watermark to the display rendition</span></label>
                    <fieldset className="studio-work-metadata-options">
                      <legend>Content declarations</legend>
                      <label className="studio-work-metadata-option"><input type="checkbox" checked={presetIsMature} onChange={(event) => { setPresetIsMature(event.target.checked); if (!event.target.checked) setPresetMatureClassification([]); }} /><span>Mature content</span></label>
                      {presetIsMature && <label><span>Mature level</span><select value={presetMatureLevel} onChange={(event) => setPresetMatureLevel(event.target.value as 'strict' | 'moderate')}><option value="moderate">Moderate</option><option value="strict">Strict</option></select></label>}
                      {presetIsMature && <div className="studio-work-metadata-options"><span>Mature classifications</span>{matureClassificationOptions.map((option) => <label className="studio-work-metadata-option" key={option.value}><input type="checkbox" checked={presetMatureClassification.includes(option.value)} onChange={(event) => setPresetMatureClassification((current) => event.target.checked ? [...new Set([...current, option.value])] : current.filter((value) => value !== option.value))} /><span>{option.label}</span></label>)}</div>}
                      <label className="studio-work-metadata-option"><input type="checkbox" checked={presetIsAiGenerated} onChange={(event) => setPresetIsAiGenerated(event.target.checked)} /><span>Made with AI</span></label>
                      <label className="studio-work-metadata-option"><input type="checkbox" checked={presetNoAi} onChange={(event) => setPresetNoAi(event.target.checked)} /><span>Do not authorize use in third-party AI training datasets</span></label>
                    </fieldset>
                    <label><span>Default DeviantArt state</span><select value={presetTargetStatus} onChange={(event) => setPresetTargetStatus(event.target.value as 'draft' | 'published')}><option value="published">Published</option><option value="draft">Draft in Sta.sh</option></select></label>
                    <p className="small"><strong>Original file:</strong> Ubeeq keeps the original. DeviantArt’s display-resolution option controls its display rendition; it does not change the stored original.</p>
                    <fieldset className="studio-work-metadata-options">
                      <legend>Default gallery placement</legend>
                      {accountGalleries.length ? accountGalleries.map((gallery) => <label className="studio-work-metadata-option" key={gallery.externalCollectionId}>
                        <input type="checkbox" checked={presetGalleryIds.includes(gallery.externalCollectionExternalId)} onChange={(event) => setPresetGalleryIds((current) => event.target.checked ? [...new Set([...current, gallery.externalCollectionExternalId])] : current.filter((id) => id !== gallery.externalCollectionExternalId))} />
                        <span>{gallery.name}</span>
                      </label>) : <small>No imported galleries yet. Create one below or synchronize the account.</small>}
                    </fieldset>
                    <div className="studio-inline-form">
                      <input value={newGalleryName} maxLength={50} onChange={(event) => setNewGalleryName(event.target.value)} placeholder="New DeviantArt gallery name" />
                      <button type="button" className="auth-secondary-btn" disabled={presetBusy || !newGalleryName.trim()} onClick={() => void createDeviantArtGallery()}>{presetBusy ? 'Working…' : 'Create gallery'}</button>
                    </div>
                    <div className="studio-inline-actions">
                      <button type="button" className="auth-primary-btn" disabled={presetBusy} onClick={() => void savePublishingPreset()}>{presetBusy ? 'Saving…' : 'Save publishing preset'}</button>
                      <button type="button" className="auth-secondary-btn" disabled={presetBusy} onClick={() => setPresetAccountId('')}>Cancel</button>
                    </div>
                  </section>}
                </div>
              );
            })}
          </div>
        ) : !loading && accounts.length > 0 && <div className="studio-empty-state">
          No connected accounts match this application filter. <button type="button" className="auth-secondary-btn" onClick={() => setAccountApplicationFilterId('')}>Show all accounts</button>
        </div>}
        {accounts.length > 0 && <section className="studio-integration-mapping-section" aria-labelledby="deviantart-collection-mapping-title">
          <div className="studio-integration-mapping-section-heading">
            <p className="studio-module-eyebrow">{brand.productName} collection mapping</p>
            <h4 id="deviantart-collection-mapping-title">Gallery mapping</h4>
            <p className="small">Map imported DeviantArt galleries to existing {brand.productName} Collections. Create and edit Collections from the Collections section.</p>
          </div>
          <div className="studio-integration-mapping-list">
            {collections.externalCollections.map((externalCollection) => {
              const mapping = collections.mappings.find((item) => item.externalCollectionId === externalCollection.externalCollectionId);
              return (
                <div className="studio-integration-mapping-row" key={externalCollection.externalCollectionId}>
                  <span>
                    <strong>{externalCollection.name}</strong>
                    <small>{externalCollection.externalUsername || 'DeviantArt'} gallery{typeof externalCollection.remoteSize === 'number' ? ` · ${externalCollection.remoteSize} works` : ''}</small>
                    {externalCollection.syncStatus === 'missing' && <small className="error">No longer returned by DeviantArt</small>}
                    {mapping?.lastMembershipSyncAt && <small>{mapping.lastMembershipCount || 0} mapped works · last reconciled {formatDate(mapping.lastMembershipSyncAt)}</small>}
                    {mapping?.lastMembershipError && <small className="error">{mapping.lastMembershipError}</small>}
                  </span>
                  <div className="studio-integration-mapping-actions">
                    <select disabled={externalCollection.syncStatus === 'missing'} value={mapping?.ubeeqCollectionId || ''} onChange={(event) => void saveMapping(externalCollection, event.target.value)}>
                      <option value="">Map to {brand.productName} collection…</option>
                      {collections.ubeeqCollections.map((collection) => <option key={collection.ubeeqCollectionId} value={collection.ubeeqCollectionId}>{collection.name}</option>)}
                    </select>
                    {mapping && <select aria-label={`${externalCollection.name} synchronization mode`} value={mapping.syncMode} onChange={(event) => void updateMappingMode(externalCollection, mapping, event.target.value as StudioExternalCollectionMapping['syncMode'])}>
                      <option value="continuous">Keep synchronized</option>
                      <option value="initial_only">Import once</option>
                      <option value="manual">Manual</option>
                      <option value="ignored">Ignore</option>
                    </select>}
                  </div>
                </div>
              );
            })}
          </div>
          {!collections.externalCollections.length && <div className="studio-empty-state">Gallery folders appear after the account's first import. Create {brand.productName} Collections from the Collections section, then map galleries here.</div>}
        </section>}
      </Card>}
      {!visibleIntegrationPlatforms.length && <div className="studio-empty-state">No integrations are currently shown. Use the controls above to show a platform.</div>}
      {movingAccountId && (() => {
        const movingAccount = accounts.find((account) => account.externalAccountId === movingAccountId);
        if (!movingAccount) return null;
        const closeMoveModal = () => {
          setMovingAccountId('');
          setMoveCreatorId('');
        };
        return (
          <div className="studio-account-move-modal-layer" role="presentation" onClick={closeMoveModal}>
            <div
              className="studio-account-move-modal"
              role="dialog"
              aria-modal="true"
              aria-labelledby="studio-account-move-title"
              onClick={(event) => event.stopPropagation()}
            >
              <div className="studio-account-move-modal-header">
                <div>
                  <p className="auth-eyebrow">Move DeviantArt account</p>
                  <h3 id="studio-account-move-title">{movingAccount.externalUsername}</h3>
                </div>
                <button type="button" className="studio-account-move-modal-close" onClick={closeMoveModal} aria-label="Close">×</button>
              </div>
              <p className="small">Choose the {brand.creatorName} that should own this account’s synchronization and publishing destination.</p>
              <label className="studio-account-move-modal-field">
                <span>Destination {brand.creatorName}</span>
                <select value={moveCreatorId} onChange={(event) => setMoveCreatorId(event.target.value)}>
                  {creators.map((creator) => <option key={creator.creatorId} value={creator.creatorId}>{creator.name}</option>)}
                </select>
              </label>
              <div className="studio-inline-actions">
                <button type="button" className="auth-primary-btn" disabled={!moveCreatorId || workingAccountId === movingAccountId} onClick={() => void moveAccount()}>
                  {workingAccountId === movingAccountId ? 'Saving…' : 'Move account'}
                </button>
                <button type="button" className="auth-secondary-btn" disabled={workingAccountId === movingAccountId} onClick={closeMoveModal}>Cancel</button>
              </div>
            </div>
          </div>
        );
      })()}
    </section>
  );
}
