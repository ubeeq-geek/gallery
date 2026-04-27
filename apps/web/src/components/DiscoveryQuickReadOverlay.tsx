import { useEffect, useMemo, useState } from 'react';
import type { CSSProperties } from 'react';
import { Link } from 'react-router-dom';

type SurfaceAssetType = 'image' | 'video' | 'audio';
type PostType = 'image' | 'video' | 'story' | 'audio';
type PostFormat = 'single' | 'multi' | 'short' | 'long';

type DiscoveryOverlayItem = {
  imageId: string;
  assetType?: SurfaceAssetType;
  postType?: PostType;
  postFormat?: PostFormat;
  surfaceType?: 'media' | 'post';
  postId?: string;
  postSlug?: string;
  postTitle?: string;
  postSummary?: string;
  artistId: string;
  artistName: string;
  creatorSlug?: string;
  gallerySlug?: string;
  title?: string;
  previewUrl: string;
  previewPosterUrl?: string;
  displayedContentRating?: string;
  displayedAiDisclosure?: string;
  displayedHeavyTopics?: string[];
  blurred?: boolean;
};

type PostBlock = {
  blockId: string;
  type:
    | 'section'
    | 'heading'
    | 'paragraph'
    | 'image'
    | 'video'
    | 'audio'
    | 'quote'
    | 'divider'
    | 'embed'
    | 'file'
    | 'link'
    | 'gallery'
    | 'carousel'
    | 'pdf_preview'
    | 'html_fragment';
  text?: string;
  level?: number;
  mediaId?: string;
  caption?: string;
  quote?: string;
  author?: string;
  url?: string;
  title?: string;
  html?: string;
  payload?: Record<string, unknown>;
  blocks?: PostBlock[];
};

type OverlayPost = {
  postId: string;
  title: string;
  slug: string;
  summary?: string;
  status: 'draft' | 'published' | 'archived';
  destination?: { type: 'post' | 'pdf' | 'external' | 'internal'; url: string } | null;
  metadata?: Record<string, string>;
  blocks: PostBlock[];
  media: Array<{
    mediaId: string;
    assetType: SurfaceAssetType;
    title?: string;
    previewUrl: string;
    previewPosterUrl?: string;
    caption?: string;
    sortOrder?: number;
    width?: number;
    height?: number;
  }>;
  primaryMediaId?: string;
  creator?: { name: string; slug: string };
  artist?: { name: string; slug: string };
};

type DiscoveryQuickReadOverlayProps = {
  open: boolean;
  item: DiscoveryOverlayItem | null;
  itemIndex: number;
  itemsCount: number;
  hasPrevious: boolean;
  hasNext: boolean;
  loading: boolean;
  error: string;
  post: OverlayPost | null;
  moreFromStream: DiscoveryOverlayItem[];
  videoMuted: boolean;
  videoRef: React.RefObject<HTMLVideoElement>;
  onClose: () => void;
  onPrevious: () => void;
  onNext: () => void;
  onSelectStreamItem: (item: DiscoveryOverlayItem) => void;
  onVideoVolumeChange: (video: HTMLVideoElement) => void;
};

type PostRenderKind = PostType;

const splitParagraphs = (text?: string): string[] => {
  if (!text) return [];
  return text
    .split(/\n\s*\n+/)
    .map((segment) => segment.trim())
    .filter(Boolean);
};

const renderInlineText = (text?: string) => {
  if (!text) return '';
  const normalized = text
    .replace(/<\s*i\s*>/gi, '<em>')
    .replace(/<\s*\/\s*i\s*>/gi, '</em>');
  const segments = normalized.split(/(<\/?em>)/gi).filter(Boolean);
  let italic = false;
  const nodes: Array<string | JSX.Element> = [];
  let key = 0;

  for (const segment of segments) {
    const lower = segment.toLowerCase();
    if (lower === '<em>') {
      italic = true;
      continue;
    }
    if (lower === '</em>') {
      italic = false;
      continue;
    }
    if (!italic) {
      nodes.push(segment);
      continue;
    }
    nodes.push(<em key={`inline-em-${key++}`}>{segment}</em>);
  }

  return nodes.length > 0 ? nodes : normalized;
};

