import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { api, type AnnouncementPresetId } from '../../api';
import { brand } from '../../brand';
import { Card } from '../components/Card';
import { WorkMetadataView } from './WorkMetadataView';
import { WorkActivityView } from './WorkActivityView';
import { WorkUploadView } from './WorkUploadView';
import { worksWorkspacePath } from '../workListNavigation';
import type {
  StudioCreator,
  StudioDeviantArtAccount,
  StudioExternalAsset,
  StudioExternalCollection,
  StudioExternalCollectionMapping,
  StudioUbeeqCollection
} from '../types';

type CollectionResponse = {
  ubeeqCollections: StudioUbeeqCollection[];
  externalCollections: StudioExternalCollection[];
  mappings: StudioExternalCollectionMapping[];
  collectionAssetIdsByCollection: Record<string, string[]>;
};

type WorkLifecycle = 'draft' | 'ready' | 'archived';
type PlatformFilter = 'all' | 'published_anywhere' | 'published_nowhere' | 'unpublished_unqueued' | 'unpublished_images' | 'deviantart_live' | 'eversally_live' | 'out_of_sync' | 'error';
type WorkSort = 'name_asc' | 'name_desc' | 'updated_desc';
const worksPageSizes = [12, 24, 48, 100] as const;
const platformFilters: PlatformFilter[] = ['all', 'published_anywhere', 'published_nowhere', 'unpublished_unqueued', 'unpublished_images', 'deviantart_live', 'eversally_live', 'out_of_sync', 'error'];
const workSorts: WorkSort[] = ['name_asc', 'name_desc', 'updated_desc'];
const deviantArtDisplayWidths = [400, 600, 800, 900, 1024, 1280, 1600, 1920];
type MatureClassification = 'nudity' | 'sexual' | 'gore' | 'language' | 'ideology';
const matureClassificationOptions: Array<{ value: MatureClassification; label: string }> = [
  { value: 'nudity', label: 'Nudity' },
  { value: 'sexual', label: 'Sexual themes' },
  { value: 'gore', label: 'Gore' },
  { value: 'language', label: 'Strong language' },
  { value: 'ideology', label: 'Ideology' }
];

const announcementPresetOptions: Array<{ id: AnnouncementPresetId; label: string }> = [
  { id: 'recommended', label: 'Recommended — match the Work type' },
  { id: 'image_showcase', label: 'Image showcase' },
  { id: 'writing_release', label: 'Post or story' },
  { id: 'video_premiere', label: 'Video premiere' },
  { id: 'audio_release', label: 'Audio release' },
  { id: 'compact_link', label: 'Compact link' },
  { id: 'text_only', label: 'Text only' },
  { id: 'collection_digest', label: 'Collection digest' },
  { id: 'series_digest', label: 'Series digest' }
];

const destinationStatusLabel = (status: StudioExternalAsset['destinationPublications'][number]['status']): string => ({
  live: 'Published', draft: 'Draft / staged', scheduled: 'Scheduled', queued: 'Queued', publishing: 'Publishing', updating: 'Updating', failed: 'Error', missing: 'Missing remotely', removed: 'Removed', unknown: 'Unknown'
})[status];
const engagementNumber = (value: number): string => new Intl.NumberFormat().format(value);

const sourcePlatformLabel = (publication: StudioExternalAsset['publications'][number]): string => publication.platform === 'deviantart' ? 'DeviantArt' : (publication.platform || 'Integration');

const assetTypeLabel = (asset: StudioExternalAsset): string => {
  if (asset.assetType === 'image') return 'Image';
  if (asset.assetType === 'literature') return 'Literature';
  if (asset.assetType === 'video') return 'Video';
  if (asset.assetType === 'animation') return 'Animation';
  return asset.publications.length ? 'Imported DeviantArt work' : `${brand.productName} work`;
};

function WorkThumbnail({ asset }: { asset: StudioExternalAsset }) {
  const eversallyPublished = asset.destinationPublications.some((publication) => (
    publication.destination === 'eversally' && publication.status === 'live' && publication.visibility !== 'private'
  ));
  // Once a work is public in Eversally, do not fall back to a remote DA
  // preview. That URL can disappear when the DA account is disconnected and
  // would make the hosted catalogue appear to depend on DA.
  const deviantArtThumbnailUrl = eversallyPublished
    ? undefined
    : asset.publications.find((publication) => publication.previewUrl)?.previewUrl;
  const [url, setUrl] = useState(asset.thumbnailUrl || deviantArtThumbnailUrl);

  useEffect(() => {
    setUrl(asset.thumbnailUrl || deviantArtThumbnailUrl);
  }, [asset.thumbnailUrl, deviantArtThumbnailUrl]);

  const handleLoadError = () => {
    setUrl((currentUrl) => currentUrl === asset.thumbnailUrl && !eversallyPublished ? deviantArtThumbnailUrl : undefined);
  };

  return (
    <div className="studio-work-thumbnail" aria-hidden="true">
      <span>{assetTypeLabel(asset).slice(0, 1)}</span>
      <small className="studio-work-thumbnail-id">{(asset.canonicalSlug || asset.assetId).slice(0, 12)}</small>
      {url && <img src={url} alt="" onError={handleLoadError} />}
    </div>
  );
}

export function WorksView({ creators }: { creators: StudioCreator[] }) {
  const location = useLocation();
  const workId = new URLSearchParams(location.search).get('workId');
  const workTab = new URLSearchParams(location.search).get('tab');
  const create = new URLSearchParams(location.search).get('create') === '1';
  if (workId && workTab === 'activity') return <WorkActivityView creators={creators} />;
  if (workId) return <WorkMetadataView creators={creators} />;
  if (create) return <WorkUploadView creators={creators} />;
  return <WorksIndex creators={creators} />;
}

