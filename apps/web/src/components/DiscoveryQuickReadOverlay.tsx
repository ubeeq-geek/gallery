import { useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { Link } from 'react-router-dom';
import { sanitizeInlineHtml } from '../blockContent';

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
    | 'credit'
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
  label?: string;
  html?: string;
  payload?: Record<string, unknown>;
  blocks?: PostBlock[];
};

type OverlayMediaCredit = {
  label: string;
  url?: string;
};

type OverlayPostMedia = {
  mediaId: string;
  assetType: SurfaceAssetType;
  title?: string;
  previewUrl: string;
  previewPosterUrl?: string;
  thumbnailUrls?: {
    w320?: string;
    w640?: string;
    w1280?: string;
    w1920?: string;
    square256?: string;
    square512?: string;
    square1024?: string;
  };
  caption?: string;
  credit?: OverlayMediaCredit;
  sortOrder?: number;
  width?: number;
  height?: number;
  comparison?: {
    type?: string;
    role?: string;
    order?: number;
    comparisonItem?: OverlayPostMedia & {
      role?: string;
      order?: number;
    };
  };
};

const getProgressiveImageUrls = (media: Pick<OverlayPostMedia, 'previewUrl' | 'thumbnailUrls'>) => ({
  placeholder: media.thumbnailUrls?.w320 || media.thumbnailUrls?.w640 || media.previewUrl,
  full: media.thumbnailUrls?.w1920 || media.thumbnailUrls?.w1280 || media.previewUrl
});

const ProgressivePostImage = ({
  media,
  alt,
  className,
  blur
}: {
  media: OverlayPostMedia;
  alt: string;
  className?: string;
  blur?: boolean;
}) => {
  const { placeholder, full } = getProgressiveImageUrls(media);
  const [src, setSrc] = useState(placeholder);
  const [loadedFull, setLoadedFull] = useState(placeholder === full);

  useEffect(() => {
    setSrc(placeholder);
    setLoadedFull(placeholder === full);
    if (!full || full === placeholder) return undefined;
    const image = new Image();
    image.onload = () => {
      setSrc(full);
      setLoadedFull(true);
    };
    image.src = full;
    return () => {
      image.onload = null;
    };
  }, [full, placeholder]);

  return (
    <img
      className={`${className || ''}${loadedFull ? ' is-loaded' : ' is-progressive'}`.trim()}
      src={src}
      alt={alt}
      loading="eager"
      decoding="async"
      style={{ filter: blur ? 'blur(28px)' : undefined }}
    />
  );
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
  media: OverlayPostMedia[];
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
  loopVideosUntilNext?: boolean;
  onClose: () => void;
  onPrevious: () => void;
  onNext: () => void;
  onSelectStreamItem: (item: DiscoveryOverlayItem) => void;
  onVideoVolumeChange: (video: HTMLVideoElement) => void;
};

type PostRenderKind = PostType;

const getYouTubeEmbed = (url?: string, options: { autoplay?: boolean; muted?: boolean } = {}): { src: string; isShort: boolean } | null => {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    const hostname = parsed.hostname.replace(/^www\./, '').toLowerCase();
    let videoId = '';
    let isShort = false;

    if (hostname === 'youtu.be') {
      videoId = parsed.pathname.split('/').filter(Boolean)[0] || '';
    } else if (hostname === 'youtube.com' || hostname === 'm.youtube.com' || hostname === 'youtube-nocookie.com') {
      const parts = parsed.pathname.split('/').filter(Boolean);
      if (parts[0] === 'shorts') {
        videoId = parts[1] || '';
        isShort = true;
      } else if (parts[0] === 'embed') {
        videoId = parts[1] || '';
      } else {
        videoId = parsed.searchParams.get('v') || '';
      }
    }

    if (!/^[A-Za-z0-9_-]{6,20}$/.test(videoId)) return null;
    const embed = new URL(`https://www.youtube-nocookie.com/embed/${videoId}`);
    if (options.autoplay) embed.searchParams.set('autoplay', '1');
    embed.searchParams.set('mute', options.muted === false ? '0' : '1');
    embed.searchParams.set('playsinline', '1');
    embed.searchParams.set('enablejsapi', '1');
    if (typeof window !== 'undefined') embed.searchParams.set('origin', window.location.origin);
    return { src: embed.toString(), isShort };
  } catch {
    return null;
  }
};

