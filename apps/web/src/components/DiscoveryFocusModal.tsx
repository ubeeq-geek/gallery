import { Link } from 'react-router-dom';
import type { GroupingAsset } from '../domainTypes';
import { formatDisclosureLine } from '../discoveryUtils';

type DiscoveryFocusModalProps = {
  open: boolean;
  item: GroupingAsset | null;
  itemsCount: number;
  itemIndex: number;
  groupingTitle: string;
  groupingSlug: string;
  loading: boolean;
  error: string;
  hasPrevious: boolean;
  hasNext: boolean;
  videoMuted: boolean;
  videoRef: React.RefObject<HTMLVideoElement>;
  onClose: () => void;
  onPrevious: () => void;
  onNext: () => void;
  onVideoVolumeChange: (video: HTMLVideoElement) => void;
};

export default function DiscoveryFocusModal({
  open,
  item,
  itemsCount,
  itemIndex,
  groupingTitle,
  groupingSlug,
  loading,
  error,
  hasPrevious,
  hasNext,
  videoMuted,
  videoRef,
  onClose,
  onPrevious,
  onNext,
  onVideoVolumeChange
}: DiscoveryFocusModalProps) {
  if (!open) return null;
  const disclosureLine = item ? formatDisclosureLine(item) : '';

  return (
    <div className="discovery-focus-modal-layer" onClick={onClose}>
      <div className="discovery-focus-modal" role="dialog" aria-modal="true" aria-label="Focused media viewer" onClick={(e) => e.stopPropagation()}>
        <div className="discovery-focus-modal-header">
          <div className="discovery-focus-modal-title-wrap">
            <span className="discovery-focus-modal-title-id">
              {item ? (item.imageId || 'Focused view') : 'Focused view'}
            </span>
            <span className="discovery-focus-modal-title-grouping">{groupingTitle || 'Grouping preview'}</span>
          </div>
          <div className="discovery-focus-modal-meta">
            <span>{item?.displayedContentRating || 'General'}</span>
            {disclosureLine && <span>{disclosureLine}</span>}
            <span>{Math.max(1, itemIndex + 1)} / {Math.max(1, itemsCount)}</span>
            {loading && <span className="discovery-focus-modal-status-chip">Loading…</span>}
            {error && <span className="discovery-focus-modal-error-chip">{error}</span>}
          </div>
          <div className="discovery-focus-modal-actions">
            <button
              type="button"
              className="auth-secondary-btn"
              disabled={!hasPrevious}
              onClick={onPrevious}
            >
              Previous
            </button>
            <button
              type="button"
              className="auth-secondary-btn"
              disabled={!hasNext}
              onClick={onNext}
            >
              Next
            </button>
            {groupingSlug && (
              <Link
                className="auth-primary-btn no-underline"
                to={`/groupings/${groupingSlug}?image=${encodeURIComponent(item?.imageId || '')}`}
                onClick={onClose}
              >
                Open grouping
              </Link>
            )}
          </div>
          <button type="button" className="discovery-focus-modal-close" onClick={onClose} aria-label="Close focused viewer">
            ✕
          </button>
        </div>
        <div className="discovery-focus-modal-media">
          {item && (
            item.assetType === 'video'
              ? (
                <video
                  key={item.imageId}
                  ref={videoRef}
                  autoPlay
                  controls
                  playsInline
                  muted={videoMuted}
                  poster={item.previewPosterUrl}
                  style={{ filter: item.blurred ? 'blur(28px)' : undefined }}
                  onVolumeChange={(event) => onVideoVolumeChange(event.currentTarget)}
                >
                  <source src={item.previewUrl} />
                </video>
              )
              : (
                <img
                  src={item.thumbnailUrls?.w1280 || item.thumbnailUrls?.w640 || item.previewUrl}
                  alt={item.imageId || 'Focused media'}
                  style={{ filter: item.blurred ? 'blur(28px)' : undefined }}
                />
              )
          )}
          {!item && <div className="small">No media selected.</div>}
        </div>
      </div>
    </div>
  );
}