const formatReleaseDate = (releaseAt?: unknown): string => {
  if (typeof releaseAt !== 'string' || !releaseAt.trim()) return '';
  const parsed = new Date(releaseAt);
  if (Number.isNaN(parsed.getTime())) return '';
  return new Intl.DateTimeFormat(undefined, {
    month: 'long',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit'
  }).format(parsed);
};

const normalizeDisclosureLine = (item?: {
  displayedAiDisclosure?: string;
  displayedHeavyTopics?: string[];
}): string => {
  if (!item) return '';
  const parts: string[] = [];
  if (item.displayedAiDisclosure && item.displayedAiDisclosure !== 'No AI') {
    parts.push(item.displayedAiDisclosure);
  }
  for (const topic of item.displayedHeavyTopics || []) {
    if (topic) parts.push(topic);
  }
  return parts.join(' • ');
};

const collectPostInlineImageUrls = (post: OverlayPost): string[] => {
  const mediaById = new Map(post.media.map((media) => [media.mediaId, media]));
  const urls: string[] = [];
  for (const block of post.blocks) {
    if (block.type !== 'image' || !block.mediaId) continue;
    const media = mediaById.get(block.mediaId);
    if (!media || media.assetType !== 'image' || !media.previewUrl) continue;
    urls.push(media.previewUrl);
  }
  return urls;
};

const getPostType = (post: OverlayPost): PostType => {
  const raw = (post.metadata?.postType || '').toLowerCase();
  if (raw === 'image' || raw === 'images' || raw === 'photo' || raw === 'photos') return 'image';
  if (raw === 'video' || raw === 'videos' || raw === 'short' || raw === 'shorts' || raw === 'reel' || raw === 'reels') return 'video';
  if (raw === 'audio' || raw === 'track' || raw === 'tracks' || raw === 'album') return 'audio';
  if (raw === 'story' || raw === 'stories' || raw === 'post' || raw === 'posts' || raw === 'article' || raw === 'reading' || raw === 'fiction') return 'story';
  const primary = post.primaryMediaId ? post.media.find((media) => media.mediaId === post.primaryMediaId) : post.media[0];
  if (primary?.assetType === 'video') return 'video';
  if (primary?.assetType === 'audio') return 'audio';
  if (primary?.assetType === 'image' && post.blocks.length <= 2) return 'image';
  if (post.blocks.some((block) => block.type === 'audio')) return 'audio';
  if (post.blocks.some((block) => block.type === 'video')) return 'video';
  return 'story';
};

const getPostFormat = (post: OverlayPost, postType: PostType = getPostType(post)): PostFormat => {
  const raw = (post.metadata?.postFormat || post.metadata?.format || '').toLowerCase();
  if ((postType === 'image' || postType === 'audio') && (raw === 'single' || raw === 'multi' || raw === 'album')) {
    return raw === 'album' ? 'multi' : raw;
  }
  if ((postType === 'video' || postType === 'story') && (raw === 'short' || raw === 'long')) return raw;
  if (postType === 'video') return post.metadata?.videoFormat === 'short' || post.metadata?.layout === 'short' ? 'short' : 'long';
  if (postType === 'story') return post.blocks.filter((block) => block.type === 'paragraph').length >= 6 ? 'long' : 'short';
  return post.media.length > 1 ? 'multi' : 'single';
};

const inferPostRenderKind = (post: OverlayPost): PostRenderKind => {
  const explicitType = getPostType(post);
  if (explicitType !== 'image') return explicitType;
  const template = (post.metadata?.template || '').toLowerCase();
  const layout = (post.metadata?.layout || '').toLowerCase();
  const kind = (post.metadata?.kind || '').toLowerCase();
  if ([template, layout, kind].some((value) => value.includes('story') || value.includes('reading') || value.includes('fiction'))) {
    return 'story';
  }
  const paragraphBlocks = post.blocks.filter((block) => block.type === 'paragraph').length;
  const headingBlocks = post.blocks.filter((block) => block.type === 'heading').length;
  const longParagraphBlocks = post.blocks.filter((block) => block.type === 'paragraph' && splitParagraphs(block.text).length > 1).length;
  if (paragraphBlocks >= 4) return 'story';
  if (paragraphBlocks >= 2 && headingBlocks >= 1) return 'story';
  if (longParagraphBlocks > 0) return 'story';
  return 'image';
};