const splitParagraphs = (text?: string): string[] => {
  if (!text) return [];
  return text
    .split(/\n\s*\n+/)
    .map((segment) => segment.trim())
    .filter(Boolean);
};

const renderInlineText = (text?: string, html?: string) => {
  if (html) return <span dangerouslySetInnerHTML={{ __html: sanitizeInlineHtml(html) }} />;
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

type VideoPlaybackOptions = {
  videoMuted: boolean;
  loopVideoUntilNext?: boolean;
  hasNext?: boolean;
  onNext?: () => void;
  onVideoVolumeChange: (video: HTMLVideoElement) => void;
};

const QuickReadVideo = ({
  src,
  poster,
  blur,
  autoPlay,
  playback,
  videoRef
}: {
  src: string;
  poster?: string;
  blur?: boolean;
  autoPlay?: boolean;
  playback?: VideoPlaybackOptions;
  videoRef?: React.RefObject<HTMLVideoElement>;
}) => {
  const localVideoRef = useRef<HTMLVideoElement | null>(null);
  const [ended, setEnded] = useState(false);
  const resolvedVideoRef = videoRef || localVideoRef;

  useEffect(() => {
    setEnded(false);
  }, [src]);

  return (
    <div className="discovery-quickread-video-wrap">
      <video
        ref={resolvedVideoRef}
        controls
        playsInline
        autoPlay={Boolean(autoPlay)}
        muted={playback?.videoMuted ?? true}
        preload="metadata"
        poster={poster}
        style={{ filter: blur ? 'blur(28px)' : undefined }}
        onEnded={(event) => {
          setEnded(true);
          if (!playback?.loopVideoUntilNext) return;
          const video = event.currentTarget;
          video.currentTime = 0;
          const replay = video.play();
          if (replay && typeof replay.catch === 'function') {
            replay.catch(() => undefined);
          }
        }}
        onVolumeChange={playback ? (event) => playback.onVideoVolumeChange(event.currentTarget) : undefined}
      >
        <source src={src} />
      </video>
      {ended && playback?.loopVideoUntilNext && playback.hasNext && playback.onNext ? (
        <button
          type="button"
          className="discovery-quickread-next-video-btn"
          onClick={() => {
            setEnded(false);
            playback.onNext?.();
          }}
        >
          Next video
        </button>
      ) : null}
    </div>
  );
};

const sendYouTubeCommand = (iframe: HTMLIFrameElement | null, func: string, args: unknown[] = []) => {
  iframe?.contentWindow?.postMessage(JSON.stringify({
    event: 'command',
    func,
    args
  }), '*');
};

const QuickReadYouTubeEmbed = ({
  src,
  title,
  playback
}: {
  src: string;
  title: string;
  playback?: VideoPlaybackOptions;
}) => {
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const [ended, setEnded] = useState(false);

  useEffect(() => {
    setEnded(false);
  }, [src]);

  useEffect(() => {
    if (playback?.videoMuted) {
      sendYouTubeCommand(iframeRef.current, 'mute');
    } else {
      sendYouTubeCommand(iframeRef.current, 'setVolume', [100]);
      sendYouTubeCommand(iframeRef.current, 'unMute');
    }
  }, [playback?.videoMuted, src]);

  useEffect(() => {
    if (!playback?.loopVideoUntilNext) return undefined;
    const onMessage = (event: MessageEvent) => {
      if (event.source !== iframeRef.current?.contentWindow) return;
      let data: unknown = event.data;
      if (typeof data === 'string') {
        try {
          data = JSON.parse(data) as unknown;
        } catch {
          return;
        }
      }
      if (!data || typeof data !== 'object') return;
      const info = (data as { info?: { playerState?: number } }).info;
      if (info?.playerState !== 0) return;
      setEnded(true);
      window.setTimeout(() => {
        sendYouTubeCommand(iframeRef.current, 'seekTo', [0, true]);
        sendYouTubeCommand(iframeRef.current, 'playVideo');
      }, 150);
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [playback?.loopVideoUntilNext, src]);

  return (
    <>
      <iframe
        ref={iframeRef}
        src={src}
        title={title}
        loading="lazy"
        allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
        allowFullScreen
        referrerPolicy="strict-origin-when-cross-origin"
        onLoad={(event) => {
          sendYouTubeCommand(event.currentTarget, 'playVideo');
          if (playback?.videoMuted) sendYouTubeCommand(event.currentTarget, 'mute');
          else {
            sendYouTubeCommand(event.currentTarget, 'setVolume', [100]);
            sendYouTubeCommand(event.currentTarget, 'unMute');
          }
        }}
      />
      {ended && playback?.loopVideoUntilNext && playback.hasNext && playback.onNext ? (
        <button
          type="button"
          className="discovery-quickread-next-video-btn"
          onClick={() => {
            setEnded(false);
            playback.onNext?.();
          }}
        >
          Next video
        </button>
      ) : null}
    </>
  );
};

const renderMediaFigure = (
  media: OverlayPostMedia,
  key: string,
  blur?: boolean,
  options: { showMeta?: boolean; autoPlayVideo?: boolean; playback?: VideoPlaybackOptions } = {}
 ) => {
  const showMeta = options.showMeta !== false;
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
          <QuickReadVideo
            key={media.mediaId}
            autoPlay={Boolean(options.autoPlayVideo)}
            src={media.previewUrl}
            poster={media.previewPosterUrl}
            blur={blur}
            playback={options.playback}
          />
        ) : (
          <>
            <ProgressivePostImage media={media} alt={media.title || 'Post media'} blur={blur} />
            <button
              type="button"
              className="discovery-quickread-fullscreen-btn"
              onClick={(event) => {
                const frame = event.currentTarget.closest('.discovery-quickread-media-frame');
                if (frame instanceof HTMLElement && frame.requestFullscreen) {
                  void frame.requestFullscreen();
                }
              }}
            >
              Full screen
            </button>
          </>
        )}
      </div>
      {showMeta ? <MediaMeta media={media} /> : null}
    </figure>
  );
};

