import { useEffect, useMemo, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { api } from '../../api';
import { brand } from '../../brand';
import { Card } from '../components/Card';
import { Pill } from '../components/Pill';
import type {
  StudioCreator,
  StudioDeviantArtAccount,
  StudioExternalCollection,
  StudioExternalCollectionMapping,
  StudioExternalSyncJob,
  StudioUbeeqCollection
} from '../types';

const deviantArtDisplayWidths = [400, 600, 800, 900, 1024, 1280, 1600, 1920];
type MatureClassification = 'nudity' | 'sexual' | 'gore' | 'language' | 'ideology';
const matureClassificationOptions: Array<{ value: MatureClassification; label: string }> = [
  { value: 'nudity', label: 'Nudity' },
  { value: 'sexual', label: 'Sexual themes' },
  { value: 'gore', label: 'Gore' },
  { value: 'language', label: 'Strong language' },
  { value: 'ideology', label: 'Ideology' }
];

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

const accountTone = (status: StudioDeviantArtAccount['connectionStatus']): 'success' | 'warning' | 'danger' | 'default' => {
  if (status === 'connected') return 'success';
  if (status === 'authentication_required') return 'danger';
  if (status === 'rate_limited' || status === 'temporarily_unavailable') return 'warning';
  return 'default';
};

const copySyncSummary = (jobs: StudioExternalSyncJob[], catalogueJob?: StudioExternalSyncJob) => {
  const startedAt = catalogueJob?.createdAt || '';
  const copyJobs = jobs.filter((job) => job.type === 'content_sync' && (!startedAt || job.createdAt >= startedAt));
  if (!copyJobs.length) return null;
  const stored = copyJobs.filter((job) => job.status === 'successful').length;
  const unavailable = copyJobs.filter((job) => ['failed', 'cancelled', 'authentication_required'].includes(job.status)).length;
  const inProgress = copyJobs.length - stored - unavailable;
  return { requested: copyJobs.length, stored, unavailable, inProgress };
};

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
  const [accounts, setAccounts] = useState<StudioDeviantArtAccount[]>([]);
  const [jobsByAccount, setJobsByAccount] = useState<Record<string, StudioExternalSyncJob[]>>({});
  const [collections, setCollections] = useState<CollectionResponse>({ ubeeqCollections: [], externalCollections: [], mappings: [] });
  const [collectionName, setCollectionName] = useState('');
  const [workingExternalCollectionId, setWorkingExternalCollectionId] = useState('');
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

  useEffect(() => {
    if (creatorId || !creators.length) return;
    setCreatorId(creators.some((creator) => creator.creatorId === requestedCreatorId) ? requestedCreatorId : creators[0].creatorId);
  }, [creatorId, creators, requestedCreatorId]);

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
      const [nextConfiguration, nextAccounts, nextCollections, nextBlueskyConfiguration, nextBlueskyAccounts] = await Promise.all([
        api.studioGetDeviantArtConfiguration(),
        api.studioListDeviantArtAccounts(),
        api.studioListDeviantArtCollections(nextCreatorId),
        api.studioGetBlueskyConfiguration(),
        api.studioListBlueskyAccounts(nextCreatorId)
      ]);
      const typedAccounts = (nextAccounts || []) as StudioDeviantArtAccount[];
      setConfiguration(nextConfiguration);
      setAccounts(typedAccounts);
      setIncludeSourceFilesByAccount(Object.fromEntries(typedAccounts.map((account) => [
        account.externalAccountId,
        account.includeSourceFilesOnSync !== false
      ])));
      setDestinationCreatorByAccount(Object.fromEntries(typedAccounts.map((account) => [
        account.externalAccountId,
        account.primaryCreatorIdentityId || account.creatorIdentityId || (creators.length === 1 ? creators[0].creatorId : '')
      ])));
      setCollections(nextCollections as CollectionResponse);
      setBlueskyConfiguration(nextBlueskyConfiguration);
      setBlueskyAccounts((nextBlueskyAccounts || []) as Array<{ externalAccountId: string; externalUsername: string; externalUserId: string }>);
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
      await api.studioSyncDeviantArtAccount(externalAccountId, includeSourceFilesByAccount[externalAccountId] === true);
      setMessage('Synchronization queued. Progress will update as the worker imports this account.');
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

  const saveAccountDestination = async (account: StudioDeviantArtAccount, disconnect = false) => {
    const destinationCreatorId = disconnect ? '' : (destinationCreatorByAccount[account.externalAccountId] || '');
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
    } catch (assignmentError) {
      setError(assignmentError instanceof Error ? assignmentError.message : `Unable to save ${brand.creatorName.toLowerCase()} assignments.`);
    } finally {
      setWorkingAccountId('');
    }
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

  const createCollection = async () => {
    const name = collectionName.trim();
    if (!creatorId || !name) return;
    setError('');
    try {
      await api.studioCreateIntegrationCollection({ creatorIdentityId: creatorId, name });
      setCollectionName('');
      setMessage(`Independent ${brand.productName} collection created.`);
      await load();
    } catch (createError) {
      setError(createError instanceof Error ? createError.message : 'Unable to create collection.');
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

  const createCollectionForGallery = async (externalCollection: StudioExternalCollection) => {
    if (!creatorId) return;
    setWorkingExternalCollectionId(externalCollection.externalCollectionId);
    setError('');
    try {
      const collection = await api.studioCreateIntegrationCollection({
        creatorIdentityId: creatorId,
        name: externalCollection.name,
        collectionType: 'gallery'
      }) as StudioUbeeqCollection;
      await api.studioSaveDeviantArtCollectionMapping(externalCollection.externalCollectionId, {
        externalAccountId: externalCollection.externalAccountId,
        ubeeqCollectionId: collection.ubeeqCollectionId,
        syncMode: 'initial_only'
      });
      setMessage(`Created the ${brand.productName} collection “${collection.name}” and mapped this DeviantArt gallery to it.`);
      await load();
    } catch (createError) {
      setError(createError instanceof Error ? createError.message : `Unable to create and map this ${brand.productName} collection.`);
    } finally {
      setWorkingExternalCollectionId('');
    }
  };

  return (
    <section className="studio-integration-grid">
      <Card
        title="Bluesky announcements"
        eyebrow="Optional distribution destination"
        className="studio-integration-accounts"
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
        {blueskyConfiguration && !blueskyConfiguration.configured && <p className="error">Bluesky is not configured. Missing server settings: {blueskyConfiguration.requiredConfiguration.join(', ')}.</p>}
        {blueskyAccounts.length ? (
          <div className="studio-integration-account-list">
            {blueskyAccounts.map((account) => <div key={account.externalAccountId} className="studio-integration-account">
              <div><p className="auth-eyebrow">Connected account</p><h3>{account.externalUsername}</h3><p className="small">{account.externalUserId}</p></div>
              <Pill tone="success" label="Connected" />
            </div>)}
          </div>
        ) : <p className="small">No Bluesky account is connected to this {brand.creatorName} yet.</p>}
      </Card>
      <Card
        title="DeviantArt integration"
        eyebrow="Your connected publishing accounts"
        className="studio-integration-accounts"
      >
        <div className="studio-integration-toolbar">
          <label>
            <span>Browse {brand.creatorName} catalogue</span>
            <select value={creatorId} onChange={(event) => setCreatorId(event.target.value)}>
              {creators.map((creator) => <option key={creator.creatorId} value={creator.creatorId}>{creator.name}</option>)}
            </select>
          </label>
          {(configuration?.credentials || []).length > 1 && <label>
            <span>Filter connected accounts</span>
            <select value={accountApplicationFilterId} onChange={(event) => setAccountApplicationFilterId(event.target.value)}>
              <option value="">All applications</option>
              {(configuration?.credentials || []).map((credential) => <option key={credential.externalPlatformCredentialId} value={credential.externalPlatformCredentialId}>{credential.applicationLabel || `DeviantArt app ${credential.clientId}`}</option>)}
            </select>
          </label>}
          <p className="small">{accountApplicationFilterId ? `${visibleAccounts.length} of ${accounts.length}` : accounts.length} connected account{accounts.length === 1 ? '' : 's'}</p>
        </div>
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
                    <p className="auth-eyebrow">OAuth application</p>
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
          <p className="error">Connection is not configured. Missing server settings: {configuration.requiredConfiguration.join(', ')}.</p>
        )}
        {loading && <p className="small">Loading integration and creator catalogue…</p>}
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
              const savedDestinationCreatorId = account.primaryCreatorIdentityId || account.creatorIdentityId || '';
              const destinationCreatorId = destinationCreatorByAccount[account.externalAccountId] || '';
              const destinationCreator = creators.find((creator) => creator.creatorId === savedDestinationCreatorId);
              const accountGalleries = collections.externalCollections.filter((collection) => collection.externalAccountId === account.externalAccountId && collection.syncStatus !== 'missing');
              const editingPreset = presetAccountId === account.externalAccountId;
              return (
                <div className="studio-integration-account-row" key={account.externalAccountId}>
                  <div>
                    <strong>{account.externalUsername}</strong>
                    <span>Connected through {(configuration?.credentials || []).find((credential) => credential.externalPlatformCredentialId === account.externalPlatformCredentialId)?.applicationLabel || 'DeviantArt application'}</span>
                    <span>Last successful sync: {formatDate(account.lastSuccessfulSyncAt)}</span>
                    <span className={destinationCreator ? undefined : 'studio-integration-assignment-needed'}>{destinationCreator ? `Sync destination: ${destinationCreator.name}` : `${brand.creatorName} assignment required before synchronization.`}</span>
                    {catalogueJob?.progress && <span>Metadata: {catalogueJob.progress.discovered} discovered · {catalogueJob.progress.synchronized} synchronized · {catalogueJob.progress.remaining} remaining</span>}
                    {copySummary && <span>Source copies: {copySummary.requested} requested · {copySummary.stored} stored · {copySummary.unavailable} unavailable{copySummary.inProgress ? ` · ${copySummary.inProgress} in progress` : ''}</span>}
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
                  <div className="studio-integration-row-actions">
                    <Pill label={connectionStatusLabel} tone={accountTone(account.connectionStatus)} />
                    {!savedDestinationCreatorId && <Pill label={`Needs ${brand.creatorName}`} tone="warning" />}
                    {account.connectionStatus === 'authentication_required' && <button type="button" className="auth-primary-btn" disabled={workingAccountId === account.externalAccountId} onClick={() => void reconnect(account)}>
                      Reconnect & repair permissions
                    </button>}
                    {savedDestinationCreatorId && <button type="button" className="auth-secondary-btn" disabled={workingAccountId === account.externalAccountId || Boolean(activeCatalogueJob) || Boolean(rateLimitedJob) || cooldownActive || recoveryInFlight} onClick={() => void sync(account.externalAccountId)}>
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
                  {account.connectionStatus === 'authentication_required' && <p className="studio-work-metadata-warning">DeviantArt needs authorization or an updated permission grant. Reconnect this same account to repair it without changing its creator assignment.</p>}
                  {savedDestinationCreatorId && <label className="studio-da-account-source-files">
                    <input type="checkbox" checked={includeSourceFilesByAccount[account.externalAccountId] === true} onChange={(event) => setIncludeSourceFilesByAccount((current) => ({ ...current, [account.externalAccountId]: event.target.checked }))} />
                    <span><strong>Include source files in this sync</strong><small>Copies available DeviantArt source files into private {brand.workspaceFullName} storage.</small></span>
                  </label>}
                  <div className="studio-integration-assignment-form">
                    <label><span>Destination {brand.creatorName}</span><select value={destinationCreatorId} onChange={(event) => setDestinationCreatorByAccount((current) => ({ ...current, [account.externalAccountId]: event.target.value }))}><option value="">Choose {brand.id === 'eversally' ? 'an' : 'a'} {brand.creatorName}…</option>{creators.map((creator) => <option key={creator.creatorId} value={creator.creatorId}>{creator.name}</option>)}</select></label>
                    <div className="studio-inline-actions">
                      <button type="button" className="auth-secondary-btn" disabled={workingAccountId === account.externalAccountId || !destinationCreatorId} onClick={() => void saveAccountDestination(account)}>Save destination {brand.creatorName}</button>
                      {savedDestinationCreatorId && <button type="button" className="auth-secondary-btn" disabled={workingAccountId === account.externalAccountId} onClick={() => void saveAccountDestination(account, true)}>Disconnect {brand.creatorName}</button>}
                    </div>
                  </div>
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
        ) : !loading && <div className="studio-empty-state">{accounts.length
          ? <>No connected accounts match this application filter. <button type="button" className="auth-secondary-btn" onClick={() => setAccountApplicationFilterId('')}>Show all accounts</button></>
          : `Connect an account to import its catalogue, galleries, and engagement history into ${brand.productName}.`}</div>}
      </Card>

      <Card title="Gallery mapping" eyebrow={`Independent ${brand.productName} collections`} className="studio-integration-gallery-mapping">
        <div className="studio-inline-form">
          <input value={collectionName} onChange={(event) => setCollectionName(event.target.value)} placeholder={`New ${brand.productName} collection`} />
          <button type="button" className="auth-secondary-btn" onClick={() => void createCollection()}>Create collection</button>
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
                  {!mapping && (
                    <button
                      type="button"
                      className="auth-secondary-btn"
                      disabled={workingExternalCollectionId === externalCollection.externalCollectionId}
                      onClick={() => void createCollectionForGallery(externalCollection)}
                    >
                      {workingExternalCollectionId === externalCollection.externalCollectionId ? 'Creating…' : `Create this Gallery as a ${brand.productName} Gallery`}
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
        {!collections.externalCollections.length && <div className="studio-empty-state">Gallery folders appear after the account's first import. {brand.productName} collections remain independent unless you map them here.</div>}
      </Card>
    </section>
  );
}
