import { useEffect, useMemo, useState } from 'react';
import {
  changePassword,
  confirmForgotPassword,
  forgotPassword,
  getCurrentUser,
  setInitialPassword,
  signIn,
  signOut,
  type CurrentUser
} from './cognitoAuth';

type View = 'creators' | 'galleries' | 'media' | 'posts' | 'settings' | 'moderation' | 'users';
type PlatformRole = 'user' | 'contributor' | 'creator' | 'admin';
const ROLE_DISPLAY_LABELS: Partial<Record<PlatformRole, string>> = {
  contributor: 'Beeker'
};
const roleDisplayLabel = (role: PlatformRole): string => ROLE_DISPLAY_LABELS[role] || role[0].toUpperCase() + role.slice(1);
type ContentRating = 'general' | 'suggestive' | 'mature' | 'sexual' | 'fetish' | 'graphic';
type AiDisclosure = 'none' | 'ai-assisted' | 'ai-generated';
type HeavyTopic = 'politics-public-affairs' | 'crime-disasters-tragedy';
const contentRatingOptions: ContentRating[] = ['general', 'suggestive', 'mature', 'sexual', 'fetish', 'graphic'];
const aiDisclosureOptions: AiDisclosure[] = ['none', 'ai-assisted', 'ai-generated'];
const heavyTopicOptions: Array<{ value: HeavyTopic; label: string }> = [
  { value: 'politics-public-affairs', label: 'Politics & Public Affairs' },
  { value: 'crime-disasters-tragedy', label: 'Crime, Disasters & Tragedy' }
];

type Artist = {
  artistId: string;
  name: string;
  slug: string;
  status: 'active' | 'inactive';
  sortOrder: number;
  discoverSquareCropEnabled?: boolean;
  defaultAiDisclosure?: AiDisclosure;
  defaultHeavyTopics?: HeavyTopic[];
};
type Gallery = {
  galleryId: string;
  artistId: string;
  artistSlug?: string;
  title: string;
  slug: string;
  coverImageId?: string;
  pairedPremiumGalleryId?: string;
  purchaseUrl?: string;
  visibility: 'free' | 'preview' | 'premium';
  status: 'draft' | 'published';
  discoverSquareCropEnabled?: boolean;
  defaultPreviewMaxWidth?: number;
  defaultAiDisclosure?: AiDisclosure;
  defaultHeavyTopics?: HeavyTopic[];
};
type Media = {
  imageId: string;
  galleryId: string;
  sortOrder: number;
  assetType?: 'image' | 'video';
  contentRating?: ContentRating;
  moderatorContentRating?: ContentRating;
  aiDisclosure?: AiDisclosure;
  moderatorAiDisclosure?: AiDisclosure;
  heavyTopics?: HeavyTopic[];
  moderatorHeavyTopics?: HeavyTopic[];
  title?: string;
  slug?: string;
  originalFilename?: string;
  squareCrop?: { x: number; y: number; size: number };
  discoverSquareCropEnabled?: boolean;
  isPreview?: boolean;
  previewMaxWidth?: number;
  previewKey: string;
  premiumKey?: string;
};
type Post = {
  postId: string;
  artistId: string;
  title: string;
  slug: string;
  summary?: string;
  status: 'draft' | 'published' | 'archived';
  media: Array<{ mediaId: string; discoverable?: boolean; sortOrder?: number; caption?: string }>;
  blocks: Array<Record<string, unknown>>;
  primaryMediaId?: string;
  discovery?: { mode?: 'primary' | 'all' | 'selected' };
  destination?: { type: 'post' | 'pdf' | 'external' | 'internal'; url: string } | null;
  metadata?: Record<string, string>;
};
type PostTemplate = 'image' | 'collection' | 'longform' | 'comic' | 'pdf' | 'audio';
type PostFormState = {
  artistId: string;
  title: string;
  slug: string;
  summary: string;
  status: Post['status'];
  discoveryMode: 'primary' | 'all' | 'selected';
  primaryMediaId: string;
  destinationType: 'post' | 'pdf' | 'external' | 'internal';
  destinationUrl: string;
  mediaJson: string;
  blocksJson: string;
  metadataJson: string;
};
type SiteSettings = { siteName: string; theme: 'ubeeq' | 'sand' | 'forest' | 'slate'; logoKey?: string; logoUrl?: string };

type AuthMode = 'signin' | 'forgot' | 'reset' | 'initial' | 'change';

const API_BASE = import.meta.env.VITE_API_BASE_URL || 'http://localhost:4000';
const token = () => localStorage.getItem('idToken') || '';

const request = async (path: string, method = 'GET', body?: unknown) => {
  const response = await fetch(`${API_BASE}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token()}`
    },
    body: body ? JSON.stringify(body) : undefined
  });
  if (!response.ok) {
    const json = await response.json().catch(() => ({}));
    throw new Error(json.message || 'Request failed');
  }
  if (response.status === 204) return null;
  return response.json();
};

const views: Array<{ id: View; label: string }> = [
  { id: 'creators', label: 'Creators' },
  { id: 'galleries', label: 'Galleries' },
  { id: 'media', label: 'Media' },
  { id: 'posts', label: 'Posts' },
  { id: 'settings', label: 'Site Settings' },
  { id: 'moderation', label: 'Moderation' },
  { id: 'users', label: 'Users' }
];

const postTemplateOptions: Array<{ value: PostTemplate; label: string }> = [
  { value: 'image', label: 'Image post' },
  { value: 'collection', label: 'Collection post' },
  { value: 'longform', label: 'Longform post' },
  { value: 'comic', label: 'Comic episode' },
  { value: 'pdf', label: 'PDF-backed post' },
  { value: 'audio', label: 'Audio post' }
];

const createEmptyPostForm = (): PostFormState => ({
  artistId: '',
  title: '',
  slug: '',
  summary: '',
  status: 'published',
  discoveryMode: 'primary',
  primaryMediaId: '',
  destinationType: 'post',
  destinationUrl: '',
  mediaJson: '[]',
  blocksJson: '[]',
  metadataJson: '{}'
});

const buildTemplatedPostForm = (current: PostFormState, template: PostTemplate): PostFormState => {
  const primaryMediaId = current.primaryMediaId.trim();
  const media = primaryMediaId
    ? [{ mediaId: primaryMediaId, discoverable: true, sortOrder: 0 }]
    : [];
  const shared = {
    ...current,
    mediaJson: JSON.stringify(media, null, 2)
  };
  switch (template) {
    case 'image':
      return {
        ...shared,
        discoveryMode: 'primary',
        destinationType: 'post',
        blocksJson: JSON.stringify(primaryMediaId ? [{ blockId: `image-${Date.now()}`, type: 'image', mediaId: primaryMediaId }] : [], null, 2),
        metadataJson: JSON.stringify({ template: 'default', layout: 'standard' }, null, 2)
      };
    case 'collection':
      return {
        ...shared,
        discoveryMode: 'selected',
        destinationType: 'post',
        blocksJson: JSON.stringify(
          [
            { blockId: `heading-${Date.now()}`, type: 'heading', level: 2, text: current.title || 'Collection title' },
            { blockId: `paragraph-${Date.now() + 1}`, type: 'paragraph', text: current.summary || 'Collection description' }
          ],
          null,
          2
        ),
        metadataJson: JSON.stringify({ template: 'collection', layout: 'grid' }, null, 2)
      };
    case 'longform':
      return {
        ...shared,
        discoveryMode: 'selected',
        destinationType: 'post',
        blocksJson: JSON.stringify(
          [
            { blockId: `heading-${Date.now()}`, type: 'heading', level: 1, text: current.title || 'Longform title' },
            { blockId: `paragraph-${Date.now() + 1}`, type: 'paragraph', text: current.summary || 'Intro paragraph...' },
            { blockId: `quote-${Date.now() + 2}`, type: 'quote', text: 'Pull quote', cite: '' },
            { blockId: `divider-${Date.now() + 3}`, type: 'divider' },
            { blockId: `paragraph-${Date.now() + 4}`, type: 'paragraph', text: 'Continue writing...' }
          ],
          null,
          2
        ),
        metadataJson: JSON.stringify({ template: 'reading', layout: 'longform' }, null, 2)
      };
    case 'comic':
      return {
        ...shared,
        discoveryMode: 'selected',
        destinationType: 'post',
        blocksJson: JSON.stringify(
          [
            { blockId: `heading-${Date.now()}`, type: 'heading', level: 2, text: current.title || 'Episode title' },
            { blockId: `paragraph-${Date.now() + 1}`, type: 'paragraph', text: current.summary || 'Episode description' },
            ...(primaryMediaId ? [{ blockId: `panel-${Date.now() + 2}`, type: 'image', mediaId: primaryMediaId }] : [])
          ],
          null,
          2
        ),
        metadataJson: JSON.stringify({ template: 'comic', layout: 'vertical-scroll' }, null, 2)
      };
    case 'pdf':
      return {
        ...shared,
        discoveryMode: 'primary',
        destinationType: 'pdf',
        destinationUrl: current.destinationUrl || 'https://example.com/doc.pdf',
        blocksJson: JSON.stringify(
          [
            { blockId: `paragraph-${Date.now()}`, type: 'paragraph', text: current.summary || 'Document summary' },
            { blockId: `pdf-${Date.now() + 1}`, type: 'pdf_preview', url: current.destinationUrl || 'https://example.com/doc.pdf' }
          ],
          null,
          2
        ),
        metadataJson: JSON.stringify({ template: 'document', layout: 'standard' }, null, 2)
      };
    case 'audio':
      return {
        ...shared,
        discoveryMode: 'primary',
        destinationType: 'post',
        blocksJson: JSON.stringify(
          [
            ...(primaryMediaId ? [{ blockId: `audio-${Date.now()}`, type: 'audio', mediaId: primaryMediaId }] : []),
            { blockId: `paragraph-${Date.now() + 1}`, type: 'paragraph', text: current.summary || 'Episode notes...' }
          ],
          null,
          2
        ),
        metadataJson: JSON.stringify({ template: 'audio', layout: 'standard' }, null, 2)
      };
    default:
      return shared;
  }
};