const MediaMeta = ({ media }: { media: Pick<OverlayPostMedia, 'caption' | 'credit'> }) => {
  if (!media.caption && !media.credit?.label) return null;
  return (
    <figcaption className="discovery-quickread-media-meta">
      {media.caption ? <span className="discovery-quickread-media-caption">{media.caption}</span> : null}
      {media.credit?.label ? (
        <span className="discovery-quickread-media-credit">
          <span>Credit: </span>
          {media.credit.url ? (
            <a href={media.credit.url} target="_blank" rel="noreferrer">
              {media.credit.label}
            </a>
          ) : (
            <span>{media.credit.label}</span>
          )}
        </span>
      ) : null}
    </figcaption>
  );
};

const ComparisonSlider = ({ media, blur, playback }: { media: OverlayPostMedia; blur?: boolean; playback?: VideoPlaybackOptions }) => {
  const [position, setPosition] = useState(50);
  const comparison = media.comparison?.comparisonItem;
  const hasDimensions = Boolean(media.width && media.height && media.width > 0 && media.height > 0);
  const mediaAspect = hasDimensions ? media.width! / media.height! : 1;
  const frameStyle = hasDimensions
    ? {
        aspectRatio: `${media.width} / ${media.height}`,
        '--quickread-media-fit-width': `min(100%, ${mediaAspect * 70}vh, ${mediaAspect * 50}rem)`
      } as CSSProperties
    : undefined;
  const comparisonStyle = {
    ...(frameStyle ?? {}),
    '--comparison-position': `${position}%`
  } as CSSProperties;

  if (!comparison || media.assetType !== 'image' || comparison.assetType !== 'image') {
    return renderMediaFigure(media, `comparison-fallback-${media.mediaId}`, blur, { playback });
  }
  const baseMedia = comparison;
  const overlayMedia = media;

  return (
    <figure className="discovery-quickread-media-figure discovery-comparison-figure">
      <div className={`discovery-comparison-frame${hasDimensions ? ' has-ratio' : ' no-ratio'}`} style={comparisonStyle}>
        <ProgressivePostImage
          media={baseMedia}
          className="discovery-comparison-img"
          alt={baseMedia.title || 'Comparison base'}
          blur={blur}
        />
        <div className="discovery-comparison-overlay">
          <ProgressivePostImage
            media={overlayMedia}
            className="discovery-comparison-img"
            alt={overlayMedia.title || 'Comparison overlay'}
            blur={blur}
          />
        </div>
        <div className="discovery-comparison-handle" aria-hidden="true" />
        <input
          className="discovery-comparison-range"
          type="range"
          min="0"
          max="100"
          value={position}
          aria-label="Compare images"
          onChange={(event) => setPosition(Number(event.target.value))}
        />
        <button
          type="button"
          className="discovery-quickread-fullscreen-btn"
          onClick={(event) => {
            const frame = event.currentTarget.closest('.discovery-comparison-frame');
            if (frame instanceof HTMLElement && frame.requestFullscreen) {
              void frame.requestFullscreen();
            }
          }}
        >
          Full screen
        </button>
      </div>
      <div className="discovery-comparison-labels" aria-hidden="true">
        <span>{overlayMedia.comparison?.role || media.comparison?.role || 'Comparison'}</span>
        <span>{baseMedia.role || 'Original'}</span>
      </div>
      <MediaMeta media={media} />
    </figure>
  );
};