export const PostMetaHeader = ({
  item,
  post,
  itemIndex,
  itemsCount,
  showPosition = true
}: {
  item: DiscoveryOverlayItem;
  post: OverlayPost | null;
  itemIndex: number;
  itemsCount: number;
  showPosition?: boolean;
}) => {
  const creator = post?.creator || post?.artist;
  const postType = post ? getPostType(post) : null;
  const postFormat = post && postType ? getPostFormat(post, postType) : null;
  const kicker = post
    ? `${postType} post${postFormat ? ` · ${postFormat}` : ''}`
    : 'Media quick read';
  return (
    <header className="discovery-quickread-post-meta">
      <div className="discovery-quickread-post-kicker">{kicker}</div>
      <h2>{post?.title || item.postTitle || item.title || 'Untitled'}</h2>
      <p className="small">
        by {creator?.name || item.artistName || 'Unknown creator'}
        {' · '}
        {item.displayedContentRating || 'General'}
        {showPosition ? (
          <>
            {' · '}
            {Math.max(1, itemIndex + 1)} / {Math.max(1, itemsCount)}
          </>
        ) : null}
      </p>
    </header>
  );
};

const renderMediaFigure = (
  media: { assetType: SurfaceAssetType; previewUrl: string; previewPosterUrl?: string; title?: string; caption?: string; width?: number; height?: number },
  key: string,
  blur?: boolean
 ) => {
  const hasDimensions = Boolean(media.width && media.height && media.width > 0 && media.height > 0);
  const mediaAspect = hasDimensions ? media.width! / media.height! : 1;
  const frameStyle = hasDimensions
    ? {
        aspectRatio: `${media.width} / ${media.height}`,
        '--quickread-media-fit-width': `min(100%, ${mediaAspect * 70}vh, ${mediaAspect * 50}rem)`
      } as CSSProperties
    : undefined;
  return (
    <figure key={key} className="discovery-quickread-media-figure">
      <div
        className={`discovery-quickread-media-frame${hasDimensions ? ' has-ratio' : ' no-ratio'}`}
        style={frameStyle}
      >
        {media.assetType === 'audio' ? (
          <audio controls preload="metadata" style={{ width: '100%' }}>
            <source src={media.previewUrl} />
          </audio>
        ) : media.assetType === 'video' ? (
          <video controls playsInline preload="metadata" poster={media.previewPosterUrl} style={{ filter: blur ? 'blur(28px)' : undefined }}>
            <source src={media.previewUrl} />
          </video>
        ) : (
          <img src={media.previewUrl} alt={media.title || 'Post media'} loading="eager" decoding="async" style={{ filter: blur ? 'blur(28px)' : undefined }} />
        )}
      </div>
      {media.caption ? <figcaption>{media.caption}</figcaption> : null}
    </figure>
  );
};

