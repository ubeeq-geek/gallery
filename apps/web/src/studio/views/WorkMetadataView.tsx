import { useEffect, useMemo, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { api } from '../../api';
import { brand } from '../../brand';
import {
  clonePostBlocks,
  parseDescriptionBlocks,
  serializeDescriptionBlocks
} from '../../blockContent';
import { BlockEditor } from '../../components/BlockEditor';
import type { PostBlock } from '../../domainTypes';
import { Card } from '../components/Card';
import type { StudioCreator, StudioDeviantArtAccount, StudioExternalAsset, StudioExternalCollection, StudioExternalPublication, StudioExternalSyncJob } from '../types';

const sourceLabel = (publication?: StudioExternalPublication): string => {
  if (publication?.platform === 'deviantart') return 'DeviantArt';
  if (publication?.platform) return publication.platform.replace(/(^|[-_ ])([a-z])/g, (_, prefix: string, letter: string) => `${prefix}${letter.toUpperCase()}`);
  return 'Integration';
};

const isMetadataLinked = (asset: StudioExternalAsset): boolean => (
  asset.titleSyncPolicy === 'mirrored' || asset.titleSyncPolicy === 'initially_mirrored'
) || (
  asset.descriptionSyncPolicy === 'mirrored' || asset.descriptionSyncPolicy === 'initially_mirrored'
);

export function WorkMetadataView({ creators }: { creators: StudioCreator[] }) {
  const location = useLocation();
  const navigate = useNavigate();
  const params = useMemo(() => new URLSearchParams(location.search), [location.search]);
  const creatorId = params.get('creatorId') || '';
  const workId = params.get('workId') || '';
  const collectionId = params.get('collectionId') || '';
  const [asset, setAsset] = useState<StudioExternalAsset | null>(null);
  const [accounts, setAccounts] = useState<StudioDeviantArtAccount[]>([]);
  const [externalCollections, setExternalCollections] = useState<StudioExternalCollection[]>([]);
  const [selectedPublicationId, setSelectedPublicationId] = useState('');
  const [newDestinationAccountId, setNewDestinationAccountId] = useState('');
  const [newDestinationTargetStatus, setNewDestinationTargetStatus] = useState<'draft' | 'published'>('published');
  const [destinationBusy, setDestinationBusy] = useState(false);
  const [spaceBusy, setSpaceBusy] = useState(false);
  const [destinationMessage, setDestinationMessage] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [linked, setLinked] = useState(true);
  const [title, setTitle] = useState('');
  const [descriptionBlocks, setDescriptionBlocks] = useState<PostBlock[]>(() => parseDescriptionBlocks());
  const [integrationTitle, setIntegrationTitle] = useState('');
  const [integrationDescriptionBlocks, setIntegrationDescriptionBlocks] = useState<PostBlock[]>(() => parseDescriptionBlocks());
  const [tags, setTags] = useState<string[]>([]);
  const [integrationCollectionIds, setIntegrationCollectionIds] = useState<string[]>([]);
  const [allowComments, setAllowComments] = useState(true);
  const [isMature, setIsMature] = useState(false);
  const [matureLevel, setMatureLevel] = useState<'strict' | 'moderate'>('moderate');
  const [matureClassification, setMatureClassification] = useState<string[]>([]);
  const [isAiGenerated, setIsAiGenerated] = useState<boolean | undefined>(undefined);
  const [noAi, setNoAi] = useState<boolean | undefined>(undefined);
  const [success, setSuccess] = useState('');
  const [metadataWarning, setMetadataWarning] = useState('');
  const [remoteUpdateJobs, setRemoteUpdateJobs] = useState<StudioExternalSyncJob[]>([]);

  const backToWorks = () => {
    const next = new URLSearchParams({ section: 'works' });
    if (creatorId) next.set('creatorId', creatorId);
    if (collectionId) next.set('collectionId', collectionId);
    navigate(`/studio/workspace?${next.toString()}`);
  };

  const destinations = (asset?.publications || []).filter((publication) => publication.syncStatus !== 'deleted');
  const integration = destinations.find((publication) => publication.externalPublicationId === selectedPublicationId) || destinations[0];
  const integrationLabel = sourceLabel(integration);

  useEffect(() => {
    if (!creatorId || !workId) {
      setLoading(false);
      setError('This work could not be opened. Return to Works and choose a work to edit.');
      return;
    }
    let active = true;
    setLoading(true);
    setError('');
    void Promise.all([
      api.studioListWorks(creatorId),
      api.studioListDeviantArtAccounts(creatorId),
      api.studioListDeviantArtCollections(creatorId)
    ]).then(([result, accountResult, collectionResult]) => {
      if (!active) return;
      const found = ((result as { items?: StudioExternalAsset[] }).items || []).find((item) => item.assetId === workId) || null;
      if (!found) {
        setError('This work is no longer available in the selected creator catalogue.');
        return;
      }
      setAsset(found);
      const destinations = found.publications.filter((publication) => publication.syncStatus !== 'deleted');
      const selected = destinations[0];
      // This endpoint returns the account collection directly. Reading it as an
      // object with an `accounts` property silently hid every valid destination.
      const connectedAccounts = ((accountResult || []) as StudioDeviantArtAccount[]).filter((account) => account.connectionStatus === 'connected');
      const availableAccounts = connectedAccounts.filter((account) => !destinations.some((publication) => publication.externalAccountId === account.externalAccountId));
      const savedIntent = found.publicationIntents.find((intent) => intent.enabled && intent.destination === 'deviantart' && availableAccounts.some((account) => account.externalAccountId === intent.integrationAccountId));
      setAccounts(connectedAccounts);
      setExternalCollections(((collectionResult as { externalCollections?: StudioExternalCollection[] }).externalCollections || []));
      setNewDestinationAccountId(savedIntent?.integrationAccountId || (availableAccounts.length === 1 ? availableAccounts[0].externalAccountId : ''));
      setNewDestinationTargetStatus(savedIntent?.desiredStatus === 'draft' ? 'draft' : 'published');
      if (savedIntent) setDestinationMessage('Publishing intent loaded from Works. Review the destination settings, then prepare it for synchronization.');
      setSelectedPublicationId(selected?.externalPublicationId || '');
      setLinked(selected ? isMetadataLinked(found) : false);
      setTitle(found.canonicalTitle || selected?.externalTitle || '');
      setDescriptionBlocks(parseDescriptionBlocks(found.canonicalDescription || selected?.externalDescription || ''));
      setIntegrationTitle(selected?.externalTitle || '');
      setIntegrationDescriptionBlocks(parseDescriptionBlocks(selected?.externalDescription || ''));
      setTags(selected?.externalTags || []);
      setIntegrationCollectionIds(selected?.externalCollectionIds || []);
      setAllowComments(selected?.displayOptions?.allowComments ?? true);
      setIsMature(selected?.displayOptions?.isMature ?? false);
      setMatureLevel(selected?.displayOptions?.matureLevel ?? 'moderate');
      setMatureClassification(selected?.displayOptions?.matureClassification || []);
      setIsAiGenerated(selected?.displayOptions?.isAiGenerated);
      setNoAi(selected?.displayOptions?.noAi);
    }).catch((loadError: unknown) => {
      if (active) setError(loadError instanceof Error ? loadError.message : 'Unable to load this work.');
    }).finally(() => {
      if (active) setLoading(false);
    });
    return () => { active = false; };
  }, [creatorId, workId]);

  useEffect(() => {
    if (!remoteUpdateJobs.length) return;
    const watchedIds = new Set(remoteUpdateJobs.map((job) => job.externalSyncJobId));
    const accountIds = [...new Set(remoteUpdateJobs.map((job) => job.externalAccountId))];
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const terminalStatuses = new Set(['successful', 'failed', 'authentication_required', 'cancelled']);

    const poll = async () => {
      try {
        const lists = await Promise.all(accountIds.map((accountId) => api.studioListDeviantArtSyncJobs(accountId) as Promise<StudioExternalSyncJob[]>));
        if (!active) return;
        const watched = lists.flat().filter((job) => watchedIds.has(job.externalSyncJobId));
        if (!watched.length) {
          setSuccess(`Metadata was saved in ${brand.productName}, but the destination update status is not available yet.`);
          timer = setTimeout(() => void poll(), 2000);
          return;
        }
        setRemoteUpdateJobs(watched);
        const pending = watched.filter((job) => !terminalStatuses.has(job.status));
        if (pending.length) {
          const isProcessing = pending.some((job) => job.status === 'processing');
          const isRetrying = pending.some((job) => job.status === 'retry_scheduled' || job.status === 'rate_limited');
          setSuccess(isProcessing
            ? `${integrationLabel} is applying and verifying the metadata update…`
            : isRetrying
              ? `${integrationLabel} has not confirmed the update yet. A retry is scheduled.`
              : `Metadata saved in ${brand.productName}. The ${integrationLabel} update is queued.`);
          timer = setTimeout(() => void poll(), 2000);
          return;
        }

        const failed = watched.find((job) => job.status !== 'successful');
        if (failed) {
          setSuccess('');
          setError(`Metadata was saved in ${brand.productName}, but ${integrationLabel} did not confirm the update${failed.errorMessage ? `: ${failed.errorMessage}` : '.'}`);
          setRemoteUpdateJobs([]);
          return;
        }

        const refreshed = await api.studioListWorks(creatorId) as { items?: StudioExternalAsset[] };
        if (!active) return;
        const verifiedAsset = (refreshed.items || []).find((item) => item.assetId === workId);
        if (verifiedAsset) setAsset(verifiedAsset);
        setError('');
        setSuccess(`${integrationLabel} metadata update completed and was verified against the destination.`);
        setRemoteUpdateJobs([]);
      } catch (pollError) {
        if (!active) return;
        setSuccess(`Metadata saved in ${brand.productName}. Waiting to confirm the ${integrationLabel} update…`);
        timer = setTimeout(() => void poll(), 3000);
      }
    };

    void poll();
    return () => {
      active = false;
      if (timer) clearTimeout(timer);
    };
  }, [creatorId, integrationLabel, remoteUpdateJobs.length, workId]);

  const sourceTitle = integration?.externalTitle || '';
  const sourceDescription = integration?.externalDescription || '';
  const sourceTags = integration?.externalTags || [];
  const sourceCollectionIds = integration?.externalCollectionIds || [];
  const sourceAllowComments = integration?.displayOptions?.allowComments ?? true;
  const sourceIsMature = integration?.displayOptions?.isMature ?? false;
  const sourceMatureLevel = integration?.displayOptions?.matureLevel ?? 'moderate';
  const sourceMatureClassification = integration?.displayOptions?.matureClassification || [];
  const sourceIsAiGenerated = integration?.displayOptions?.isAiGenerated;
  const sourceNoAi = integration?.displayOptions?.noAi;
  const reportsAiGenerated = integration?.displayOptions?.isAiGenerated !== undefined;
  const reportsNoAi = integration?.displayOptions?.noAi !== undefined;
  const canLink = Boolean(integration);
  const canUpdatePublishedDescription = !(
    integration?.platform === 'deviantart'
    && integration.syncStatus === 'active'
    && integration.canUpdatePublishedDescription !== true
  );
  const usesStashPublishedDescriptionUpdate = integration?.publishedDescriptionUpdateMode === 'stash';
  const creatorName = creators.find((creator) => creator.creatorId === creatorId)?.name || brand.creatorName;
  const availableDestinationAccounts = accounts.filter((account) => !destinations.some((publication) => publication.externalAccountId === account.externalAccountId));
  const availableExternalCollections = externalCollections.filter((collection) => (
    collection.externalAccountId === integration?.externalAccountId
    && collection.syncStatus !== 'missing'
  ));

  const selectDestination = (publication: StudioExternalPublication) => {
    setSelectedPublicationId(publication.externalPublicationId);
    setIntegrationTitle(publication.externalTitle || '');
    setIntegrationDescriptionBlocks(parseDescriptionBlocks(publication.externalDescription || ''));
    setTags(publication.externalTags || []);
    setIntegrationCollectionIds(publication.externalCollectionIds || []);
    setAllowComments(publication.displayOptions?.allowComments ?? true);
    setIsMature(publication.displayOptions?.isMature ?? false);
    setMatureLevel(publication.displayOptions?.matureLevel ?? 'moderate');
    setMatureClassification(publication.displayOptions?.matureClassification || []);
    setIsAiGenerated(publication.displayOptions?.isAiGenerated);
    setNoAi(publication.displayOptions?.noAi);
  };

  const addDestination = async () => {
    if (!asset || !newDestinationAccountId) return;
    setDestinationBusy(true);
    setError('');
    setDestinationMessage('');
    try {
      const result = await api.studioAddDeviantArtWorkDestination(asset.assetId, newDestinationAccountId, newDestinationTargetStatus) as { publication: Omit<StudioExternalPublication, 'externalUsername' | 'externalCollectionIds' | 'displayOptions'> };
      const account = accounts.find((item) => item.externalAccountId === newDestinationAccountId);
      const publication: StudioExternalPublication = {
        ...result.publication,
        externalUsername: account?.externalUsername || 'connected account',
        externalCollectionIds: [],
        displayOptions: { allowComments: true, isMature: false, isAiGenerated: false, noAi: false }
      };
      setAsset((current) => current ? { ...current, titleSyncPolicy: 'mirrored', descriptionSyncPolicy: 'mirrored', publications: [...current.publications.filter((item) => item.externalPublicationId !== publication.externalPublicationId), publication] } : current);
      setLinked(true);
      setNewDestinationAccountId('');
      selectDestination(publication);
      setDestinationMessage(`DeviantArt was added as a ${newDestinationTargetStatus === 'draft' ? 'Sta.sh draft' : 'published'} destination. Review its settings, then sync when ready.`);
    } catch (destinationError) {
      setError(destinationError instanceof Error ? destinationError.message : 'Unable to add this destination.');
    } finally {
      setDestinationBusy(false);
    }
  };

  const updateDestinationTargetStatus = async (publication: StudioExternalPublication, targetStatus: 'draft' | 'published') => {
    if (!asset || publication.syncStatus === 'active') return;
    setDestinationBusy(true);
    setError('');
    setDestinationMessage('');
    try {
      await api.studioAddDeviantArtWorkDestination(asset.assetId, publication.externalAccountId, targetStatus);
      setAsset((current) => current ? {
        ...current,
        publications: current.publications.map((item) => item.externalPublicationId === publication.externalPublicationId ? { ...item, targetStatus } : item)
      } : current);
      setDestinationMessage(targetStatus === 'draft'
        ? 'This destination will remain a private Sta.sh draft when synchronized.'
        : 'This destination will be published to DeviantArt when synchronized.');
    } catch (destinationError) {
      setError(destinationError instanceof Error ? destinationError.message : 'Unable to update the destination status.');
    } finally {
      setDestinationBusy(false);
    }
  };

  const removeDestination = async (publication: StudioExternalPublication) => {
    const isPublished = publication.syncStatus === 'active';
    const confirmation = isPublished
      ? `Unpublish ${sourceLabel(publication)} for ${publication.externalUsername}? The ${brand.productName} copy will remain private. On DeviantArt this will ultimately move the work back to Sta.sh, rather than delete it.`
      : `Remove ${sourceLabel(publication)} as a destination for ${publication.externalUsername}? The work will remain a private draft in ${brand.workspaceFullName}.`;
    if (!asset || !window.confirm(confirmation)) return;
    if (isPublished) {
      setDestinationMessage(`Unpublishing ${sourceLabel(publication)} is not available through its connected API yet, so this destination remains published for now.`);
      return;
    }
    setDestinationBusy(true);
    setError('');
    setDestinationMessage('');
    try {
      await api.studioRemoveDeviantArtWorkDestination(asset.assetId, publication.externalAccountId);
      const remaining = destinations.filter((item) => item.externalPublicationId !== publication.externalPublicationId);
      setAsset((current) => current ? { ...current, publications: current.publications.filter((item) => item.externalPublicationId !== publication.externalPublicationId) } : current);
      if (publication.externalPublicationId === integration?.externalPublicationId) {
        const next = remaining[0];
        setSelectedPublicationId(next?.externalPublicationId || '');
        if (next) selectDestination(next);
      }
      setDestinationMessage(`${sourceLabel(publication)} destination removed.`);
    } catch (destinationError) {
      setError(destinationError instanceof Error ? destinationError.message : 'Unable to remove this destination.');
    } finally {
      setDestinationBusy(false);
    }
  };

  const syncDestination = async (publication: StudioExternalPublication) => {
    if (!asset) return;
    setDestinationBusy(true);
    setError('');
    setDestinationMessage('');
    try {
      await api.studioSyncDeviantArtWorkDestination(asset.assetId, publication.externalAccountId);
      setDestinationMessage(`Sync to ${sourceLabel(publication)} has been queued.`);
    } catch (destinationError) {
      setError(destinationError instanceof Error ? destinationError.message : 'Unable to start this sync.');
    } finally {
      setDestinationBusy(false);
    }
  };

  const resolveDestination = async (strategy: 'pull' | 'push') => {
    if (!asset || !integration) return;
    const source = sourceLabel(integration);
    const confirmation = strategy === 'pull'
      ? `Pull the current ${source} metadata into ${brand.productName}? This replaces the local title, description, tags, and supported destination metadata with the remote version.`
      : `Push the current ${brand.productName} metadata to ${source}? This replaces the supported remote metadata with the local version.`;
    if (!window.confirm(confirmation)) return;
    setDestinationBusy(true);
    setError('');
    setDestinationMessage('');
    try {
      await api.studioResolveWorkPublicationConflict(asset.assetId, integration.externalPublicationId, strategy);
      setDestinationMessage(strategy === 'pull'
        ? `${source} changes are being pulled and reconciled.`
        : `${brand.productName} metadata is queued to replace the ${source} version.`);
    } catch (resolutionError) {
      setError(resolutionError instanceof Error ? resolutionError.message : `Unable to reconcile this ${source} publication.`);
    } finally {
      setDestinationBusy(false);
    }
  };

  const handleLinkChange = (nextLinked: boolean) => {
    setLinked(nextLinked);
    if (nextLinked && integration) {
      setIntegrationTitle(title);
      setIntegrationDescriptionBlocks(clonePostBlocks(descriptionBlocks));
    }
  };

  const updateSpacePublication = async (published: boolean, visibility: 'private' | 'unlisted' | 'public') => {
    if (!asset) return;
    setSpaceBusy(true);
    setError('');
    try {
      const spacePublication = await api.studioUpdateSpacePublication(asset.assetId, { published, hostingMode: 'hosted', visibility });
      const withdrewDiscovery = !published || visibility !== 'public';
      setAsset((current) => current ? {
        ...current,
        visibility,
        spacePublication,
        ...(withdrewDiscovery && current.discoveryState === 'opted_in' ? { discoveryState: 'none' } : {})
      } : current);
      setSuccess(published ? `This work is now ${visibility} in ${brand.workspaceFullName}.` : `This work is no longer published in ${brand.workspaceFullName}.`);
    } catch (spaceError) {
      setError(spaceError instanceof Error ? spaceError.message : `Unable to update the ${brand.workspaceFullName} publication.`);
    } finally {
      setSpaceBusy(false);
    }
  };

  const updateDiscovery = async (state: 'none' | 'eligible' | 'opted_in') => {
    if (!asset) return;
    setSpaceBusy(true);
    setError('');
    try {
      const result = await api.studioUpdateWorkDiscovery(asset.assetId, state);
      setAsset((current) => current ? { ...current, discoveryState: result.state } : current);
      setSuccess(state === 'opted_in' ? 'This work is opted into discovery.' : state === 'eligible' ? 'This work is eligible for discovery but is not opted in.' : 'This work is not participating in discovery.');
    } catch (discoveryError) {
      setError(discoveryError instanceof Error ? discoveryError.message : 'Unable to update discovery participation.');
    } finally {
      setSpaceBusy(false);
    }
  };

  const save = async () => {
    if (!asset) return;
    setSaving(true);
    setError('');
    setSuccess('');
    setMetadataWarning('');
    try {
      const nextIntegrationTitle = linked ? title : integrationTitle;
      const canonicalDescription = serializeDescriptionBlocks(descriptionBlocks, 'ubeeq');
      const nextIntegrationBlocks = linked ? descriptionBlocks : integrationDescriptionBlocks;
      const nextIntegrationDescription = serializeDescriptionBlocks(nextIntegrationBlocks, integration?.platform === 'deviantart' ? 'deviantart' : 'ubeeq');
      const normalizedSourceDescription = serializeDescriptionBlocks(parseDescriptionBlocks(sourceDescription), integration?.platform === 'deviantart' ? 'deviantart' : 'ubeeq');
      const normalizedTags = [...new Set(tags.map((tag) => tag.trim().replace(/\s+/g, '_')).filter(Boolean))];
      const normalizedCollectionIds = [...new Set(integrationCollectionIds)];
      const normalizedMatureClassification = [...new Set(matureClassification.map((classification) => classification.trim().toLowerCase()).filter((classification): classification is 'nudity' | 'sexual' | 'gore' | 'language' | 'ideology' => (
        classification === 'nudity' || classification === 'sexual' || classification === 'gore' || classification === 'language' || classification === 'ideology'
      )))];
      const integrationMetadata = integration ? {
        externalPublicationId: integration.externalPublicationId,
        ...(nextIntegrationTitle !== sourceTitle ? { title: nextIntegrationTitle } : {}),
        ...(canUpdatePublishedDescription && nextIntegrationDescription !== normalizedSourceDescription ? { description: nextIntegrationDescription } : {}),
        ...(normalizedTags.join('\u0000') !== sourceTags.join('\u0000') ? { tags: normalizedTags } : {}),
        ...(normalizedCollectionIds.slice().sort().join('\u0000') !== sourceCollectionIds.slice().sort().join('\u0000') ? { collectionExternalIds: normalizedCollectionIds } : {}),
        ...(allowComments !== sourceAllowComments ? { allowComments } : {}),
        ...(isMature !== sourceIsMature ? { isMature } : {}),
        ...(matureLevel !== sourceMatureLevel ? { matureLevel } : {}),
        ...(normalizedMatureClassification.join('\u0000') !== sourceMatureClassification.join('\u0000') ? { matureClassification: normalizedMatureClassification } : {}),
        ...(isAiGenerated !== undefined && isAiGenerated !== sourceIsAiGenerated ? { isAiGenerated } : {}),
        ...(noAi !== undefined && noAi !== sourceNoAi ? { noAi } : {})
      } : undefined;
      const updated = await api.studioUpdateExternalAsset(asset.assetId, {
        canonicalTitle: title,
        canonicalDescription,
        titleSyncPolicy: linked && canLink ? 'mirrored' : 'independent',
        descriptionSyncPolicy: linked && canLink && canUpdatePublishedDescription ? 'mirrored' : 'independent',
        integrationMetadata
      }) as Pick<StudioExternalAsset, 'canonicalTitle' | 'canonicalDescription' | 'titleSyncPolicy' | 'descriptionSyncPolicy' | 'updatedAt'> & {
        remoteUpdateJobs?: StudioExternalSyncJob[];
        remoteUpdateWarnings?: string[];
      };
      const queuedRemoteUpdates = updated.remoteUpdateJobs || [];
      const updateWarnings = updated.remoteUpdateWarnings || [];
      setAsset((current) => current ? {
        ...current,
        ...updated,
        publications: current.publications.map((publication) => publication.externalPublicationId === integration?.externalPublicationId && publication.syncStatus !== 'active' ? {
          ...publication,
          externalTitle: nextIntegrationTitle,
          externalDescription: nextIntegrationDescription,
          externalTags: normalizedTags,
          externalCollectionIds: normalizedCollectionIds,
          displayOptions: {
            ...publication.displayOptions,
            allowComments,
            isMature,
            matureLevel,
            matureClassification: normalizedMatureClassification,
            ...(isAiGenerated !== undefined ? { isAiGenerated } : {}),
            ...(noAi !== undefined ? { noAi } : {})
          }
        } : publication)
      } : current);
      setTitle(updated.canonicalTitle || '');
      setDescriptionBlocks(parseDescriptionBlocks(updated.canonicalDescription || ''));
      setIntegrationTitle(nextIntegrationTitle);
      setIntegrationDescriptionBlocks(parseDescriptionBlocks(canUpdatePublishedDescription ? nextIntegrationDescription : sourceDescription));
      setTags(normalizedTags);
      setIntegrationCollectionIds(normalizedCollectionIds);
      setMatureClassification(normalizedMatureClassification);
      setRemoteUpdateJobs(queuedRemoteUpdates);
      setMetadataWarning(updateWarnings.join(' '));
      setSuccess(queuedRemoteUpdates.length ? `Metadata saved in ${brand.productName}. The ${integrationLabel} update is queued.` : `Metadata saved in ${brand.productName}.`);
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : 'Unable to save this work’s metadata.');
    } finally {
      setSaving(false);
    }
  };

  const integrationControls = integration && <>
    <label>
      <span>Tags</span>
      <input value={tags.join(', ')} onChange={(event) => setTags(event.target.value.split(','))} placeholder="Add comma-separated tags" />
    </label>
    <fieldset className="studio-work-metadata-options">
      <legend>DeviantArt gallery placement</legend>
      {!availableExternalCollections.length
        ? <small>No active DeviantArt gallery folders are available for this account.</small>
        : availableExternalCollections.map((collection) => <label className="studio-work-metadata-option" key={collection.externalCollectionId}>
          <input
            type="checkbox"
            checked={integrationCollectionIds.includes(collection.externalCollectionExternalId)}
            onChange={(event) => setIntegrationCollectionIds((current) => event.target.checked
              ? [...new Set([...current, collection.externalCollectionExternalId])]
              : current.filter((collectionId) => collectionId !== collection.externalCollectionExternalId))}
          />
          <span>{collection.name}{typeof collection.remoteSize === 'number' ? ` (${collection.remoteSize})` : ''}</span>
        </label>)}
      <small>Gallery placement is applied through DeviantArt’s published-deviation edit API and verified after saving.</small>
    </fieldset>
    {(integration.metadataSyncStatus === 'conflict' || integration.metadataSyncStatus === 'remote_changed') && <div className="studio-work-metadata-warning">
      <p>{integration.metadataSyncStatus === 'conflict'
        ? `Both ${brand.productName} and DeviantArt changed this destination. Choose the version that should win.`
        : 'DeviantArt metadata changed since the previous synchronization. Choose whether to keep the remote version or replace it with the local version.'}</p>
      <div className="studio-inline-actions">
        <button type="button" className="auth-secondary-btn" disabled={destinationBusy} onClick={() => void resolveDestination('pull')}>Pull DeviantArt changes</button>
        <button type="button" className="auth-secondary-btn" disabled={destinationBusy} onClick={() => void resolveDestination('push')}>Use {brand.productName} version</button>
      </div>
    </div>}
    {integration.metadataSyncStatus === 'local_update_pending' && <p className="small">A {brand.productName} metadata update is queued or waiting for DeviantArt verification.</p>}
    {integration.syncStatus !== 'active' && integration.remoteStateReason && <p className="studio-work-metadata-warning">{integration.remoteStateReason}</p>}
    <label className="studio-work-metadata-option">
      <input type="checkbox" checked={allowComments} onChange={(event) => setAllowComments(event.target.checked)} />
      <span>Allow comments on {integrationLabel}</span>
    </label>
    <label className="studio-work-metadata-option">
      <input type="checkbox" checked={isMature} onChange={(event) => setIsMature(event.target.checked)} />
      <span>Mature content</span>
    </label>
    {isMature && <>
      <label>
        <span>Mature level</span>
        <select value={matureLevel} onChange={(event) => setMatureLevel(event.target.value as 'strict' | 'moderate')}>
          <option value="moderate">Moderate</option>
          <option value="strict">Strict</option>
        </select>
      </label>
      <label>
        <span>Mature classifications</span>
        <input value={matureClassification.join(', ')} onChange={(event) => setMatureClassification(event.target.value.split(','))} placeholder="nudity, sexual, gore, language, ideology" />
      </label>
    </>}
    <label>
      <span>Made with AI</span>
      <select value={isAiGenerated === undefined ? 'unknown' : String(isAiGenerated)} onChange={(event) => setIsAiGenerated(event.target.value === 'unknown' ? undefined : event.target.value === 'true')}>
        {!reportsAiGenerated && <option value="unknown">Not reported by DeviantArt — leave unchanged</option>}
        <option value="true">Yes — made with AI</option>
        <option value="false">No — not made with AI</option>
      </select>
    </label>
    <label>
      <span>No AI training</span>
      <select value={noAi === undefined ? 'unknown' : String(noAi)} onChange={(event) => setNoAi(event.target.value === 'unknown' ? undefined : event.target.value === 'true')}>
        {!reportsNoAi && <option value="unknown">Not reported by DeviantArt — leave unchanged</option>}
        <option value="true">Enabled — prohibit third-party AI datasets</option>
        <option value="false">Disabled — allow third-party AI datasets</option>
      </select>
    </label>
    {(!reportsAiGenerated || !reportsNoAi) && integration?.syncStatus === 'active' && <small className="studio-work-metadata-unknown">DeviantArt’s public read API may omit these AI label values. {brand.productName} preserves values it has written; for an imported deviation, select an explicit value to set it on the next save.</small>}
    <small>{canUpdatePublishedDescription
      ? usesStashPublishedDescriptionUpdate
        ? `Description changes use the retained DeviantArt Sta.sh item. ${brand.productName} reads the deviation back before marking the update synchronized.`
        : `Changes to supported metadata, including the description, are submitted to ${integrationLabel} when you save.`
      : `Supported fields such as title, tags, display options, mature status, and AI settings are submitted to ${integrationLabel}. DeviantArt does not permit API updates to a published deviation’s description.`}</small>
  </>;

  return (
    <section className="studio-work-metadata-layout">
      <Card
        title="Edit work metadata"
        eyebrow={`Works / ${creatorName}`}
        actions={<button type="button" className="auth-secondary-btn" onClick={backToWorks}>Back to Works</button>}
      >
        {loading && <p className="small">Loading work metadata…</p>}
        {error && <p className="error">{error}</p>}
        {!loading && asset && <div className="studio-work-metadata-editor">
          <div className="studio-work-metadata-heading">
            <div>
              <h4>{asset.canonicalTitle || sourceTitle || 'Untitled work'}</h4>
              <p>{integration ? `Destination settings for ${integrationLabel}${integration.externalUsername ? ` · ${integration.externalUsername}` : ''}` : `Stored in ${brand.workspaceFullName}`}</p>
            </div>
            <span className="studio-collection-visibility">{asset.visibility}</span>
          </div>

          <section className="studio-work-destinations">
            <div className="studio-work-destinations-heading">
              <div>
                <p className="studio-work-metadata-field-heading">Destinations</p>
                <p>Keep this work in {brand.workspaceFullName}, then add a platform only when you are ready to prepare and sync it.</p>
              </div>
              {availableDestinationAccounts.length > 0 && <div className="studio-work-destination-add">
                <select value={newDestinationAccountId} disabled={destinationBusy} onChange={(event) => setNewDestinationAccountId(event.target.value)} aria-label="Add DeviantArt destination">
                  <option value="">Add DeviantArt destination…</option>
                  {availableDestinationAccounts.map((account) => (
                    <option key={account.externalAccountId} value={account.externalAccountId}>DeviantArt · {account.externalUsername}</option>
                  ))}
                </select>
                <select value={newDestinationTargetStatus} disabled={destinationBusy} onChange={(event) => setNewDestinationTargetStatus(event.target.value as 'draft' | 'published')} aria-label="DeviantArt destination status">
                  <option value="published">Published (default)</option>
                  <option value="draft">Draft in Sta.sh</option>
                </select>
                <button type="button" className="auth-secondary-btn" disabled={destinationBusy || !newDestinationAccountId} onClick={() => void addDestination()}>Prepare destination</button>
              </div>}
            </div>
            {!availableDestinationAccounts.length && !accounts.length && <div className="studio-work-destination-unavailable">
              <span>No connected DeviantArt account is assigned to this creator.</span>
              <Link className="auth-secondary-btn no-underline" to={`/studio/workspace?section=integrations&creatorId=${encodeURIComponent(creatorId)}`}>Manage DeviantArt connections</Link>
            </div>}
            {!availableDestinationAccounts.length && accounts.length > 0 && destinations.length > 0 && <p className="small studio-work-destination-complete">Every connected DeviantArt account for this creator is already represented below.</p>}
            {destinations.length ? <div className="studio-work-destination-list">
              {destinations.map((publication) => <article key={publication.externalPublicationId} className={`studio-work-destination-row${publication.externalPublicationId === integration?.externalPublicationId ? ' studio-work-destination-row-active' : ''}`}>
                <button type="button" className="studio-work-destination-select" onClick={() => selectDestination(publication)}>
                  <strong>{sourceLabel(publication)} · {publication.externalUsername}</strong>
                  <span>{publication.syncStatus === 'pending_publish' ? (publication.targetStatus === 'draft' ? 'Ready to save in Sta.sh' : 'Ready to publish') : publication.syncStatus === 'draft' ? 'Draft in Sta.sh' : publication.syncStatus === 'active' ? 'Published' : publication.syncStatus}</span>
                </button>
                <div className="studio-work-destination-actions">
                  {(publication.syncStatus === 'pending_publish' || publication.syncStatus === 'draft') && <select
                    value={publication.targetStatus || (publication.syncStatus === 'draft' ? 'draft' : 'published')}
                    disabled={destinationBusy}
                    aria-label={`${sourceLabel(publication)} destination status`}
                    onChange={(event) => void updateDestinationTargetStatus(publication, event.target.value as 'draft' | 'published')}
                  >
                    <option value="published">Published</option>
                    <option value="draft">Draft in Sta.sh</option>
                  </select>}
                  {(publication.syncStatus === 'pending_publish' || publication.syncStatus === 'draft') && <button type="button" className="auth-primary-btn" disabled={destinationBusy} onClick={() => void syncDestination(publication)}>{(publication.targetStatus || (publication.syncStatus === 'draft' ? 'draft' : 'published')) === 'draft' ? 'Save to Sta.sh' : 'Publish to DeviantArt'}</button>}
                  <button type="button" className="auth-secondary-btn" disabled={destinationBusy} onClick={() => void removeDestination(publication)}>{publication.syncStatus === 'active' ? 'Unpublish…' : 'Remove destination'}</button>
                </div>
              </article>)}
            </div> : <p className="small">No destinations yet. {accounts.length ? 'Choose the DeviantArt account above to prepare this work for synchronization.' : `You can continue editing the ${brand.productName} metadata while you manage the creator’s connected platforms.`}</p>}
          </section>

          <section className="studio-work-space-controls">
            <div>
              <p className="studio-work-metadata-field-heading">{brand.workspaceFullName}</p>
              <p>Space publication and network discovery are separate choices.</p>
            </div>
            <label className="studio-work-metadata-option">
              <input
                type="checkbox"
                checked={asset.spacePublication?.published || false}
                disabled={spaceBusy}
                onChange={(event) => void updateSpacePublication(event.target.checked, asset.spacePublication?.visibility || 'private')}
              />
              <span>Publish this work to {brand.workspaceFullName}</span>
            </label>
            <label>
              <span>Space visibility</span>
              <select
                value={asset.spacePublication?.visibility || 'private'}
                disabled={spaceBusy || !asset.spacePublication?.published}
                onChange={(event) => void updateSpacePublication(true, event.target.value as 'private' | 'unlisted' | 'public')}
              >
                <option value="private">Private — creator and managers only</option>
                <option value="unlisted">Unlisted — direct URL only</option>
                <option value="public">Space-visible — listed publicly</option>
              </select>
            </label>
            <label>
              <span>Discovery participation</span>
              <select
                value={asset.discoveryState || 'none'}
                disabled={spaceBusy || asset.discoveryState === 'removed'}
                onChange={(event) => void updateDiscovery(event.target.value as 'none' | 'eligible' | 'opted_in')}
              >
                <option value="none">Not participating</option>
                <option value="eligible">Eligible, not opted in</option>
                <option value="opted_in" disabled={!asset.spacePublication?.published || asset.spacePublication.visibility !== 'public'}>Opted into discovery</option>
                {asset.discoveryState === 'removed' && <option value="removed">Removed by moderation</option>}
              </select>
              <small>Publishing publicly to your Space never opts this work into discovery automatically.</small>
            </label>
          </section>

          {canLink && <label className="studio-work-metadata-link">
            <input type="checkbox" checked={linked} onChange={(event) => handleLinkChange(event.target.checked)} />
            <span>
              <strong>Keep shared metadata combined with connected integrations</strong>
              <small>When enabled, edits are shared with compatible integration fields. Fields that a destination cannot update remain independent in {brand.productName}.</small>
            </span>
          </label>}

          {linked && canLink ? <div className="studio-work-metadata-fields">
            <section>
              <p className="studio-work-metadata-field-heading">Shared metadata</p>
              <label>
                <span>Title</span>
                <input value={title} onChange={(event) => setTitle(event.target.value)} maxLength={300} />
              </label>
              <BlockEditor
                label="Description"
                value={descriptionBlocks}
                onChange={setDescriptionBlocks}
                helpText={canUpdatePublishedDescription
                  ? usesStashPublishedDescriptionUpdate
                    ? 'Use portable blocks and formatting. DeviantArt description changes use the retained Sta.sh item and are verified after writing.'
                    : 'Use portable blocks and formatting. Compatible content is shared with connected destinations when you save.'
                  : `This description is saved in ${brand.productName}. DeviantArt does not expose description editing for an already-published deviation through its API.`}
              />
            </section>
            <section className="studio-work-metadata-source-fields">
              <p className="studio-work-metadata-field-heading">Connected integration metadata</p>
              {integrationControls}
            </section>
          </div> : <div className="studio-work-metadata-fields">
            <section>
              <p className="studio-work-metadata-field-heading">{brand.productName} metadata</p>
              <label>
                <span>Title</span>
                <input value={title} onChange={(event) => setTitle(event.target.value)} maxLength={300} />
              </label>
              <BlockEditor
                label="Description"
                value={descriptionBlocks}
                onChange={setDescriptionBlocks}
                helpText={`This is ${brand.productName}’s portable block document. It can also be reused by posts and future destinations.`}
              />
            </section>
            {integration && <section className="studio-work-metadata-source-fields">
              <p className="studio-work-metadata-field-heading">{integrationLabel} metadata</p>
              <label>
                <span>{integrationLabel} title</span>
                <input value={integrationTitle} onChange={(event) => setIntegrationTitle(event.target.value)} maxLength={300} />
              </label>
              <BlockEditor
                label={`${integrationLabel} description`}
                value={integrationDescriptionBlocks}
                onChange={setIntegrationDescriptionBlocks}
                readOnly={!canUpdatePublishedDescription}
                helpText={canUpdatePublishedDescription
                  ? usesStashPublishedDescriptionUpdate
                    ? `Only supported blocks and formatting are submitted through the retained DeviantArt Sta.sh item, then verified against the published deviation.`
                    : `Only blocks and formatting supported by ${integrationLabel} are included when this destination syncs.`
                  : `Read-only value from ${integrationLabel}. DeviantArt does not expose published-description editing through its API.`}
              />
              {integrationControls}
            </section>}
          </div>}

          <div className="studio-work-metadata-footer">
            <button type="button" className="auth-primary-btn" disabled={saving || remoteUpdateJobs.length > 0} onClick={() => void save()}>{saving ? 'Saving…' : remoteUpdateJobs.length ? 'Verifying…' : 'Save metadata'}</button>
            <Link className="auth-secondary-btn no-underline" to={`/studio/workspace?section=works&creatorId=${encodeURIComponent(creatorId)}${collectionId ? `&collectionId=${encodeURIComponent(collectionId)}` : ''}`}>Cancel</Link>
          </div>
          {success && <p className="studio-work-metadata-success">{success}</p>}
          {(metadataWarning || !canUpdatePublishedDescription) && <p className="studio-work-metadata-warning">{metadataWarning || `This published DeviantArt work predates retained Sta.sh identifiers. Its ${brand.productName} description remains editable, but cannot be synchronized back automatically.`}</p>}
        </div>}
      </Card>
    </section>
  );
}