const MediaCarousel = ({ media, blur, playback }: { media: OverlayPostMedia[]; blur?: boolean; playback?: VideoPlaybackOptions }) => {
  const orderedMedia = media.filter((item) => item.previewUrl).sort((a, b) => (a.sortOrder || 0) - (b.sortOrder || 0));
  const [activeIndex, setActiveIndex] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speedSeconds, setSpeedSeconds] = useState(4);
  const activeMedia = orderedMedia[activeIndex] || orderedMedia[0];
  const hasMultiple = orderedMedia.length > 1;

  useEffect(() => {
    if (!playing || !hasMultiple) return undefined;
    const timer = window.setInterval(() => {
      setActiveIndex((current) => (current + 1) % orderedMedia.length);
    }, speedSeconds * 1000);
    return () => window.clearInterval(timer);
  }, [hasMultiple, orderedMedia.length, playing, speedSeconds]);

  if (!activeMedia) return null;

  const goPrevious = () => setActiveIndex((current) => (current - 1 + orderedMedia.length) % orderedMedia.length);
  const goNext = () => setActiveIndex((current) => (current + 1) % orderedMedia.length);
  const renderedMedia = activeMedia.comparison?.comparisonItem
    ? <ComparisonSlider media={activeMedia} blur={blur} playback={playback} />
    : renderMediaFigure(activeMedia, `carousel-media-${activeMedia.mediaId}`, blur, {
      autoPlayVideo: activeMedia.assetType === 'video',
      playback
    });

  return (
    <div className="discovery-quickread-media-carousel">
      {renderedMedia}
      {hasMultiple ? (
        <div className="discovery-quickread-media-nav" aria-label="Post media navigation">
          <button type="button" className="discovery-quickread-media-chevron" onClick={goPrevious} aria-label="Previous media">
            ‹
          </button>
          <div className="discovery-quickread-media-count">
            {activeIndex + 1} / {orderedMedia.length}
          </div>
          <button type="button" className="discovery-quickread-media-chevron" onClick={goNext} aria-label="Next media">
            ›
          </button>
          <button
            type="button"
            className={`discovery-quickread-slideshow-btn${playing ? ' is-active' : ''}`}
            onClick={() => setPlaying((value) => !value)}
          >
            {playing ? 'Pause' : 'Play'}
          </button>
          <label className="discovery-quickread-speed-control">
            <span>Speed</span>
            <input
              type="range"
              min="1"
              max="8"
              step="0.5"
              value={speedSeconds}
              aria-label="Slideshow speed in seconds"
              onChange={(event) => setSpeedSeconds(Number(event.target.value))}
            />
            <span>{speedSeconds.toFixed(speedSeconds % 1 === 0 ? 0 : 1)}s</span>
          </label>
        </div>
      ) : null}
    </div>
  );
};