const StandardPostRenderer = ({ item, post, storyMode = false }: { item: DiscoveryOverlayItem; post: OverlayPost; storyMode?: boolean }) => {
  const orderedMedia = [...post.media].sort((a, b) => (a.sortOrder || 0) - (b.sortOrder || 0));
  const mediaById = new Map(orderedMedia.map((media) => [media.mediaId, media]));
  const hasBlocks = post.blocks.length > 0;
  const primaryMedia = post.primaryMediaId ? mediaById.get(post.primaryMediaId) : undefined;
  const postType = getPostType(post);
  const postFormat = getPostFormat(post, postType);
  const shouldRenderPrimaryMediaTopBlock = Boolean(primaryMedia && postType !== 'story' && hasBlocks);
  const fallbackMedia = primaryMedia
    ? [primaryMedia, ...orderedMedia.filter((media) => media.mediaId !== primaryMedia.mediaId)]
    : orderedMedia;
  const renderBlock = (block: PostBlock, index: number, keyPrefix = 'block') => {
    const key = `${keyPrefix}-${block.blockId || index}`;
    if (block.type === 'section') {
      const sectionStatus = typeof block.payload?.status === 'string' ? block.payload.status : 'published';
      const isPreviewOnly = Boolean(block.payload?.previewOnly) || sectionStatus === 'scheduled' || sectionStatus === 'draft';
      if (isPreviewOnly && !block.blocks?.length) {
        const releaseDate = formatReleaseDate(block.payload?.releaseAt);
        return (
          <section key={key} className="discovery-quickread-section-block discovery-quickread-coming-soon">
            <article className="gallery-to-publish-card" aria-live="polite">
              <div className="gallery-to-publish-icon" aria-hidden="true">
                <svg viewBox="0 0 24 24" fill="none">
                  <rect x="4" y="5" width="16" height="15" rx="3" stroke="currentColor" strokeWidth="1.8" />
                  <path d="M8 3.5V7" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
                  <path d="M16 3.5V7" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
                  <path d="M4 10H20" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
                </svg>
              </div>
              <div className="gallery-to-publish-copy">
                <div className="gallery-to-publish-chip">Coming Soon</div>
                <h3>{block.title || 'Next section'}</h3>
                <p>The next section will be available on:</p>
                {releaseDate ? <strong>{releaseDate}</strong> : <strong>Publishing date to be announced</strong>}
                <p className="gallery-to-publish-local-time">(Your local time)</p>
              </div>
            </article>
          </section>
        );
      }
      return (
        <section key={key} className={`discovery-quickread-section-block${storyMode ? ' story-section' : ''}`}>
          {block.title ? <h2 className={storyMode ? 'post-part-title' : undefined}>{renderInlineText(block.title)}</h2> : null}
          {block.text ? <p>{renderInlineText(block.text)}</p> : null}
          {block.blocks?.length ? (
            <div className="discovery-quickread-section-children">
              {block.blocks.map((child, childIndex) => renderBlock(child, childIndex, key))}
            </div>
          ) : null}
        </section>
      );
    }
    if (block.type === 'heading') {
      const level = Math.max(1, Math.min(6, block.level || 2));
      if (level === 1) return <h1 key={key}>{renderInlineText(block.text)}</h1>;
      if (level === 2) return <h2 key={key} className={storyMode ? 'post-part-title' : undefined}>{renderInlineText(block.text)}</h2>;
      if (level === 3) return <h3 key={key} className={storyMode ? 'post-part-label' : undefined}>{renderInlineText(block.text)}</h3>;
      if (level === 4) return <h4 key={key}>{renderInlineText(block.text)}</h4>;
      if (level === 5) return <h5 key={key}>{renderInlineText(block.text)}</h5>;
      return <h6 key={key}>{renderInlineText(block.text)}</h6>;
    }
    if (block.type === 'paragraph') {
      const paragraphs = splitParagraphs(block.text);
      if (paragraphs.length === 0) return null;
      return (
        <div key={key} className={`discovery-quickread-paragraph-group${storyMode ? ' post-body' : ''}`}>
          {paragraphs.map((paragraph, paragraphIndex) => (
            <p key={`${key}-${paragraphIndex}`}>{renderInlineText(paragraph)}</p>
          ))}
        </div>
      );
    }
    if (block.type === 'quote') {
      return (
        <blockquote key={key} className={storyMode ? 'post-inline-quote' : 'panel'}>
          <p>{renderInlineText(block.quote || block.text || '')}</p>
          {block.author ? <footer className="small">— {block.author}</footer> : null}
        </blockquote>
      );
    }
    if (block.type === 'divider') {
      return <hr key={key} />;
    }
    if (block.type === 'image' || block.type === 'video') {
      const media = block.mediaId ? mediaById.get(block.mediaId) : undefined;
      if (!media) return null;
      return renderMediaFigure({ ...media, caption: block.caption || media.caption }, `media-${key}`, item.blurred);
    }
    if (block.type === 'audio') {
      const media = block.mediaId ? mediaById.get(block.mediaId) : undefined;
      if (!media) return null;
      return (
        <div key={key} className="panel">
          <audio controls style={{ width: '100%' }}>
            <source src={media.previewUrl} />
          </audio>
        </div>
      );
    }
    if (block.type === 'html_fragment') {
      return (
        <pre key={key} className="panel small" style={{ overflowX: 'auto' }}>
          {block.html || ''}
        </pre>
      );
    }
    if (block.url || block.text || block.title) {
      return (
        <div key={key} className="panel">
          {block.url ? <a href={block.url} target="_blank" rel="noreferrer" className="no-underline">{block.title || block.url}</a> : null}
          {block.text ? <p className="small mt-2">{renderInlineText(block.text)}</p> : null}
        </div>
      );
    }
    return null;
  };

  return (
    <div className={`discovery-quickread-content-flow discovery-quickread-${postType}-flow discovery-quickread-${postType}-${postFormat}-flow`}>
      {shouldRenderPrimaryMediaTopBlock && primaryMedia
        ? renderMediaFigure(primaryMedia, `primary-media-${primaryMedia.mediaId}`, item.blurred)
        : null}
      {!hasBlocks ? (
        <>
          {post.summary ? <p>{post.summary}</p> : null}
          {fallbackMedia.map((media, index) =>
            renderMediaFigure(media, `fallback-media-${media.mediaId || index}`, item.blurred)
          )}
        </>
      ) : post.blocks.map((block, index) => renderBlock(block, index))}
    </div>
  );
};

