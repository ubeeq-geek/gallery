import { Link } from 'react-router-dom';

type SurfaceAssetType = 'image' | 'video';

type DiscoveryOverlayItem = {
  imageId: string;
  assetType?: SurfaceAssetType;
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

type PostRenderKind = 'standard' | 'parody' | 'story';

const splitParagraphs = (text?: string): string[] => {
  if (!text) return [];
  return text
    .split(/\n\s*\n+/)
    .map((segment) => segment.trim())
    .filter(Boolean);
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

const inferPostRenderKind = (post: OverlayPost): PostRenderKind => {
  const template = (post.metadata?.template || '').toLowerCase();
  const layout = (post.metadata?.layout || '').toLowerCase();
  const kind = (post.metadata?.kind || '').toLowerCase();
  if ([template, layout, kind].some((value) => value.includes('parody') || value.includes('profile') || value.includes('social'))) {
    return 'parody';
  }
  if ([template, layout, kind].some((value) => value.includes('story') || value.includes('reading') || value.includes('fiction'))) {
    return 'story';
  }
  const longParagraphBlocks = post.blocks.filter((block) => block.type === 'paragraph' && splitParagraphs(block.text).length > 1).length;
  if (longParagraphBlocks > 0) return 'story';
  return 'standard';
};

const PostMetaHeader = ({ item, post, itemIndex, itemsCount }: { item: DiscoveryOverlayItem; post: OverlayPost | null; itemIndex: number; itemsCount: number }) => {
  const creator = post?.creator || post?.artist;
  return (
    <header className="discovery-quickread-post-meta">
      <div className="discovery-quickread-post-kicker">{post ? 'Post quick read' : 'Media quick read'}</div>
      <h2>{post?.title || item.postTitle || item.title || 'Untitled'}</h2>
      <p className="small">
        by {creator?.name || item.artistName || 'Unknown creator'}
        {' · '}
        {item.displayedContentRating || 'General'}
        {' · '}
        {Math.max(1, itemIndex + 1)} / {Math.max(1, itemsCount)}
      </p>
      {post?.summary ? <p className="discovery-quickread-summary">{post.summary}</p> : (item.postSummary ? <p className="discovery-quickread-summary">{item.postSummary}</p> : null)}
    </header>
  );
};

const renderMediaFigure = (
  media: { assetType: SurfaceAssetType; previewUrl: string; previewPosterUrl?: string; title?: string; caption?: string },
  key: string,
  blur?: boolean
) => (
  <figure key={key} className="discovery-quickread-media-figure">
    {media.assetType === 'video' ? (
      <video controls playsInline preload="metadata" poster={media.previewPosterUrl} style={{ filter: blur ? 'blur(28px)' : undefined }}>
        <source src={media.previewUrl} />
      </video>
    ) : (
      <img src={media.previewUrl} alt={media.title || 'Post media'} style={{ filter: blur ? 'blur(28px)' : undefined }} />
    )}
    {media.caption ? <figcaption>{media.caption}</figcaption> : null}
  </figure>
);

const StandardPostRenderer = ({ item, post }: { item: DiscoveryOverlayItem; post: OverlayPost }) => {
  const orderedMedia = [...post.media].sort((a, b) => (a.sortOrder || 0) - (b.sortOrder || 0));
  const mediaById = new Map(orderedMedia.map((media) => [media.mediaId, media]));
  return (
    <div className="discovery-quickread-content-flow">
      {post.blocks.map((block, index) => {
        if (block.type === 'heading') {
          const level = Math.max(1, Math.min(6, block.level || 2));
          if (level === 1) return <h1 key={block.blockId || index}>{block.text || ''}</h1>;
          if (level === 2) return <h2 key={block.blockId || index}>{block.text || ''}</h2>;
          if (level === 3) return <h3 key={block.blockId || index}>{block.text || ''}</h3>;
          if (level === 4) return <h4 key={block.blockId || index}>{block.text || ''}</h4>;
          if (level === 5) return <h5 key={block.blockId || index}>{block.text || ''}</h5>;
          return <h6 key={block.blockId || index}>{block.text || ''}</h6>;
        }
        if (block.type === 'paragraph') {
          const paragraphs = splitParagraphs(block.text);
          if (paragraphs.length === 0) return null;
          return (
            <div key={block.blockId || index} className="discovery-quickread-paragraph-group">
              {paragraphs.map((paragraph, paragraphIndex) => (
                <p key={`${block.blockId || index}-${paragraphIndex}`}>{paragraph}</p>
              ))}
            </div>
          );
        }
        if (block.type === 'quote') {
          return (
            <blockquote key={block.blockId || index} className="panel">
              <p>{block.quote || block.text || ''}</p>
              {block.author ? <footer className="small">— {block.author}</footer> : null}
            </blockquote>
          );
        }
        if (block.type === 'divider') {
          return <hr key={block.blockId || index} />;
        }
        if (block.type === 'image' || block.type === 'video') {
          const media = block.mediaId ? mediaById.get(block.mediaId) : undefined;
          if (!media) return null;
          return renderMediaFigure({ ...media, caption: block.caption || media.caption }, `media-${block.blockId || index}`, item.blurred);
        }
        if (block.type === 'audio') {
          const media = block.mediaId ? mediaById.get(block.mediaId) : undefined;
          if (!media) return null;
          return (
            <div key={block.blockId || index} className="panel">
              <audio controls style={{ width: '100%' }}>
                <source src={media.previewUrl} />
              </audio>
            </div>
          );
        }
        if (block.type === 'html_fragment') {
          return (
            <pre key={block.blockId || index} className="panel small" style={{ overflowX: 'auto' }}>
              {block.html || ''}
            </pre>
          );
        }
        if (block.url || block.text || block.title) {
          return (
            <div key={block.blockId || index} className="panel">
              {block.url ? <a href={block.url} target="_blank" rel="noreferrer" className="no-underline">{block.title || block.url}</a> : null}
              {block.text ? <p className="small mt-2">{block.text}</p> : null}
            </div>
          );
        }
        return null;
      })}
    </div>
  );
};

const ParodyPostRenderer = ({ item, post }: { item: DiscoveryOverlayItem; post: OverlayPost }) => {
  const profileSummary = post.blocks.filter((block) => block.type === 'paragraph').slice(0, 2);
  const activity = post.blocks.filter((block) => block.type === 'quote').slice(0, 3);
  return (
    <div className="discovery-quickread-content-flow">
      <section className="discovery-quickread-parody-profile panel">
        <h3>Profile Snapshot</h3>
        {profileSummary.length > 0 ? profileSummary.map((block, index) => (
          <p key={`parody-summary-${block.blockId || index}`}>{block.text}</p>
        )) : <p>{post.summary || 'Structured parody profile content is rendered here.'}</p>}
      </section>
      <section className="discovery-quickread-parody-activity panel">
        <h3>Activity</h3>
        {activity.length > 0 ? activity.map((block, index) => (
          <blockquote key={`parody-activity-${block.blockId || index}`}>
            {block.quote || block.text}
          </blockquote>
        )) : <p>No activity entries were supplied.</p>}
      </section>
      <StandardPostRenderer item={item} post={post} />
    </div>
  );
};

const StoryPostRenderer = ({ item, post }: { item: DiscoveryOverlayItem; post: OverlayPost }) => {
  return (
    <div className="discovery-quickread-content-flow discovery-quickread-story-flow">
      <StandardPostRenderer item={item} post={post} />
    </div>
  );
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
  if (!open || !item) return null;

  const renderKind = post ? inferPostRenderKind(post) : 'standard';
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
            {post ? (
              renderKind === 'parody'
                ? <ParodyPostRenderer item={item} post={post} />
                : renderKind === 'story'
                  ? <StoryPostRenderer item={item} post={post} />
                  : <StandardPostRenderer item={item} post={post} />
            ) : (
              <article className="discovery-quickread-content-flow">
                <div className="discovery-quickread-media-figure">
                  {item.assetType === 'video' ? (
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
                {item.postSummary ? <p>{item.postSummary}</p> : null}
              </article>
            )}
          </section>

          <DiscoverySecondaryRail
            item={item}
            post={post}
            moreFromStream={moreFromStream}
            onSelectStreamItem={onSelectStreamItem}
            onClose={onClose}
          />
        </div>
      </div>
    </div>
  );
}

export type { DiscoveryOverlayItem, OverlayPost };