const StandardPostRenderer = ({
  item,
  post,
  storyMode = false,
  playback
}: {
  item: DiscoveryOverlayItem;
  post: OverlayPost;
  storyMode?: boolean;
  playback?: VideoPlaybackOptions;
}) => {
  const orderedMedia = [...post.media].sort((a, b) => (a.sortOrder || 0) - (b.sortOrder || 0));
  const mediaById = new Map(orderedMedia.map((media) => [media.mediaId, media]));
  const hasBlocks = post.blocks.length > 0;
  const primaryMedia = post.primaryMediaId ? mediaById.get(post.primaryMediaId) : undefined;
  const postType = getPostType(post);
  const postFormat = getPostFormat(post, postType);
  const hasComparisonMedia = orderedMedia.some((media) => Boolean(media.comparison?.comparisonItem));
  const shouldRenderMediaSet = postType !== 'story' && (postFormat === 'multi' || orderedMedia.length > 1 || hasComparisonMedia);
  const shouldRenderPrimaryMediaTopBlock = Boolean(primaryMedia && postType !== 'story' && hasBlocks && !shouldRenderMediaSet);
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
      if (level === 1) return <h1 key={key}>{renderInlineText(block.text, block.html)}</h1>;
      if (level === 2) return <h2 key={key} className={storyMode ? 'post-part-title' : undefined}>{renderInlineText(block.text, block.html)}</h2>;
      if (level === 3) return <h3 key={key} className={storyMode ? 'post-part-label' : undefined}>{renderInlineText(block.text, block.html)}</h3>;
      if (level === 4) return <h4 key={key}>{renderInlineText(block.text, block.html)}</h4>;
      if (level === 5) return <h5 key={key}>{renderInlineText(block.text, block.html)}</h5>;
      return <h6 key={key}>{renderInlineText(block.text, block.html)}</h6>;
    }
    if (block.type === 'paragraph') {
      if (block.html) {
        return <p key={key}>{renderInlineText(block.text, block.html)}</p>;
      }
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
          <p>{renderInlineText(block.quote || block.text || '', block.html)}</p>
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
      const blockMedia = { ...media, caption: block.caption || media.caption };
      return blockMedia.comparison?.comparisonItem
        ? <ComparisonSlider key={`media-${key}`} media={blockMedia} blur={item.blurred} playback={playback} />
        : renderMediaFigure(blockMedia, `media-${key}`, item.blurred, {
          autoPlayVideo: blockMedia.assetType === 'video' && item.assetType === 'video',
          playback
        });
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
    if (block.type === 'embed') {
      const provider = typeof block.payload?.provider === 'string' ? block.payload.provider.toLowerCase() : '';
      const youtube = provider === 'youtube' || provider === 'youtube-shorts' || !provider
        ? getYouTubeEmbed(block.url, { autoplay: item.assetType === 'video', muted: playback?.videoMuted })
        : null;
      const isShortEmbed = youtube?.isShort || block.payload?.format === 'short' || block.payload?.layout === 'short';
      if (youtube) {
        return (
          <figure key={key} className={`discovery-quickread-embed-figure${isShortEmbed ? ' is-short' : ''}`}>
            {block.title ? <figcaption>{block.title}</figcaption> : null}
            <div className="discovery-quickread-embed-frame">
              <QuickReadYouTubeEmbed
                src={youtube.src}
                title={block.title || block.label || 'YouTube video'}
                playback={playback}
              />
            </div>
            {block.text || block.caption ? <p className="small">{renderInlineText(block.caption || block.text)}</p> : null}
          </figure>
        );
      }
      if (block.url) {
        return (
          <div key={key} className="panel">
            <a href={block.url} target="_blank" rel="noreferrer" className="no-underline">
              {block.label || block.title || block.url}
            </a>
            {block.text ? <p className="small mt-2">{renderInlineText(block.text)}</p> : null}
          </div>
        );
      }
      return null;
    }
    if (block.type === 'html_fragment') {
      return (
        <pre key={key} className="panel small" style={{ overflowX: 'auto' }}>
          {block.html || ''}
        </pre>
      );
    }
    if (block.type === 'credit') {
      const creditText = block.text || '';
      const sourceLabel = block.label || block.title || block.url || 'Source';
      return (
        <aside key={key} className="discovery-quickread-credit-block">
          <div className="discovery-quickread-credit-heading">
            <span className="discovery-quickread-credit-label">Credit</span>
            {block.url ? (
              <a href={block.url} target="_blank" rel="noreferrer">
                {sourceLabel}
              </a>
            ) : (
              <span className="discovery-quickread-credit-source">{sourceLabel}</span>
            )}
          </div>
          {creditText ? <p>{renderInlineText(creditText)}</p> : null}
        </aside>
      );
    }
    if (block.url || block.text || block.title) {
      return (
        <div key={key} className="panel">
          {block.url ? <a href={block.url} target="_blank" rel="noreferrer" className="no-underline">{block.label || block.title || block.url}</a> : null}
          {block.text ? <p className="small mt-2">{renderInlineText(block.text)}</p> : null}
        </div>
      );
    }
    return null;
  };

  return (
    <div className={`discovery-quickread-content-flow discovery-quickread-${postType}-flow discovery-quickread-${postType}-${postFormat}-flow`}>
      {shouldRenderPrimaryMediaTopBlock && primaryMedia
        ? renderMediaFigure(primaryMedia, `primary-media-${primaryMedia.mediaId}`, item.blurred, {
          autoPlayVideo: primaryMedia.assetType === 'video',
          playback
        })
        : null}
      {shouldRenderMediaSet ? <MediaCarousel media={fallbackMedia} blur={item.blurred} playback={playback} /> : null}
      {!hasBlocks ? (
        <>
          {post.summary ? <p>{post.summary}</p> : null}
          {!shouldRenderMediaSet ? fallbackMedia.map((media, index) =>
            media.comparison?.comparisonItem
              ? <ComparisonSlider key={`fallback-media-${media.mediaId || index}`} media={media} blur={item.blurred} playback={playback} />
              : renderMediaFigure(media, `fallback-media-${media.mediaId || index}`, item.blurred, {
                autoPlayVideo: media.assetType === 'video' && index === 0,
                playback
              })
          ) : null}
        </>
      ) : post.blocks.map((block, index) => renderBlock(block, index))}
    </div>
  );
};