const StoryPostRenderer = ({ item, post }: { item: DiscoveryOverlayItem; post: OverlayPost }) => {
  return (
    <div className="discovery-quickread-content-flow discovery-quickread-story-flow post-reading">
      <StandardPostRenderer item={item} post={post} storyMode />
    </div>
  );
};

const ShortStoryPostRenderer = ({ item, post }: { item: DiscoveryOverlayItem; post: OverlayPost }) => {
  return (
    <div className="discovery-quickread-content-flow discovery-quickread-short-story-flow post-reading">
      <StandardPostRenderer item={item} post={post} storyMode />
    </div>
  );
};

export const RichPostRenderer = ({ item, post }: { item: DiscoveryOverlayItem; post: OverlayPost }) => {
  const renderKind = inferPostRenderKind(post);
  if (renderKind === 'image') {
    return (
      <div className="discovery-quickread-content-flow discovery-quickread-story-flow post-reading">
        <StandardPostRenderer item={item} post={post} storyMode />
      </div>
    );
  }
  if (renderKind !== 'story') {
    return <StandardPostRenderer item={item} post={post} />;
  }
  const storyFormat = getPostFormat(post, 'story');
  return storyFormat === 'short'
    ? <ShortStoryPostRenderer item={item} post={post} />
    : <StoryPostRenderer item={item} post={post} />;
};

