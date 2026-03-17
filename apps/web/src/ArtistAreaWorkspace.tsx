import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { getCurrentUser } from './cognitoAuth';
import { api } from './api';
import {
  clearStoredWorkspace,
  readStoredWorkspace,
  slugify,
  uniqueSlug,
  writeStoredWorkspace,
  type ArtistAreaPanel,
  type StoredWorkspace
} from './artistAreaWorkspaceUtils';


type ManagedArtist = {
  artistId: string;
  name: string;
  slug: string;
  status: 'active' | 'inactive';
  sortOrder: number;
  discoverSquareCropEnabled?: boolean;
  defaultAiDisclosure?: AiDisclosure;
  defaultHeavyTopics?: HeavyTopic[];
};

type ManagedGallery = {
  galleryId: string;
  artistId: string;
  artistSlug?: string;
  title: string;
  slug: string;
  visibility: 'free' | 'preview' | 'premium';
  status: 'draft' | 'published';
  coverImageId?: string;
  pairedPremiumGalleryId?: string;
  purchaseUrl?: string;
  premiumPassword?: string;
  discoverSquareCropEnabled?: boolean;
  defaultAiDisclosure?: AiDisclosure;
  defaultHeavyTopics?: HeavyTopic[];
};

type ArtistMember = { userId: string; role: 'owner' | 'editor' | 'manager' };
type SiteSettings = { siteName: string; theme: 'ubeeq' | 'sand' | 'forest' | 'slate'; logoKey?: string; logoUrl?: string };
type AuditEvent = { auditId: string; time: string; action: string; actorUserId?: string; actorRole?: string };


type AiDisclosure = 'none' | 'ai-assisted' | 'ai-generated';
type HeavyTopic = 'politics-public-affairs' | 'crime-disasters-tragedy';
const aiDisclosureOptions: AiDisclosure[] = ['none', 'ai-assisted', 'ai-generated'];
const heavyTopicOptions: Array<{ value: HeavyTopic; label: string }> = [
  { value: 'politics-public-affairs', label: 'Politics & Public Affairs' },
  { value: 'crime-disasters-tragedy', label: 'Crime, Disasters & Tragedy' }
];

const legacyAdminParityChecklist: Array<{ area: string; status: 'migrated' | 'in-progress'; notes: string }> = [
  { area: 'Artists CRUD', status: 'migrated', notes: 'Create, edit, delete, and sort workflows are available in Artists panel.' },
  { area: 'Galleries CRUD', status: 'migrated', notes: 'Create/edit/delete plus visibility, premium pairing, purchase URL, and password updates.' },
  { area: 'Media CRUD', status: 'migrated', notes: 'Create/edit/delete, crop metadata, renditions, and set-as-cover from list and edit form.' },
  { area: 'Site settings', status: 'migrated', notes: 'Theme/site-name/logo upload actions are in Operations panel.' },
  { area: 'Moderation tools', status: 'migrated', notes: 'Comment status/delete and user block/unblock are in Operations panel.' },
  { area: 'Operational utilities', status: 'migrated', notes: 'Trending rebuild and audit log paging/filtering are in Operations panel.' },
  { area: 'Account auth screens', status: 'in-progress', notes: 'Password reset/change lives in main app account settings/auth flows, not in this workspace panel.' }
];

type ManagedMedia = {
  imageId: string;
  galleryId: string;
  sortOrder?: number;
  assetType?: 'image' | 'video';
  title?: string;
  originalFilename?: string;
  previewKey: string;
  premiumKey?: string;
  previewPosterKey?: string;
  premiumPosterKey?: string;
  width?: number;
  height?: number;
  durationSeconds?: number;
  discoverSquareCropEnabled?: boolean;
  aiDisclosure?: AiDisclosure;
  moderatorAiDisclosure?: AiDisclosure;
  heavyTopics?: HeavyTopic[];
  moderatorHeavyTopics?: HeavyTopic[];
  squareCrop?: { x: number; y: number; size: number };
  contentRating?: 'general' | 'suggestive' | 'mature' | 'sexual' | 'fetish' | 'graphic';
  moderatorContentRating?: 'general' | 'suggestive' | 'mature' | 'sexual' | 'fetish' | 'graphic';
};