const StoryPostRenderer = ({ item, post, playback }: { item: DiscoveryOverlayItem; post: OverlayPost; playback?: VideoPlaybackOptions }) => {
  return (
    <div className="discovery-quickread-content-flow discovery-quickread-story-flow post-reading">
      <StandardPostRenderer item={item} post={post} storyMode playback={playback} />
    </div>
  );
};

const ShortStoryPostRenderer = ({ item, post, playback }: { item: DiscoveryOverlayItem; post: OverlayPost; playback?: VideoPlaybackOptions }) => {
  return (
    <div className="discovery-quickread-content-flow discovery-quickread-short-story-flow post-reading">
      <StandardPostRenderer item={item} post={post} storyMode playback={playback} />
    </div>
  );
};

export const RichPostRenderer = ({ item, post, playback }: { item: DiscoveryOverlayItem; post: OverlayPost; playback?: VideoPlaybackOptions }) => {
  const renderKind = inferPostRenderKind(post);
  if (renderKind === 'image') {
    return (
      <div className="discovery-quickread-content-flow discovery-quickread-story-flow post-reading">
        <StandardPostRenderer item={item} post={post} storyMode playback={playback} />
      </div>
    );
  }
  if (renderKind !== 'story') {
    return <StandardPostRenderer item={item} post={post} playback={playback} />;
  }
  const storyFormat = getPostFormat(post, 'story');
  return storyFormat === 'short'
    ? <ShortStoryPostRenderer item={item} post={post} playback={playback} />
    : <StoryPostRenderer item={item} post={post} playback={playback} />;
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
  loopVideosUntilNext,
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
  const videoPlayback = {
    videoMuted,
    loopVideoUntilNext: loopVideosUntilNext,
    hasNext,
    onNext,
    onVideoVolumeChange
  };

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
              <RichPostRenderer
                item={item}
                post={post}
                playback={videoPlayback}
              />
            ) : (
              <article className="discovery-quickread-content-flow">
                <div className="discovery-quickread-media-figure">
                  {item.assetType === 'audio' ? (
                    <audio controls preload="metadata" style={{ width: '100%' }}>
                      <source src={item.previewUrl} />
                    </audio>
                  ) : item.assetType === 'video' ? (
                    <QuickReadVideo
                      key={item.imageId}
                      videoRef={videoRef}
                      autoPlay
                      src={item.previewUrl}
                      poster={item.previewPosterUrl}
                      blur={item.blurred}
                      playback={videoPlayback}
                    />
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