const DiscoverySecondaryRail = ({
  item,
  post,
  moreFromStream,
  onSelectStreamItem,
  onClose
}: {
  item: DiscoveryOverlayItem;
  post: OverlayPost | null;
  moreFromStream: DiscoveryOverlayItem[];
  onSelectStreamItem: (item: DiscoveryOverlayItem) => void;
  onClose: () => void;
}) => {
  const creatorSlug = post?.creator?.slug || post?.artist?.slug || item.creatorSlug;
  const canonicalPostPath = post?.slug ? `/posts/${encodeURIComponent(post.slug)}` : (item.postSlug ? `/posts/${encodeURIComponent(item.postSlug)}` : undefined);
  const groupingPath = item.gallerySlug ? `/gallery/${encodeURIComponent(item.gallerySlug)}${item.imageId ? `?image=${encodeURIComponent(item.imageId)}` : ''}` : undefined;
  const disclosureLine = normalizeDisclosureLine(item);

  return (
    <aside className="discovery-quickread-rail" aria-label="Discovery context and related actions">
      <div className="discovery-quickread-rail-card">
        <h3>You are still in discovery</h3>
        <p className="small">Close this panel at any time to return to the same place in your feed with filters unchanged.</p>
        <button type="button" className="auth-secondary-btn" onClick={onClose}>Return to feed</button>
      </div>

      <div className="discovery-quickread-rail-card">
        <h3>Go deeper</h3>
        <div className="discovery-quickread-destination-list">
          {creatorSlug ? (
            <Link to={`/creators/${encodeURIComponent(creatorSlug)}`} className="auth-secondary-btn no-underline">Creator page</Link>
          ) : null}
          {groupingPath ? (
            <Link to={groupingPath} className="auth-secondary-btn no-underline">Stream / grouping</Link>
          ) : null}
          {canonicalPostPath ? (
            <Link to={canonicalPostPath} className="auth-secondary-btn no-underline">Canonical post page</Link>
          ) : null}
          {post?.destination?.url ? (
            <a href={post.destination.url} target="_blank" rel="noreferrer" className="auth-secondary-btn no-underline">
              {post.destination.type === 'pdf' ? 'Open PDF' : post.destination.type === 'external' ? 'Open external' : 'Open destination'}
            </a>
          ) : null}
          {item.previewUrl ? (
            <a href={item.previewUrl} target="_blank" rel="noreferrer" className="auth-secondary-btn no-underline">Download media</a>
          ) : null}
        </div>
      </div>

      <div className="discovery-quickread-rail-card">
        <h3>More from this stream</h3>
        <div className="discovery-quickread-related-list">
          {moreFromStream.length === 0 ? <p className="small m-0">No related items yet.</p> : moreFromStream.map((related) => (
            <button
              key={`${related.imageId}-${related.postId || related.surfaceType || 'media'}`}
              type="button"
              className="discovery-quickread-related-card"
              onClick={() => onSelectStreamItem(related)}
            >
              <img src={related.previewPosterUrl || related.previewUrl} alt={related.title || related.postTitle || 'Related item'} loading="lazy" decoding="async" />
              <span>{related.postTitle || related.title || related.imageId}</span>
            </button>
          ))}
        </div>
      </div>

      <div className="discovery-quickread-rail-card">
        <p className="small m-0">{item.displayedContentRating || 'General'}{disclosureLine ? ` • ${disclosureLine}` : ''}</p>
      </div>
    </aside>
  );
};