function WorksIndex({ creators }: { creators: StudioCreator[] }) {
  const location = useLocation();
  const navigate = useNavigate();
  const routeParams = useMemo(() => new URLSearchParams(location.search), [location.search]);
  const requestedCreatorId = routeParams.get('creatorId') || '';
  const requestedCollectionId = routeParams.get('collectionId') || '';
  const requestedStatus = routeParams.get('status');
  const requestedPlatformFilter = routeParams.get('platformState') as PlatformFilter | null;
  const requestedPlatformAccountId = routeParams.get('platformAccount') || '';
  const requestedSort = routeParams.get('sort') as WorkSort | null;
  const requestedPage = Number.parseInt(routeParams.get('page') || '', 10);
  const requestedPageSize = Number.parseInt(routeParams.get('perPage') || '', 10);
  const [creatorId, setCreatorId] = useState('');
  const [collectionId, setCollectionId] = useState(requestedCollectionId);
  const [query, setQuery] = useState(routeParams.get('q') || '');
  const [lifecycle, setLifecycle] = useState<'all' | WorkLifecycle>(requestedStatus === 'draft' || requestedStatus === 'ready' || requestedStatus === 'archived' ? requestedStatus : 'all');
  const [platformFilter, setPlatformFilter] = useState<PlatformFilter>(requestedPlatformFilter && platformFilters.includes(requestedPlatformFilter) ? requestedPlatformFilter : 'all');
  const [platformAccountId, setPlatformAccountId] = useState(requestedPlatformAccountId);
  const [sort, setSort] = useState<WorkSort>(requestedSort && workSorts.includes(requestedSort) ? requestedSort : 'name_asc');
  const [page, setPage] = useState(Number.isInteger(requestedPage) && requestedPage > 0 ? requestedPage : 1);
  const [pageSize, setPageSize] = useState<number>(worksPageSizes.includes(requestedPageSize as typeof worksPageSizes[number]) ? requestedPageSize : 24);
  const [shownPlatforms, setShownPlatforms] = useState({
    eversally: routeParams.get('showSpace') !== '0',
    deviantart: routeParams.get('showDeviantArt') !== '0'
  });
  const [assets, setAssets] = useState<StudioExternalAsset[]>([]);
  const [catalogueLoaded, setCatalogueLoaded] = useState(false);
  const [accounts, setAccounts] = useState<StudioDeviantArtAccount[]>([]);
  const [collections, setCollections] = useState<CollectionResponse>({ ubeeqCollections: [], externalCollections: [], mappings: [], collectionAssetIdsByCollection: {} });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [updatingAssetId, setUpdatingAssetId] = useState('');
  const [selectedWorkAssetIds, setSelectedWorkAssetIds] = useState<string[]>([]);
  const [bulkCollectionId, setBulkCollectionId] = useState('');
  const [bulkUpdating, setBulkUpdating] = useState(false);
  const [collectionPickerAssetId, setCollectionPickerAssetId] = useState('');
  const [collectionPickerQuery, setCollectionPickerQuery] = useState('');
  const [destinationAccountByAsset, setDestinationAccountByAsset] = useState<Record<string, string>>({});
  const [destinationStatusByAsset, setDestinationStatusByAsset] = useState<Record<string, 'draft' | 'published'>>({});
  const [destinationUpdatingAssetId, setDestinationUpdatingAssetId] = useState('');
  const [destinationMessageByAsset, setDestinationMessageByAsset] = useState<Record<string, string>>({});
  const [bulkDestinationAccountId, setBulkDestinationAccountId] = useState('');
  const [bulkDestinationStatus, setBulkDestinationStatus] = useState<'draft' | 'published'>('published');
  const [bulkDaDisplayResolution, setBulkDaDisplayResolution] = useState('');
  const [bulkDaAllowFreeDownload, setBulkDaAllowFreeDownload] = useState(false);
  const [bulkDaAddWatermark, setBulkDaAddWatermark] = useState(false);
  const [bulkDaTags, setBulkDaTags] = useState('');
  const [bulkDaGalleryIds, setBulkDaGalleryIds] = useState<string[]>([]);
  const [bulkDaIsMature, setBulkDaIsMature] = useState(false);
  const [bulkDaMatureLevel, setBulkDaMatureLevel] = useState<'strict' | 'moderate'>('moderate');
  const [bulkDaMatureClassification, setBulkDaMatureClassification] = useState<MatureClassification[]>([]);
  const [bulkDaIsAiGenerated, setBulkDaIsAiGenerated] = useState(false);
  const [bulkDaNoAi, setBulkDaNoAi] = useState(false);
  const [bulkDaAllowComments, setBulkDaAllowComments] = useState(true);
  const [bulkDaApplyTitle, setBulkDaApplyTitle] = useState(false);
  const [bulkDaApplyTags, setBulkDaApplyTags] = useState(false);
  const [bulkDaApplyGalleries, setBulkDaApplyGalleries] = useState(false);
  const [bulkDaApplyComments, setBulkDaApplyComments] = useState(false);
  const [bulkDaApplyDisplay, setBulkDaApplyDisplay] = useState(false);
  const [bulkDaApplyMature, setBulkDaApplyMature] = useState(false);
  const [bulkDaApplyAiGenerated, setBulkDaApplyAiGenerated] = useState(false);
  const [bulkDaApplyNoAi, setBulkDaApplyNoAi] = useState(false);
  const [bulkDaEditing, setBulkDaEditing] = useState(false);
  const [bulkDaEditMessage, setBulkDaEditMessage] = useState('');
  const [bulkPresetSaving, setBulkPresetSaving] = useState(false);
  const [bulkSpaceIntent, setBulkSpaceIntent] = useState(false);
  const [bulkSpaceVisibility, setBulkSpaceVisibility] = useState<'private' | 'unlisted' | 'public'>('private');
  const [bulkDeviantArtIntent, setBulkDeviantArtIntent] = useState(true);
  const [bulkDestinationUpdating, setBulkDestinationUpdating] = useState(false);
  const [bulkDestinationMessage, setBulkDestinationMessage] = useState('');
  const [bulkReviewOpen, setBulkReviewOpen] = useState(false);
  const [bulkReviewPlatform, setBulkReviewPlatform] = useState<'eversally' | 'deviantart' | 'bluesky' | 'discord'>('deviantart');
  const [bulkDiscordAnnouncementMode, setBulkDiscordAnnouncementMode] = useState<'default' | 'per_work' | 'digest' | 'none'>('default');
  const [bulkDiscordAnnouncementPreset, setBulkDiscordAnnouncementPreset] = useState<AnnouncementPresetId>('recommended');
  const [bulkDiscordIncludePrimaryMedia, setBulkDiscordIncludePrimaryMedia] = useState(true);
  const [bulkPublishing, setBulkPublishing] = useState(false);
  const [bulkPublishMessage, setBulkPublishMessage] = useState('');
  const appliedRouteCollectionFilter = useRef('');

  const activeCreator = useMemo(() => creators.find((creator) => creator.creatorId === creatorId), [creatorId, creators]);
  const selectedCollection = useMemo(
    () => collections.ubeeqCollections.find((collection) => collection.ubeeqCollectionId === collectionId),
    [collectionId, collections.ubeeqCollections]
  );
  const load = async (nextCreatorId = creatorId) => {
    if (!nextCreatorId) return;
    setLoading(true);
    setError('');
    try {
      const [catalogue, nextCollections, nextAccounts] = await Promise.all([
        api.studioListWorks(nextCreatorId),
        api.studioListDeviantArtCollections(nextCreatorId),
        api.studioListDeviantArtAccounts(nextCreatorId)
      ]);
      setAssets(((catalogue as { items?: StudioExternalAsset[] }).items || []));
      setCatalogueLoaded(true);
      setCollections(nextCollections as CollectionResponse);
      const queueableAccounts = ((nextAccounts || []) as StudioDeviantArtAccount[]).filter((account) => (
        account.connectionStatus === 'connected'
        || account.connectionStatus === 'rate_limited'
        || account.connectionStatus === 'temporarily_unavailable'
      ));
      setAccounts(queueableAccounts);
      setBulkDeviantArtIntent(queueableAccounts.length > 0);
      setBulkDestinationAccountId((current) => (
        queueableAccounts.some((account) => account.externalAccountId === current)
          ? current
          : queueableAccounts.length === 1 ? queueableAccounts[0].externalAccountId : ''
      ));
    } catch (loadError) {
      setCatalogueLoaded(true);
      setError(loadError instanceof Error ? loadError.message : 'Unable to load works for this creator.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (!creators.length) return;
    const nextCreatorId = creators.some((creator) => creator.creatorId === requestedCreatorId)
      ? requestedCreatorId
      : creators[0].creatorId;
    setCreatorId((current) => current === nextCreatorId ? current : nextCreatorId);
  }, [creators, requestedCreatorId]);

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [creatorId]);

  useEffect(() => {
    const selectedAccountId = bulkDestinationAccountId || (accounts.length === 1 ? accounts[0]?.externalAccountId : '');
    const preset = accounts.find((account) => account.externalAccountId === selectedAccountId)?.deviantArtPublishingPreset;
    if (!preset) return;
    setBulkDestinationStatus(preset.targetStatus || 'published');
    setBulkDaDisplayResolution(preset.displayResolution ? String(preset.displayResolution) : '');
    setBulkDaAllowFreeDownload(preset.allowFreeDownload === true);
    setBulkDaAddWatermark(preset.addWatermark === true && Boolean(preset.displayResolution));
    setBulkDaTags((preset.defaultTags || []).join(', '));
    setBulkDaGalleryIds(preset.galleryExternalCollectionIds || []);
    setBulkDaIsMature(preset.isMature === true);
    setBulkDaMatureLevel(preset.matureLevel || 'moderate');
    setBulkDaMatureClassification(preset.matureClassification || []);
    setBulkDaIsAiGenerated(preset.isAiGenerated === true);
    setBulkDaNoAi(preset.noAi === true);
  }, [accounts, bulkDestinationAccountId]);

  useEffect(() => {
    if (!platformAccountId || !accounts.length) return;
    if (!accounts.some((account) => account.externalAccountId === platformAccountId)) setPlatformAccountId('');
  }, [accounts, platformAccountId]);

  useEffect(() => {
    if (!collections.ubeeqCollections.length) return;
    const routeFilterKey = `${requestedCreatorId}:${requestedCollectionId}`;
    if (appliedRouteCollectionFilter.current === routeFilterKey) return;
    if (requestedCollectionId && collections.ubeeqCollections.some((collection) => collection.ubeeqCollectionId === requestedCollectionId)) {
      setCollectionId(requestedCollectionId);
    } else if (requestedCollectionId) {
      setCollectionId('');
    }
    appliedRouteCollectionFilter.current = routeFilterKey;
  }, [collections.ubeeqCollections, requestedCollectionId, requestedCreatorId]);

  const mappedExternalCollectionIds = useMemo(() => {
    if (!collectionId) return new Set<string>();
    const mappedIds = new Set(
      collections.mappings
        .filter((mapping) => mapping.ubeeqCollectionId === collectionId)
        .map((mapping) => mapping.externalCollectionId)
    );
    return new Set(
      collections.externalCollections
        .filter((collection) => mappedIds.has(collection.externalCollectionId))
        .map((collection) => collection.externalCollectionExternalId)
    );
  }, [collectionId, collections.externalCollections, collections.mappings]);

  const manuallyAssignedAssetIds = useMemo(
    () => new Set(collections.collectionAssetIdsByCollection[collectionId] || []),
    [collectionId, collections.collectionAssetIdsByCollection]
  );

  const visibleAssets = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    return assets.filter((asset) => {
      const inCollection = !collectionId || asset.publications.some((publication) => (
        publication.externalCollectionIds.some((externalCollectionId) => mappedExternalCollectionIds.has(externalCollectionId))
      )) || manuallyAssignedAssetIds.has(asset.assetId);
      if (!inCollection) return false;
      if (lifecycle !== 'all' && asset.workStatus !== lifecycle) return false;
      const hasSpaceDestination = asset.destinationPublications.some((publication) => publication.destination === 'eversally' && publication.status !== 'removed')
        || asset.publicationIntents.some((intent) => intent.destination === 'eversally' && intent.enabled);
      const hasDeviantArtDestination = asset.publications.some((publication) => publication.platform === 'deviantart' && publication.syncStatus !== 'deleted')
        || asset.destinationPublications.some((publication) => publication.destination === 'deviantart' && publication.status !== 'removed')
        || asset.publicationIntents.some((intent) => intent.destination === 'deviantart' && intent.enabled);
      if (!shownPlatforms.eversally && !hasDeviantArtDestination) return false;
      if (!shownPlatforms.deviantart && !hasSpaceDestination) return false;
      if (platformAccountId && !(
        asset.origin.integrationAccountId === platformAccountId
        || asset.publications.some((publication) => publication.externalAccountId === platformAccountId)
        || asset.destinationPublications.some((publication) => publication.integrationAccountId === platformAccountId)
        || asset.publicationIntents.some((intent) => intent.integrationAccountId === platformAccountId)
      )) return false;
      const current = asset.destinationPublications.filter((publication) => publication.status !== 'removed');
      const hasLivePublication = current.some((publication) => publication.status === 'live');
      const hasActiveQueue = current.some((publication) => (
        (publication.status === 'scheduled' || publication.status === 'queued' || publication.status === 'publishing' || publication.status === 'updating')
        && publication.syncStatus !== 'error'
      ));
      if (platformFilter === 'published_anywhere' && !current.some((publication) => publication.status === 'live')) return false;
      if (platformFilter === 'published_nowhere' && current.some((publication) => publication.status === 'live')) return false;
      if (platformFilter === 'unpublished_unqueued' && (
        asset.workStatus === 'archived'
        || asset.workStatus === 'deleted'
        || hasLivePublication
        || hasActiveQueue
      )) return false;
      if (platformFilter === 'unpublished_images' && (
        asset.assetType !== 'image'
        || asset.workStatus === 'archived'
        || asset.workStatus === 'deleted'
        || current.some((publication) => publication.status === 'live')
      )) return false;
      if (platformFilter === 'deviantart_live' && !current.some((publication) => publication.destination === 'deviantart' && publication.status === 'live')) return false;
      if (platformFilter === 'eversally_live' && !current.some((publication) => publication.destination === 'eversally' && publication.status === 'live')) return false;
      if (platformFilter === 'out_of_sync' && !current.some((publication) => publication.syncStatus === 'local_newer' || publication.syncStatus === 'remote_newer' || publication.syncStatus === 'conflict')) return false;
      if (platformFilter === 'error' && !current.some((publication) => publication.status === 'failed' || publication.syncStatus === 'error')) return false;
      if (!normalizedQuery) return true;
      return [asset.canonicalTitle || '', asset.canonicalDescription || '', ...asset.publications.flatMap((publication) => [publication.externalTitle || '', ...publication.externalTags])]
        .some((value) => value.toLowerCase().includes(normalizedQuery));
    });
  }, [assets, collectionId, lifecycle, manuallyAssignedAssetIds, mappedExternalCollectionIds, platformAccountId, platformFilter, query, shownPlatforms.deviantart, shownPlatforms.eversally]);
  const sortedAssets = useMemo(() => [...visibleAssets]
    .sort((left, right) => {
      if (sort === 'updated_desc') return right.updatedAt.localeCompare(left.updatedAt);
      const leftTitle = left.canonicalTitle || left.publications[0]?.externalTitle || '';
      const rightTitle = right.canonicalTitle || right.publications[0]?.externalTitle || '';
      const comparison = leftTitle.localeCompare(rightTitle, undefined, { numeric: true, sensitivity: 'base' });
      return sort === 'name_desc' ? -comparison : comparison;
    }), [sort, visibleAssets]);
  const pageCount = Math.max(1, Math.ceil(sortedAssets.length / pageSize));
  const currentPage = catalogueLoaded ? Math.min(page, pageCount) : page;
  const pageStart = (currentPage - 1) * pageSize;
  const displayedAssets = useMemo(
    () => sortedAssets.slice(pageStart, pageStart + pageSize),
    [pageSize, pageStart, sortedAssets]
  );
  const displayedAssetIds = useMemo(() => new Set(displayedAssets.map((asset) => asset.assetId)), [displayedAssets]);
  const selectedDisplayedAssetIds = useMemo(
    () => selectedWorkAssetIds.filter((assetId) => displayedAssetIds.has(assetId)),
    [displayedAssetIds, selectedWorkAssetIds]
  );
  const selectedBulkAccountId = bulkDestinationAccountId || (accounts.length === 1 ? accounts[0]?.externalAccountId : '');
  const bulkAccountGalleries = useMemo(
    () => collections.externalCollections.filter((collection) => collection.externalAccountId === selectedBulkAccountId && collection.syncStatus !== 'missing'),
    [collections.externalCollections, selectedBulkAccountId]
  );
  const selectedDeviantArtOriginWorks = useMemo(() => displayedAssets.flatMap((asset) => {
    if (!selectedDisplayedAssetIds.includes(asset.assetId) || asset.origin.type !== 'import' || asset.origin.platform !== 'deviantart') return [];
    const publication = asset.publications.find((item) => (
      item.platform === 'deviantart'
      && item.externalAccountId === selectedBulkAccountId
      && (item.syncStatus === 'active' || item.syncStatus === 'draft' || item.syncStatus === 'pending_publish')
    ));
    return publication ? [{ asset, publication }] : [];
  }), [displayedAssets, selectedBulkAccountId, selectedDisplayedAssetIds]);
  const hasBulkDeviantArtEditFields = bulkDaApplyTitle
    || bulkDaApplyTags
    || bulkDaApplyGalleries
    || bulkDaApplyComments
    || bulkDaApplyDisplay
    || bulkDaApplyMature
    || bulkDaApplyAiGenerated
    || bulkDaApplyNoAi;

  const bulkDeviantArtOptions = () => {
    const parsedDisplayResolution = Number.parseInt(bulkDaDisplayResolution, 10);
    return {
      tags: [...new Set(bulkDaTags.split(',').map((tag) => tag.trim()).filter(Boolean))],
      galleryExternalCollectionIds: bulkDaGalleryIds,
      displayResolution: Number.isInteger(parsedDisplayResolution) && parsedDisplayResolution > 0 ? parsedDisplayResolution : null,
      allowFreeDownload: bulkDaAllowFreeDownload,
      addWatermark: Boolean(Number.isInteger(parsedDisplayResolution) && parsedDisplayResolution > 0 && bulkDaAddWatermark),
      isMature: bulkDaIsMature,
      matureLevel: bulkDaMatureLevel,
      matureClassification: bulkDaIsMature ? bulkDaMatureClassification : [],
      isAiGenerated: bulkDaIsAiGenerated,
      noAi: bulkDaNoAi
    };
  };

  useEffect(() => {
    setSelectedWorkAssetIds((current) => current.filter((assetId) => displayedAssetIds.has(assetId)));
  }, [displayedAssetIds]);

  useEffect(() => {
    if (!catalogueLoaded) return;
    setPage((current) => Math.min(current, pageCount));
  }, [catalogueLoaded, pageCount]);

  const worksListParams = useMemo(() => {
    const params = new URLSearchParams();
    params.set('section', 'works');
    if (creatorId) params.set('creatorId', creatorId);
    if (collectionId) params.set('collectionId', collectionId);
    if (lifecycle !== 'all') params.set('status', lifecycle);
    if (platformFilter !== 'all') params.set('platformState', platformFilter);
    if (platformAccountId) params.set('platformAccount', platformAccountId);
    if (query) params.set('q', query);
    if (sort !== 'name_asc') params.set('sort', sort);
    if (currentPage > 1) params.set('page', String(currentPage));
    if (pageSize !== 24) params.set('perPage', String(pageSize));
    if (!shownPlatforms.eversally) params.set('showSpace', '0');
    if (!shownPlatforms.deviantart) params.set('showDeviantArt', '0');
    return params;
  }, [collectionId, creatorId, currentPage, lifecycle, pageSize, platformAccountId, platformFilter, query, shownPlatforms.deviantart, shownPlatforms.eversally, sort]);

  const worksListSearch = worksListParams.toString();

  useEffect(() => {
    if (!creatorId || worksListSearch === location.search.replace(/^\?/, '')) return;
    // The sidebar owns the shared creator context through the URL. When it
    // changes creator, this view can render once with its previous local
    // state before the creator-sync effect catches up. Do not write that
    // stale value back to the URL or the two states can oscillate forever.
    if (requestedCreatorId && requestedCreatorId !== creatorId && creators.some((creator) => creator.creatorId === requestedCreatorId)) return;
    navigate({ pathname: location.pathname, search: `?${worksListSearch}` }, { replace: true });
  }, [creatorId, creators, location.pathname, location.search, navigate, requestedCreatorId, worksListSearch]);

  const workRoute = (workId: string, tab?: string) => worksWorkspacePath(`?${worksListSearch}`, { workId, tab });

  const setAssetCollectionMembership = async (asset: StudioExternalAsset, targetCollectionId: string, shouldInclude: boolean) => {
    if (!targetCollectionId || !creatorId) return;
    const assignedAssetIds = new Set(collections.collectionAssetIdsByCollection[targetCollectionId] || []);
    if (shouldInclude) assignedAssetIds.add(asset.assetId);
    else assignedAssetIds.delete(asset.assetId);
    const assetIds = [...assignedAssetIds];
    setUpdatingAssetId(asset.assetId);
    setError('');
    try {
      await api.studioReplaceIntegrationCollectionAssets(targetCollectionId, { creatorIdentityId: creatorId, assetIds });
      setCollections((current) => ({
        ...current,
        collectionAssetIdsByCollection: { ...current.collectionAssetIdsByCollection, [targetCollectionId]: assetIds }
      }));
    } catch (updateError) {
      setError(updateError instanceof Error ? updateError.message : 'Unable to update this work’s collections.');
    } finally {
      setUpdatingAssetId('');
    }
  };

  const toggleWorkSelection = (assetId: string, checked: boolean) => {
    setSelectedWorkAssetIds((current) => checked
      ? [...new Set([...current, assetId])]
      : current.filter((item) => item !== assetId));
  };

  const addSelectedWorksToCollection = async () => {
    if (!bulkCollectionId || !creatorId || !selectedDisplayedAssetIds.length) return;
    const assetIds = [...new Set([
      ...(collections.collectionAssetIdsByCollection[bulkCollectionId] || []),
      ...selectedDisplayedAssetIds
    ])];
    setBulkUpdating(true);
    setError('');
    try {
      await api.studioReplaceIntegrationCollectionAssets(bulkCollectionId, { creatorIdentityId: creatorId, assetIds });
      setCollections((current) => ({
        ...current,
        collectionAssetIdsByCollection: { ...current.collectionAssetIdsByCollection, [bulkCollectionId]: assetIds }
      }));
      setBulkCollectionId('');
      setSelectedWorkAssetIds([]);
    } catch (updateError) {
      setError(updateError instanceof Error ? updateError.message : 'Unable to add the selected works to this collection.');
    } finally {
      setBulkUpdating(false);
    }
  };

  const addDeviantArtDestination = async (asset: StudioExternalAsset, externalAccountId: string, targetStatus: 'draft' | 'published') => {
    if (!externalAccountId) return;
    setDestinationUpdatingAssetId(asset.assetId);
    setError('');
    setDestinationMessageByAsset((current) => ({ ...current, [asset.assetId]: '' }));
    try {
      const intent = await api.studioSetWorkPublicationIntent(asset.assetId, { destination: 'deviantart', integrationAccountId: externalAccountId, enabled: true, desiredStatus: targetStatus === 'draft' ? 'draft' : 'live' });
      setAssets((current) => current.map((item) => item.assetId === asset.assetId ? { ...item, publicationIntents: [...item.publicationIntents.filter((existing) => !(existing.destination === 'deviantart' && existing.integrationAccountId === externalAccountId)), intent] } : item));
      setDestinationMessageByAsset((current) => ({ ...current, [asset.assetId]: `Publishing intent saved for DeviantArt · ${accounts.find((account) => account.externalAccountId === externalAccountId)?.externalUsername || 'account'}. No remote publication has been created yet.` }));
    } catch (destinationError) {
      setError(destinationError instanceof Error ? destinationError.message : 'Unable to add DeviantArt as a destination.');
    } finally {
      setDestinationUpdatingAssetId('');
    }
  };

  const setSpaceIntent = async (asset: StudioExternalAsset, enabled: boolean) => {
    setDestinationUpdatingAssetId(asset.assetId);
    setError('');
    try {
      const intent = await api.studioSetWorkPublicationIntent(asset.assetId, { destination: 'eversally', enabled, desiredStatus: 'live' });
      setAssets((current) => current.map((item) => item.assetId === asset.assetId ? { ...item, publicationIntents: [...item.publicationIntents.filter((existing) => existing.destination !== 'eversally'), intent] } : item));
      setDestinationMessageByAsset((current) => ({ ...current, [asset.assetId]: enabled
        ? `${brand.workspaceFullName} selected for the next publish operation. The Work remains unpublished until you review and publish it.`
        : `${brand.workspaceFullName} removed from the next publish operation. Current publication state was not changed.` }));
    } catch (intentError) {
      setError(intentError instanceof Error ? intentError.message : 'Unable to save this publishing intent.');
    } finally {
      setDestinationUpdatingAssetId('');
    }
  };

  const addSelectedWorksToDeviantArt = async () => {
    const externalAccountId = bulkDestinationAccountId || (accounts.length === 1 ? accounts[0].externalAccountId : '');
    if (!selectedDisplayedAssetIds.length || (!bulkSpaceIntent && !bulkDeviantArtIntent) || (bulkDeviantArtIntent && !externalAccountId)) return;
    setBulkDestinationUpdating(true);
    setBulkDestinationMessage('');
    setError('');
    try {
      const selectedAssets = displayedAssets.filter((asset) => selectedDisplayedAssetIds.includes(asset.assetId));
      const results = await Promise.all(selectedAssets.map(async (asset) => {
        if (bulkDeviantArtIntent) {
          await api.studioAddDeviantArtWorkDestination(asset.assetId, externalAccountId, bulkDestinationStatus, bulkDeviantArtOptions());
        }
        const intents = await Promise.all([
          ...(bulkSpaceIntent ? [api.studioSetWorkPublicationIntent(asset.assetId, { destination: 'eversally', enabled: true, desiredStatus: 'live' })] : []),
          ...(bulkDeviantArtIntent ? [api.studioSetWorkPublicationIntent(asset.assetId, { destination: 'deviantart', integrationAccountId: externalAccountId, enabled: true, desiredStatus: bulkDestinationStatus === 'draft' ? 'draft' : 'live' })] : [])
        ]);
        return [asset.assetId, intents] as const;
      }));
      const intentsByAssetId = new Map(results);
      setAssets((current) => current.map((asset) => {
        const intents = intentsByAssetId.get(asset.assetId);
        if (!intents) return asset;
        return { ...asset, publicationIntents: [
          ...asset.publicationIntents.filter((existing) => !intents.some((intent) => intent.destination === existing.destination && intent.integrationAccountId === existing.integrationAccountId)),
          ...intents
        ] };
      }));
      setSelectedWorkAssetIds([]);
      setBulkDestinationMessage([
        results.length ? `Publishing choices and DeviantArt settings saved for ${results.length} work${results.length === 1 ? '' : 's'}. No remote publications were created.` : ''
      ].filter(Boolean).join(' '));
    } catch (destinationError) {
      setError(destinationError instanceof Error ? destinationError.message : 'Unable to update the selected publishing destinations.');
    } finally {
      setBulkDestinationUpdating(false);
    }
  };

  const publishSelectedWorks = async () => {
    const externalAccountId = bulkDestinationAccountId || (accounts.length === 1 ? accounts[0].externalAccountId : '');
    if (!selectedDisplayedAssetIds.length || (!bulkSpaceIntent && !bulkDeviantArtIntent) || (bulkDeviantArtIntent && !externalAccountId)) return;
    const selectedAssets = displayedAssets.filter((asset) => selectedDisplayedAssetIds.includes(asset.assetId));
    const parsedDisplayResolution = Number.parseInt(bulkDaDisplayResolution, 10);
    if (bulkDeviantArtIntent && bulkDaDisplayResolution && !deviantArtDisplayWidths.includes(parsedDisplayResolution)) {
      setError('Choose a supported DeviantArt display size.');
      return;
    }
    const deviantArtOptions = bulkDeviantArtOptions();
    const destinations = [
      ...(bulkSpaceIntent ? [`${brand.workspaceFullName} (${bulkSpaceVisibility})`] : []),
      ...(bulkDeviantArtIntent ? [`DeviantArt · ${accounts.find((account) => account.externalAccountId === externalAccountId)?.externalUsername || 'account'} (${bulkDestinationStatus === 'draft' ? 'Sta.sh draft' : 'publish'})`] : [])
    ];
    const includesUnverifiedFailure = selectedAssets.some((asset) => asset.publications.some((publication) => publication.platform === 'deviantart' && publication.syncStatus === 'error'));
    const retryWarning = includesUnverifiedFailure
      ? ' At least one selected DeviantArt submission could not previously be verified. Check Sta.sh first: retrying it may create a second draft.'
      : '';
    if (!window.confirm(`Publish ${selectedAssets.length} selected work${selectedAssets.length === 1 ? '' : 's'} to ${destinations.join(' and ')}? Existing DeviantArt publications will not be duplicated; Eversally visibility will be set as selected.${retryWarning}`)) return;
    setBulkPublishing(true);
    setBulkPublishMessage('');
    setError('');
    const results: Array<{ title: string; error?: string }> = [];
    const publishedSpaceWorkIds: string[] = [];
    for (const asset of selectedAssets) {
      const title = asset.canonicalTitle || asset.publications[0]?.externalTitle || 'Untitled work';
      try {
        if (bulkSpaceIntent) {
          await api.studioUpdateSpacePublication(asset.assetId, {
            published: true,
            hostingMode: 'hosted',
            visibility: bulkSpaceVisibility,
            announcement: {
              mode: bulkDiscordAnnouncementMode,
              preset: bulkDiscordAnnouncementPreset,
              includePrimaryMedia: bulkDiscordIncludePrimaryMedia
            }
          });
          publishedSpaceWorkIds.push(asset.assetId);
        }
        if (bulkDeviantArtIntent) {
          const result = await api.studioAddDeviantArtWorkDestination(asset.assetId, externalAccountId, bulkDestinationStatus, deviantArtOptions) as { publication?: { syncStatus?: string } };
          if (result.publication?.syncStatus === 'pending_publish' || result.publication?.syncStatus === 'draft' || result.publication?.syncStatus === 'error') {
            await api.studioSyncDeviantArtWorkDestination(asset.assetId, externalAccountId);
          }
        }
        results.push({ title });
      } catch (publishError) {
        results.push({ title, error: publishError instanceof Error ? publishError.message : 'Unable to publish.' });
      }
    }
    if (bulkSpaceIntent && bulkSpaceVisibility === 'public' && bulkDiscordAnnouncementMode === 'digest' && publishedSpaceWorkIds.length) {
      try {
        await api.studioQueueDiscordBulkAnnouncement({
          creatorId,
          workIds: publishedSpaceWorkIds,
          preset: bulkDiscordAnnouncementPreset,
          includePrimaryMedia: bulkDiscordIncludePrimaryMedia
        });
      } catch (announcementError) {
        results.push({ title: 'Discord digest', error: announcementError instanceof Error ? announcementError.message : 'Unable to queue the Discord digest.' });
      }
    }
    const failed = results.filter((result) => result.error);
    setBulkPublishMessage(failed.length
      ? `${results.length - failed.length} published or queued. ${failed.length} need attention: ${failed.slice(0, 3).map((result) => result.title).join(', ')}${failed.length > 3 ? '…' : ''}.`
      : `${results.length} work${results.length === 1 ? '' : 's'} published or queued successfully.`);
    setBulkPublishing(false);
    setBulkReviewOpen(false);
    await load();
  };

  const saveBulkDeviantArtPreset = async () => {
    const externalAccountId = bulkDestinationAccountId || (accounts.length === 1 ? accounts[0].externalAccountId : '');
    const account = accounts.find((item) => item.externalAccountId === externalAccountId);
    if (!externalAccountId || !account) return;
    const parsedDisplayResolution = Number.parseInt(bulkDaDisplayResolution, 10);
    if (bulkDaDisplayResolution && !deviantArtDisplayWidths.includes(parsedDisplayResolution)) {
      setError('Choose a supported DeviantArt display size.');
      return;
    }
    setBulkPresetSaving(true);
    setError('');
    try {
      await api.studioSaveDeviantArtPublishingPreset(externalAccountId, {
        defaultTags: [...new Set(bulkDaTags.split(',').map((tag) => tag.trim()).filter(Boolean))],
        galleryExternalCollectionIds: bulkDaGalleryIds,
        targetStatus: bulkDestinationStatus,
        ...(Number.isInteger(parsedDisplayResolution) && parsedDisplayResolution > 0 ? { displayResolution: parsedDisplayResolution } : {}),
        allowFreeDownload: bulkDaAllowFreeDownload,
        addWatermark: Boolean(Number.isInteger(parsedDisplayResolution) && parsedDisplayResolution > 0 && bulkDaAddWatermark),
        isMature: bulkDaIsMature,
        matureLevel: bulkDaMatureLevel,
        matureClassification: bulkDaIsMature ? bulkDaMatureClassification : [],
        isAiGenerated: bulkDaIsAiGenerated,
        noAi: bulkDaNoAi
      });
      setAccounts((current) => current.map((item) => item.externalAccountId === externalAccountId ? {
        ...item,
        deviantArtPublishingPreset: {
          titleFormat: 'filename_title_case',
          defaultTags: [...new Set(bulkDaTags.split(',').map((tag) => tag.trim()).filter(Boolean))],
          galleryExternalCollectionIds: bulkDaGalleryIds,
          sourceFileMode: 'original',
          targetStatus: bulkDestinationStatus,
          ...(Number.isInteger(parsedDisplayResolution) && parsedDisplayResolution > 0 ? { displayResolution: parsedDisplayResolution } : {}),
          allowFreeDownload: bulkDaAllowFreeDownload,
          addWatermark: Boolean(Number.isInteger(parsedDisplayResolution) && parsedDisplayResolution > 0 && bulkDaAddWatermark),
          isMature: bulkDaIsMature,
          matureLevel: bulkDaMatureLevel,
          matureClassification: bulkDaIsMature ? bulkDaMatureClassification : [],
          isAiGenerated: bulkDaIsAiGenerated,
          noAi: bulkDaNoAi
        }
      } : item));
      setBulkDestinationMessage(`Saved DeviantArt defaults for ${account.externalUsername}.`);
    } catch (presetError) {
      setError(presetError instanceof Error ? presetError.message : 'Unable to save DeviantArt defaults.');
    } finally {
      setBulkPresetSaving(false);
    }
  };

  const bulkEditSelectedDeviantArtWorks = async () => {
    if (!selectedDeviantArtOriginWorks.length || !hasBulkDeviantArtEditFields) return;
    const parsedDisplayResolution = Number.parseInt(bulkDaDisplayResolution, 10);
    if (bulkDaApplyDisplay && bulkDaDisplayResolution && !deviantArtDisplayWidths.includes(parsedDisplayResolution)) {
      setError('Choose a supported DeviantArt display size.');
      return;
    }
    const tags = [...new Set(bulkDaTags.split(',').map((tag) => tag.trim()).filter(Boolean))];
    if (bulkDaApplyTags && !tags.length) {
      setError('Enter at least one tag before applying tags in bulk.');
      return;
    }
    if (bulkDaApplyGalleries && !bulkDaGalleryIds.length) {
      setError('Choose at least one gallery before applying gallery placement in bulk.');
      return;
    }
    setBulkDaEditing(true);
    setBulkDaEditMessage('');
    setError('');
    const results: Array<{ title: string; queued?: boolean; error?: string }> = [];
    for (const { asset, publication } of selectedDeviantArtOriginWorks) {
      const title = asset.canonicalTitle || publication.externalTitle || 'Untitled work';
      try {
        const result = await api.studioUpdateDeviantArtPublicationMetadata(asset.assetId, {
          externalPublicationId: publication.externalPublicationId,
          ...(bulkDaApplyTitle ? { title } : {}),
          ...(bulkDaApplyTags ? { tags } : {}),
          ...(bulkDaApplyGalleries ? { collectionExternalIds: bulkDaGalleryIds } : {}),
          ...(bulkDaApplyComments ? { allowComments: bulkDaAllowComments } : {}),
          ...(bulkDaApplyDisplay ? {
            displayResolution: Number.isInteger(parsedDisplayResolution) && parsedDisplayResolution > 0 ? parsedDisplayResolution : null,
            allowFreeDownload: bulkDaAllowFreeDownload,
            addWatermark: Boolean(Number.isInteger(parsedDisplayResolution) && parsedDisplayResolution > 0 && bulkDaAddWatermark)
          } : {}),
          ...(bulkDaApplyMature ? {
            isMature: bulkDaIsMature,
            matureLevel: bulkDaMatureLevel,
            matureClassification: bulkDaIsMature ? bulkDaMatureClassification : []
          } : {}),
          ...(bulkDaApplyAiGenerated ? { isAiGenerated: bulkDaIsAiGenerated } : {}),
          ...(bulkDaApplyNoAi ? { noAi: bulkDaNoAi } : {})
        });
        results.push({ title, queued: Boolean(result.remoteUpdateJobs?.length) });
      } catch (editError) {
        results.push({ title, error: editError instanceof Error ? editError.message : 'Unable to update DeviantArt.' });
      }
    }
    const failed = results.filter((result) => result.error);
    const queued = results.filter((result) => result.queued).length;
    const saved = results.length - failed.length - queued;
    setBulkDaEditMessage(failed.length
      ? `${queued} remote edit${queued === 1 ? '' : 's'} queued and ${saved} staged locally. ${failed.length} failed: ${failed.slice(0, 3).map((result) => result.title).join(', ')}${failed.length > 3 ? '…' : ''}.`
      : `${queued} DeviantArt edit${queued === 1 ? '' : 's'} queued${saved ? ` and ${saved} draft edit${saved === 1 ? '' : 's'} saved locally` : ''}. Descriptions were not changed.`);
    setBulkDaEditing(false);
    await load();
  };

  const bulkDestinationCount = Number(bulkSpaceIntent) + Number(bulkDeviantArtIntent);

  return (
    <section className="studio-works-layout">
      <Card
        title="Works"
        eyebrow={`${activeCreator?.name || brand.creatorName} catalogue`}
      >
        <div className="studio-works-primary-actions" aria-label="Work actions">
          <button type="button" className="auth-secondary-btn" disabled={loading || !creatorId} onClick={() => void load()}>
            {loading ? 'Refreshing…' : 'Refresh works'}
          </button>
          <Link className="auth-primary-btn no-underline" to={worksWorkspacePath(`?${worksListSearch}`, { create: true })}>Upload works</Link>
          <Link className="auth-secondary-btn no-underline studio-works-create-writing" to={worksWorkspacePath(`?${worksListSearch}`, { create: true, kind: 'writing' })}>Create Post or Story</Link>
        </div>
        <div className="studio-works-platform-chips" role="group" aria-label="Platforms shown">
          <button
            type="button"
            className={`studio-works-platform-chip ${shownPlatforms.eversally && shownPlatforms.deviantart ? 'is-active' : ''}`}
            aria-pressed={shownPlatforms.eversally && shownPlatforms.deviantart}
            onClick={() => setShownPlatforms({ eversally: true, deviantart: true })}
          >
            <span className="studio-works-platform-dot studio-works-platform-dot-all" />
            <span>All</span>
            <small>{assets.length}</small>
          </button>
          <button
            type="button"
            className={`studio-works-platform-chip ${shownPlatforms.eversally && !shownPlatforms.deviantart ? 'is-active' : ''}`}
            aria-pressed={shownPlatforms.eversally && !shownPlatforms.deviantart}
            onClick={() => setShownPlatforms({ eversally: true, deviantart: false })}
          >
            <span className="studio-works-platform-dot studio-works-platform-dot-space" />
            <span>{brand.workspaceFullName}</span>
            <small>{assets.filter((asset) => asset.destinationPublications.some((publication) => publication.destination === 'eversally' && publication.status !== 'removed')).length}</small>
          </button>
          <button
            type="button"
            className={`studio-works-platform-chip ${shownPlatforms.deviantart && !shownPlatforms.eversally ? 'is-active' : ''}`}
            aria-pressed={shownPlatforms.deviantart && !shownPlatforms.eversally}
            onClick={() => setShownPlatforms({ eversally: false, deviantart: true })}
          >
            <span className="studio-works-platform-dot studio-works-platform-dot-deviantart" />
            <span>DeviantArt</span>
            <small>{assets.filter((asset) => asset.destinationPublications.some((publication) => publication.destination === 'deviantart' && publication.status !== 'removed')).length}</small>
          </button>
          {[
            ['bluesky', 'Bluesky', '#5b86ad'],
            ['youtube', 'YouTube', '#9a5151'],
            ['soundcloud', 'SoundCloud', '#b56b32'],
            ['fanvue', 'FanVue', '#795aa4']
          ].map(([key, label, color]) => <button type="button" className="studio-works-platform-chip is-disabled" disabled key={key} title={`${label} publishing is not available yet`}>
            <span className="studio-works-platform-dot" style={{ background: color }} />
            <span>{label}</span>
          </button>)}
        </div>
        <div className="studio-works-controls">
          <label>
            <span>Collection</span>
            <select value={collectionId} onChange={(event) => { setCollectionId(event.target.value); setPage(1); }}>
              <option value="">All works</option>
              {collections.ubeeqCollections.map((collection) => <option key={collection.ubeeqCollectionId} value={collection.ubeeqCollectionId}>{collection.name}</option>)}
            </select>
          </label>
          <label>
            <span>Work state</span>
            <select value={lifecycle} onChange={(event) => { setLifecycle(event.target.value as 'all' | WorkLifecycle); setPage(1); }}>
              <option value="all">All works</option>
              <option value="draft">Draft</option>
              <option value="ready">Ready</option>
              <option value="archived">Archived</option>
            </select>
          </label>
          <label>
            <span>Sort</span>
            <select value={sort} onChange={(event) => { setSort(event.target.value as WorkSort); setPage(1); }}>
              <option value="name_asc">Name: A–Z</option>
              <option value="name_desc">Name: Z–A</option>
              <option value="updated_desc">Last updated</option>
            </select>
          </label>
          <label>
            <span>Per page</span>
            <select value={pageSize} onChange={(event) => { setPageSize(Number(event.target.value)); setPage(1); }}>
              {worksPageSizes.map((size) => <option key={size} value={size}>{size}</option>)}
            </select>
          </label>
          <label className="studio-works-search">
            <span>Search works</span>
            <input value={query} onChange={(event) => { setQuery(event.target.value); setPage(1); }} placeholder="Title, description, or tag" />
          </label>
        </div>

        <details className="studio-works-more-filters">
          <summary>More filters</summary>
          <div className="studio-works-more-filters-grid">
            <label>
              <span>Platform state</span>
              <select value={platformFilter} onChange={(event) => { setPlatformFilter(event.target.value as PlatformFilter); setPage(1); }}>
                <option value="all">All platform states</option>
                <option value="published_anywhere">Published anywhere</option>
                <option value="published_nowhere">Published nowhere</option>
                <option value="unpublished_unqueued">Unpublished and unqueued</option>
                <option value="unpublished_images">Unpublished images (drafts)</option>
                <option value="eversally_live">Published on {brand.workspaceFullName}</option>
                <option value="deviantart_live">Published on DeviantArt</option>
                <option value="out_of_sync">Out of sync</option>
                <option value="error">Errors</option>
              </select>
            </label>
            <label>
              <span>Platform account</span>
              <select value={platformAccountId} disabled={!accounts.length} onChange={(event) => { setPlatformAccountId(event.target.value); setPage(1); }}>
                <option value="">{accounts.length ? 'All platform accounts' : 'No connected accounts'}</option>
                {!!accounts.length && <optgroup label="DeviantArt">
                  {accounts.map((account) => <option key={account.externalAccountId} value={account.externalAccountId}>@{account.externalUsername}</option>)}
                </optgroup>}
              </select>
            </label>
          </div>
        </details>

        {loading && <p className="small">Loading works…</p>}
        {error && <p className="error">{error}</p>}

        {!!displayedAssets.length && <div className="studio-works-bulk-bar">
          <label className="studio-work-select-all" aria-label={`Select all ${displayedAssets.length} works on this page`}>
            <input
              type="checkbox"
              checked={selectedDisplayedAssetIds.length === displayedAssets.length}
              onChange={(event) => setSelectedWorkAssetIds(event.target.checked ? displayedAssets.map((asset) => asset.assetId) : [])}
            />
            <span>Select all</span>
          </label>
          <span className="studio-works-selection-count">
            <span className="studio-works-selection-count-wide">{selectedWorkAssetIds.length} of {visibleAssets.length} selected</span>
            <span className="studio-works-selection-count-compact">{selectedWorkAssetIds.length} selected</span>
          </span>
          <label className="studio-works-bulk-collection">
            <span>Add selected to collection</span>
            <select value={bulkCollectionId} onChange={(event) => setBulkCollectionId(event.target.value)}>
              <option value="">Choose a collection…</option>
              {collections.ubeeqCollections.map((collection) => <option key={collection.ubeeqCollectionId} value={collection.ubeeqCollectionId}>{collection.name}</option>)}
            </select>
          </label>
          <button type="button" className="auth-primary-btn" disabled={!bulkCollectionId || !selectedDisplayedAssetIds.length || bulkUpdating} onClick={() => void addSelectedWorksToCollection()}>
            {bulkUpdating ? 'Adding…' : 'Add selected'}
          </button>
          <button type="button" className="auth-primary-btn" disabled={!selectedDisplayedAssetIds.length || bulkPublishing} onClick={() => setBulkReviewOpen((current) => !current)}>
            {bulkReviewOpen ? 'Close review' : <>
              <span className="studio-works-review-label-wide">Review &amp; publish ({selectedDisplayedAssetIds.length})</span>
              <span className="studio-works-review-label-compact">Publish</span>
            </>}
          </button>
          {bulkReviewOpen && !!selectedDisplayedAssetIds.length && <div className="studio-works-review-dialog-layer" role="presentation" onMouseDown={() => setBulkReviewOpen(false)}>
            <div className="studio-works-review-dialog" role="dialog" aria-modal="true" aria-labelledby="studio-review-publish-title" onMouseDown={(event) => event.stopPropagation()}>
            <div className="studio-work-destination-target studio-works-bulk-review">
            <h3 id="studio-review-publish-title">Review &amp; publish — {selectedDisplayedAssetIds.length} work{selectedDisplayedAssetIds.length === 1 ? '' : 's'}</h3>
            <div className="studio-works-review-tabs" role="tablist" aria-label="Review destinations">
              {([
                ['eversally', brand.workspaceFullName],
                ['deviantart', 'DeviantArt'],
                ['discord', 'Discord'],
                ['bluesky', 'Bluesky']
              ] as const).map(([platform, label]) => <button
                key={platform}
                type="button"
                role="tab"
                aria-selected={bulkReviewPlatform === platform}
                className={bulkReviewPlatform === platform ? 'is-active' : ''}
                onClick={() => setBulkReviewPlatform(platform)}
              >{label}</button>)}
            </div>
            {bulkReviewPlatform === 'bluesky' && <p className="studio-works-review-note">Bluesky announcements will use this same release-format contract when a Bluesky account is connected. No announcement is sent for Private or Unlisted Space Works.</p>}
            <span>Bulk publishing review</span>
            {!bulkSpaceIntent && !bulkDeviantArtIntent && <p className="studio-work-metadata-warning">Choose at least one publish destination below.</p>}
            {bulkDeviantArtIntent && !bulkDestinationAccountId && <p className="studio-work-metadata-warning">Choose a DeviantArt account below.</p>}
            {(bulkSpaceIntent || bulkDeviantArtIntent) && <p className="small">{selectedDisplayedAssetIds.length} selected work{selectedDisplayedAssetIds.length === 1 ? '' : 's'} will be sent to:</p>}
            <ul className="small">
              {bulkSpaceIntent && <li>{brand.workspaceFullName} — {bulkSpaceVisibility === 'public' ? 'Space-visible' : bulkSpaceVisibility}</li>}
              {bulkSpaceIntent && bulkDiscordAnnouncementMode !== 'none' && <li>Discord — {bulkDiscordAnnouncementMode === 'digest' ? 'one digest for this release' : bulkDiscordAnnouncementMode === 'per_work' ? 'one announcement per Work' : 'channel default'} · {announcementPresetOptions.find((option) => option.id === bulkDiscordAnnouncementPreset)?.label || 'Recommended'}</li>}
              {bulkDeviantArtIntent && <li>DeviantArt · {accounts.find((account) => account.externalAccountId === (bulkDestinationAccountId || (accounts.length === 1 ? accounts[0].externalAccountId : '')))?.externalUsername || 'account'} — {bulkDestinationStatus === 'draft' ? 'save as Sta.sh draft' : 'publish'} · {bulkDaDisplayResolution ? `${bulkDaDisplayResolution}px display rendition` : 'original display'} · free download {bulkDaAllowFreeDownload ? 'enabled' : 'disabled'}{bulkDaAddWatermark && bulkDaDisplayResolution ? ' · watermark enabled' : ''} · {bulkDaIsMature ? `mature (${bulkDaMatureLevel})` : 'not mature'} · {bulkDaIsAiGenerated ? 'made with AI' : 'not marked AI-generated'} · AI training {bulkDaNoAi ? 'disallowed' : 'allowed'}</li>}
            </ul>
            <p className="small">Queued in the current Works order:</p>
            <ol className="small">
              {displayedAssets.filter((asset) => selectedDisplayedAssetIds.includes(asset.assetId)).slice(0, 8).map((asset, index) => <li key={asset.assetId}>{index + 1}. {asset.canonicalTitle || asset.publications[0]?.externalTitle || 'Untitled work'}</li>)}
            </ol>
            {selectedDisplayedAssetIds.length > 8 && <p className="small">…and {selectedDisplayedAssetIds.length - 8} more.</p>}
            <div className="studio-works-review-dialog-actions">
              <button type="button" className="auth-secondary-btn" disabled={bulkPublishing} onClick={() => setBulkReviewOpen(false)}>Cancel</button>
              <button type="button" className="auth-primary-btn" disabled={bulkPublishing || !bulkDestinationCount || (bulkDeviantArtIntent && !bulkDestinationAccountId)} onClick={() => void publishSelectedWorks()}>{bulkPublishing ? 'Publishing…' : `Publish to ${bulkDestinationCount} destination${bulkDestinationCount === 1 ? '' : 's'}`}</button>
            </div>
          </div>
          <div className="studio-works-bulk-destination studio-works-review-panel">
            {bulkReviewPlatform === 'eversally' && <>
              <span>Publish to {brand.workspaceFullName}</span>
              <label><input type="checkbox" checked={bulkSpaceIntent} onChange={(event) => setBulkSpaceIntent(event.target.checked)} /> Publish these Works to {brand.workspaceFullName}</label>
              <label><span>Space visibility</span><select value={bulkSpaceVisibility} onChange={(event) => setBulkSpaceVisibility(event.target.value as 'private' | 'unlisted' | 'public')}>
                <option value="private">Private</option>
                <option value="unlisted">Unlisted</option>
                <option value="public">Space-visible</option>
              </select></label>
              <small className="studio-work-destination-message">Publishing to your Space does not opt these Works into discovery.</small>
            </>}
            {bulkReviewPlatform === 'bluesky' && <>
              <span>Bluesky announcements</span>
              <p className="studio-works-review-note">Bluesky publishing will be available when a Bluesky account is connected for this Creator. No announcement will be sent for Private or Unlisted Works.</p>
            </>}
            {bulkReviewPlatform === 'discord' && <>
              <span>Discord announcement</span>
              <p className="studio-works-review-note">Use the channel default, tailor this release, combine the selected Works into one digest, or publish without a Discord announcement.</p>
              <label className="studio-works-bulk-da-option"><span>Announcement delivery</span><select value={bulkDiscordAnnouncementMode} onChange={(event) => setBulkDiscordAnnouncementMode(event.target.value as 'default' | 'per_work' | 'digest' | 'none')}>
                <option value="default">Use each channel’s default</option>
                <option value="per_work">One announcement per Work</option>
                <option value="digest">One digest for this release</option>
                <option value="none">Do not announce this release</option>
              </select></label>
              {bulkDiscordAnnouncementMode !== 'none' && <label className="studio-works-bulk-da-option"><span>Recommended format</span><select value={bulkDiscordAnnouncementPreset} onChange={(event) => setBulkDiscordAnnouncementPreset(event.target.value as AnnouncementPresetId)}>{announcementPresetOptions.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}</select></label>}
              {bulkDiscordAnnouncementMode !== 'none' && <label><input type="checkbox" checked={bulkDiscordIncludePrimaryMedia} onChange={(event) => setBulkDiscordIncludePrimaryMedia(event.target.checked)} /> Include the primary image or media in supported rich previews</label>}
              <small className="studio-work-destination-message">Discord delivery is only available for Space-visible Works. A digest is queued once this entire release has been published.</small>
            </>}
            {bulkReviewPlatform === 'deviantart' && <>
            <span>Publish destinations</span>
            <label><input type="checkbox" checked={bulkSpaceIntent} onChange={(event) => setBulkSpaceIntent(event.target.checked)} /> {brand.workspaceFullName}</label>
            {bulkSpaceIntent && <select value={bulkSpaceVisibility} onChange={(event) => setBulkSpaceVisibility(event.target.value as 'private' | 'unlisted' | 'public')} aria-label={`${brand.workspaceFullName} visibility for selected works`}>
              <option value="private">Private</option>
              <option value="unlisted">Unlisted</option>
              <option value="public">Space-visible</option>
            </select>}
            {!!accounts.length && <label><input type="checkbox" checked={bulkDeviantArtIntent} onChange={(event) => setBulkDeviantArtIntent(event.target.checked)} /> DeviantArt</label>}
            {bulkDeviantArtIntent && accounts.length > 1 && <select value={bulkDestinationAccountId} onChange={(event) => setBulkDestinationAccountId(event.target.value)}>
              <option value="">Choose an account…</option>
              {accounts.map((account) => <option key={account.externalAccountId} value={account.externalAccountId}>{account.externalUsername}{account.connectionStatus === 'connected' ? '' : ` (${account.connectionStatus === 'rate_limited' ? 'rate limited — queued' : 'temporarily unavailable — queued'})`}</option>)}
            </select>}
            {bulkDeviantArtIntent && accounts.length === 1 && <small>{accounts[0].externalUsername}{accounts[0].connectionStatus === 'connected' ? '' : ` · ${accounts[0].connectionStatus === 'rate_limited' ? 'rate limited; publishing will queue' : 'temporarily unavailable; publishing will queue'}`}</small>}
            {bulkDeviantArtIntent && <select value={bulkDestinationStatus} onChange={(event) => setBulkDestinationStatus(event.target.value as 'draft' | 'published')} aria-label="DeviantArt destination status for selected works">
              <option value="published">Published (default)</option>
              <option value="draft">Draft in Sta.sh</option>
            </select>}
            {bulkDeviantArtIntent && <label className="studio-works-bulk-da-option"><span>Tags</span><input value={bulkDaTags} onChange={(event) => setBulkDaTags(event.target.value)} placeholder="brand, illustration, series" /></label>}
            {bulkDeviantArtIntent && bulkAccountGalleries.length > 0 && <fieldset className="studio-work-metadata-options"><legend>Gallery placement</legend>{bulkAccountGalleries.map((gallery) => <label className="studio-work-metadata-option" key={gallery.externalCollectionId}><input type="checkbox" checked={bulkDaGalleryIds.includes(gallery.externalCollectionExternalId)} onChange={(event) => setBulkDaGalleryIds((current) => event.target.checked ? [...new Set([...current, gallery.externalCollectionExternalId])] : current.filter((id) => id !== gallery.externalCollectionExternalId))} /><span>{gallery.name}</span></label>)}</fieldset>}
            {bulkDeviantArtIntent && <fieldset className="studio-work-metadata-options"><legend>Content declarations</legend>
              <label className="studio-work-metadata-option"><input type="checkbox" checked={bulkDaIsMature} onChange={(event) => { setBulkDaIsMature(event.target.checked); if (!event.target.checked) setBulkDaMatureClassification([]); }} /><span>Mature content</span></label>
              {bulkDaIsMature && <label className="studio-works-bulk-da-option"><span>Mature level</span><select value={bulkDaMatureLevel} onChange={(event) => setBulkDaMatureLevel(event.target.value as 'strict' | 'moderate')}><option value="moderate">Moderate</option><option value="strict">Strict</option></select></label>}
              {bulkDaIsMature && matureClassificationOptions.map((option) => <label className="studio-work-metadata-option" key={option.value}><input type="checkbox" checked={bulkDaMatureClassification.includes(option.value)} onChange={(event) => setBulkDaMatureClassification((current) => event.target.checked ? [...new Set([...current, option.value])] : current.filter((value) => value !== option.value))} /><span>{option.label}</span></label>)}
              <label className="studio-work-metadata-option"><input type="checkbox" checked={bulkDaIsAiGenerated} onChange={(event) => setBulkDaIsAiGenerated(event.target.checked)} /><span>Made with AI</span></label>
              <label className="studio-work-metadata-option"><input type="checkbox" checked={bulkDaNoAi} onChange={(event) => setBulkDaNoAi(event.target.checked)} /><span>No third-party AI training</span></label>
            </fieldset>}
            {bulkDeviantArtIntent && <label className="studio-works-bulk-da-option"><span>Display size</span><select value={bulkDaDisplayResolution} onChange={(event) => setBulkDaDisplayResolution(event.target.value)} aria-label="DeviantArt display size for selected works"><option value="">Original</option>{deviantArtDisplayWidths.map((width) => <option key={width} value={width}>Size: {width} pixels wide</option>)}</select></label>}
            {bulkDeviantArtIntent && <label><input type="checkbox" checked={bulkDaAllowFreeDownload} onChange={(event) => setBulkDaAllowFreeDownload(event.target.checked)} /> Allow original download</label>}
            {bulkDeviantArtIntent && <label><input type="checkbox" checked={bulkDaAddWatermark} disabled={!bulkDaDisplayResolution} onChange={(event) => setBulkDaAddWatermark(event.target.checked)} /> Add watermark</label>}
            {bulkDeviantArtIntent && <button type="button" className="auth-secondary-btn" disabled={!bulkDestinationAccountId || bulkPresetSaving} onClick={() => void saveBulkDeviantArtPreset()}>
              {bulkPresetSaving ? 'Saving default…' : 'Save as account default'}
            </button>}
            {bulkDeviantArtIntent && (() => {
              const selectedAccount = accounts.find((account) => account.externalAccountId === (bulkDestinationAccountId || (accounts.length === 1 ? accounts[0].externalAccountId : '')));
              const preset = selectedAccount?.deviantArtPublishingPreset;
              return <small className="studio-work-destination-message">Settings began with {selectedAccount?.externalUsername || 'this account'}’s saved preset{preset?.defaultTags?.length ? ` · ${preset.defaultTags.join(', ')}` : ''}. Changes here apply to the selected Works. <Link to={`/studio/workspace?section=integrations&creatorId=${encodeURIComponent(creatorId)}`}>Edit full preset</Link></small>;
            })()}
            {bulkDeviantArtIntent && <fieldset className="studio-work-metadata-options">
              <legend>Bulk edit existing DeviantArt works</legend>
              <p className="small">Choose exactly which fields to replace on the selected DeviantArt-originated Works. DeviantArt descriptions are always left unchanged.</p>
              <label className="studio-work-metadata-option"><input type="checkbox" checked={bulkDaApplyTitle} onChange={(event) => setBulkDaApplyTitle(event.target.checked)} /><span>Apply each Work’s current title</span></label>
              <label className="studio-work-metadata-option"><input type="checkbox" checked={bulkDaApplyTags} onChange={(event) => setBulkDaApplyTags(event.target.checked)} /><span>Replace tags</span></label>
              <label className="studio-work-metadata-option"><input type="checkbox" checked={bulkDaApplyGalleries} onChange={(event) => setBulkDaApplyGalleries(event.target.checked)} /><span>Replace gallery placement</span></label>
              <label className="studio-work-metadata-option"><input type="checkbox" checked={bulkDaApplyComments} onChange={(event) => setBulkDaApplyComments(event.target.checked)} /><span>Change comment permission</span></label>
              {bulkDaApplyComments && <label className="studio-work-metadata-option"><input type="checkbox" checked={bulkDaAllowComments} onChange={(event) => setBulkDaAllowComments(event.target.checked)} /><span>Allow comments</span></label>}
              <label className="studio-work-metadata-option"><input type="checkbox" checked={bulkDaApplyDisplay} onChange={(event) => setBulkDaApplyDisplay(event.target.checked)} /><span>Apply display size, download, and watermark options</span></label>
              <label className="studio-work-metadata-option"><input type="checkbox" checked={bulkDaApplyMature} onChange={(event) => setBulkDaApplyMature(event.target.checked)} /><span>Apply mature-content declaration</span></label>
              <label className="studio-work-metadata-option"><input type="checkbox" checked={bulkDaApplyAiGenerated} onChange={(event) => setBulkDaApplyAiGenerated(event.target.checked)} /><span>Apply “Made with AI” declaration</span></label>
              <label className="studio-work-metadata-option"><input type="checkbox" checked={bulkDaApplyNoAi} onChange={(event) => setBulkDaApplyNoAi(event.target.checked)} /><span>Apply NoAI declaration</span></label>
              <button
                type="button"
                className="auth-secondary-btn"
                disabled={!selectedDeviantArtOriginWorks.length || !hasBulkDeviantArtEditFields || bulkDaEditing}
                onClick={() => void bulkEditSelectedDeviantArtWorks()}
              >
                {bulkDaEditing ? 'Applying edits…' : `Apply edits to ${selectedDeviantArtOriginWorks.length} DA-originated work${selectedDeviantArtOriginWorks.length === 1 ? '' : 's'}`}
              </button>
              {!!selectedDisplayedAssetIds.length && selectedDeviantArtOriginWorks.length < selectedDisplayedAssetIds.length && <small>{selectedDisplayedAssetIds.length - selectedDeviantArtOriginWorks.length} selected Work{selectedDisplayedAssetIds.length - selectedDeviantArtOriginWorks.length === 1 ? '' : 's'} will be skipped because they were not imported from this DeviantArt account or no longer have an editable publication.</small>}
              {bulkDaEditMessage && <small className="studio-work-destination-message">{bulkDaEditMessage}</small>}
            </fieldset>}
            <button type="button" className="auth-secondary-btn" disabled={!selectedDisplayedAssetIds.length || (!bulkSpaceIntent && !bulkDeviantArtIntent) || (bulkDeviantArtIntent && !bulkDestinationAccountId) || bulkDestinationUpdating} onClick={() => void addSelectedWorksToDeviantArt()}>
              {bulkDestinationUpdating ? 'Saving…' : 'Save choices'}
            </button>
            {bulkDestinationMessage && <small className="studio-work-destination-message">{bulkDestinationMessage}</small>}
            {bulkPublishMessage && <small className="studio-work-destination-message">{bulkPublishMessage}</small>}
            </>}
          </div>
            </div>
          </div>}
        </div>}
        <div className="studio-works-list">
          {displayedAssets.map((asset) => {
            const manuallyAssigned = manuallyAssignedAssetIds.has(asset.assetId);
            const assignedCollections = collections.ubeeqCollections.filter((collection) => (
              (collections.collectionAssetIdsByCollection[collection.ubeeqCollectionId] || []).includes(asset.assetId)
            ));
            const visiblePickerCollections = collections.ubeeqCollections.filter((collection) => (
              collection.name.toLowerCase().includes(collectionPickerQuery.trim().toLowerCase())
            ));
            const isCollectionPickerOpen = collectionPickerAssetId === asset.assetId;
            const deviantArtDestinations = asset.publications.filter((publication) => publication.platform === 'deviantart' && publication.syncStatus !== 'deleted');
            const remoteLifecycleIssues = asset.publications.filter((publication) => (
              publication.platform === 'deviantart'
              && (publication.syncStatus === 'missing' || publication.syncStatus === 'restricted' || publication.syncStatus === 'deleted' || publication.syncStatus === 'error')
            ));
            const selectedDestinationAccountId = destinationAccountByAsset[asset.assetId] || (accounts.length === 1 ? accounts[0].externalAccountId : '');
            const selectedDestinationStatus = destinationStatusByAsset[asset.assetId] || 'published';
            const isDestinationUpdating = destinationUpdatingAssetId === asset.assetId;
            const spaceIntentEnabled = asset.publicationIntents.some((intent) => intent.destination === 'eversally' && intent.enabled);
            const daDestinationCandidates = [
              ...accounts.map((account) => ({ accountId: account.externalAccountId, label: `DeviantArt · ${account.externalUsername}` })),
              ...asset.destinationPublications.filter((publication) => publication.destination === 'deviantart').map((publication) => ({ accountId: publication.integrationAccountId, label: `DeviantArt · ${publication.accountLabel || 'disconnected account'}` })),
              ...asset.publicationIntents.filter((intent) => intent.destination === 'deviantart').map((intent) => ({ accountId: intent.integrationAccountId, label: `DeviantArt · ${accounts.find((account) => account.externalAccountId === intent.integrationAccountId)?.externalUsername || 'disconnected account'}` }))
            ].filter((row, index, rows) => rows.findIndex((candidate) => candidate.accountId === row.accountId) === index);
            const destinationRows = [
              ...(shownPlatforms.eversally ? [{ destination: 'eversally', accountId: undefined, label: brand.workspaceFullName }] : []),
              ...(shownPlatforms.deviantart ? daDestinationCandidates.map((row) => ({ destination: 'deviantart', ...row })) : [])
            ].map((row) => ({
              ...row,
              publication: asset.destinationPublications.find((publication) => publication.destination === row.destination && publication.integrationAccountId === row.accountId && publication.status !== 'removed'),
              intent: asset.publicationIntents.find((intent) => intent.enabled && intent.destination === row.destination && intent.integrationAccountId === row.accountId)
            }));
            const originLabel = asset.origin.type === 'import'
              ? `Imported from ${asset.origin.platform === 'deviantart' ? 'DeviantArt' : asset.origin.platform || 'an integration'}`
              : `Created in ${brand.productName}`;
            return (
              <article className="studio-work-row" key={asset.assetId}>
                <label className="studio-work-select" aria-label={`Select ${asset.canonicalTitle || 'work'}`}>
                  <input type="checkbox" checked={selectedDisplayedAssetIds.includes(asset.assetId)} onChange={(event) => toggleWorkSelection(asset.assetId, event.target.checked)} />
                </label>
                <WorkThumbnail asset={asset} />
                <div className="studio-work-details">
                  <strong>{asset.canonicalTitle || asset.publications[0]?.externalTitle || 'Untitled work'}</strong>
                  <span>{assetTypeLabel(asset)} · {originLabel}</span>
                  {asset.engagement && <div className="studio-work-engagement" title={asset.engagement.capturedAt ? `Updated ${new Date(asset.engagement.capturedAt).toLocaleString()}` : undefined}>
                    <span><strong>{engagementNumber(asset.engagement.views)}</strong> views</span>
                    <span><strong>{engagementNumber(asset.engagement.favourites)}</strong> favourites</span>
                    <span><strong>{engagementNumber(asset.engagement.comments)}</strong> comments</span>
                    <span><strong>{engagementNumber(asset.engagement.downloads)}</strong> downloads</span>
                  </div>}
                  <details className="studio-work-row-advanced">
                    <summary>Publishing intent</summary>
                  <div className="studio-work-destination-target">
                    <span>Publishing intent</span>
                    <label className="studio-work-intent-option">
                      <input type="checkbox" checked={spaceIntentEnabled} disabled={isDestinationUpdating} onChange={(event) => void setSpaceIntent(asset, event.target.checked)} />
                      <span>{brand.workspaceFullName}</span>
                    </label>
                    {accounts.length
                        ? <div>
                          {accounts.length > 1 && <select
                            value={selectedDestinationAccountId}
                            disabled={isDestinationUpdating}
                            aria-label={`Choose a DeviantArt destination for ${asset.canonicalTitle || 'this work'}`}
                            onChange={(event) => setDestinationAccountByAsset((current) => ({ ...current, [asset.assetId]: event.target.value }))}
                          >
                            <option value="">Choose an account…</option>
                            {accounts.map((account) => <option key={account.externalAccountId} value={account.externalAccountId}>{account.externalUsername}</option>)}
                          </select>}
                          {accounts.length === 1 && <small>{accounts[0].externalUsername}</small>}
                          <select
                            value={selectedDestinationStatus}
                            disabled={isDestinationUpdating}
                            aria-label={`Choose DeviantArt status for ${asset.canonicalTitle || 'this work'}`}
                            onChange={(event) => setDestinationStatusByAsset((current) => ({ ...current, [asset.assetId]: event.target.value as 'draft' | 'published' }))}
                          >
                            <option value="published">Published (default)</option>
                            <option value="draft">Draft in Sta.sh</option>
                          </select>
                          <button
                            type="button"
                            className="auth-secondary-btn"
                            disabled={isDestinationUpdating || !selectedDestinationAccountId}
                            onClick={() => void addDeviantArtDestination(asset, selectedDestinationAccountId, selectedDestinationStatus)}
                          >
                            {isDestinationUpdating ? 'Saving…' : 'Save DeviantArt intent'}
                          </button>
                        </div>
                        : <div><small>No connected account is available for this creator.</small><Link className="auth-secondary-btn no-underline" to={`/studio/workspace?section=integrations&creatorId=${encodeURIComponent(creatorId)}`}>Manage integrations</Link></div>}
                    {destinationMessageByAsset[asset.assetId] && <small className="studio-work-destination-message">{destinationMessageByAsset[asset.assetId]}</small>}
                  </div>
                  </details>
                  {remoteLifecycleIssues.map((publication) => <small className="studio-work-metadata-warning" key={`remote-state:${publication.externalPublicationId}`}>
                    @{publication.externalUsername} · {publication.syncStatus.replace(/_/g, ' ')}{publication.remoteStateReason ? ` — ${publication.remoteStateReason}` : ''}
                  </small>)}
                </div>
                <div className="studio-work-destination-column">
                  <div className="studio-work-destination-states">
                    <span>Destinations</span>
                    {destinationRows.map((row) => <div className="studio-work-destination-state" key={`${row.destination}:${row.accountId || 'space'}`}>
                      <div className="studio-work-destination-chip">
                        <span className={`studio-works-platform-dot ${row.destination === 'eversally' ? 'studio-works-platform-dot-space' : 'studio-works-platform-dot-deviantart'}`} />
                        <strong>{row.label}</strong>
                        <span className={`studio-work-destination-pill ${row.publication?.status === 'live' ? 'studio-destination-live' : row.publication?.status === 'failed' ? 'studio-destination-error' : ''}`}>
                          {row.publication
                            ? row.publication.destination === 'eversally' && row.publication.status === 'live' && row.publication.visibility === 'private'
                              ? 'Private · managers only'
                              : `${destinationStatusLabel(row.publication.status)}${row.publication.destination === 'eversally' ? ` · ${row.publication.visibility}` : ''}`
                            : 'Not published'}
                          {row.publication && row.publication.syncStatus !== 'in_sync' && row.publication.syncStatus !== 'not_applicable' ? ` · ${row.publication.syncStatus.replace(/_/g, ' ')}` : ''}
                        </span>
                      </div>
                      {row.intent && !row.publication && <small>Selected to publish as {row.intent.desiredStatus === 'draft' ? 'draft / staged' : row.intent.desiredStatus}</small>}
                    </div>)}
                  </div>
                </div>
                <div className="studio-work-actions">
                  {selectedCollection && manuallyAssigned && <span className="studio-work-membership">Added to this collection</span>}
                  <div className="studio-work-collection-summary">
                    <span>Collections</span>
                    {assignedCollections.length
                      ? <div>{assignedCollections.map((collection) => <span className="studio-work-collection-chip" key={collection.ubeeqCollectionId}>{collection.name}</span>)}</div>
                      : <small>Not in a collection</small>}
                  </div>
                  <Link
                    className="auth-secondary-btn no-underline"
                    to={workRoute(asset.assetId)}
                  >
                    {deviantArtDestinations.some((publication) => publication.syncStatus === 'pending_publish') || !asset.destinationPublications.some((publication) => publication.status === 'live')
                      ? 'Review & publish'
                      : 'Edit metadata'}
                  </Link>
                  <button
                    type="button"
                    className="auth-secondary-btn"
                    disabled={updatingAssetId === asset.assetId}
                    onClick={() => {
                      setCollectionPickerAssetId(isCollectionPickerOpen ? '' : asset.assetId);
                      setCollectionPickerQuery('');
                    }}
                  >
                    {isCollectionPickerOpen ? 'Done' : 'Collections'}
                  </button>
                  <Link
                    className="auth-secondary-btn no-underline"
                    to={workRoute(asset.assetId, 'activity')}
                  >
                    Activity
                  </Link>
                  {asset.destinationPublications.some((publication) => publication.destination === 'eversally' && publication.status === 'live' && publication.visibility !== 'private') && asset.canonicalSlug && activeCreator?.slug && <Link
                    className="auth-secondary-btn no-underline"
                    to={`/creators/${encodeURIComponent(activeCreator.slug)}/works/${encodeURIComponent(asset.canonicalSlug)}`}
                  >
                    Open public work
                  </Link>}
                </div>
                {isCollectionPickerOpen && <div className="studio-work-collection-picker">
                  <label>
                    <span>Filter collections</span>
                    <input value={collectionPickerQuery} onChange={(event) => setCollectionPickerQuery(event.target.value)} placeholder="Search collections…" autoFocus />
                  </label>
                  <div>
                    {visiblePickerCollections.map((collection) => {
                      const checked = (collections.collectionAssetIdsByCollection[collection.ubeeqCollectionId] || []).includes(asset.assetId);
                      return <label className="studio-work-collection-option" key={collection.ubeeqCollectionId}>
                        <input type="checkbox" checked={checked} disabled={updatingAssetId === asset.assetId} onChange={(event) => void setAssetCollectionMembership(asset, collection.ubeeqCollectionId, event.target.checked)} />
                        <span>{collection.name}</span>
                      </label>;
                    })}
                    {!visiblePickerCollections.length && <p className="small">No collections match this filter.</p>}
                  </div>
                </div>}
              </article>
            );
          })}
        </div>
        {pageCount > 1 && <nav className="studio-works-pagination studio-works-pagination-bottom" aria-label="Works pagination">
          <span>Showing {pageStart + 1}–{Math.min(pageStart + pageSize, visibleAssets.length)} of {visibleAssets.length} works</span>
          <div className="studio-works-pagination-actions">
            <button type="button" className="auth-secondary-btn" disabled={currentPage === 1} onClick={() => setPage((current) => Math.max(1, current - 1))}>Previous</button>
            <span>Page {currentPage} of {pageCount}</span>
            <button type="button" className="auth-secondary-btn" disabled={currentPage === pageCount} onClick={() => setPage((current) => Math.min(pageCount, current + 1))}>Next</button>
          </div>
        </nav>}
        {!loading && !visibleAssets.length && <div className="studio-empty-state">No works match this creator, collection, and search filter.</div>}
      </Card>
    </section>
  );
}