export function ArtistAreaWorkspace() {
  const [artists, setArtists] = useState<ManagedArtist[]>([]);
  const [galleries, setGalleries] = useState<ManagedGallery[]>([]);
  const [myArtists, setMyArtists] = useState<Array<{ artistId: string; name: string; memberRole?: string }>>([]);
  const [media, setMedia] = useState<ManagedMedia[]>([]);
  const [mediaGalleryId, setMediaGalleryId] = useState(() => readStoredWorkspace().mediaGalleryId || '');
  const [artistQuery, setArtistQuery] = useState('');
  const [galleryQuery, setGalleryQuery] = useState('');
  const [galleryArtistFilter, setGalleryArtistFilter] = useState(() => readStoredWorkspace().galleryArtistFilter || 'all');
  const [mediaQuery, setMediaQuery] = useState('');
  const [mediaTypeFilter, setMediaTypeFilter] = useState<'all' | 'image' | 'video'>(() => readStoredWorkspace().mediaTypeFilter || 'all');
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [dangerMode, setDangerMode] = useState(() => Boolean(readStoredWorkspace().dangerMode));
  const [activePanel, setActivePanel] = useState<ArtistAreaPanel>(() => readStoredWorkspace().activePanel || 'overview');
  const [lastSyncedAt, setLastSyncedAt] = useState<string>('');
  const [artistForm, setArtistForm] = useState({ name: '', slug: '', sortOrder: 1, discoverSquareCropEnabled: true, defaultAiDisclosure: 'none' as AiDisclosure, defaultHeavyTopics: [] as HeavyTopic[] });
  const [galleryForm, setGalleryForm] = useState({
    artistId: '',
    artistSlug: '',
    title: '',
    slug: '',
    visibility: 'free' as ManagedGallery['visibility'],
    status: 'published' as ManagedGallery['status'],
    coverImageId: '',
    pairedPremiumGalleryId: '',
    purchaseUrl: '',
    premiumPassword: '',
    discoverSquareCropEnabled: true,
    defaultAiDisclosure: 'none' as AiDisclosure,
    defaultHeavyTopics: [] as HeavyTopic[]
  });
  const [coverGalleryId, setCoverGalleryId] = useState('');
  const [coverImageId, setCoverImageId] = useState('');
  const [editingArtistId, setEditingArtistId] = useState<string | null>(null);
  const [artistEditForm, setArtistEditForm] = useState({ name: '', slug: '', status: 'active' as ManagedArtist['status'], sortOrder: 1, discoverSquareCropEnabled: true, defaultAiDisclosure: 'none' as AiDisclosure, defaultHeavyTopics: [] as HeavyTopic[] });
  const [editingGalleryId, setEditingGalleryId] = useState<string | null>(null);
  const [galleryEditForm, setGalleryEditForm] = useState({
    artistId: '',
    artistSlug: '',
    title: '',
    slug: '',
    visibility: 'free' as ManagedGallery['visibility'],
    status: 'published' as ManagedGallery['status'],
    coverImageId: '',
    pairedPremiumGalleryId: '',
    purchaseUrl: '',
    premiumPassword: '',
    discoverSquareCropEnabled: true,
    defaultAiDisclosure: 'none' as AiDisclosure,
    defaultHeavyTopics: [] as HeavyTopic[]
  });
  const [editingMediaId, setEditingMediaId] = useState<string | null>(null);
  const [mediaEditForm, setMediaEditForm] = useState({
    galleryId: '',
    imageId: '',
    assetType: 'image' as 'image' | 'video',
    title: '',
    originalFilename: '',
    previewKey: '',
    premiumKey: '',
    previewPosterKey: '',
    premiumPosterKey: '',
    width: 0,
    height: 0,
    durationSeconds: 0,
    sortOrder: 1,
    contentRating: 'general' as NonNullable<ManagedMedia['contentRating']>,
    moderatorContentRating: '' as '' | NonNullable<ManagedMedia['contentRating']>,
    aiDisclosure: 'none' as AiDisclosure,
    moderatorAiDisclosure: '' as '' | AiDisclosure,
    heavyTopics: [] as HeavyTopic[],
    moderatorHeavyTopics: [] as HeavyTopic[],
    discoverSquareCropEnabled: true,
    cropX: 0,
    cropY: 0,
    cropSize: 512
  });
  const [membersArtistId, setMembersArtistId] = useState('');
  const [artistMembers, setArtistMembers] = useState<ArtistMember[]>([]);
  const [memberUserId, setMemberUserId] = useState('');
  const [memberRole, setMemberRole] = useState<ArtistMember['role']>('editor');
  const [siteSettings, setSiteSettings] = useState<SiteSettings>({ siteName: 'Ubeeq', theme: 'ubeeq' });
  const [commentId, setCommentId] = useState('');
  const [commentHidden, setCommentHidden] = useState(false);
  const [blockUserId, setBlockUserId] = useState('');
  const [blockReason, setBlockReason] = useState('');
  const [auditEvents, setAuditEvents] = useState<AuditEvent[]>([]);
  const [auditCursor, setAuditCursor] = useState('');
  const [auditNextCursor, setAuditNextCursor] = useState('');
  const [auditActionFilter, setAuditActionFilter] = useState('');
  const [auditActorFilter, setAuditActorFilter] = useState('');
  const currentUser = useMemo(() => getCurrentUser(), []);
  const isAdmin = Boolean(currentUser?.groups.includes('Admins'));
  const isArtist = Boolean(currentUser?.groups.includes('Artists'));
  const canManageContent = Boolean(isAdmin || isArtist);

  const [mediaForm, setMediaForm] = useState({
    galleryId: '',
    assetType: 'image' as 'image' | 'video',
    title: '',
    originalFilename: '',
    previewKey: '',
    premiumKey: '',
    previewPosterKey: '',
    premiumPosterKey: '',
    width: 1600,
    height: 1067,
    durationSeconds: 0,
    sortOrder: 1,
    contentRating: 'general' as ManagedMedia['contentRating'],
    moderatorContentRating: '' as '' | NonNullable<ManagedMedia['contentRating']>,
    aiDisclosure: 'none' as AiDisclosure,
    moderatorAiDisclosure: '' as '' | AiDisclosure,
    heavyTopics: [] as HeavyTopic[],
    moderatorHeavyTopics: [] as HeavyTopic[],
    cropX: 0,
    cropY: 0,
    cropSize: 512,
    discoverSquareCropEnabled: true
  });

  useEffect(() => {
    if (!message && !error) return;
    const t = window.setTimeout(() => {
      setMessage('');
      setError('');
    }, 4500);
    return () => window.clearTimeout(t);
  }, [message, error]);

  useEffect(() => {
    const payload: StoredWorkspace = {
      activePanel,
      dangerMode,
      galleryArtistFilter,
      mediaTypeFilter,
      mediaGalleryId
    };
    writeStoredWorkspace(payload);
  }, [activePanel, dangerMode, galleryArtistFilter, mediaTypeFilter, mediaGalleryId]);

  const availablePanels = useMemo<ArtistAreaPanel[]>(() => {
    const panels: ArtistAreaPanel[] = ['overview'];
    if (isAdmin) panels.push('artists');
    if (canManageContent) panels.push('galleries', 'media');
    if (isAdmin) panels.push('operations');
    return panels;
  }, [canManageContent, isAdmin]);

  useEffect(() => {
    if (!availablePanels.includes(activePanel)) {
      setActivePanel(availablePanels[0] || 'overview');
    }
  }, [activePanel, availablePanels]);

  const withFeedback = async (fn: () => Promise<void>) => {
    try {
      setError('');
      setMessage('');
      setSubmitting(true);
      await fn();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSubmitting(false);
    }
  };

  const load = async () => {
    setLoading(true);
    try {
      const [managed, allArtists, allGalleries, settings] = await Promise.all([
        api.getMyArtists(),
        api.adminListArtists(),
        api.adminListGalleries(),
        api.getSiteSettings()
      ]);
      setMyArtists((managed || []) as Array<{ artistId: string; name: string; memberRole?: string }>);
      setArtists((allArtists || []) as ManagedArtist[]);
      setGalleries((allGalleries || []) as ManagedGallery[]);
      const firstArtistId = (allArtists as ManagedArtist[])[0]?.artistId || '';
      const firstGalleryId = (allGalleries as ManagedGallery[])[0]?.galleryId || '';
      setGalleryForm((prev) => ({ ...prev, artistId: prev.artistId || firstArtistId, artistSlug: prev.artistSlug || ((allArtists as ManagedArtist[]).find((a) => a.artistId === (prev.artistId || firstArtistId))?.slug || '') }));
      setMediaGalleryId((prev) => prev || firstGalleryId);
      setMediaForm((prev) => ({ ...prev, galleryId: prev.galleryId || firstGalleryId }));
      setCoverGalleryId((prev) => prev || firstGalleryId);
      setMembersArtistId((prev) => prev || firstArtistId);
      setSiteSettings(settings as SiteSettings);
      const activeMediaGalleryId = mediaGalleryId || firstGalleryId;
      if (activeMediaGalleryId) {
        const mediaItems = await api.adminListGalleryMedia(activeMediaGalleryId);
        setMedia((mediaItems || []) as ManagedMedia[]);
      }
      setLastSyncedAt(new Date().toLocaleTimeString());
      setError('');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  };

  const loadMedia = async (galleryId: string) => {
    if (!galleryId) {
      setMedia([]);
      return;
    }
    try {
      const items = await api.adminListGalleryMedia(galleryId);
      setMedia((items || []) as ManagedMedia[]);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const readSquareCrop = (x: number, y: number, size: number) => ({
    x: Number(x) || 0,
    y: Number(y) || 0,
    size: Math.max(1, Number(size) || 1)
  });

  useEffect(() => {
    if (!mediaGalleryId) {
      setMedia([]);
      return;
    }
    void loadMedia(mediaGalleryId);
  }, [mediaGalleryId]);

  useEffect(() => {
    void load();
  }, []);

  useEffect(() => {
    if (!membersArtistId) {
      setArtistMembers([]);
      return;
    }
    void (async () => {
      try {
        const members = await api.adminListArtistMembers(membersArtistId);
        setArtistMembers((members || []) as ArtistMember[]);
      } catch (e) {
        setError((e as Error).message);
      }
    })();
  }, [membersArtistId]);

  const myArtistIds = useMemo(() => new Set(myArtists.map((item) => item.artistId)), [myArtists]);
  const artistSlugSet = useMemo(() => new Set(artists.map((item) => item.slug)), [artists]);
  const gallerySlugSet = useMemo(() => new Set(galleries.map((item) => item.slug)), [galleries]);

  const stats = useMemo(() => {
    const free = galleries.filter((g) => g.visibility === 'free').length;
    const preview = galleries.filter((g) => g.visibility === 'preview').length;
    const premium = galleries.filter((g) => g.visibility === 'premium').length;
    const videos = media.filter((m) => m.assetType === 'video').length;
    const images = media.filter((m) => (m.assetType || 'image') === 'image').length;
    return { free, preview, premium, videos, images };
  }, [galleries, media]);

  const visibleArtists = useMemo(() => artists
    .filter((artist) => {
      const q = artistQuery.trim().toLowerCase();
      if (!q) return true;
      return artist.name.toLowerCase().includes(q) || artist.slug.toLowerCase().includes(q);
    })
    .sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name)), [artists, artistQuery]);

  const visibleGalleries = useMemo(() => galleries
    .filter((gallery) => {
      if (galleryArtistFilter !== 'all' && gallery.artistId !== galleryArtistFilter) return false;
      const q = galleryQuery.trim().toLowerCase();
      if (!q) return true;
      return gallery.title.toLowerCase().includes(q) || gallery.slug.toLowerCase().includes(q);
    })
    .sort((a, b) => a.title.localeCompare(b.title)), [galleries, galleryArtistFilter, galleryQuery]);

  const visibleMedia = useMemo(() => media
    .filter((item) => {
      if (mediaTypeFilter !== 'all' && (item.assetType || 'image') !== mediaTypeFilter) return false;
      const q = mediaQuery.trim().toLowerCase();
      if (!q) return true;
      return (item.title || '').toLowerCase().includes(q)
        || item.imageId.toLowerCase().includes(q)
        || item.previewKey.toLowerCase().includes(q);
    }), [media, mediaQuery, mediaTypeFilter]);

  const startEditArtist = (artist: ManagedArtist) => {
    setEditingArtistId(artist.artistId);
    setArtistEditForm({ name: artist.name, slug: artist.slug, status: artist.status, sortOrder: artist.sortOrder, discoverSquareCropEnabled: artist.discoverSquareCropEnabled !== false, defaultAiDisclosure: artist.defaultAiDisclosure || 'none', defaultHeavyTopics: artist.defaultHeavyTopics || [] });
  };

  const saveArtistEdit = () => withFeedback(async () => {
    if (!editingArtistId) return;
    await api.updateArtist(editingArtistId, {
      name: artistEditForm.name.trim(),
      slug: slugify(artistEditForm.slug || artistEditForm.name),
      status: artistEditForm.status,
      sortOrder: Number(artistEditForm.sortOrder) || 1,
      discoverSquareCropEnabled: artistEditForm.discoverSquareCropEnabled,
      defaultAiDisclosure: artistEditForm.defaultAiDisclosure,
      defaultHeavyTopics: artistEditForm.defaultHeavyTopics
    });
    setEditingArtistId(null);
    setMessage('Artist updated.');
    await load();
  });

  const startEditGallery = (gallery: ManagedGallery) => {
    setEditingGalleryId(gallery.galleryId);
    setGalleryEditForm({
      artistId: gallery.artistId,
      artistSlug: gallery.artistSlug || '',
      title: gallery.title,
      slug: gallery.slug,
      visibility: gallery.visibility,
      status: gallery.status,
      coverImageId: gallery.coverImageId || '',
      pairedPremiumGalleryId: gallery.pairedPremiumGalleryId || '',
      purchaseUrl: gallery.purchaseUrl || '',
      premiumPassword: '',
      discoverSquareCropEnabled: gallery.discoverSquareCropEnabled !== false,
      defaultAiDisclosure: gallery.defaultAiDisclosure || 'none',
      defaultHeavyTopics: gallery.defaultHeavyTopics || []
    });
  };

  const saveGalleryEdit = () => withFeedback(async () => {
    if (!editingGalleryId) return;
    await api.adminUpdateGallery(editingGalleryId, {
      artistId: galleryEditForm.artistId || undefined,
      artistSlug: galleryEditForm.artistSlug.trim() || undefined,
      title: galleryEditForm.title.trim(),
      slug: slugify(galleryEditForm.slug || galleryEditForm.title),
      visibility: galleryEditForm.visibility,
      status: galleryEditForm.status,
      coverImageId: galleryEditForm.coverImageId.trim() || undefined,
      pairedPremiumGalleryId: galleryEditForm.pairedPremiumGalleryId.trim() || undefined,
      purchaseUrl: galleryEditForm.purchaseUrl.trim() || undefined,
      premiumPassword: galleryEditForm.premiumPassword.trim() || undefined,
      discoverSquareCropEnabled: galleryEditForm.discoverSquareCropEnabled,
      defaultAiDisclosure: galleryEditForm.defaultAiDisclosure,
      defaultHeavyTopics: galleryEditForm.defaultHeavyTopics
    });
    setEditingGalleryId(null);
    setMessage('Gallery updated.');
    await load();
  });

  const applyMediaToEditForm = (item: ManagedMedia) => {
    setMediaEditForm({
      galleryId: item.galleryId,
      imageId: item.imageId,
      assetType: item.assetType || 'image',
      title: item.title || '',
      originalFilename: item.originalFilename || '',
      previewKey: item.previewKey,
      premiumKey: item.premiumKey || '',
      previewPosterKey: item.previewPosterKey || '',
      premiumPosterKey: item.premiumPosterKey || '',
      width: item.width || 0,
      height: item.height || 0,
      durationSeconds: item.durationSeconds || 0,
      sortOrder: item.sortOrder || 1,
      contentRating: item.contentRating || 'general',
      moderatorContentRating: item.moderatorContentRating || '',
      aiDisclosure: item.aiDisclosure || 'none',
      moderatorAiDisclosure: item.moderatorAiDisclosure || '',
      heavyTopics: item.heavyTopics || [],
      moderatorHeavyTopics: item.moderatorHeavyTopics || [],
      discoverSquareCropEnabled: item.discoverSquareCropEnabled !== false,
      cropX: item.squareCrop?.x || 0,
      cropY: item.squareCrop?.y || 0,
      cropSize: item.squareCrop?.size || 512
    });
  };

  const startEditMedia = (item: ManagedMedia) => {
    setEditingMediaId(item.imageId);
    applyMediaToEditForm(item);
  };

  const hydrateMediaEditFromGallery = () => withFeedback(async () => {
    const trimmedImageId = mediaEditForm.imageId.trim();
    if (!mediaEditForm.galleryId || !trimmedImageId) throw new Error('Gallery and image ID are required');
    const items = await api.adminListGalleryMedia(mediaEditForm.galleryId) as ManagedMedia[];
    const found = (items || []).find((item) => item.imageId === trimmedImageId);
    if (!found) throw new Error('Image not found in selected gallery');
    setEditingMediaId(found.imageId);
    setMediaGalleryId(mediaEditForm.galleryId);
    applyMediaToEditForm(found);
    setMessage('Loaded media item into edit form.');
  });

  const setEditMediaAsGalleryCover = () => withFeedback(async () => {
    const targetImageId = mediaEditForm.imageId.trim() || editingMediaId;
    if (!mediaEditForm.galleryId || !targetImageId) throw new Error('Gallery and image ID are required');
    await api.adminUpdateGallery(mediaEditForm.galleryId, { coverImageId: targetImageId });
    setMessage(`Set ${targetImageId} as gallery cover.`);
    await load();
  });

  const saveMediaEdit = () => withFeedback(async () => {
    const targetImageId = mediaEditForm.imageId || editingMediaId;
    if (!targetImageId || !mediaEditForm.galleryId) return;
    await api.adminUpdateMedia(mediaEditForm.galleryId, targetImageId, {
      assetType: mediaEditForm.assetType,
      title: mediaEditForm.title.trim() || undefined,
      originalFilename: mediaEditForm.originalFilename.trim() || undefined,
      previewKey: mediaEditForm.previewKey.trim(),
      premiumKey: mediaEditForm.premiumKey.trim() || undefined,
      previewPosterKey: mediaEditForm.previewPosterKey.trim() || undefined,
      premiumPosterKey: mediaEditForm.premiumPosterKey.trim() || undefined,
      width: Number(mediaEditForm.width) || undefined,
      height: Number(mediaEditForm.height) || undefined,
      durationSeconds: Number(mediaEditForm.durationSeconds) || undefined,
      sortOrder: Number(mediaEditForm.sortOrder) || 1,
      contentRating: mediaEditForm.contentRating,
      moderatorContentRating: mediaEditForm.moderatorContentRating || undefined,
      aiDisclosure: mediaEditForm.aiDisclosure,
      moderatorAiDisclosure: mediaEditForm.moderatorAiDisclosure || undefined,
      heavyTopics: mediaEditForm.heavyTopics,
      moderatorHeavyTopics: mediaEditForm.moderatorHeavyTopics,
      discoverSquareCropEnabled: mediaEditForm.discoverSquareCropEnabled,
      squareCrop: mediaEditForm.assetType === 'image'
        ? readSquareCrop(mediaEditForm.cropX, mediaEditForm.cropY, mediaEditForm.cropSize)
        : undefined
    });
    setEditingMediaId(null);
    setMessage('Media updated.');
    await loadMedia(mediaEditForm.galleryId);
  });

  const addArtistMember = () => withFeedback(async () => {
    if (!membersArtistId || !memberUserId.trim()) throw new Error('Artist and user ID are required');
    await api.adminAddArtistMember(membersArtistId, { userId: memberUserId.trim(), role: memberRole });
    const members = await api.adminListArtistMembers(membersArtistId);
    setArtistMembers((members || []) as ArtistMember[]);
    setMemberUserId('');
    setMessage('Artist member added.');
  });

  const removeArtistMember = (userId: string) => withFeedback(async () => {
    if (!membersArtistId) throw new Error('Artist is required');
    if (!dangerMode) throw new Error('Enable Danger Mode to remove members.');
    if (!window.confirm(`Remove member "${userId}" from this artist?`)) return;
    await api.adminRemoveArtistMember(membersArtistId, userId);
    const members = await api.adminListArtistMembers(membersArtistId);
    setArtistMembers((members || []) as ArtistMember[]);
    setMessage('Artist member removed.');
  });

  const createArtist = () => withFeedback(async () => {
    const rawSlug = slugify(artistForm.slug || artistForm.name);
    if (!artistForm.name.trim() || !rawSlug) throw new Error('Name and slug are required');
    const slug = uniqueSlug(rawSlug, artistSlugSet);
    await api.adminCreateArtist({
      name: artistForm.name.trim(),
      slug,
      status: 'active',
      sortOrder: Number(artistForm.sortOrder) || 1,
      discoverSquareCropEnabled: artistForm.discoverSquareCropEnabled,
      defaultAiDisclosure: artistForm.defaultAiDisclosure,
      defaultHeavyTopics: artistForm.defaultHeavyTopics
    });
    setArtistForm({ name: '', slug: '', sortOrder: 1, discoverSquareCropEnabled: true, defaultAiDisclosure: 'none', defaultHeavyTopics: [] });
    setMessage(`Artist created (${slug}).`);
    await load();
  });

  const createGallery = () => withFeedback(async () => {
    const rawSlug = slugify(galleryForm.slug || galleryForm.title);
    if (!galleryForm.artistId || !galleryForm.title.trim() || !rawSlug) {
      throw new Error('Artist, title, and slug are required');
    }
    const artist = artists.find((item) => item.artistId === galleryForm.artistId);
    const slug = uniqueSlug(rawSlug, gallerySlugSet);
    await api.adminCreateGallery({
      artistId: galleryForm.artistId,
      artistSlug: galleryForm.artistSlug.trim() || artist?.slug || '',
      title: galleryForm.title.trim(),
      slug,
      visibility: galleryForm.visibility,
      status: galleryForm.status,
      coverImageId: galleryForm.coverImageId.trim() || undefined,
      pairedPremiumGalleryId: galleryForm.pairedPremiumGalleryId.trim() || undefined,
      purchaseUrl: galleryForm.purchaseUrl.trim() || undefined,
      premiumPassword: galleryForm.premiumPassword.trim() || undefined,
      discoverSquareCropEnabled: galleryForm.discoverSquareCropEnabled,
      defaultAiDisclosure: galleryForm.defaultAiDisclosure,
      defaultHeavyTopics: galleryForm.defaultHeavyTopics
    });
    setGalleryForm((prev) => ({ ...prev, artistSlug: '', title: '', slug: '', coverImageId: '', pairedPremiumGalleryId: '', purchaseUrl: '', premiumPassword: '', discoverSquareCropEnabled: true, defaultAiDisclosure: 'none', defaultHeavyTopics: [] }));
    setMessage(`Gallery created (${slug}).`);
    await load();
  });

  const setGalleryCover = () => withFeedback(async () => {
    if (!coverGalleryId || !coverImageId.trim()) throw new Error('Gallery and cover image ID are required');
    await api.adminUpdateGallery(coverGalleryId, { coverImageId: coverImageId.trim() });
    setMessage('Gallery cover image updated.');
    await load();
  });

  const generateMediaRenditions = (item: ManagedMedia) => withFeedback(async () => {
    if ((item.assetType || 'image') !== 'image') throw new Error('Renditions only apply to images');
    await api.adminGenerateMediaRenditions(item.galleryId, item.imageId);
    setMessage(`Renditions generated for ${item.imageId}.`);
    await loadMedia(item.galleryId);
  });

  const generateEditMediaRenditions = () => withFeedback(async () => {
    const targetImageId = mediaEditForm.imageId || editingMediaId;
    if (!targetImageId || !mediaEditForm.galleryId) throw new Error('Media item is required');
    if (mediaEditForm.assetType !== 'image') throw new Error('Renditions only apply to images');
    await api.adminGenerateMediaRenditions(mediaEditForm.galleryId, targetImageId, {
      squareCrop: readSquareCrop(mediaEditForm.cropX, mediaEditForm.cropY, mediaEditForm.cropSize)
    });
    setMessage(`Renditions generated for ${targetImageId}.`);
    await loadMedia(mediaEditForm.galleryId);
  });
  const setMediaAsGalleryCover = (item: ManagedMedia) => withFeedback(async () => {
    await api.adminUpdateGallery(item.galleryId, { coverImageId: item.imageId });
    setMessage(`Set ${item.imageId} as gallery cover.`);
    await load();
  });


  const createMedia = () => withFeedback(async () => {
    if (!mediaForm.galleryId || !mediaForm.previewKey.trim()) {
      throw new Error('Gallery and preview key are required');
    }
    await api.adminCreateMedia({
      galleryId: mediaForm.galleryId,
      assetType: mediaForm.assetType,
      title: mediaForm.title.trim() || undefined,
      originalFilename: mediaForm.originalFilename.trim() || undefined,
      previewKey: mediaForm.previewKey.trim(),
      premiumKey: mediaForm.premiumKey.trim() || undefined,
      previewPosterKey: mediaForm.previewPosterKey.trim() || undefined,
      premiumPosterKey: mediaForm.premiumPosterKey.trim() || undefined,
      width: Number(mediaForm.width) || undefined,
      height: Number(mediaForm.height) || undefined,
      durationSeconds: Number(mediaForm.durationSeconds) || undefined,
      sortOrder: Number(mediaForm.sortOrder) || 1,
      contentRating: mediaForm.contentRating || 'general',
      moderatorContentRating: mediaForm.moderatorContentRating || undefined,
      aiDisclosure: mediaForm.aiDisclosure,
      moderatorAiDisclosure: mediaForm.moderatorAiDisclosure || undefined,
      heavyTopics: mediaForm.heavyTopics,
      moderatorHeavyTopics: mediaForm.moderatorHeavyTopics,
      discoverSquareCropEnabled: mediaForm.discoverSquareCropEnabled,
      squareCrop: mediaForm.assetType === 'image'
        ? readSquareCrop(mediaForm.cropX, mediaForm.cropY, mediaForm.cropSize)
        : undefined
    });
    setMessage('Media created.');
    setMediaForm((prev) => ({ ...prev, title: '', originalFilename: '', previewKey: '', premiumKey: '', previewPosterKey: '', premiumPosterKey: '', moderatorContentRating: '', moderatorAiDisclosure: '', heavyTopics: [], moderatorHeavyTopics: [], cropX: 0, cropY: 0, cropSize: 512, discoverSquareCropEnabled: true }));
    setMediaGalleryId(mediaForm.galleryId);
    await loadMedia(mediaForm.galleryId);
  });

  const deleteArtist = (artist: ManagedArtist) => withFeedback(async () => {
    if (!dangerMode) throw new Error('Enable Danger Mode to delete records.');
    if (!window.confirm(`Delete artist \"${artist.name}\"? This cannot be undone.`)) return;
    await api.adminDeleteArtist(artist.artistId);
    setMessage('Artist deleted.');
    await load();
  });

  const deleteGallery = (gallery: ManagedGallery) => withFeedback(async () => {
    if (!dangerMode) throw new Error('Enable Danger Mode to delete records.');
    if (!window.confirm(`Delete gallery \"${gallery.title}\"? This cannot be undone.`)) return;
    await api.adminDeleteGallery(gallery.galleryId);
    setMessage('Gallery deleted.');
    await load();
  });

  const deleteMedia = (item: ManagedMedia) => withFeedback(async () => {
    if (!dangerMode) throw new Error('Enable Danger Mode to delete records.');
    if (!window.confirm(`Delete media \"${item.imageId}\"?`)) return;
    await api.adminDeleteMedia(item.galleryId, item.imageId, item.sortOrder || 0);
    setMessage('Media deleted.');
    await loadMedia(item.galleryId);
  });

  const saveSiteSettings = () => withFeedback(async () => {
    const updated = await api.adminUpdateSiteSettings(siteSettings);
    setSiteSettings(updated as SiteSettings);
    setMessage('Site settings saved.');
  });
  const uploadLogo = (file: File | null) => withFeedback(async () => {
    if (!file) return;
    const upload = await api.adminCreateSiteSettingsLogoUploadUrl(file.type || 'image/png') as { uploadUrl: string; contentType?: string; key: string };
    const putResponse = await fetch(upload.uploadUrl, {
      method: 'PUT',
      headers: { 'Content-Type': upload.contentType || file.type || 'image/png' },
      body: file
    });
    if (!putResponse.ok) throw new Error('Logo upload failed');
    setSiteSettings((prev) => ({ ...prev, logoKey: upload.key }));
    setMessage('Logo uploaded. Save site settings to publish.');
  });

  const moderateComment = () => withFeedback(async () => {
    if (!commentId.trim()) throw new Error('Comment ID is required');
    await api.adminSetCommentStatus(commentId.trim(), { hidden: commentHidden });
    setMessage('Comment status updated.');
  });

  const removeComment = () => withFeedback(async () => {
    if (!commentId.trim()) throw new Error('Comment ID is required');
    await api.adminDeleteComment(commentId.trim());
    setMessage('Comment deleted.');
  });

  const blockUser = () => withFeedback(async () => {
    if (!blockUserId.trim()) throw new Error('User ID is required');
    await api.adminBlockUser(blockUserId.trim(), blockReason.trim() || undefined);
    setMessage('User blocked.');
  });

  const unblockUser = () => withFeedback(async () => {
    if (!blockUserId.trim()) throw new Error('User ID is required');
    await api.adminUnblockUser(blockUserId.trim());
    setMessage('User unblocked.');
  });

  const loadAudit = () => withFeedback(async () => {
    const page = await api.adminGetAudit(40, auditCursor || undefined, { action: auditActionFilter.trim() || undefined, actorUserId: auditActorFilter.trim() || undefined });
    setAuditEvents((page.items || []) as AuditEvent[]);
    setAuditNextCursor(page.nextCursor || '');
    setMessage('Audit loaded.');
  });

  const rebuildTrending = () => withFeedback(async () => {
    const result = await api.adminRebuildTrending() as { durationMs?: number };
    setMessage(`Trending rebuild completed${result.durationMs ? ` in ${result.durationMs}ms` : ''}.`);
  });

  const exportSnapshot = () => {
    const payload = {
      exportedAt: new Date().toISOString(),
      artists: visibleArtists,
      galleries: visibleGalleries,
      media: visibleMedia
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `artist-area-snapshot-${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(url);
    setMessage('Snapshot exported.');
  };

  return (
    <div className="layout discovery-layout">
      <section className="panel">
        <p className="small">Artist Area / Studio</p>
        <h1>Upload & Content Management</h1>
        <p className="small">This is the integrated in-app workspace for artist/admin operations.</p>
        <p className="small">Signed in as: <strong>{currentUser?.displayName || currentUser?.username || 'unknown user'}</strong> · Groups: {(currentUser?.groups || []).join(', ') || 'none'}</p>
        <div className="inline-form" style={{ gap: 12, alignItems: 'center' }}>
          <Link to="/artist-area" className="auth-secondary-btn no-underline">Back to Artist Area</Link>
          <button onClick={() => void load()} disabled={loading}>{loading ? 'Refreshing…' : 'Refresh data'}</button>
          <button onClick={exportSnapshot}>Export snapshot JSON</button>
          <label className="small" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <input type="checkbox" checked={dangerMode} onChange={(e) => setDangerMode(e.target.checked)} />
            Danger Mode (enable delete)
          </label>
          <button onClick={() => {
            clearStoredWorkspace();
            setActivePanel('overview');
            setDangerMode(false);
            setGalleryArtistFilter('all');
            setMediaTypeFilter('all');
            setMediaGalleryId('');
            setMessage('Workspace preferences reset.');
          }}>Reset workspace prefs</button>
          <p className="small">{lastSyncedAt ? `Last synced at ${lastSyncedAt}` : 'Not synced yet'}</p>
        </div>
        <div className="inline-form" style={{ gap: 8 }}>
          {availablePanels.includes('overview') && <button onClick={() => setActivePanel('overview')} className={activePanel === 'overview' ? 'auth-primary-btn' : 'auth-secondary-btn'}>Overview</button>}
          {availablePanels.includes('artists') && <button onClick={() => setActivePanel('artists')} className={activePanel === 'artists' ? 'auth-primary-btn' : 'auth-secondary-btn'}>Artists</button>}
          {availablePanels.includes('galleries') && <button onClick={() => setActivePanel('galleries')} className={activePanel === 'galleries' ? 'auth-primary-btn' : 'auth-secondary-btn'}>Galleries</button>}
          {availablePanels.includes('media') && <button onClick={() => setActivePanel('media')} className={activePanel === 'media' ? 'auth-primary-btn' : 'auth-secondary-btn'}>Media</button>}
          {availablePanels.includes('operations') && <button onClick={() => setActivePanel('operations')} className={activePanel === 'operations' ? 'auth-primary-btn' : 'auth-secondary-btn'}>Operations</button>}
        </div>
      </section>

      {activePanel === 'overview' && (
        <section className="panel artist-public-grid">
          <article>
            <h3>Workspace metrics</h3>
            <ul>
              <li>Artists: {artists.length}</li>
              <li>Galleries: {galleries.length}</li>
              <li>Visible media in selection: {media.length}</li>
            </ul>
          </article>
          <article>
            <h3>Gallery visibility mix</h3>
            <ul>
              <li>Free: {stats.free}</li>
              <li>Preview: {stats.preview}</li>
              <li>Premium: {stats.premium}</li>
            </ul>
          </article>
          <article>
            <h3>Media type mix</h3>
            <ul>
              <li>Images: {stats.images}</li>
              <li>Videos: {stats.videos}</li>
            </ul>
          </article>
          <article>
            <h3>Workspace coverage</h3>
            <ul>
              {legacyAdminParityChecklist.map((item) => (
                <li key={item.area}>
                  <strong>{item.status === 'migrated' ? '✅' : '🟡'} {item.area}:</strong> {item.notes}
                </li>
              ))}
            </ul>
          </article>
        </section>
      )}

      {activePanel === 'artists' && isAdmin && (
        <>
          <section className="panel artist-public-grid">
            <article>
              <h3>Create artist</h3>
              <div className="inline-form"><input placeholder="Name" value={artistForm.name} onChange={(e) => setArtistForm({ ...artistForm, name: e.target.value, slug: artistForm.slug || slugify(e.target.value) })} /></div>
              <div className="inline-form"><input placeholder="Slug" value={artistForm.slug} onChange={(e) => setArtistForm({ ...artistForm, slug: slugify(e.target.value) })} /></div>
              <div className="inline-form"><input type="number" placeholder="Sort order" value={artistForm.sortOrder} onChange={(e) => setArtistForm({ ...artistForm, sortOrder: Number(e.target.value || 1) })} /></div>
              <label className="small" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><input type="checkbox" checked={artistForm.discoverSquareCropEnabled} onChange={(e) => setArtistForm({ ...artistForm, discoverSquareCropEnabled: e.target.checked })} /> Allow square crop in discovery</label>
              <div className="inline-form"><select value={artistForm.defaultAiDisclosure} onChange={(e) => setArtistForm({ ...artistForm, defaultAiDisclosure: e.target.value as AiDisclosure })}>{aiDisclosureOptions.map((opt) => <option key={opt} value={opt}>{opt}</option>)}</select></div>
              <div className="inline-form" style={{ gap: 10, flexWrap: 'wrap' }}>{heavyTopicOptions.map((topic) => (<label key={topic.value} className="small" style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}><input type="checkbox" checked={artistForm.defaultHeavyTopics.includes(topic.value)} onChange={(e) => setArtistForm({ ...artistForm, defaultHeavyTopics: e.target.checked ? Array.from(new Set([...artistForm.defaultHeavyTopics, topic.value])) : artistForm.defaultHeavyTopics.filter((v) => v !== topic.value) })} />{topic.label}</label>))}</div>
              <div className="inline-form" style={{ gap: 8 }}>
                <button onClick={() => void createArtist()} disabled={submitting}>Create artist</button>
                <button onClick={() => setArtistForm({ name: '', slug: '', sortOrder: 1, discoverSquareCropEnabled: true, defaultAiDisclosure: 'none', defaultHeavyTopics: [] })} disabled={submitting}>Reset</button>
              </div>
            </article>
            <article>
              <h3>Your artist memberships</h3>
              {myArtists.length ? <ul>{myArtists.map((a) => <li key={a.artistId}>{a.name} ({a.memberRole || 'editor'})</li>)}</ul> : <p className="small">No artist memberships found.</p>}
            </article>
            <article>
              <h3>Artist members</h3>
              <div className="inline-form">
                <select value={membersArtistId} onChange={(e) => setMembersArtistId(e.target.value)}>
                  <option value="">Select artist</option>
                  {artists.map((artist) => <option key={`members-${artist.artistId}`} value={artist.artistId}>{artist.name}</option>)}
                </select>
              </div>
              <div className="inline-form" style={{ gap: 8 }}>
                <input placeholder="User ID" value={memberUserId} onChange={(e) => setMemberUserId(e.target.value)} />
                <select value={memberRole} onChange={(e) => setMemberRole(e.target.value as ArtistMember['role'])}>
                  <option value="owner">owner</option>
                  <option value="manager">manager</option>
                  <option value="editor">editor</option>
                </select>
              </div>
              <div className="inline-form"><button onClick={() => void addArtistMember()} disabled={submitting}>Add member</button></div>
              <ul>
                {artistMembers.map((member) => (
                  <li key={member.userId}>{member.userId} ({member.role})<button style={{ marginLeft: 8 }} onClick={() => void removeArtistMember(member.userId)} disabled={submitting}>Remove</button></li>
                ))}
                {!artistMembers.length && <li className="small">No members found for selected artist.</li>}
              </ul>
            </article>
            <article>
              <h3>Search and manage</h3>
              <div className="inline-form"><input placeholder="Search artists" value={artistQuery} onChange={(e) => setArtistQuery(e.target.value)} /></div>
              <button onClick={() => setArtistQuery('')}>Clear search</button>
            </article>
          </section>
          <section className="panel">
            <h2>Artists ({visibleArtists.length})</h2>
            {loading ? <p className="small">Loading…</p> : (
              <ul>
                {visibleArtists.map((artist) => (
                  <li key={artist.artistId}>
                    <strong>{artist.name}</strong> ({artist.slug}) · {artist.status}
                    {myArtistIds.has(artist.artistId) ? ' · managed by you' : ''}
                    <button style={{ marginLeft: 8 }} onClick={() => startEditArtist(artist)} disabled={submitting}>Edit</button>
                    <button style={{ marginLeft: 8 }} onClick={() => void deleteArtist(artist)} disabled={submitting}>Delete</button>
                  </li>
                ))}
              </ul>
            )}
          </section>
          {editingArtistId && (
            <section className="panel">
              <h3>Edit artist</h3>
              <div className="inline-form"><input placeholder="Name" value={artistEditForm.name} onChange={(e) => setArtistEditForm({ ...artistEditForm, name: e.target.value })} /></div>
              <div className="inline-form"><input placeholder="Slug" value={artistEditForm.slug} onChange={(e) => setArtistEditForm({ ...artistEditForm, slug: slugify(e.target.value) })} /></div>
              <div className="inline-form"><input type="number" placeholder="Sort order" value={artistEditForm.sortOrder} onChange={(e) => setArtistEditForm({ ...artistEditForm, sortOrder: Number(e.target.value || 1) })} /></div>
              <div className="inline-form"><select value={artistEditForm.status} onChange={(e) => setArtistEditForm({ ...artistEditForm, status: e.target.value as ManagedArtist['status'] })}><option value="active">active</option><option value="inactive">inactive</option></select></div>
              <label className="small" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><input type="checkbox" checked={artistEditForm.discoverSquareCropEnabled} onChange={(e) => setArtistEditForm({ ...artistEditForm, discoverSquareCropEnabled: e.target.checked })} /> Allow square crop in discovery</label>
              <div className="inline-form"><select value={artistEditForm.defaultAiDisclosure} onChange={(e) => setArtistEditForm({ ...artistEditForm, defaultAiDisclosure: e.target.value as AiDisclosure })}>{aiDisclosureOptions.map((opt) => <option key={`ae-${opt}`} value={opt}>{opt}</option>)}</select></div>
              <div className="inline-form" style={{ gap: 10, flexWrap: 'wrap' }}>{heavyTopicOptions.map((topic) => (<label key={`ae-${topic.value}`} className="small" style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}><input type="checkbox" checked={artistEditForm.defaultHeavyTopics.includes(topic.value)} onChange={(e) => setArtistEditForm({ ...artistEditForm, defaultHeavyTopics: e.target.checked ? Array.from(new Set([...artistEditForm.defaultHeavyTopics, topic.value])) : artistEditForm.defaultHeavyTopics.filter((v) => v !== topic.value) })} />{topic.label}</label>))}</div>
              <div className="inline-form" style={{ gap: 8 }}><button onClick={() => void saveArtistEdit()} disabled={submitting}>Save artist</button><button onClick={() => setEditingArtistId(null)} disabled={submitting}>Cancel</button></div>
            </section>
          )}
        </>
      )}

      {activePanel === 'galleries' && canManageContent && (
        <>
          <section className="panel artist-public-grid">
            <article>
              <h3>Create gallery</h3>
              <div className="inline-form">
                <select value={galleryForm.artistId} onChange={(e) => {
                  const artistId = e.target.value;
                  const artist = artists.find((item) => item.artistId === artistId);
                  setGalleryForm({ ...galleryForm, artistId, artistSlug: artist?.slug || '' });
                }}>
                  <option value="">Select artist</option>
                  {artists.map((artist) => <option key={artist.artistId} value={artist.artistId}>{artist.name}</option>)}
                </select>
              </div>
              <div className="inline-form"><input placeholder="Artist slug (optional override)" value={galleryForm.artistSlug} onChange={(e) => setGalleryForm({ ...galleryForm, artistSlug: slugify(e.target.value) })} /></div>
              <div className="inline-form"><input placeholder="Title" value={galleryForm.title} onChange={(e) => setGalleryForm({ ...galleryForm, title: e.target.value, slug: galleryForm.slug || slugify(e.target.value) })} /></div>
              <div className="inline-form"><input placeholder="Slug" value={galleryForm.slug} onChange={(e) => setGalleryForm({ ...galleryForm, slug: slugify(e.target.value) })} /></div>
              <div className="inline-form">
                <select value={galleryForm.visibility} onChange={(e) => setGalleryForm({ ...galleryForm, visibility: e.target.value as ManagedGallery['visibility'] })}>
                  <option value="free">Free</option><option value="preview">Preview</option><option value="premium">Premium</option>
                </select>
              </div>
              <div className="inline-form">
                <select value={galleryForm.status} onChange={(e) => setGalleryForm({ ...galleryForm, status: e.target.value as ManagedGallery['status'] })}>
                  <option value="published">Published</option><option value="draft">Draft</option>
                </select>
              </div>
              <div className="inline-form"><input placeholder="Cover image ID (optional)" value={galleryForm.coverImageId} onChange={(e) => setGalleryForm({ ...galleryForm, coverImageId: e.target.value })} /></div>
              <div className="inline-form"><input placeholder="Paired premium gallery ID (optional)" value={galleryForm.pairedPremiumGalleryId} onChange={(e) => setGalleryForm({ ...galleryForm, pairedPremiumGalleryId: e.target.value })} /></div>
              <div className="inline-form"><input placeholder="Purchase URL (optional)" value={galleryForm.purchaseUrl} onChange={(e) => setGalleryForm({ ...galleryForm, purchaseUrl: e.target.value })} /></div>
              <div className="inline-form"><input type="password" placeholder="Premium password (optional)" value={galleryForm.premiumPassword} onChange={(e) => setGalleryForm({ ...galleryForm, premiumPassword: e.target.value })} /></div>
              <label className="small" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><input type="checkbox" checked={galleryForm.discoverSquareCropEnabled} onChange={(e) => setGalleryForm({ ...galleryForm, discoverSquareCropEnabled: e.target.checked })} /> Allow square crop in discovery</label>
              <div className="inline-form"><select value={galleryForm.defaultAiDisclosure} onChange={(e) => setGalleryForm({ ...galleryForm, defaultAiDisclosure: e.target.value as AiDisclosure })}>{aiDisclosureOptions.map((opt) => <option key={`g-${opt}`} value={opt}>{opt}</option>)}</select></div>
              <div className="inline-form" style={{ gap: 10, flexWrap: 'wrap' }}>{heavyTopicOptions.map((topic) => (<label key={`g-${topic.value}`} className="small" style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}><input type="checkbox" checked={galleryForm.defaultHeavyTopics.includes(topic.value)} onChange={(e) => setGalleryForm({ ...galleryForm, defaultHeavyTopics: e.target.checked ? Array.from(new Set([...galleryForm.defaultHeavyTopics, topic.value])) : galleryForm.defaultHeavyTopics.filter((v) => v !== topic.value) })} />{topic.label}</label>))}</div>
              <div className="inline-form" style={{ gap: 8 }}>
                <button onClick={() => void createGallery()} disabled={submitting}>Create gallery</button>
                <button onClick={() => setGalleryForm((prev) => ({ ...prev, artistSlug: '', title: '', slug: '', coverImageId: '', pairedPremiumGalleryId: '', purchaseUrl: '', premiumPassword: '' }))} disabled={submitting}>Reset</button>
              </div>
            </article>
            <article>
              <h3>Search/filter galleries</h3>
              <div className="inline-form"><input placeholder="Search galleries" value={galleryQuery} onChange={(e) => setGalleryQuery(e.target.value)} /></div>
              <div className="inline-form">
                <select value={galleryArtistFilter} onChange={(e) => setGalleryArtistFilter(e.target.value)}>
                  <option value="all">All artists</option>
                  {artists.map((artist) => <option key={`filter-${artist.artistId}`} value={artist.artistId}>{artist.name}</option>)}
                </select>
              </div>
              <button onClick={() => { setGalleryQuery(''); setGalleryArtistFilter('all'); }}>Clear filters</button>
            </article>
            <article>
              <h3>Set gallery cover image</h3>
              <div className="inline-form">
                <select value={coverGalleryId} onChange={(e) => setCoverGalleryId(e.target.value)}>
                  <option value="">Select gallery</option>
                  {galleries.map((gallery) => <option key={`cover-${gallery.galleryId}`} value={gallery.galleryId}>{gallery.title}</option>)}
                </select>
              </div>
              <div className="inline-form"><input placeholder="Cover image ID" value={coverImageId} onChange={(e) => setCoverImageId(e.target.value)} /></div>
              <button onClick={() => void setGalleryCover()} disabled={submitting}>Save cover image</button>
            </article>
            <article>
              <h3>Migration status (next ten)</h3>
              <ul>
                <li>✅ Panelized workspace navigation</li>
                <li>✅ Persisted workspace preferences</li>
                <li>✅ Snapshot export</li>
                <li>✅ Danger mode guardrails</li>
                <li>✅ Auto-clearing alerts</li>
                <li>✅ Slug conflict avoidance</li>
                <li>✅ Visibility metrics</li>
                <li>✅ Media mix metrics</li>
                <li>✅ Filter clear actions</li>
                <li>✅ Stronger error surfacing</li>
                <li>✅ Delete actions kept in-app</li>
                <li>✅ Workspace preference reset action</li>
              </ul>
            </article>
          </section>
          {editingGalleryId && (
            <section className="panel">
              <h3>Edit gallery</h3>
              <div className="inline-form">
                <select value={galleryEditForm.artistId} onChange={(e) => {
                  const artistId = e.target.value;
                  const artist = artists.find((item) => item.artistId === artistId);
                  setGalleryEditForm({ ...galleryEditForm, artistId, artistSlug: artist?.slug || galleryEditForm.artistSlug });
                }}>
                  <option value="">Select artist</option>
                  {artists.map((artist) => <option key={`edit-artist-${artist.artistId}`} value={artist.artistId}>{artist.name}</option>)}
                </select>
              </div>
              <div className="inline-form"><input placeholder="Artist slug (optional)" value={galleryEditForm.artistSlug} onChange={(e) => setGalleryEditForm({ ...galleryEditForm, artistSlug: slugify(e.target.value) })} /></div>
              <div className="inline-form"><input placeholder="Title" value={galleryEditForm.title} onChange={(e) => setGalleryEditForm({ ...galleryEditForm, title: e.target.value })} /></div>
              <div className="inline-form"><input placeholder="Slug" value={galleryEditForm.slug} onChange={(e) => setGalleryEditForm({ ...galleryEditForm, slug: slugify(e.target.value) })} /></div>
              <div className="inline-form"><select value={galleryEditForm.visibility} onChange={(e) => setGalleryEditForm({ ...galleryEditForm, visibility: e.target.value as ManagedGallery['visibility'] })}><option value="free">free</option><option value="preview">preview</option><option value="premium">premium</option></select></div>
              <div className="inline-form"><select value={galleryEditForm.status} onChange={(e) => setGalleryEditForm({ ...galleryEditForm, status: e.target.value as ManagedGallery['status'] })}><option value="draft">draft</option><option value="published">published</option></select></div>
              <div className="inline-form"><input placeholder="Cover image ID" value={galleryEditForm.coverImageId} onChange={(e) => setGalleryEditForm({ ...galleryEditForm, coverImageId: e.target.value })} /></div>
              <div className="inline-form"><input placeholder="Paired premium gallery ID" value={galleryEditForm.pairedPremiumGalleryId} onChange={(e) => setGalleryEditForm({ ...galleryEditForm, pairedPremiumGalleryId: e.target.value })} /></div>
              <div className="inline-form"><input placeholder="Purchase URL" value={galleryEditForm.purchaseUrl} onChange={(e) => setGalleryEditForm({ ...galleryEditForm, purchaseUrl: e.target.value })} /></div>
              <div className="inline-form"><input type="password" placeholder="Set new premium password (optional)" value={galleryEditForm.premiumPassword} onChange={(e) => setGalleryEditForm({ ...galleryEditForm, premiumPassword: e.target.value })} /></div>
              <label className="small" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><input type="checkbox" checked={galleryEditForm.discoverSquareCropEnabled} onChange={(e) => setGalleryEditForm({ ...galleryEditForm, discoverSquareCropEnabled: e.target.checked })} /> Allow square crop in discovery</label>
              <div className="inline-form"><select value={galleryEditForm.defaultAiDisclosure} onChange={(e) => setGalleryEditForm({ ...galleryEditForm, defaultAiDisclosure: e.target.value as AiDisclosure })}>{aiDisclosureOptions.map((opt) => <option key={`ge-${opt}`} value={opt}>{opt}</option>)}</select></div>
              <div className="inline-form" style={{ gap: 10, flexWrap: 'wrap' }}>{heavyTopicOptions.map((topic) => (<label key={`ge-${topic.value}`} className="small" style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}><input type="checkbox" checked={galleryEditForm.defaultHeavyTopics.includes(topic.value)} onChange={(e) => setGalleryEditForm({ ...galleryEditForm, defaultHeavyTopics: e.target.checked ? Array.from(new Set([...galleryEditForm.defaultHeavyTopics, topic.value])) : galleryEditForm.defaultHeavyTopics.filter((v) => v !== topic.value) })} />{topic.label}</label>))}</div>
              <div className="inline-form" style={{ gap: 8 }}><button onClick={() => void saveGalleryEdit()} disabled={submitting}>Save gallery</button><button onClick={() => setEditingGalleryId(null)} disabled={submitting}>Cancel</button></div>
            </section>
          )}

          <section className="panel">
            <h2>Galleries ({visibleGalleries.length})</h2>
            {loading ? <p className="small">Loading…</p> : (
              <ul>
                {visibleGalleries.slice(0, 80).map((gallery) => (
                  <li key={gallery.galleryId}>
                    <strong>{gallery.title}</strong> ({gallery.slug}) · artist: {gallery.artistSlug || artists.find((a) => a.artistId === gallery.artistId)?.slug || gallery.artistId} · {gallery.visibility} · {gallery.status}{gallery.coverImageId ? ` · cover: ${gallery.coverImageId}` : ''}
                    <button style={{ marginLeft: 8 }} onClick={() => startEditGallery(gallery)} disabled={submitting}>Edit</button>
                    <button style={{ marginLeft: 8 }} onClick={() => void deleteGallery(gallery)} disabled={submitting}>Delete</button>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      )}

      {activePanel === 'media' && canManageContent && (
        <section className="panel artist-public-grid">
          <article>
            <h3>Create media</h3>
            <div className="inline-form">
              <select value={mediaForm.galleryId} onChange={(e) => { setMediaForm({ ...mediaForm, galleryId: e.target.value }); setMediaGalleryId(e.target.value); }}>
                <option value="">Select gallery</option>
                {galleries.map((gallery) => <option key={gallery.galleryId} value={gallery.galleryId}>{gallery.title}</option>)}
              </select>
            </div>
            <div className="inline-form"><select value={mediaForm.assetType} onChange={(e) => setMediaForm({ ...mediaForm, assetType: e.target.value as 'image' | 'video' })}><option value="image">Image</option><option value="video">Video</option></select></div>
            <div className="inline-form"><input placeholder="Title (optional)" value={mediaForm.title} onChange={(e) => setMediaForm({ ...mediaForm, title: e.target.value })} /></div>
            <div className="inline-form"><input placeholder="Original filename (optional)" value={mediaForm.originalFilename} onChange={(e) => setMediaForm({ ...mediaForm, originalFilename: e.target.value })} /></div>
            <div className="inline-form"><input placeholder="Preview key" value={mediaForm.previewKey} onChange={(e) => setMediaForm({ ...mediaForm, previewKey: e.target.value })} /></div>
            <div className="inline-form"><input placeholder="Premium key (optional)" value={mediaForm.premiumKey} onChange={(e) => setMediaForm({ ...mediaForm, premiumKey: e.target.value })} /></div>
            <div className="inline-form"><input placeholder="Preview poster key (optional)" value={mediaForm.previewPosterKey} onChange={(e) => setMediaForm({ ...mediaForm, previewPosterKey: e.target.value })} /></div>
            <div className="inline-form"><input placeholder="Premium poster key (optional)" value={mediaForm.premiumPosterKey} onChange={(e) => setMediaForm({ ...mediaForm, premiumPosterKey: e.target.value })} /></div>
            <div className="inline-form"><input type="number" placeholder="Width" value={mediaForm.width} onChange={(e) => setMediaForm({ ...mediaForm, width: Number(e.target.value || 0) })} /></div>
            <div className="inline-form"><input type="number" placeholder="Height" value={mediaForm.height} onChange={(e) => setMediaForm({ ...mediaForm, height: Number(e.target.value || 0) })} /></div>
            <div className="inline-form"><input type="number" placeholder="Duration seconds" value={mediaForm.durationSeconds} onChange={(e) => setMediaForm({ ...mediaForm, durationSeconds: Number(e.target.value || 0) })} /></div>
            <div className="inline-form"><input type="number" placeholder="Sort order" value={mediaForm.sortOrder} onChange={(e) => setMediaForm({ ...mediaForm, sortOrder: Number(e.target.value || 1) })} /></div>
            <div className="inline-form"><select value={mediaForm.contentRating || 'general'} onChange={(e) => setMediaForm({ ...mediaForm, contentRating: e.target.value as NonNullable<ManagedMedia['contentRating']> })}><option value="general">general</option><option value="suggestive">suggestive</option><option value="mature">mature</option><option value="sexual">sexual</option><option value="fetish">fetish</option><option value="graphic">graphic</option></select></div>
            <div className="inline-form"><select value={mediaForm.moderatorContentRating} onChange={(e) => setMediaForm({ ...mediaForm, moderatorContentRating: e.target.value as '' | NonNullable<ManagedMedia['contentRating']> })}><option value="">moderator content rating (optional)</option><option value="general">general</option><option value="suggestive">suggestive</option><option value="mature">mature</option><option value="sexual">sexual</option><option value="fetish">fetish</option><option value="graphic">graphic</option></select></div>
            <div className="inline-form"><select value={mediaForm.aiDisclosure} onChange={(e) => setMediaForm({ ...mediaForm, aiDisclosure: e.target.value as AiDisclosure })}>{aiDisclosureOptions.map((opt) => <option key={`m-ai-${opt}`} value={opt}>{opt}</option>)}</select></div>
            <div className="inline-form"><select value={mediaForm.moderatorAiDisclosure} onChange={(e) => setMediaForm({ ...mediaForm, moderatorAiDisclosure: e.target.value as '' | AiDisclosure })}><option value="">moderator AI disclosure (optional)</option>{aiDisclosureOptions.map((opt) => <option key={`m-mai-${opt}`} value={opt}>{opt}</option>)}</select></div>
            <label className="small" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><input type="checkbox" checked={mediaForm.discoverSquareCropEnabled} onChange={(e) => setMediaForm({ ...mediaForm, discoverSquareCropEnabled: e.target.checked })} /> Allow square crop in discovery</label>
            <div className="inline-form" style={{ gap: 10, flexWrap: 'wrap' }}>{heavyTopicOptions.map((topic) => (<label key={`m-topic-${topic.value}`} className="small" style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}><input type="checkbox" checked={mediaForm.heavyTopics.includes(topic.value)} onChange={(e) => setMediaForm({ ...mediaForm, heavyTopics: e.target.checked ? Array.from(new Set([...mediaForm.heavyTopics, topic.value])) : mediaForm.heavyTopics.filter((v) => v !== topic.value) })} />{topic.label}</label>))}</div>
            <div className="inline-form" style={{ gap: 10, flexWrap: 'wrap' }}>{heavyTopicOptions.map((topic) => (<label key={`m-mtopic-${topic.value}`} className="small" style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}><input type="checkbox" checked={mediaForm.moderatorHeavyTopics.includes(topic.value)} onChange={(e) => setMediaForm({ ...mediaForm, moderatorHeavyTopics: e.target.checked ? Array.from(new Set([...mediaForm.moderatorHeavyTopics, topic.value])) : mediaForm.moderatorHeavyTopics.filter((v) => v !== topic.value) })} />Moderator: {topic.label}</label>))}</div>
            {mediaForm.assetType === 'image' && (<div className="inline-form" style={{ gap: 8 }}><input type="number" placeholder="Crop X" value={mediaForm.cropX} onChange={(e) => setMediaForm({ ...mediaForm, cropX: Number(e.target.value || 0) })} /><input type="number" placeholder="Crop Y" value={mediaForm.cropY} onChange={(e) => setMediaForm({ ...mediaForm, cropY: Number(e.target.value || 0) })} /><input type="number" placeholder="Crop size" min={1} value={mediaForm.cropSize} onChange={(e) => setMediaForm({ ...mediaForm, cropSize: Number(e.target.value || 512) })} /></div>)}
            <button onClick={() => void createMedia()} disabled={submitting}>Create media record</button>
          </article>
          <article>
            <h3>Gallery media ({visibleMedia.length})</h3>
            <div className="inline-form">
              <select value={mediaGalleryId} onChange={(e) => setMediaGalleryId(e.target.value)}>
                <option value="">Select gallery</option>
                {galleries.map((gallery) => <option key={`media-${gallery.galleryId}`} value={gallery.galleryId}>{gallery.title}</option>)}
              </select>
            </div>
            <div className="inline-form" style={{ gap: 8 }}>
              <input placeholder="Search media" value={mediaQuery} onChange={(e) => setMediaQuery(e.target.value)} />
              <select value={mediaTypeFilter} onChange={(e) => setMediaTypeFilter(e.target.value as 'all' | 'image' | 'video')}>
                <option value="all">All types</option><option value="image">Image</option><option value="video">Video</option>
              </select>
            </div>
            <div className="inline-form" style={{ gap: 8 }}>
              <button onClick={() => void loadMedia(mediaGalleryId)} disabled={!mediaGalleryId || loading}>Reload media</button>
              <button onClick={() => { setMediaQuery(''); setMediaTypeFilter('all'); }}>Clear filters</button>
            </div>
            <ul>
              {visibleMedia.slice(0, 40).map((item) => (
                <li key={item.imageId}>{item.assetType || 'image'} · {item.imageId} · {item.previewKey} · {item.contentRating || 'general'} · AI: {item.aiDisclosure || 'none'} · Topics: {(item.heavyTopics || []).join(', ') || 'none'}<button style={{ marginLeft: 8 }} onClick={() => startEditMedia(item)} disabled={submitting}>Edit</button><button style={{ marginLeft: 8 }} onClick={() => void setMediaAsGalleryCover(item)} disabled={submitting}>Set as cover</button><button style={{ marginLeft: 8 }} onClick={() => void generateMediaRenditions(item)} disabled={submitting || (item.assetType || 'image') !== 'image'}>Generate renditions</button><button style={{ marginLeft: 8 }} onClick={() => void deleteMedia(item)} disabled={submitting}>Delete</button></li>
              ))}
              {!visibleMedia.length && <li className="small">No media records for current filter.</li>}
            </ul>
          </article>
          {editingMediaId && (
            <article>
              <h3>Edit media</h3>
              <div className="inline-form">
                <select value={mediaEditForm.galleryId} onChange={(e) => setMediaEditForm({ ...mediaEditForm, galleryId: e.target.value })}>
                  <option value="">Select gallery</option>
                  {galleries.map((gallery) => <option key={`me-${gallery.galleryId}`} value={gallery.galleryId}>{gallery.title}</option>)}
                </select>
              </div>
              <div className="inline-form" style={{ gap: 8 }}><input placeholder="Image ID" value={mediaEditForm.imageId} onChange={(e) => setMediaEditForm({ ...mediaEditForm, imageId: e.target.value })} /><button onClick={() => void hydrateMediaEditFromGallery()} disabled={submitting}>Load image</button></div>
              <div className="inline-form"><select value={mediaEditForm.assetType} onChange={(e) => setMediaEditForm({ ...mediaEditForm, assetType: e.target.value as 'image' | 'video' })}><option value="image">Image</option><option value="video">Video</option></select></div>
              <div className="inline-form"><input placeholder="Title" value={mediaEditForm.title} onChange={(e) => setMediaEditForm({ ...mediaEditForm, title: e.target.value })} /></div>
              <div className="inline-form"><input placeholder="Original filename (optional)" value={mediaEditForm.originalFilename} onChange={(e) => setMediaEditForm({ ...mediaEditForm, originalFilename: e.target.value })} /></div>
              <div className="inline-form"><input placeholder="Preview key" value={mediaEditForm.previewKey} onChange={(e) => setMediaEditForm({ ...mediaEditForm, previewKey: e.target.value })} /></div>
              <div className="inline-form"><input placeholder="Premium key" value={mediaEditForm.premiumKey} onChange={(e) => setMediaEditForm({ ...mediaEditForm, premiumKey: e.target.value })} /></div>
              <div className="inline-form"><input placeholder="Preview poster key" value={mediaEditForm.previewPosterKey} onChange={(e) => setMediaEditForm({ ...mediaEditForm, previewPosterKey: e.target.value })} /></div>
              <div className="inline-form"><input placeholder="Premium poster key" value={mediaEditForm.premiumPosterKey} onChange={(e) => setMediaEditForm({ ...mediaEditForm, premiumPosterKey: e.target.value })} /></div>
              <div className="inline-form"><input type="number" placeholder="Width" value={mediaEditForm.width} onChange={(e) => setMediaEditForm({ ...mediaEditForm, width: Number(e.target.value || 0) })} /></div>
              <div className="inline-form"><input type="number" placeholder="Height" value={mediaEditForm.height} onChange={(e) => setMediaEditForm({ ...mediaEditForm, height: Number(e.target.value || 0) })} /></div>
              <div className="inline-form"><input type="number" placeholder="Duration seconds" value={mediaEditForm.durationSeconds} onChange={(e) => setMediaEditForm({ ...mediaEditForm, durationSeconds: Number(e.target.value || 0) })} /></div>
              <div className="inline-form"><input type="number" placeholder="Sort order" value={mediaEditForm.sortOrder} onChange={(e) => setMediaEditForm({ ...mediaEditForm, sortOrder: Number(e.target.value || 1) })} /></div>
              <div className="inline-form"><select value={mediaEditForm.contentRating} onChange={(e) => setMediaEditForm({ ...mediaEditForm, contentRating: e.target.value as NonNullable<ManagedMedia['contentRating']> })}><option value="general">general</option><option value="suggestive">suggestive</option><option value="mature">mature</option><option value="sexual">sexual</option><option value="fetish">fetish</option><option value="graphic">graphic</option></select></div>
              <div className="inline-form"><select value={mediaEditForm.moderatorContentRating} onChange={(e) => setMediaEditForm({ ...mediaEditForm, moderatorContentRating: e.target.value as '' | NonNullable<ManagedMedia['contentRating']> })}><option value="">moderator content rating (optional)</option><option value="general">general</option><option value="suggestive">suggestive</option><option value="mature">mature</option><option value="sexual">sexual</option><option value="fetish">fetish</option><option value="graphic">graphic</option></select></div>
              <div className="inline-form"><select value={mediaEditForm.aiDisclosure} onChange={(e) => setMediaEditForm({ ...mediaEditForm, aiDisclosure: e.target.value as AiDisclosure })}>{aiDisclosureOptions.map((opt) => <option key={`me-ai-${opt}`} value={opt}>{opt}</option>)}</select></div>
              <div className="inline-form"><select value={mediaEditForm.moderatorAiDisclosure} onChange={(e) => setMediaEditForm({ ...mediaEditForm, moderatorAiDisclosure: e.target.value as '' | AiDisclosure })}><option value="">moderator AI disclosure (optional)</option>{aiDisclosureOptions.map((opt) => <option key={`me-mai-${opt}`} value={opt}>{opt}</option>)}</select></div>
              <label className="small" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><input type="checkbox" checked={mediaEditForm.discoverSquareCropEnabled} onChange={(e) => setMediaEditForm({ ...mediaEditForm, discoverSquareCropEnabled: e.target.checked })} /> Allow square crop in discovery</label>
              <div className="inline-form" style={{ gap: 10, flexWrap: 'wrap' }}>{heavyTopicOptions.map((topic) => (<label key={`me-topic-${topic.value}`} className="small" style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}><input type="checkbox" checked={mediaEditForm.heavyTopics.includes(topic.value)} onChange={(e) => setMediaEditForm({ ...mediaEditForm, heavyTopics: e.target.checked ? Array.from(new Set([...mediaEditForm.heavyTopics, topic.value])) : mediaEditForm.heavyTopics.filter((v) => v !== topic.value) })} />{topic.label}</label>))}</div>
              <div className="inline-form" style={{ gap: 10, flexWrap: 'wrap' }}>{heavyTopicOptions.map((topic) => (<label key={`me-mtopic-${topic.value}`} className="small" style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}><input type="checkbox" checked={mediaEditForm.moderatorHeavyTopics.includes(topic.value)} onChange={(e) => setMediaEditForm({ ...mediaEditForm, moderatorHeavyTopics: e.target.checked ? Array.from(new Set([...mediaEditForm.moderatorHeavyTopics, topic.value])) : mediaEditForm.moderatorHeavyTopics.filter((v) => v !== topic.value) })} />Moderator: {topic.label}</label>))}</div>
              {mediaEditForm.assetType === 'image' && (<div className="inline-form" style={{ gap: 8 }}><input type="number" placeholder="Crop X" value={mediaEditForm.cropX} onChange={(e) => setMediaEditForm({ ...mediaEditForm, cropX: Number(e.target.value || 0) })} /><input type="number" placeholder="Crop Y" value={mediaEditForm.cropY} onChange={(e) => setMediaEditForm({ ...mediaEditForm, cropY: Number(e.target.value || 0) })} /><input type="number" placeholder="Crop size" min={1} value={mediaEditForm.cropSize} onChange={(e) => setMediaEditForm({ ...mediaEditForm, cropSize: Number(e.target.value || 512) })} /></div>)}
              <div className="inline-form" style={{ gap: 8 }}><button onClick={() => void saveMediaEdit()} disabled={submitting}>Save media</button><button onClick={() => void setEditMediaAsGalleryCover()} disabled={submitting}>Set as cover</button><button onClick={() => void generateEditMediaRenditions()} disabled={submitting || mediaEditForm.assetType !== 'image'}>Generate renditions</button><button onClick={() => setEditingMediaId(null)} disabled={submitting}>Cancel</button></div>
            </article>
          )}

          <article>
            <h3>Upload note</h3>
            <p className="small">Current flow creates media metadata records. Object uploads can remain in existing media pipeline while upload UI is migrated here next.</p>
          </article>
        </section>
      )}

      {activePanel === 'operations' && isAdmin && (
        <section className="panel artist-public-grid">
          <article>
            <h3>Site settings</h3>
            <p className="small">Need account password actions? Use <Link to="/settings">Change password</Link> in this app.</p>
            <div className="inline-form"><input placeholder="Site name" value={siteSettings.siteName} onChange={(e) => setSiteSettings({ ...siteSettings, siteName: e.target.value })} /></div>
            <div className="inline-form"><select value={siteSettings.theme} onChange={(e) => setSiteSettings({ ...siteSettings, theme: e.target.value as SiteSettings['theme'] })}><option value="ubeeq">Ubeeq</option><option value="sand">Sand</option><option value="forest">Forest</option><option value="slate">Slate</option></select></div>
            <div className="inline-form"><input placeholder="Logo key" value={siteSettings.logoKey || ''} onChange={(e) => setSiteSettings({ ...siteSettings, logoKey: e.target.value || undefined })} /></div>
            <div className="inline-form"><input type="file" accept="image/*" onChange={(e) => void uploadLogo(e.target.files?.[0] || null)} /></div>
            {siteSettings.logoUrl && <img src={siteSettings.logoUrl} alt="Current site logo" style={{ maxWidth: 180, borderRadius: 8 }} />}
            <button onClick={() => void saveSiteSettings()} disabled={submitting}>Save site settings</button>
          </article>
          <article>
            <h3>Comment moderation</h3>
            <div className="inline-form"><input placeholder="Comment ID" value={commentId} onChange={(e) => setCommentId(e.target.value)} /></div>
            <label className="small" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><input type="checkbox" checked={commentHidden} onChange={(e) => setCommentHidden(e.target.checked)} /> Hidden</label>
            <div className="inline-form" style={{ gap: 8 }}><button onClick={() => void moderateComment()} disabled={submitting}>Set comment status</button><button onClick={() => void removeComment()} disabled={submitting}>Delete comment</button></div>
          </article>
          <article>
            <h3>User safety actions</h3>
            <div className="inline-form"><input placeholder="User ID" value={blockUserId} onChange={(e) => setBlockUserId(e.target.value)} /></div>
            <div className="inline-form"><input placeholder="Reason (optional)" value={blockReason} onChange={(e) => setBlockReason(e.target.value)} /></div>
            <div className="inline-form" style={{ gap: 8 }}><button onClick={() => void blockUser()} disabled={submitting}>Block user</button><button onClick={() => void unblockUser()} disabled={submitting}>Unblock user</button></div>
          </article>
          <article>
            <h3>Trending maintenance</h3>
            <button onClick={() => void rebuildTrending()} disabled={submitting}>Rebuild trending feed</button>
          </article>
          <article>
            <h3>Audit log</h3>
            <div className="inline-form" style={{ gap: 8 }}><input placeholder="Filter action" value={auditActionFilter} onChange={(e) => setAuditActionFilter(e.target.value)} /><input placeholder="Filter actor userId" value={auditActorFilter} onChange={(e) => setAuditActorFilter(e.target.value)} /></div>
            <div className="inline-form" style={{ gap: 8 }}><button onClick={() => { setAuditCursor(''); void loadAudit(); }} disabled={submitting}>Load latest audit</button><button onClick={() => { if (!auditNextCursor) return; setAuditCursor(auditNextCursor); }} disabled={!auditNextCursor || submitting}>Use next cursor</button><button onClick={() => void loadAudit()} disabled={submitting}>Load with cursor</button></div>
            <p className="small">Current cursor: {auditCursor || 'none'} · Next: {auditNextCursor || 'none'}</p>
            <ul>{auditEvents.slice(0, 20).map((event) => <li key={event.auditId}>{event.time} · {event.action} · {event.actorUserId || 'system'}</li>)}{!auditEvents.length && <li className="small">No audit events loaded.</li>}</ul>
          </article>
        </section>
      )}

      {message && <p>{message}</p>}
      {error && <p className="error">{error}</p>}
    </div>
  );
}