export default function DiscoveryQuickReadOverlay({
  open,
  item,
  itemIndex,
  itemsCount,
  hasPrevious,
  hasNext,
  loading,
  error,
  post,
  moreFromStream,
  videoMuted,
  videoRef,
  onClose,
  onPrevious,
  onNext,
  onSelectStreamItem,
  onVideoVolumeChange
}: DiscoveryQuickReadOverlayProps) {
  const [isStackedQuickReadLayout, setIsStackedQuickReadLayout] = useState(() => {
    if (typeof window === 'undefined') return false;
    return window.innerWidth <= 1099;
  });
  const hasOverlayItem = Boolean(item);
  const isPostSurface = item?.surfaceType === 'post' || Boolean(item?.postId);
  const postInlineImageUrls = useMemo(() => (post ? collectPostInlineImageUrls(post) : []), [post]);
  const [postInlineMediaReady, setPostInlineMediaReady] = useState(!isPostSurface);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const onResize = () => {
      setIsStackedQuickReadLayout(window.innerWidth <= 1099);
    };
    onResize();
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  useEffect(() => {
    if (!open || !hasOverlayItem || !isPostSurface) {
      setPostInlineMediaReady(true);
      return;
    }
    if (!post) {
      setPostInlineMediaReady(false);
      return;
    }
    if (postInlineImageUrls.length === 0) {
      setPostInlineMediaReady(true);
      return;
    }

    let cancelled = false;
    let remaining = postInlineImageUrls.length;
    setPostInlineMediaReady(false);

    const done = () => {
      if (cancelled) return;
      remaining -= 1;
      if (remaining <= 0) setPostInlineMediaReady(true);
    };

    for (const url of postInlineImageUrls) {
      const image = new Image();
      image.onload = done;
      image.onerror = done;
      image.src = url;
    }

    return () => {
      cancelled = true;
    };
  }, [open, hasOverlayItem, isPostSurface, post, postInlineImageUrls]);

  if (!open || !item) return null;

  const leftTitle = post ? 'Quick read' : 'Quick view';

  return (
    <div className="discovery-focus-modal-layer discovery-quickread-layer" onClick={onClose}>
      <div className="discovery-focus-modal discovery-quickread-shell" role="dialog" aria-modal="true" aria-label="Discovery quick-read" onClick={(event) => event.stopPropagation()}>
        <div className="discovery-focus-modal-header discovery-quickread-header">
          <div className="discovery-focus-modal-title-wrap">
            <span className="discovery-focus-modal-title-id">{leftTitle}</span>
            <span className="discovery-focus-modal-title-grouping">{itemIndex + 1} / {Math.max(1, itemsCount)}</span>
            {loading ? <span className="discovery-focus-modal-status-chip">Loading…</span> : null}
            {error ? <span className="discovery-focus-modal-error-chip">{error}</span> : null}
          </div>
          <div className="discovery-focus-modal-actions">
            <button type="button" className="auth-secondary-btn" disabled={!hasPrevious} onClick={onPrevious}>Previous</button>
            <button type="button" className="auth-secondary-btn" disabled={!hasNext} onClick={onNext}>Next</button>
            {post?.slug ? <Link className="auth-primary-btn no-underline" to={`/posts/${encodeURIComponent(post.slug)}`} onClick={onClose}>Open in post page</Link> : null}
          </div>
          <button type="button" className="discovery-focus-modal-close" onClick={onClose} aria-label="Close quick-read">✕</button>
        </div>

        <div className="discovery-quickread-body">
          <section className="discovery-quickread-main" aria-label="Post reading surface">
            <PostMetaHeader item={item} post={post} itemIndex={itemIndex} itemsCount={itemsCount} />
            {isPostSurface && (!post || !postInlineMediaReady) ? (
              <article className="discovery-quickread-content-flow">
                <div className="discovery-quickread-loading-block" aria-live="polite">
                  {post ? 'Preparing post content…' : 'Loading full post…'}
                </div>
                <div className="discovery-quickread-loading-line" />
                <div className="discovery-quickread-loading-line is-wide" />
                <div className="discovery-quickread-loading-line" />
              </article>
            ) : post ? (
              <RichPostRenderer item={item} post={post} />
            ) : (
              <article className="discovery-quickread-content-flow">
                <div className="discovery-quickread-media-figure">
                  {item.assetType === 'audio' ? (
                    <audio controls preload="metadata" style={{ width: '100%' }}>
                      <source src={item.previewUrl} />
                    </audio>
                  ) : item.assetType === 'video' ? (
                    <video
                      ref={videoRef}
                      controls
                      playsInline
                      autoPlay
                      muted={videoMuted}
                      poster={item.previewPosterUrl}
                      style={{ filter: item.blurred ? 'blur(28px)' : undefined }}
                      onVolumeChange={(event) => onVideoVolumeChange(event.currentTarget)}
                    >
                      <source src={item.previewUrl} />
                    </video>
                  ) : (
                    <img src={item.previewUrl} alt={item.title || 'Discovery media'} style={{ filter: item.blurred ? 'blur(28px)' : undefined }} />
                  )}
                </div>
              </article>
            )}
            <div className="discovery-quickread-main-nav">
              <button type="button" className="auth-secondary-btn" disabled={!hasPrevious} onClick={onPrevious}>Previous</button>
              <button type="button" className="auth-secondary-btn" disabled={!hasNext} onClick={onNext}>Next</button>
              {post?.slug ? <Link className="auth-primary-btn no-underline" to={`/posts/${encodeURIComponent(post.slug)}`} onClick={onClose}>Open in post page</Link> : null}
            </div>
            {isStackedQuickReadLayout ? (
              <DiscoverySecondaryRail
                item={item}
                post={post}
                moreFromStream={moreFromStream}
                onSelectStreamItem={onSelectStreamItem}
                onClose={onClose}
              />
            ) : null}
          </section>

          {!isStackedQuickReadLayout ? (
            <DiscoverySecondaryRail
              item={item}
              post={post}
              moreFromStream={moreFromStream}
              onSelectStreamItem={onSelectStreamItem}
              onClose={onClose}
            />
          ) : null}
        </div>
      </div>
    </div>
  );
}

export type { DiscoveryOverlayItem, OverlayPost };