const inferTemplateFromMetadata = (metadata?: Record<string, string> | null): PostTemplate => {
  const template = (metadata?.template || '').toLowerCase();
  if (template === 'collection') return 'collection';
  if (template === 'reading') return 'longform';
  if (template === 'comic') return 'comic';
  if (template === 'document') return 'pdf';
  if (template === 'audio') return 'audio';
  return 'image';
};

export function StudioApp() {
  const [view, setView] = useState<View>('creators');
  const [artists, setArtists] = useState<Artist[]>([]);
  const [galleries, setGalleries] = useState<Gallery[]>([]);
  const [media, setMedia] = useState<Media[]>([]);
  const [posts, setPosts] = useState<Post[]>([]);

  const [artistForm, setArtistForm] = useState({
    name: '',
    slug: '',
    sortOrder: 1,
    discoverSquareCropEnabled: true,
    defaultAiDisclosure: 'none' as AiDisclosure,
    defaultHeavyTopics: [] as HeavyTopic[]
  });
  const [galleryForm, setGalleryForm] = useState({
    artistId: '',
    artistSlug: '',
    title: '',
    slug: '',
    coverImageId: '',
    pairedPremiumGalleryId: '',
    purchaseUrl: '',
    visibility: 'free',
    premiumPassword: '',
    discoverSquareCropEnabled: true,
    defaultPreviewMaxWidth: '',
    defaultAiDisclosure: 'none' as AiDisclosure,
    defaultHeavyTopics: [] as HeavyTopic[]
  });
  const [mediaForm, setMediaForm] = useState({
    galleryId: '',
    assetType: 'image',
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
    contentRating: 'general' as ContentRating,
    moderatorContentRating: '',
    aiDisclosure: 'none' as AiDisclosure,
    moderatorAiDisclosure: '',
    heavyTopics: [] as HeavyTopic[],
    moderatorHeavyTopics: [] as HeavyTopic[],
    cropX: 0,
    cropY: 0,
    cropSize: 512,
    discoverSquareCropEnabled: true,
    isPreview: false,
    previewMaxWidth: ''
  });
  const [editingArtistId, setEditingArtistId] = useState<string | null>(null);
  const [editingGalleryId, setEditingGalleryId] = useState<string | null>(null);
  const [editingMediaId, setEditingMediaId] = useState<string | null>(null);
  const [editingPostId, setEditingPostId] = useState<string | null>(null);
  const [artistEditForm, setArtistEditForm] = useState({
    name: '',
    slug: '',
    status: 'active',
    sortOrder: 1,
    discoverSquareCropEnabled: true,
    defaultAiDisclosure: 'none' as AiDisclosure,
    defaultHeavyTopics: [] as HeavyTopic[]
  });
  const [galleryEditForm, setGalleryEditForm] = useState({
    artistId: '',
    artistSlug: '',
    title: '',
    slug: '',
    coverImageId: '',
    pairedPremiumGalleryId: '',
    purchaseUrl: '',
    visibility: 'free',
    status: 'published',
    premiumPassword: '',
    discoverSquareCropEnabled: true,
    defaultPreviewMaxWidth: '',
    defaultAiDisclosure: 'none' as AiDisclosure,
    defaultHeavyTopics: [] as HeavyTopic[]
  });
  const [mediaEditForm, setMediaEditForm] = useState({
    galleryId: '',
    imageId: '',
    assetType: 'image',
    title: '',
    originalFilename: '',
    previewKey: '',
    premiumKey: '',
    previewPosterKey: '',
    premiumPosterKey: '',
    width: 0,
    height: 0,
    durationSeconds: 0,
    sortOrder: 0,
    contentRating: 'general' as ContentRating,
    moderatorContentRating: '',
    aiDisclosure: 'none' as AiDisclosure,
    moderatorAiDisclosure: '',
    heavyTopics: [] as HeavyTopic[],
    moderatorHeavyTopics: [] as HeavyTopic[],
    cropX: 0,
    cropY: 0,
    cropSize: 512,
    discoverSquareCropEnabled: true,
    isPreview: false,
    previewMaxWidth: ''
  });
  const [postTemplate, setPostTemplate] = useState<PostTemplate>('image');
  const [postForm, setPostForm] = useState<PostFormState>(createEmptyPostForm);
  const [postEditTemplate, setPostEditTemplate] = useState<PostTemplate>('image');
  const [postEditForm, setPostEditForm] = useState<PostFormState>(createEmptyPostForm);

  const [mediaGalleryId, setMediaGalleryId] = useState('');
  const [commentId, setCommentId] = useState('');
  const [blockUserId, setBlockUserId] = useState('');
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [savingSettings, setSavingSettings] = useState(false);
  const [siteSettings, setSiteSettings] = useState<SiteSettings>({ siteName: 'Ubeeq', theme: 'ubeeq' });

  const [authMode, setAuthMode] = useState<AuthMode>('signin');
  const [user, setUser] = useState<CurrentUser>(() => getCurrentUser());
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [code, setCode] = useState('');
  const [session, setSession] = useState('');
  const [currentPassword, setCurrentPassword] = useState('');

  const artistById = useMemo(() => new Map(artists.map((a) => [a.artistId, a])), [artists]);
  const isAdmin = user?.groups.includes('Admins');
  const isCreator = Boolean(user?.groups.includes('Creators') || user?.groups.includes('Artists'));
  const canManageContent = Boolean(isAdmin || isCreator);
  const visibleViews = useMemo(
    () => views.filter((item) => {
      if (item.id === 'settings') return Boolean(isAdmin);
      if (item.id === 'galleries' || item.id === 'media' || item.id === 'posts') return canManageContent;
      return Boolean(isAdmin);
    }),
    [canManageContent, isAdmin]
  );

  const loadArtists = async () => setArtists(await request('/admin/artists'));
  const loadGalleries = async () => setGalleries(await request('/admin/galleries'));
  const loadSiteSettings = async () => setSiteSettings(await request('/site-settings'));
  const loadMedia = async (galleryId: string) => {
    if (!galleryId) return;
    setMedia(await request(`/admin/galleries/${galleryId}/images`));
  };
  const loadPosts = async () => setPosts(await request('/admin/posts'));

  const loadAll = async () => {
    if (!user) return;
    try {
      setError('');
      if (isAdmin) {
        await Promise.all([loadArtists(), loadGalleries(), loadPosts(), loadSiteSettings()]);
      } else if (canManageContent) {
        await Promise.all([loadGalleries(), loadPosts()]);
      }
    } catch (e) {
      setError((e as Error).message);
    }
  };

  useEffect(() => {
    loadAll();
  }, [user, isAdmin, canManageContent]);

  useEffect(() => {
    if (!user) return;
    if (!visibleViews.some((item) => item.id === view) && visibleViews[0]) {
      setView(visibleViews[0].id);
    }
  }, [user, view, visibleViews]);

  const withFeedback = async (fn: () => Promise<void>, successMessage?: string) => {
    try {
      setError('');
      setMessage('');
      await fn();
      if (successMessage) setMessage(successMessage);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const doSignIn = () => withFeedback(async () => {
    const result = await signIn(email, password);
    if (result.status === 'new_password_required') {
      setSession(result.session);
      setAuthMode('initial');
      setMessage('Set initial password to continue.');
      return;
    }
    setUser(result.user);
    setMessage('Signed in');
  });

  const doForgot = () => withFeedback(async () => {
    await forgotPassword(email);
    setAuthMode('reset');
    setMessage('Reset code sent.');
  });

  const doReset = () => withFeedback(async () => {
    await confirmForgotPassword(email, code, newPassword);
    setAuthMode('signin');
    setMessage('Password reset complete.');
  });

  const doInitialPassword = () => withFeedback(async () => {
    const loggedIn = await setInitialPassword(email, session, newPassword);
    setUser(loggedIn);
    setMessage('Initial password set. Signed in.');
    setAuthMode('signin');
  });

  const doChangePassword = () => withFeedback(async () => {
    await changePassword(currentPassword, newPassword);
    setMessage('Password changed');
    setCurrentPassword('');
    setNewPassword('');
  });

  const doSignOut = () => withFeedback(async () => {
    await signOut();
    setUser(null);
    setAuthMode('signin');
  }, 'Signed out');

  const createArtist = () => withFeedback(async () => {
    await request('/admin/artists', 'POST', { ...artistForm, status: 'active' });
    setArtistForm({
      name: '',
      slug: '',
      sortOrder: 1,
      discoverSquareCropEnabled: true,
      defaultAiDisclosure: 'none',
      defaultHeavyTopics: []
    });
    await loadArtists();
  }, 'Creator created');

  const deleteArtist = (artistId: string) => withFeedback(async () => {
    await request(`/admin/artists/${artistId}`, 'DELETE');
    await loadArtists();
  }, 'Creator deleted');

  const startEditArtist = (artist: Artist) => {
    setEditingArtistId(artist.artistId);
    setArtistEditForm({
      name: artist.name,
      slug: artist.slug,
      status: artist.status,
      sortOrder: artist.sortOrder,
      discoverSquareCropEnabled: artist.discoverSquareCropEnabled !== false,
      defaultAiDisclosure: artist.defaultAiDisclosure || 'none',
      defaultHeavyTopics: artist.defaultHeavyTopics || []
    });
  };

  const saveEditArtist = (artistId: string) => withFeedback(async () => {
    await request(`/admin/artists/${artistId}`, 'PATCH', artistEditForm);
    setEditingArtistId(null);
    await loadArtists();
  }, 'Creator updated');

  const createGallery = () => withFeedback(async () => {
    await request('/admin/galleries', 'POST', {
      ...galleryForm,
      status: 'published',
      defaultPreviewMaxWidth: galleryForm.defaultPreviewMaxWidth !== '' ? Number(galleryForm.defaultPreviewMaxWidth) : undefined
    });
    setGalleryForm({
      artistId: '',
      artistSlug: '',
      title: '',
      slug: '',
      coverImageId: '',
      pairedPremiumGalleryId: '',
      purchaseUrl: '',
      visibility: 'free',
      premiumPassword: '',
      discoverSquareCropEnabled: true,
      defaultPreviewMaxWidth: '',
      defaultAiDisclosure: 'none',
      defaultHeavyTopics: []
    });
    await loadGalleries();
  }, 'Gallery created');

  const deleteGallery = (galleryId: string) => withFeedback(async () => {
    await request(`/admin/galleries/${galleryId}`, 'DELETE');
    await loadGalleries();
  }, 'Gallery deleted');

  const startEditGallery = (gallery: Gallery) => {
    setEditingGalleryId(gallery.galleryId);
    setGalleryEditForm({
      artistId: gallery.artistId,
      artistSlug: gallery.artistSlug || '',
      title: gallery.title,
      slug: gallery.slug,
      coverImageId: gallery.coverImageId || '',
      pairedPremiumGalleryId: gallery.pairedPremiumGalleryId || '',
      purchaseUrl: gallery.purchaseUrl || '',
      visibility: gallery.visibility,
      status: gallery.status,
      premiumPassword: '',
      discoverSquareCropEnabled: gallery.discoverSquareCropEnabled !== false,
      defaultPreviewMaxWidth: gallery.defaultPreviewMaxWidth?.toString() || '',
      defaultAiDisclosure: gallery.defaultAiDisclosure || 'none',
      defaultHeavyTopics: gallery.defaultHeavyTopics || []
    });
  };

  const saveEditGallery = (galleryId: string) => withFeedback(async () => {
    await request(`/admin/galleries/${galleryId}`, 'PATCH', {
      ...galleryEditForm,
      defaultPreviewMaxWidth: galleryEditForm.defaultPreviewMaxWidth !== '' ? Number(galleryEditForm.defaultPreviewMaxWidth) : undefined
    });
    setEditingGalleryId(null);
    await loadGalleries();
  }, 'Gallery updated');

  const setGalleryCover = (galleryId: string, imageId: string) => withFeedback(async () => {
    await request(`/admin/galleries/${galleryId}`, 'PATCH', { coverImageId: imageId });
    await loadGalleries();
  }, 'Gallery cover updated');

  const createMedia = () => withFeedback(async () => {
    const includeSquareCrop =
      mediaForm.assetType === 'image' &&
      (mediaForm.cropX !== 0 || mediaForm.cropY !== 0 || mediaForm.cropSize !== 512);
    await request('/admin/images', 'POST', {
      ...mediaForm,
      previewMaxWidth: mediaForm.previewMaxWidth !== '' ? Number(mediaForm.previewMaxWidth) : undefined,
      squareCrop: includeSquareCrop
        ? { x: mediaForm.cropX, y: mediaForm.cropY, size: mediaForm.cropSize }
        : undefined
    });
    if (mediaGalleryId === mediaForm.galleryId) {
      await loadMedia(mediaForm.galleryId);
    }
  }, 'Media created');

  const deleteMedia = (item: Media) => withFeedback(async () => {
    await request(`/admin/images/${item.galleryId}/${item.imageId}?sortOrder=${item.sortOrder}`, 'DELETE');
    if (mediaGalleryId) await loadMedia(mediaGalleryId);
  }, 'Media deleted');

  const startEditMedia = (item: Media) => {
    setEditingMediaId(item.imageId);
    setMediaEditForm({
      galleryId: item.galleryId,
      imageId: item.imageId,
      assetType: item.assetType || 'image',
      title: item.title || '',
      originalFilename: item.originalFilename || '',
      previewKey: item.previewKey,
      premiumKey: item.premiumKey || '',
      previewPosterKey: '',
      premiumPosterKey: '',
      width: 0,
      height: 0,
      durationSeconds: 0,
      sortOrder: item.sortOrder,
      contentRating: (item.contentRating || 'general') as ContentRating,
      moderatorContentRating: item.moderatorContentRating || '',
      aiDisclosure: item.aiDisclosure || 'none',
      moderatorAiDisclosure: item.moderatorAiDisclosure || '',
      heavyTopics: item.heavyTopics || [],
      moderatorHeavyTopics: item.moderatorHeavyTopics || [],
      cropX: item.squareCrop?.x || 0,
      cropY: item.squareCrop?.y || 0,
      cropSize: item.squareCrop?.size || 512,
      discoverSquareCropEnabled: item.discoverSquareCropEnabled !== false,
      isPreview: Boolean(item.isPreview),
      previewMaxWidth: item.previewMaxWidth?.toString() || ''
    });
  };

  const saveEditMedia = () => withFeedback(async () => {
    const includeSquareCrop =
      mediaEditForm.assetType === 'image' &&
      (mediaEditForm.cropX !== 0 || mediaEditForm.cropY !== 0 || mediaEditForm.cropSize !== 512);
    await request(`/admin/images/${mediaEditForm.galleryId}/${mediaEditForm.imageId}`, 'PATCH', {
      ...mediaEditForm,
      previewMaxWidth: mediaEditForm.previewMaxWidth !== '' ? Number(mediaEditForm.previewMaxWidth) : undefined,
      squareCrop: includeSquareCrop
        ? { x: mediaEditForm.cropX, y: mediaEditForm.cropY, size: mediaEditForm.cropSize }
        : undefined,
      generateRenditions: true
    });
    setEditingMediaId(null);
    if (mediaGalleryId) await loadMedia(mediaGalleryId);
  }, 'Media updated');

  const parseJsonInput = <T,>(value: string, fallback: T): T => {
    if (!value.trim()) return fallback;
    return JSON.parse(value) as T;
  };

  const appendPostMediaRefJson = (
    currentJson: string,
    mediaId: string,
    setJson: (next: string) => void
  ) => {
    const trimmedMediaId = mediaId.trim();
    if (!trimmedMediaId) return;
    const current = parseJsonInput<Array<{ mediaId: string; discoverable?: boolean; sortOrder?: number; caption?: string }>>(currentJson, []);
    if (current.some((item) => item.mediaId === trimmedMediaId)) return;
    const next = [...current, { mediaId: trimmedMediaId, discoverable: true, sortOrder: current.length }];
    setJson(JSON.stringify(next, null, 2));
  };

  const appendPostBlockJson = (
    currentJson: string,
    block: Record<string, unknown>,
    setJson: (next: string) => void
  ) => {
    const current = parseJsonInput<Array<Record<string, unknown>>>(currentJson, []);
    const next = [...current, block];
    setJson(JSON.stringify(next, null, 2));
  };

  const createPost = () => withFeedback(async () => {
    if (!postForm.artistId || !postForm.title.trim()) throw new Error('Creator and title are required');
    const payload = {
      artistId: postForm.artistId,
      title: postForm.title.trim(),
      slug: postForm.slug.trim() || undefined,
      summary: postForm.summary.trim() || undefined,
      status: postForm.status,
      discoveryMode: postForm.discoveryMode,
      primaryMediaId: postForm.primaryMediaId.trim() || undefined,
      media: parseJsonInput<Array<{ mediaId: string; discoverable?: boolean; sortOrder?: number; caption?: string }>>(postForm.mediaJson, []),
      blocks: parseJsonInput<Array<Record<string, unknown>>>(postForm.blocksJson, []),
      metadata: parseJsonInput<Record<string, string>>(postForm.metadataJson, {}),
      destination: postForm.destinationUrl.trim()
        ? { type: postForm.destinationType, url: postForm.destinationUrl.trim() }
        : null
    };
    await request('/admin/posts', 'POST', payload);
    setPostForm((prev) => ({ ...createEmptyPostForm(), artistId: prev.artistId }));
    setPostTemplate('image');
    await loadPosts();
  }, 'Post created');

  const startEditPost = (post: Post) => {
    setEditingPostId(post.postId);
    setPostEditTemplate(inferTemplateFromMetadata(post.metadata));
    setPostEditForm({
      artistId: post.artistId,
      title: post.title,
      slug: post.slug,
      summary: post.summary || '',
      status: post.status,
      discoveryMode: post.discovery?.mode || 'primary',
      primaryMediaId: post.primaryMediaId || '',
      destinationType: post.destination?.type || 'post',
      destinationUrl: post.destination?.url || '',
      mediaJson: JSON.stringify(post.media || [], null, 2),
      blocksJson: JSON.stringify(post.blocks || [], null, 2),
      metadataJson: JSON.stringify(post.metadata || {}, null, 2)
    });
  };

  const saveEditPost = () => withFeedback(async () => {
    if (!editingPostId) return;
    const payload = {
      title: postEditForm.title.trim(),
      slug: postEditForm.slug.trim() || undefined,
      summary: postEditForm.summary.trim() || undefined,
      status: postEditForm.status,
      discoveryMode: postEditForm.discoveryMode,
      primaryMediaId: postEditForm.primaryMediaId.trim() || undefined,
      media: parseJsonInput<Array<{ mediaId: string; discoverable?: boolean; sortOrder?: number; caption?: string }>>(postEditForm.mediaJson, []),
      blocks: parseJsonInput<Array<Record<string, unknown>>>(postEditForm.blocksJson, []),
      metadata: parseJsonInput<Record<string, string>>(postEditForm.metadataJson, {}),
      destination: postEditForm.destinationUrl.trim()
        ? { type: postEditForm.destinationType, url: postEditForm.destinationUrl.trim() }
        : null
    };
    await request(`/admin/posts/${editingPostId}`, 'PATCH', payload);
    setEditingPostId(null);
    await loadPosts();
  }, 'Post updated');

  const deletePost = (postId: string) => withFeedback(async () => {
    await request(`/admin/posts/${postId}`, 'DELETE');
    await loadPosts();
  }, 'Post deleted');

  const generateRenditions = (item: Media) => withFeedback(async () => {
    await request(`/admin/images/${item.galleryId}/${item.imageId}/renditions`, 'POST', {
      squareCrop: item.squareCrop
    });
    if (mediaGalleryId) await loadMedia(mediaGalleryId);
  }, 'Renditions generated');

  const hideComment = () => withFeedback(async () => {
    await request(`/admin/comments/${commentId}`, 'PATCH', { hidden: true });
  }, `Comment ${commentId} hidden`);

  const deleteComment = () => withFeedback(async () => {
    await request(`/admin/comments/${commentId}`, 'DELETE');
  }, `Comment ${commentId} deleted`);

  const blockUser = () => withFeedback(async () => {
    await request(`/admin/users/${blockUserId}/block`, 'POST', { reason: 'policy' });
  }, `Blocked user ${blockUserId}`);

  const unblockUser = () => withFeedback(async () => {
    await request(`/admin/users/${blockUserId}/block`, 'DELETE');
  }, `Unblocked user ${blockUserId}`);

  const saveSiteSettings = () => withFeedback(async () => {
    setSavingSettings(true);
    try {
      await request('/admin/site-settings', 'PATCH', {
        siteName: siteSettings.siteName,
        theme: siteSettings.theme,
        logoKey: siteSettings.logoKey
      });
      await loadSiteSettings();
    } finally {
      setSavingSettings(false);
    }
  }, 'Site settings saved');

  const uploadLogo = (file: File | null) => withFeedback(async () => {
    if (!file) return;
    const upload = await request('/admin/site-settings/logo-upload-url', 'POST', { contentType: file.type || 'image/png' });
    const putResponse = await fetch(upload.uploadUrl, {
      method: 'PUT',
      headers: { 'Content-Type': upload.contentType || file.type || 'image/png' },
      body: file
    });
    if (!putResponse.ok) {
      throw new Error('Logo upload failed');
    }
    setSiteSettings((prev) => ({ ...prev, logoKey: upload.key }));
    setMessage('Logo uploaded. Save settings to publish.');
  });

  return (
    <main className="studio-shell">
      <aside className="sidebar">
        <h1>Orchestration</h1>
        <div className="auth-card">
          {!user ? (
            <>
              <div className="auth-nav">
                <button onClick={() => setAuthMode('signin')}>Sign In</button>
                <button onClick={() => setAuthMode('forgot')}>Forgot</button>
              </div>
            </>
          ) : (
            <>
              <p>Signed in: <strong>{user.username}</strong></p>
              <p className="muted">Groups: {user.groups.join(', ') || 'none'}</p>
              <button onClick={() => setAuthMode('change')}>Change Password</button>
              <button onClick={doSignOut}>Sign Out</button>
            </>
          )}

          {(authMode === 'signin' || authMode === 'forgot' || authMode === 'reset' || authMode === 'initial' || authMode === 'change') && (
            <>
              {(authMode !== 'change') && (
                <input placeholder="Email" value={email} onChange={(e) => setEmail(e.target.value)} />
              )}
              {(authMode === 'signin') && (
                <input placeholder="Password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
              )}
              {(authMode === 'reset') && (
                <input placeholder="Code" value={code} onChange={(e) => setCode(e.target.value)} />
              )}
              {(authMode === 'reset' || authMode === 'initial' || authMode === 'change') && (
                <input placeholder="New password" type="password" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} />
              )}
              {authMode === 'change' && (
                <input placeholder="Current password" type="password" value={currentPassword} onChange={(e) => setCurrentPassword(e.target.value)} />
              )}

              {authMode === 'signin' && <button onClick={doSignIn}>Sign In</button>}
              {authMode === 'forgot' && <button onClick={doForgot}>Send Reset Code</button>}
              {authMode === 'reset' && <button onClick={doReset}>Reset Password</button>}
              {authMode === 'initial' && <button onClick={doInitialPassword}>Set Initial Password</button>}
              {authMode === 'change' && <button onClick={doChangePassword}>Change Password</button>}
            </>
          )}
        </div>

        {visibleViews.map((item) => (
          <button key={item.id} className={view === item.id ? 'nav-btn active' : 'nav-btn'} onClick={() => setView(item.id)}>
            {item.label}
          </button>
        ))}
      </aside>

      <section className="content">
        {!user && <p>Sign in to continue.</p>}
        {user && !canManageContent && <p className="error">You are signed in but not in the Cognito `Creators`/`Artists` or `Admins` groups.</p>}

        {user && isAdmin && view === 'creators' && (
          <>
            <h2>Creators</h2>
            <div className="list">
              {artists.map((artist) => (
                <div className="list-row" key={artist.artistId}>
                  <span>{artist.name} ({artist.slug})</span>
                  <div className="row-actions">
                    <button onClick={() => startEditArtist(artist)}>Edit</button>
                    <button onClick={() => deleteArtist(artist.artistId)}>Delete</button>
                  </div>
                </div>
              ))}
            </div>
            {editingArtistId && (
              <>
                <h3>Edit Creator</h3>
                <input placeholder="Name" value={artistEditForm.name} onChange={(e) => setArtistEditForm({ ...artistEditForm, name: e.target.value })} />
                <input placeholder="Slug" value={artistEditForm.slug} onChange={(e) => setArtistEditForm({ ...artistEditForm, slug: e.target.value })} />
                <select value={artistEditForm.status} onChange={(e) => setArtistEditForm({ ...artistEditForm, status: e.target.value })}>
                  <option value="active">active</option>
                  <option value="inactive">inactive</option>
                </select>
                <input type="number" placeholder="Sort order" value={artistEditForm.sortOrder} onChange={(e) => setArtistEditForm({ ...artistEditForm, sortOrder: Number(e.target.value || 0) })} />
                <label className="inline-form">
                  <input
                    type="checkbox"
                    checked={artistEditForm.discoverSquareCropEnabled}
                    onChange={(e) => setArtistEditForm({ ...artistEditForm, discoverSquareCropEnabled: e.target.checked })}
                  />
                  <span>Allow square crop in discovery</span>
                </label>
                <label className="inline-form">
                  <span>Default AI disclosure</span>
                  <select value={artistEditForm.defaultAiDisclosure} onChange={(e) => setArtistEditForm({ ...artistEditForm, defaultAiDisclosure: e.target.value as AiDisclosure })}>
                    {aiDisclosureOptions.map((option) => <option key={`artist-edit-ai-${option}`} value={option}>{option}</option>)}
                  </select>
                </label>
                {heavyTopicOptions.map((topic) => (
                  <label key={`artist-edit-topic-${topic.value}`} className="inline-form">
                    <input
                      type="checkbox"
                      checked={artistEditForm.defaultHeavyTopics.includes(topic.value)}
                      onChange={(e) => setArtistEditForm({
                        ...artistEditForm,
                        defaultHeavyTopics: e.target.checked
                          ? Array.from(new Set([...artistEditForm.defaultHeavyTopics, topic.value]))
                          : artistEditForm.defaultHeavyTopics.filter((value) => value !== topic.value)
                      })}
                    />
                    <span>{topic.label}</span>
                  </label>
                ))}
                <button onClick={() => saveEditArtist(editingArtistId)}>Save Creator</button>
                <button onClick={() => setEditingArtistId(null)}>Cancel</button>
              </>
            )}
            <h3>Create Creator</h3>
            <input placeholder="Name" value={artistForm.name} onChange={(e) => setArtistForm({ ...artistForm, name: e.target.value })} />
            <input placeholder="Slug" value={artistForm.slug} onChange={(e) => setArtistForm({ ...artistForm, slug: e.target.value })} />
            <input type="number" placeholder="Sort order" value={artistForm.sortOrder} onChange={(e) => setArtistForm({ ...artistForm, sortOrder: Number(e.target.value || 1) })} />
            <label className="inline-form">
              <input
                type="checkbox"
                checked={artistForm.discoverSquareCropEnabled}
                onChange={(e) => setArtistForm({ ...artistForm, discoverSquareCropEnabled: e.target.checked })}
              />
              <span>Allow square crop in discovery</span>
            </label>
            <label className="inline-form">
              <span>Default AI disclosure</span>
              <select value={artistForm.defaultAiDisclosure} onChange={(e) => setArtistForm({ ...artistForm, defaultAiDisclosure: e.target.value as AiDisclosure })}>
                {aiDisclosureOptions.map((option) => <option key={`artist-create-ai-${option}`} value={option}>{option}</option>)}
              </select>
            </label>
            {heavyTopicOptions.map((topic) => (
              <label key={`artist-create-topic-${topic.value}`} className="inline-form">
                <input
                  type="checkbox"
                  checked={artistForm.defaultHeavyTopics.includes(topic.value)}
                  onChange={(e) => setArtistForm({
                    ...artistForm,
                    defaultHeavyTopics: e.target.checked
                      ? Array.from(new Set([...artistForm.defaultHeavyTopics, topic.value]))
                      : artistForm.defaultHeavyTopics.filter((value) => value !== topic.value)
                  })}
                />
                <span>{topic.label}</span>
              </label>
            ))}
            <button onClick={createArtist}>Create Artist</button>
          </>
        )}

        {user && canManageContent && view === 'galleries' && (
          <>
            <h2>Galleries</h2>
            <div className="list">
              {galleries.map((gallery) => (
                <div className="list-row" key={gallery.galleryId}>
                  <span>
                    {gallery.title} ({gallery.slug})
                    {' · '}preview default: {gallery.defaultPreviewMaxWidth ?? 'none'}
                  </span>
                  {isAdmin && (
                    <div className="row-actions">
                      <button onClick={() => startEditGallery(gallery)}>Edit</button>
                      <button onClick={() => deleteGallery(gallery.galleryId)}>Delete</button>
                    </div>
                  )}
                </div>
              ))}
            </div>
            {isAdmin && editingGalleryId && (
              <>
                <h3>Edit Gallery</h3>
                <input placeholder="Creator ID" value={galleryEditForm.artistId} onChange={(e) => setGalleryEditForm({ ...galleryEditForm, artistId: e.target.value })} />
                <input placeholder="Creator Slug" value={galleryEditForm.artistSlug} onChange={(e) => setGalleryEditForm({ ...galleryEditForm, artistSlug: e.target.value })} />
                <input placeholder="Title" value={galleryEditForm.title} onChange={(e) => setGalleryEditForm({ ...galleryEditForm, title: e.target.value })} />
                <input placeholder="Slug" value={galleryEditForm.slug} onChange={(e) => setGalleryEditForm({ ...galleryEditForm, slug: e.target.value })} />
                <input placeholder="Cover Image ID (optional)" value={galleryEditForm.coverImageId} onChange={(e) => setGalleryEditForm({ ...galleryEditForm, coverImageId: e.target.value })} />
                <input placeholder="Paired Premium Gallery ID (preview only)" value={galleryEditForm.pairedPremiumGalleryId} onChange={(e) => setGalleryEditForm({ ...galleryEditForm, pairedPremiumGalleryId: e.target.value })} />
                <input placeholder="Purchase URL (preview only)" value={galleryEditForm.purchaseUrl} onChange={(e) => setGalleryEditForm({ ...galleryEditForm, purchaseUrl: e.target.value })} />
                <select value={galleryEditForm.visibility} onChange={(e) => setGalleryEditForm({ ...galleryEditForm, visibility: e.target.value })}>
                  <option value="free">free</option>
                  <option value="preview">preview</option>
                  <option value="premium">premium</option>
                </select>
                <select value={galleryEditForm.status} onChange={(e) => setGalleryEditForm({ ...galleryEditForm, status: e.target.value })}>
                  <option value="published">published</option>
                  <option value="draft">draft</option>
                </select>
                <label className="inline-form">
                  <input
                    type="checkbox"
                    checked={galleryEditForm.discoverSquareCropEnabled}
                    onChange={(e) => setGalleryEditForm({ ...galleryEditForm, discoverSquareCropEnabled: e.target.checked })}
                  />
                  <span>Allow square crop in discovery</span>
                </label>
                <input
                  type="number"
                  placeholder="Default preview max width (optional)"
                  value={galleryEditForm.defaultPreviewMaxWidth}
                  onChange={(e) => setGalleryEditForm({ ...galleryEditForm, defaultPreviewMaxWidth: e.target.value })}
                />
                <label className="inline-form">
                  <span>Default AI disclosure</span>
                  <select value={galleryEditForm.defaultAiDisclosure} onChange={(e) => setGalleryEditForm({ ...galleryEditForm, defaultAiDisclosure: e.target.value as AiDisclosure })}>
                    {aiDisclosureOptions.map((option) => <option key={`gallery-edit-ai-${option}`} value={option}>{option}</option>)}
                  </select>
                </label>
                {heavyTopicOptions.map((topic) => (
                  <label key={`gallery-edit-topic-${topic.value}`} className="inline-form">
                    <input
                      type="checkbox"
                      checked={galleryEditForm.defaultHeavyTopics.includes(topic.value)}
                      onChange={(e) => setGalleryEditForm({
                        ...galleryEditForm,
                        defaultHeavyTopics: e.target.checked
                          ? Array.from(new Set([...galleryEditForm.defaultHeavyTopics, topic.value]))
                          : galleryEditForm.defaultHeavyTopics.filter((value) => value !== topic.value)
                      })}
                    />
                    <span>{topic.label}</span>
                  </label>
                ))}
                <input placeholder="Set new premium password (optional)" value={galleryEditForm.premiumPassword} onChange={(e) => setGalleryEditForm({ ...galleryEditForm, premiumPassword: e.target.value })} />
                <button onClick={() => saveEditGallery(editingGalleryId)}>Save Gallery</button>
                <button onClick={() => setEditingGalleryId(null)}>Cancel</button>
              </>
            )}
            <h3>Create Gallery</h3>
            <input placeholder="Creator ID" value={galleryForm.artistId} onChange={(e) => setGalleryForm({ ...galleryForm, artistId: e.target.value })} />
            <input placeholder="Creator Slug" value={galleryForm.artistSlug} onChange={(e) => setGalleryForm({ ...galleryForm, artistSlug: e.target.value })} />
            <input placeholder="Title" value={galleryForm.title} onChange={(e) => setGalleryForm({ ...galleryForm, title: e.target.value })} />
            <input placeholder="Slug" value={galleryForm.slug} onChange={(e) => setGalleryForm({ ...galleryForm, slug: e.target.value })} />
            <input placeholder="Cover Image ID (optional)" value={galleryForm.coverImageId} onChange={(e) => setGalleryForm({ ...galleryForm, coverImageId: e.target.value })} />
            <input placeholder="Paired Premium Gallery ID (preview only)" value={galleryForm.pairedPremiumGalleryId} onChange={(e) => setGalleryForm({ ...galleryForm, pairedPremiumGalleryId: e.target.value })} />
            <input placeholder="Purchase URL (preview only)" value={galleryForm.purchaseUrl} onChange={(e) => setGalleryForm({ ...galleryForm, purchaseUrl: e.target.value })} />
            <select value={galleryForm.visibility} onChange={(e) => setGalleryForm({ ...galleryForm, visibility: e.target.value })}>
              <option value="free">free</option>
              <option value="preview">preview</option>
              <option value="premium">premium</option>
            </select>
            <label className="inline-form">
              <input
                type="checkbox"
                checked={galleryForm.discoverSquareCropEnabled}
                onChange={(e) => setGalleryForm({ ...galleryForm, discoverSquareCropEnabled: e.target.checked })}
              />
              <span>Allow square crop in discovery</span>
            </label>
            <input
              type="number"
              placeholder="Default preview max width (optional)"
              value={galleryForm.defaultPreviewMaxWidth}
              onChange={(e) => setGalleryForm({ ...galleryForm, defaultPreviewMaxWidth: e.target.value })}
            />
            <label className="inline-form">
              <span>Default AI disclosure</span>
              <select value={galleryForm.defaultAiDisclosure} onChange={(e) => setGalleryForm({ ...galleryForm, defaultAiDisclosure: e.target.value as AiDisclosure })}>
                {aiDisclosureOptions.map((option) => <option key={`gallery-create-ai-${option}`} value={option}>{option}</option>)}
              </select>
            </label>
            {heavyTopicOptions.map((topic) => (
              <label key={`gallery-create-topic-${topic.value}`} className="inline-form">
                <input
                  type="checkbox"
                  checked={galleryForm.defaultHeavyTopics.includes(topic.value)}
                  onChange={(e) => setGalleryForm({
                    ...galleryForm,
                    defaultHeavyTopics: e.target.checked
                      ? Array.from(new Set([...galleryForm.defaultHeavyTopics, topic.value]))
                      : galleryForm.defaultHeavyTopics.filter((value) => value !== topic.value)
                  })}
                />
                <span>{topic.label}</span>
              </label>
            ))}
            <input placeholder="Premium password" value={galleryForm.premiumPassword} onChange={(e) => setGalleryForm({ ...galleryForm, premiumPassword: e.target.value })} />
            <button onClick={createGallery}>Create Gallery</button>
          </>
        )}

        {user && canManageContent && view === 'media' && (
          <>
            <h2>Media</h2>
            <select value={mediaGalleryId} onChange={(e) => { setMediaGalleryId(e.target.value); void loadMedia(e.target.value); }}>
              <option value="">Select gallery</option>
              {galleries.map((g) => (
                <option key={g.galleryId} value={g.galleryId}>{g.title}</option>
              ))}
            </select>
            <div className="list">
              {media.map((item) => (
                <div className="list-row" key={item.imageId}>
                  <span>
                    {item.assetType || 'image'}: {item.imageId} ({item.previewKey}) [{item.contentRating || 'general'}]
                    {' · '}isPreview: {item.isPreview ? 'yes' : 'no'}
                    {' · '}previewMaxWidth: {item.previewMaxWidth ?? 'none'}
                    {' · '}AI: {item.aiDisclosure || 'none'}
                    {' · '}Topics: {(item.heavyTopics || []).join(', ') || 'none'}
                  </span>
                  {canManageContent && (
                    <button onClick={() => setGalleryCover(item.galleryId, item.imageId)}>Set As Cover</button>
                  )}
                  {isAdmin && (
                    <div className="row-actions">
                      <button onClick={() => startEditMedia(item)}>Edit</button>
                      {item.assetType !== 'video' && <button onClick={() => generateRenditions(item)}>Generate Renditions</button>}
                      <button onClick={() => deleteMedia(item)}>Delete</button>
                    </div>
                  )}
                </div>
              ))}
            </div>
            {isAdmin && editingMediaId && (
              <>
                <h3>Edit Media</h3>
                <input placeholder="Gallery ID" value={mediaEditForm.galleryId} onChange={(e) => setMediaEditForm({ ...mediaEditForm, galleryId: e.target.value })} />
                <input placeholder="Image ID" value={mediaEditForm.imageId} onChange={(e) => setMediaEditForm({ ...mediaEditForm, imageId: e.target.value })} />
                <select value={mediaEditForm.assetType} onChange={(e) => setMediaEditForm({ ...mediaEditForm, assetType: e.target.value })}>
                  <option value="image">image</option>
                  <option value="video">video</option>
                </select>
                <input placeholder="Title" value={mediaEditForm.title} onChange={(e) => setMediaEditForm({ ...mediaEditForm, title: e.target.value })} />
                <input placeholder="Original filename" value={mediaEditForm.originalFilename} onChange={(e) => setMediaEditForm({ ...mediaEditForm, originalFilename: e.target.value })} />
                <input placeholder="Preview key" value={mediaEditForm.previewKey} onChange={(e) => setMediaEditForm({ ...mediaEditForm, previewKey: e.target.value })} />
                <input placeholder="Premium key" value={mediaEditForm.premiumKey} onChange={(e) => setMediaEditForm({ ...mediaEditForm, premiumKey: e.target.value })} />
                <input placeholder="Preview poster key" value={mediaEditForm.previewPosterKey} onChange={(e) => setMediaEditForm({ ...mediaEditForm, previewPosterKey: e.target.value })} />
                <input placeholder="Premium poster key" value={mediaEditForm.premiumPosterKey} onChange={(e) => setMediaEditForm({ ...mediaEditForm, premiumPosterKey: e.target.value })} />
                <input type="number" placeholder="Width" value={mediaEditForm.width} onChange={(e) => setMediaEditForm({ ...mediaEditForm, width: Number(e.target.value || 0) })} />
                <input type="number" placeholder="Height" value={mediaEditForm.height} onChange={(e) => setMediaEditForm({ ...mediaEditForm, height: Number(e.target.value || 0) })} />
                <input type="number" placeholder="Duration seconds" value={mediaEditForm.durationSeconds} onChange={(e) => setMediaEditForm({ ...mediaEditForm, durationSeconds: Number(e.target.value || 0) })} />
                <input type="number" placeholder="Sort order" value={mediaEditForm.sortOrder} onChange={(e) => setMediaEditForm({ ...mediaEditForm, sortOrder: Number(e.target.value || 0) })} />
                <select value={mediaEditForm.contentRating} onChange={(e) => setMediaEditForm({ ...mediaEditForm, contentRating: e.target.value as ContentRating })}>
                  {contentRatingOptions.map((option) => <option key={`edit-rating-${option}`} value={option}>{option}</option>)}
                </select>
                <select value={mediaEditForm.moderatorContentRating} onChange={(e) => setMediaEditForm({ ...mediaEditForm, moderatorContentRating: e.target.value })}>
                  <option value="">Moderator override (none)</option>
                  {contentRatingOptions.map((option) => <option key={`edit-mod-rating-${option}`} value={option}>{option}</option>)}
                </select>
                <select value={mediaEditForm.aiDisclosure} onChange={(e) => setMediaEditForm({ ...mediaEditForm, aiDisclosure: e.target.value as AiDisclosure })}>
                  {aiDisclosureOptions.map((option) => <option key={`edit-ai-${option}`} value={option}>{option}</option>)}
                </select>
                <select value={mediaEditForm.moderatorAiDisclosure} onChange={(e) => setMediaEditForm({ ...mediaEditForm, moderatorAiDisclosure: e.target.value })}>
                  <option value="">Moderator AI override (none)</option>
                  {aiDisclosureOptions.map((option) => <option key={`edit-mod-ai-${option}`} value={option}>{option}</option>)}
                </select>
                {heavyTopicOptions.map((topic) => (
                  <label key={`media-edit-topic-${topic.value}`} className="inline-form">
                    <input
                      type="checkbox"
                      checked={mediaEditForm.heavyTopics.includes(topic.value)}
                      onChange={(e) => setMediaEditForm({
                        ...mediaEditForm,
                        heavyTopics: e.target.checked
                          ? Array.from(new Set([...mediaEditForm.heavyTopics, topic.value]))
                          : mediaEditForm.heavyTopics.filter((value) => value !== topic.value)
                      })}
                    />
                    <span>Creator topic: {topic.label}</span>
                  </label>
                ))}
                {heavyTopicOptions.map((topic) => (
                  <label key={`media-edit-mod-topic-${topic.value}`} className="inline-form">
                    <input
                      type="checkbox"
                      checked={mediaEditForm.moderatorHeavyTopics.includes(topic.value)}
                      onChange={(e) => setMediaEditForm({
                        ...mediaEditForm,
                        moderatorHeavyTopics: e.target.checked
                          ? Array.from(new Set([...mediaEditForm.moderatorHeavyTopics, topic.value]))
                          : mediaEditForm.moderatorHeavyTopics.filter((value) => value !== topic.value)
                      })}
                    />
                    <span>Moderator topic: {topic.label}</span>
                  </label>
                ))}
                <label className="inline-form">
                  <input
                    type="checkbox"
                    checked={mediaEditForm.discoverSquareCropEnabled}
                    onChange={(e) => setMediaEditForm({ ...mediaEditForm, discoverSquareCropEnabled: e.target.checked })}
                  />
                  <span>Allow square crop in discovery</span>
                </label>
                <label className="inline-form">
                  <input
                    type="checkbox"
                    checked={mediaEditForm.isPreview}
                    onChange={(e) => setMediaEditForm({ ...mediaEditForm, isPreview: e.target.checked })}
                  />
                  <span>Show as preview in premium gallery</span>
                </label>
                <input
                  type="number"
                  placeholder="Preview max width (optional)"
                  value={mediaEditForm.previewMaxWidth}
                  onChange={(e) => setMediaEditForm({ ...mediaEditForm, previewMaxWidth: e.target.value })}
                />
                {mediaEditForm.assetType === 'image' && (
                  <>
                    <input type="number" placeholder="Square crop X" value={mediaEditForm.cropX} onChange={(e) => setMediaEditForm({ ...mediaEditForm, cropX: Number(e.target.value || 0) })} />
                    <input type="number" placeholder="Square crop Y" value={mediaEditForm.cropY} onChange={(e) => setMediaEditForm({ ...mediaEditForm, cropY: Number(e.target.value || 0) })} />
                    <input type="number" placeholder="Square crop size" value={mediaEditForm.cropSize} onChange={(e) => setMediaEditForm({ ...mediaEditForm, cropSize: Number(e.target.value || 1) })} />
                  </>
                )}
                <button onClick={saveEditMedia}>Save Media</button>
                <button onClick={() => setEditingMediaId(null)}>Cancel</button>
              </>
            )}
            <h3>Create Media</h3>
            <input placeholder="Gallery ID" value={mediaForm.galleryId} onChange={(e) => setMediaForm({ ...mediaForm, galleryId: e.target.value })} />
            <select value={mediaForm.assetType} onChange={(e) => setMediaForm({ ...mediaForm, assetType: e.target.value })}>
              <option value="image">image</option>
              <option value="video">video</option>
            </select>
            <input placeholder="Title (optional)" value={mediaForm.title} onChange={(e) => setMediaForm({ ...mediaForm, title: e.target.value })} />
            <input placeholder="Original filename (optional)" value={mediaForm.originalFilename} onChange={(e) => setMediaForm({ ...mediaForm, originalFilename: e.target.value })} />
            <input placeholder="Preview key" value={mediaForm.previewKey} onChange={(e) => setMediaForm({ ...mediaForm, previewKey: e.target.value })} />
            <input placeholder="Premium key" value={mediaForm.premiumKey} onChange={(e) => setMediaForm({ ...mediaForm, premiumKey: e.target.value })} />
            <input placeholder="Preview poster key" value={mediaForm.previewPosterKey} onChange={(e) => setMediaForm({ ...mediaForm, previewPosterKey: e.target.value })} />
            <input placeholder="Premium poster key" value={mediaForm.premiumPosterKey} onChange={(e) => setMediaForm({ ...mediaForm, premiumPosterKey: e.target.value })} />
            <input type="number" placeholder="Width" value={mediaForm.width} onChange={(e) => setMediaForm({ ...mediaForm, width: Number(e.target.value || 0) })} />
            <input type="number" placeholder="Height" value={mediaForm.height} onChange={(e) => setMediaForm({ ...mediaForm, height: Number(e.target.value || 0) })} />
            <input type="number" placeholder="Duration seconds" value={mediaForm.durationSeconds} onChange={(e) => setMediaForm({ ...mediaForm, durationSeconds: Number(e.target.value || 0) })} />
            <input type="number" placeholder="Sort order" value={mediaForm.sortOrder} onChange={(e) => setMediaForm({ ...mediaForm, sortOrder: Number(e.target.value || 0) })} />
            <select value={mediaForm.contentRating} onChange={(e) => setMediaForm({ ...mediaForm, contentRating: e.target.value as ContentRating })}>
              {contentRatingOptions.map((option) => <option key={`create-rating-${option}`} value={option}>{option}</option>)}
            </select>
            <select value={mediaForm.moderatorContentRating} onChange={(e) => setMediaForm({ ...mediaForm, moderatorContentRating: e.target.value })}>
              <option value="">Moderator override (none)</option>
              {contentRatingOptions.map((option) => <option key={`create-mod-rating-${option}`} value={option}>{option}</option>)}
            </select>
            <select value={mediaForm.aiDisclosure} onChange={(e) => setMediaForm({ ...mediaForm, aiDisclosure: e.target.value as AiDisclosure })}>
              {aiDisclosureOptions.map((option) => <option key={`create-ai-${option}`} value={option}>{option}</option>)}
            </select>
            <select value={mediaForm.moderatorAiDisclosure} onChange={(e) => setMediaForm({ ...mediaForm, moderatorAiDisclosure: e.target.value })}>
              <option value="">Moderator AI override (none)</option>
              {aiDisclosureOptions.map((option) => <option key={`create-mod-ai-${option}`} value={option}>{option}</option>)}
            </select>
            {heavyTopicOptions.map((topic) => (
              <label key={`media-create-topic-${topic.value}`} className="inline-form">
                <input
                  type="checkbox"
                  checked={mediaForm.heavyTopics.includes(topic.value)}
                  onChange={(e) => setMediaForm({
                    ...mediaForm,
                    heavyTopics: e.target.checked
                      ? Array.from(new Set([...mediaForm.heavyTopics, topic.value]))
                      : mediaForm.heavyTopics.filter((value) => value !== topic.value)
                  })}
                />
                <span>Creator topic: {topic.label}</span>
              </label>
            ))}
            {heavyTopicOptions.map((topic) => (
              <label key={`media-create-mod-topic-${topic.value}`} className="inline-form">
                <input
                  type="checkbox"
                  checked={mediaForm.moderatorHeavyTopics.includes(topic.value)}
                  onChange={(e) => setMediaForm({
                    ...mediaForm,
                    moderatorHeavyTopics: e.target.checked
                      ? Array.from(new Set([...mediaForm.moderatorHeavyTopics, topic.value]))
                      : mediaForm.moderatorHeavyTopics.filter((value) => value !== topic.value)
                  })}
                />
                <span>Moderator topic: {topic.label}</span>
              </label>
            ))}
            <label className="inline-form">
              <input
                type="checkbox"
                checked={mediaForm.discoverSquareCropEnabled}
                onChange={(e) => setMediaForm({ ...mediaForm, discoverSquareCropEnabled: e.target.checked })}
              />
              <span>Allow square crop in discovery</span>
            </label>
            <label className="inline-form">
              <input
                type="checkbox"
                checked={mediaForm.isPreview}
                onChange={(e) => setMediaForm({ ...mediaForm, isPreview: e.target.checked })}
              />
              <span>Show as preview in premium gallery</span>
            </label>
            <input
              type="number"
              placeholder="Preview max width (optional)"
              value={mediaForm.previewMaxWidth}
              onChange={(e) => setMediaForm({ ...mediaForm, previewMaxWidth: e.target.value })}
            />
            {mediaForm.assetType === 'image' && (
              <>
                <input type="number" placeholder="Square crop X" value={mediaForm.cropX} onChange={(e) => setMediaForm({ ...mediaForm, cropX: Number(e.target.value || 0) })} />
                <input type="number" placeholder="Square crop Y" value={mediaForm.cropY} onChange={(e) => setMediaForm({ ...mediaForm, cropY: Number(e.target.value || 0) })} />
                <input type="number" placeholder="Square crop size" value={mediaForm.cropSize} onChange={(e) => setMediaForm({ ...mediaForm, cropSize: Number(e.target.value || 1) })} />
              </>
            )}
            <button onClick={createMedia}>Create Media</button>
          </>
        )}

        {user && canManageContent && view === 'posts' && (
          <>
            <h2>Posts</h2>
            <div className="list">
              {posts.map((post) => (
                <div className="list-row" key={post.postId}>
                  <span>
                    {post.title} ({post.slug}) · {post.status}
                    {' · '}discovery: {post.discovery?.mode || 'primary'}
                    {' · '}media: {post.media?.length || 0}
                    {' · '}blocks: {post.blocks?.length || 0}
                  </span>
                  <div className="row-actions">
                    <button onClick={() => startEditPost(post)}>Edit</button>
                    <button onClick={() => deletePost(post.postId)}>Delete</button>
                  </div>
                </div>
              ))}
            </div>
            {editingPostId && (
              <>
                <h3>Edit Post</h3>
                <div className="row-actions">
                  <select value={postEditTemplate} onChange={(e) => setPostEditTemplate(e.target.value as PostTemplate)}>
                    {postTemplateOptions.map((option) => (
                      <option key={`post-edit-template-${option.value}`} value={option.value}>{option.label}</option>
                    ))}
                  </select>
                  <button type="button" onClick={() => setPostEditForm((prev) => buildTemplatedPostForm(prev, postEditTemplate))}>
                    Apply template
                  </button>
                </div>
                <select value={postEditForm.artistId} onChange={(e) => setPostEditForm({ ...postEditForm, artistId: e.target.value })}>
                  <option value="">Select creator</option>
                  {artists.map((artist) => <option key={`post-edit-artist-${artist.artistId}`} value={artist.artistId}>{artist.name}</option>)}
                </select>
                <input placeholder="Title" value={postEditForm.title} onChange={(e) => setPostEditForm({ ...postEditForm, title: e.target.value })} />
                <input placeholder="Slug" value={postEditForm.slug} onChange={(e) => setPostEditForm({ ...postEditForm, slug: e.target.value })} />
                <textarea placeholder="Summary (optional)" value={postEditForm.summary} onChange={(e) => setPostEditForm({ ...postEditForm, summary: e.target.value })} rows={3} />
                <select value={postEditForm.status} onChange={(e) => setPostEditForm({ ...postEditForm, status: e.target.value as Post['status'] })}>
                  <option value="draft">draft</option>
                  <option value="published">published</option>
                  <option value="archived">archived</option>
                </select>
                <select value={postEditForm.discoveryMode} onChange={(e) => setPostEditForm({ ...postEditForm, discoveryMode: e.target.value as 'primary' | 'all' | 'selected' })}>
                  <option value="primary">primary</option>
                  <option value="all">all</option>
                  <option value="selected">selected</option>
                </select>
                <input placeholder="Primary media ID (optional)" value={postEditForm.primaryMediaId} onChange={(e) => setPostEditForm({ ...postEditForm, primaryMediaId: e.target.value })} />
                <select value={postEditForm.destinationType} onChange={(e) => setPostEditForm({ ...postEditForm, destinationType: e.target.value as 'post' | 'pdf' | 'external' | 'internal' })}>
                  <option value="post">post</option>
                  <option value="pdf">pdf</option>
                  <option value="external">external</option>
                  <option value="internal">internal</option>
                </select>
                <input placeholder="Destination URL (optional)" value={postEditForm.destinationUrl} onChange={(e) => setPostEditForm({ ...postEditForm, destinationUrl: e.target.value })} />
                <textarea placeholder="Media refs JSON" value={postEditForm.mediaJson} onChange={(e) => setPostEditForm({ ...postEditForm, mediaJson: e.target.value })} rows={4} />
                <div className="row-actions">
                  <button
                    type="button"
                    onClick={() =>
                      appendPostMediaRefJson(postEditForm.mediaJson, postEditForm.primaryMediaId, (next) =>
                        setPostEditForm({ ...postEditForm, mediaJson: next })
                      )
                    }
                  >
                    Add primary media ref
                  </button>
                </div>
                <textarea placeholder="Blocks JSON" value={postEditForm.blocksJson} onChange={(e) => setPostEditForm({ ...postEditForm, blocksJson: e.target.value })} rows={6} />
                <div className="row-actions">
                  <button
                    type="button"
                    onClick={() =>
                      appendPostBlockJson(
                        postEditForm.blocksJson,
                        { blockId: `h-${Date.now()}`, type: 'heading', level: 2, text: 'New heading' },
                        (next) => setPostEditForm({ ...postEditForm, blocksJson: next })
                      )
                    }
                  >
                    Add heading block
                  </button>
                  <button
                    type="button"
                    onClick={() =>
                      appendPostBlockJson(
                        postEditForm.blocksJson,
                        { blockId: `p-${Date.now()}`, type: 'paragraph', text: 'New paragraph' },
                        (next) => setPostEditForm({ ...postEditForm, blocksJson: next })
                      )
                    }
                  >
                    Add paragraph block
                  </button>
                  <button
                    type="button"
                    onClick={() =>
                      appendPostBlockJson(
                        postEditForm.blocksJson,
                        { blockId: `m-${Date.now()}`, type: 'image', mediaId: postEditForm.primaryMediaId || '' },
                        (next) => setPostEditForm({ ...postEditForm, blocksJson: next })
                      )
                    }
                  >
                    Add image block
                  </button>
                  <button
                    type="button"
                    onClick={() =>
                      appendPostBlockJson(
                        postEditForm.blocksJson,
                        { blockId: `v-${Date.now()}`, type: 'video', mediaId: postEditForm.primaryMediaId || '' },
                        (next) => setPostEditForm({ ...postEditForm, blocksJson: next })
                      )
                    }
                  >
                    Add video block
                  </button>
                  <button
                    type="button"
                    onClick={() =>
                      appendPostBlockJson(
                        postEditForm.blocksJson,
                        { blockId: `a-${Date.now()}`, type: 'audio', mediaId: postEditForm.primaryMediaId || '' },
                        (next) => setPostEditForm({ ...postEditForm, blocksJson: next })
                      )
                    }
                  >
                    Add audio block
                  </button>
                  <button
                    type="button"
                    onClick={() =>
                      appendPostBlockJson(
                        postEditForm.blocksJson,
                        { blockId: `q-${Date.now()}`, type: 'quote', text: 'Add a quote...', cite: '' },
                        (next) => setPostEditForm({ ...postEditForm, blocksJson: next })
                      )
                    }
                  >
                    Add quote block
                  </button>
                  <button
                    type="button"
                    onClick={() =>
                      appendPostBlockJson(
                        postEditForm.blocksJson,
                        { blockId: `d-${Date.now()}`, type: 'divider' },
                        (next) => setPostEditForm({ ...postEditForm, blocksJson: next })
                      )
                    }
                  >
                    Add divider block
                  </button>
                  <button
                    type="button"
                    onClick={() =>
                      appendPostBlockJson(
                        postEditForm.blocksJson,
                        { blockId: `l-${Date.now()}`, type: 'link', url: postEditForm.destinationUrl || 'https://example.com', label: 'Open link' },
                        (next) => setPostEditForm({ ...postEditForm, blocksJson: next })
                      )
                    }
                  >
                    Add link block
                  </button>
                  <button
                    type="button"
                    onClick={() =>
                      appendPostBlockJson(
                        postEditForm.blocksJson,
                        { blockId: `e-${Date.now()}`, type: 'embed', url: postEditForm.destinationUrl || 'https://example.com/embed' },
                        (next) => setPostEditForm({ ...postEditForm, blocksJson: next })
                      )
                    }
                  >
                    Add embed block
                  </button>
                  <button
                    type="button"
                    onClick={() =>
                      appendPostBlockJson(
                        postEditForm.blocksJson,
                        { blockId: `f-${Date.now()}`, type: 'file', url: postEditForm.destinationUrl || 'https://example.com/file.pdf', label: 'Attached file' },
                        (next) => setPostEditForm({ ...postEditForm, blocksJson: next })
                      )
                    }
                  >
                    Add file block
                  </button>
                  <button
                    type="button"
                    onClick={() =>
                      appendPostBlockJson(
                        postEditForm.blocksJson,
                        { blockId: `pdf-${Date.now()}`, type: 'pdf_preview', url: postEditForm.destinationUrl || 'https://example.com/doc.pdf' },
                        (next) => setPostEditForm({ ...postEditForm, blocksJson: next })
                      )
                    }
                  >
                    Add PDF preview block
                  </button>
                </div>
                <textarea placeholder="Metadata JSON" value={postEditForm.metadataJson} onChange={(e) => setPostEditForm({ ...postEditForm, metadataJson: e.target.value })} rows={3} />
                <button onClick={saveEditPost}>Save Post</button>
                <button onClick={() => setEditingPostId(null)}>Cancel</button>
              </>
            )}
            <h3>Create Post</h3>
            <div className="row-actions">
              <select value={postTemplate} onChange={(e) => setPostTemplate(e.target.value as PostTemplate)}>
                {postTemplateOptions.map((option) => (
                  <option key={`post-template-${option.value}`} value={option.value}>{option.label}</option>
                ))}
              </select>
              <button type="button" onClick={() => setPostForm((prev) => buildTemplatedPostForm(prev, postTemplate))}>
                Apply template
              </button>
            </div>
            <select value={postForm.artistId} onChange={(e) => setPostForm({ ...postForm, artistId: e.target.value })}>
              <option value="">Select creator</option>
              {artists.map((artist) => <option key={`post-create-artist-${artist.artistId}`} value={artist.artistId}>{artist.name}</option>)}
            </select>
            <input placeholder="Title" value={postForm.title} onChange={(e) => setPostForm({ ...postForm, title: e.target.value })} />
            <input placeholder="Slug (optional)" value={postForm.slug} onChange={(e) => setPostForm({ ...postForm, slug: e.target.value })} />
            <textarea placeholder="Summary (optional)" value={postForm.summary} onChange={(e) => setPostForm({ ...postForm, summary: e.target.value })} rows={3} />
            <select value={postForm.status} onChange={(e) => setPostForm({ ...postForm, status: e.target.value as Post['status'] })}>
              <option value="draft">draft</option>
              <option value="published">published</option>
              <option value="archived">archived</option>
            </select>
            <select value={postForm.discoveryMode} onChange={(e) => setPostForm({ ...postForm, discoveryMode: e.target.value as 'primary' | 'all' | 'selected' })}>
              <option value="primary">primary</option>
              <option value="all">all</option>
              <option value="selected">selected</option>
            </select>
            <input placeholder="Primary media ID (optional)" value={postForm.primaryMediaId} onChange={(e) => setPostForm({ ...postForm, primaryMediaId: e.target.value })} />
            <select value={postForm.destinationType} onChange={(e) => setPostForm({ ...postForm, destinationType: e.target.value as 'post' | 'pdf' | 'external' | 'internal' })}>
              <option value="post">post</option>
              <option value="pdf">pdf</option>
              <option value="external">external</option>
              <option value="internal">internal</option>
            </select>
            <input placeholder="Destination URL (optional)" value={postForm.destinationUrl} onChange={(e) => setPostForm({ ...postForm, destinationUrl: e.target.value })} />
            <textarea placeholder="Media refs JSON" value={postForm.mediaJson} onChange={(e) => setPostForm({ ...postForm, mediaJson: e.target.value })} rows={4} />
            <div className="row-actions">
              <button
                type="button"
                onClick={() =>
                  appendPostMediaRefJson(postForm.mediaJson, postForm.primaryMediaId, (next) =>
                    setPostForm({ ...postForm, mediaJson: next })
                  )
                }
              >
                Add primary media ref
              </button>
            </div>
            <textarea placeholder="Blocks JSON" value={postForm.blocksJson} onChange={(e) => setPostForm({ ...postForm, blocksJson: e.target.value })} rows={6} />
            <div className="row-actions">
              <button
                type="button"
                onClick={() =>
                  appendPostBlockJson(
                    postForm.blocksJson,
                    { blockId: `h-${Date.now()}`, type: 'heading', level: 2, text: 'New heading' },
                    (next) => setPostForm({ ...postForm, blocksJson: next })
                  )
                }
              >
                Add heading block
              </button>
              <button
                type="button"
                onClick={() =>
                  appendPostBlockJson(
                    postForm.blocksJson,
                    { blockId: `p-${Date.now()}`, type: 'paragraph', text: 'New paragraph' },
                    (next) => setPostForm({ ...postForm, blocksJson: next })
                  )
                }
              >
                Add paragraph block
              </button>
              <button
                type="button"
                onClick={() =>
                  appendPostBlockJson(
                    postForm.blocksJson,
                    { blockId: `m-${Date.now()}`, type: 'image', mediaId: postForm.primaryMediaId || '' },
                    (next) => setPostForm({ ...postForm, blocksJson: next })
                  )
                }
              >
                Add image block
              </button>
              <button
                type="button"
                onClick={() =>
                  appendPostBlockJson(
                    postForm.blocksJson,
                    { blockId: `v-${Date.now()}`, type: 'video', mediaId: postForm.primaryMediaId || '' },
                    (next) => setPostForm({ ...postForm, blocksJson: next })
                  )
                }
              >
                Add video block
              </button>
              <button
                type="button"
                onClick={() =>
                  appendPostBlockJson(
                    postForm.blocksJson,
                    { blockId: `a-${Date.now()}`, type: 'audio', mediaId: postForm.primaryMediaId || '' },
                    (next) => setPostForm({ ...postForm, blocksJson: next })
                  )
                }
              >
                Add audio block
              </button>
              <button
                type="button"
                onClick={() =>
                  appendPostBlockJson(
                    postForm.blocksJson,
                    { blockId: `q-${Date.now()}`, type: 'quote', text: 'Add a quote...', cite: '' },
                    (next) => setPostForm({ ...postForm, blocksJson: next })
                  )
                }
              >
                Add quote block
              </button>
              <button
                type="button"
                onClick={() =>
                  appendPostBlockJson(
                    postForm.blocksJson,
                    { blockId: `d-${Date.now()}`, type: 'divider' },
                    (next) => setPostForm({ ...postForm, blocksJson: next })
                  )
                }
              >
                Add divider block
              </button>
              <button
                type="button"
                onClick={() =>
                  appendPostBlockJson(
                    postForm.blocksJson,
                    { blockId: `l-${Date.now()}`, type: 'link', url: postForm.destinationUrl || 'https://example.com', label: 'Open link' },
                    (next) => setPostForm({ ...postForm, blocksJson: next })
                  )
                }
              >
                Add link block
              </button>
              <button
                type="button"
                onClick={() =>
                  appendPostBlockJson(
                    postForm.blocksJson,
                    { blockId: `e-${Date.now()}`, type: 'embed', url: postForm.destinationUrl || 'https://example.com/embed' },
                    (next) => setPostForm({ ...postForm, blocksJson: next })
                  )
                }
              >
                Add embed block
              </button>
              <button
                type="button"
                onClick={() =>
                  appendPostBlockJson(
                    postForm.blocksJson,
                    { blockId: `f-${Date.now()}`, type: 'file', url: postForm.destinationUrl || 'https://example.com/file.pdf', label: 'Attached file' },
                    (next) => setPostForm({ ...postForm, blocksJson: next })
                  )
                }
              >
                Add file block
              </button>
              <button
                type="button"
                onClick={() =>
                  appendPostBlockJson(
                    postForm.blocksJson,
                    { blockId: `pdf-${Date.now()}`, type: 'pdf_preview', url: postForm.destinationUrl || 'https://example.com/doc.pdf' },
                    (next) => setPostForm({ ...postForm, blocksJson: next })
                  )
                }
              >
                Add PDF preview block
              </button>
            </div>
            <textarea placeholder="Metadata JSON" value={postForm.metadataJson} onChange={(e) => setPostForm({ ...postForm, metadataJson: e.target.value })} rows={3} />
            <button onClick={createPost}>Create Post</button>
          </>
        )}

        {user && isAdmin && view === 'moderation' && (
          <>
            <h2>Moderation</h2>
            <input placeholder="Comment ID" value={commentId} onChange={(e) => setCommentId(e.target.value)} />
            <button onClick={hideComment}>Hide Comment</button>
            <button onClick={deleteComment}>Delete Comment</button>
          </>
        )}

        {user && isAdmin && view === 'users' && (
          <>
            <h2>User Controls</h2>
            <p className="muted">{roleDisplayLabel('contributor')} is the UI label for contributor role accounts.</p>
            <input placeholder="User ID" value={blockUserId} onChange={(e) => setBlockUserId(e.target.value)} />
            <button onClick={blockUser}>Block User</button>
            <button onClick={unblockUser}>Unblock User</button>
          </>
        )}

        {user && isAdmin && view === 'settings' && (
          <div className="content-card">
            <h2>Site Settings</h2>
            <input
              placeholder="Site Name"
              value={siteSettings.siteName}
              onChange={(e) => setSiteSettings({ ...siteSettings, siteName: e.target.value })}
            />
            <select
              value={siteSettings.theme}
              onChange={(e) => setSiteSettings({ ...siteSettings, theme: e.target.value as SiteSettings['theme'] })}
            >
              <option value="ubeeq">Ubeeq</option>
              <option value="sand">Sand</option>
              <option value="forest">Forest</option>
              <option value="slate">Slate</option>
            </select>
            <input
              placeholder="Logo S3 Key (optional)"
              value={siteSettings.logoKey || ''}
              onChange={(e) => setSiteSettings({ ...siteSettings, logoKey: e.target.value || undefined })}
            />
            <label className="muted">Upload Logo</label>
            <input type="file" accept="image/*" onChange={(e) => void uploadLogo(e.target.files?.[0] || null)} />
            {siteSettings.logoUrl && <img src={siteSettings.logoUrl} alt="Current logo" className="brand-image" />}
            <button onClick={saveSiteSettings} disabled={savingSettings}>{savingSettings ? 'Saving...' : 'Save Settings'}</button>
          </div>
        )}

        {message && <p className="success">{message}</p>}
        {error && <p className="error">{error}</p>}
      </section>
    </main>
  );
}


export const AdminApp = StudioApp;
