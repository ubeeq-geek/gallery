import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api } from '../api';
import { brand } from '../brand';

type PublicAsset = {
  assetId: string;
  kind: string;
  mimeType: string;
  url?: string;
  thumbnailUrl?: string;
  altText?: string;
};

type PublicWork = {
  workId: string;
  title: string;
  slug: string;
  description?: string;
  tags: string[];
  kind: string;
  publishedAt?: string;
  updatedAt: string;
  visibility?: 'private' | 'unlisted' | 'public';
  primaryAsset?: PublicAsset;
  assets: PublicAsset[];
  destinations: Array<{ destination: string; url: string }>;
};

type PublicCreator = { creatorId: string; name: string; slug: string };
type PublicCollection = { collectionId: string; title: string; slug: string; description?: string; workCount?: number };

function WorkCard({ creator, work }: { creator: PublicCreator; work: PublicWork }) {
  const preview = work.primaryAsset?.thumbnailUrl || work.primaryAsset?.url;
  return <article className="canonical-work-card">
    <Link to={`/creators/${encodeURIComponent(creator.slug)}/works/${encodeURIComponent(work.slug)}`}>
      <div className="canonical-work-card-preview">
        {preview ? <img src={preview} alt={work.primaryAsset?.altText || ''} /> : <span>{work.kind}</span>}
      </div>
      <strong>{work.title}</strong>
    </Link>
    {work.description && <p>{work.description}</p>}
  </article>;
}

function SpaceState({ loading, error }: { loading: boolean; error: string }) {
  if (loading) return <p>Loading…</p>;
  if (error) return <p className="error">{error}</p>;
  return null;
}

export function CreatorWorksPage() {
  const { slug = '' } = useParams();
  const [creator, setCreator] = useState<PublicCreator | null>(null);
  const [works, setWorks] = useState<PublicWork[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  useEffect(() => {
    setLoading(true);
    api.getCreatorWorks(slug).then((result) => {
      const payload = result as { creator: PublicCreator; items: PublicWork[] };
      setCreator(payload.creator);
      setWorks(payload.items || []);
      setError('');
    }).catch((reason) => setError(reason instanceof Error ? reason.message : 'Unable to load this Space.')).finally(() => setLoading(false));
  }, [slug]);
  return <main className="canonical-space-page">
    <header className="canonical-space-heading">
      <p>{brand.workspaceFullName}</p>
      <h1>{creator?.name || 'Works'}</h1>
      {creator && <nav><Link to={`/creators/${creator.slug}`}>Profile</Link><Link to={`/creators/${creator.slug}/collections`}>Collections</Link></nav>}
    </header>
    <SpaceState loading={loading} error={error} />
    {!loading && !error && <section className="canonical-work-grid">{works.map((work) => <WorkCard key={work.workId} creator={creator!} work={work} />)}</section>}
    {!loading && !error && !works.length && <p>No public works have been published yet.</p>}
  </main>;
}

export function CreatorWorkPage() {
  const { slug = '', workSlug = '' } = useParams();
  const [creator, setCreator] = useState<PublicCreator | null>(null);
  const [work, setWork] = useState<PublicWork | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  useEffect(() => {
    setLoading(true);
    api.getCreatorWork(slug, workSlug).then((result) => {
      const payload = result as { creator: PublicCreator; work: PublicWork };
      setCreator(payload.creator);
      setWork(payload.work);
      setError('');
    }).catch((reason) => setError(reason instanceof Error ? reason.message : 'Unable to load this work.')).finally(() => setLoading(false));
  }, [slug, workSlug]);
  return <main className="canonical-space-page canonical-work-page">
    <SpaceState loading={loading} error={error} />
    {creator && work && <>
      <header className="canonical-space-heading">
        <p><Link to={`/creators/${creator.slug}/works`}>{creator.name}</Link> · {brand.workspaceFullName}</p>
        <h1>{work.title}</h1>
        {work.publishedAt && <time dateTime={work.publishedAt}>Published {new Date(work.publishedAt).toLocaleDateString()}</time>}
      </header>
      <section className="canonical-work-assets">
        {work.assets.map((asset) => asset.kind === 'image' && asset.url
          ? <img key={asset.assetId} src={asset.url} alt={asset.altText || work.title} />
          : asset.url ? <a key={asset.assetId} href={asset.url}>Open {asset.kind}</a> : null)}
      </section>
      {work.description && <div className="canonical-work-description">{work.description}</div>}
      {!!work.tags.length && <div className="canonical-work-tags">{work.tags.map((tag) => <span key={tag}>{tag}</span>)}</div>}
      {!!work.destinations.length && <nav className="canonical-work-destinations">{work.destinations.map((destination) => <a key={`${destination.destination}:${destination.url}`} href={destination.url} rel="noreferrer">Open on {destination.destination}</a>)}</nav>}
    </>}
  </main>;
}

export function CreatorCollectionsPage() {
  const { slug = '' } = useParams();
  const [creator, setCreator] = useState<PublicCreator | null>(null);
  const [collections, setCollections] = useState<PublicCollection[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  useEffect(() => {
    setLoading(true);
    api.getCreatorCollections(slug).then((result) => {
      const payload = result as { creator: PublicCreator; items: PublicCollection[] };
      setCreator(payload.creator);
      setCollections(payload.items || []);
      setError('');
    }).catch((reason) => setError(reason instanceof Error ? reason.message : 'Unable to load collections.')).finally(() => setLoading(false));
  }, [slug]);
  return <main className="canonical-space-page">
    <header className="canonical-space-heading"><p>{brand.workspaceFullName}</p><h1>{creator?.name || 'Collections'}</h1>{creator && <Link to={`/creators/${creator.slug}/works`}>Works</Link>}</header>
    <SpaceState loading={loading} error={error} />
    <section className="canonical-collection-list">{creator && collections.map((collection) => <Link key={collection.collectionId} to={`/creators/${creator.slug}/collections/${collection.slug}`}><strong>{collection.title}</strong><span>{collection.workCount || 0} works</span>{collection.description && <p>{collection.description}</p>}</Link>)}</section>
  </main>;
}

export function CreatorCollectionPage() {
  const { slug = '', collectionSlug = '' } = useParams();
  const [creator, setCreator] = useState<PublicCreator | null>(null);
  const [collection, setCollection] = useState<PublicCollection | null>(null);
  const [works, setWorks] = useState<PublicWork[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  useEffect(() => {
    setLoading(true);
    api.getCreatorCollection(slug, collectionSlug).then((result) => {
      const payload = result as { creator: PublicCreator; collection: PublicCollection; works: PublicWork[] };
      setCreator(payload.creator);
      setCollection(payload.collection);
      setWorks(payload.works || []);
      setError('');
    }).catch((reason) => setError(reason instanceof Error ? reason.message : 'Unable to load this collection.')).finally(() => setLoading(false));
  }, [slug, collectionSlug]);
  return <main className="canonical-space-page">
    <SpaceState loading={loading} error={error} />
    {creator && collection && <><header className="canonical-space-heading"><p><Link to={`/creators/${creator.slug}/collections`}>{creator.name} collections</Link></p><h1>{collection.title}</h1>{collection.description && <p>{collection.description}</p>}</header><section className="canonical-work-grid">{works.map((work) => <WorkCard key={work.workId} creator={creator} work={work} />)}</section></>}
  </main>;
}
