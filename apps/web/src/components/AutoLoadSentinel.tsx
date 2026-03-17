import { useEffect, useRef } from 'react';

export default function AutoLoadSentinel({
  enabled,
  loading,
  onLoadMore,
  rootMargin = '240px 0px'
}: {
  enabled: boolean;
  loading: boolean;
  onLoadMore: () => Promise<void> | void;
  rootMargin?: string;
}) {
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!enabled || loading || !ref.current) return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        void onLoadMore();
      }
    }, { rootMargin });
    observer.observe(ref.current);
    return () => observer.disconnect();
  }, [enabled, loading, onLoadMore, rootMargin]);

  if (!enabled) return null;
  return (
    <div ref={ref} className="inline-form mt-4">
      <button onClick={() => void onLoadMore()} disabled={loading}>{loading ? 'Loading...' : 'Load more'}</button>
    </div>
  );
}
