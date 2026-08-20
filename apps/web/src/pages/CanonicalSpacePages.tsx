import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api } from '../api';
import { brand } from '../brand';
import { serializeDescriptionBlocks } from '../blockContent';
import type { PostBlock } from '../domainTypes';

type PublicAsset = {
  assetId: string;
  kind: string;
  mimeType: string;
  url?: string;
  thumbnailUrl?: string;
  altText?: string;
  hostingMode?: 'hosted' | 'external';
  sourceCopyQuality?: string | number | boolean | null;
};

type PublicWork = {
  workId: string;
  title: string;
  slug: string;
  description?: string;
  body?: PostBlock[];
  tags: string[];
  kind: string;
  publishedAt?: string;
  updatedAt: string;
  visibility?: 'private' | 'unlisted' | 'public';
  contentAvailability: 'metadata_only' | 'external_reference' | 'display_copy' | 'original_hosted';
  primaryAsset?: PublicAsset;
  assets: PublicAsset[];
  destinations: Array<{ destination: string; url: string }>;
};

type PublicCreator = {
  creatorId: string;
  name: string;
  slug: string;
  bio?: string;
  externalLinks: Array<{ label: string; url: string }>;
  theme: 'default' | 'ubeeq' | 'sand' | 'forest' | 'slate';
  announcement?: { enabled: boolean; message: string; url?: string };
  profileImageUrl?: string;
  coverImageUrl?: string;
};
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

function SpaceHeader({ creator, section }: { creator: PublicCreator | null; section?: string }) {
  if (!creator) return <header className="canonical-space-heading"><p>{brand.workspaceFullName}</p><h1>{section || 'Space'}</h1></header>;
  const feeds = api.getCreatorFeedUrls(creator.slug);
  return <>
    {creator.coverImageUrl && <div className="canonical-space-cover"><img src={creator.coverImageUrl} alt="" /></div>}
    {creator.announcement && <aside className="canonical-space-announcement">{creator.announcement.url ? <a href={creator.announcement.url}>{creator.announcement.message}</a> : creator.announcement.message}</aside>}
    <header className="canonical-space-heading canonical-space-identity">
      {creator.profileImageUrl && <img className="canonical-space-avatar" src={creator.profileImageUrl} alt="" />}
      <div><p>{brand.workspaceFullName}</p><h1>{creator.name}</h1>{section && <h2>{section}</h2>}</div>
      {creator.bio && <p className="canonical-space-bio">{creator.bio}</p>}
      <nav><Link to={`/creators/${creator.slug}`}>Profile</Link><Link to={`/creators/${creator.slug}/works`}>Works</Link><Link to={`/creators/${creator.slug}/collections`}>Collections</Link><a href={feeds.rss}>RSS</a><a href={feeds.atom}>Atom</a>{creator.externalLinks.map((link) => <a key={link.url} href={link.url} rel="me noreferrer">{link.label}</a>)}</nav>
    </header>
  </>;
}

function WorkAsset({ asset, title }: { asset: PublicAsset; title: string }) {
  if (!asset.url) return null;
  const externallyHosted = asset.hostingMode === 'external';
  return <figure className="canonical-work-asset" key={asset.assetId}>
    {asset.kind === 'image' || asset.mimeType.startsWith('image/')
      ? <img src={asset.url} alt={asset.altText || title} />
      : asset.kind === 'video' || asset.mimeType.startsWith('video/')
        ? <video controls preload="metadata" poster={asset.thumbnailUrl}><source src={asset.url} type={asset.mimeType} /></video>
        : asset.kind === 'audio' || asset.mimeType.startsWith('audio/')
          ? <audio controls preload="metadata" src={asset.url} />
          : <a href={asset.url}>Open {asset.kind}</a>}
    <figcaption>{externallyHosted ? 'Hosted externally' : asset.sourceCopyQuality === 'display_copy' ? `Display copy hosted by ${brand.productName}` : `Original hosted by ${brand.productName}`}{externallyHosted && <a href={asset.url}>Open source</a>}</figcaption>
  </figure>;
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
  return <main className="canonical-space-page" data-theme={creator?.theme === 'default' ? undefined : creator?.theme}>
    <SpaceHeader creator={creator} section="Works" />
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
  return <main className="canonical-space-page canonical-work-page" data-theme={creator?.theme === 'default' ? undefined : creator?.theme}>
    <SpaceState loading={loading} error={error} />
    {creator && work && <>
      <SpaceHeader creator={creator} />
      <header className="canonical-space-heading canonical-work-heading">
        <p><Link to={`/creators/${creator.slug}/works`}>Works</Link></p><h1>{work.title}</h1>
        {work.publishedAt && <time dateTime={work.publishedAt}>Published {new Date(work.publishedAt).toLocaleDateString()}</time>}
      </header>
      <section className="canonical-work-assets">
        {work.assets.map((asset) => <WorkAsset key={asset.assetId} asset={asset} title={work.title} />)}
      </section>
      {work.body?.length
        ? <div className="canonical-work-description" dangerouslySetInnerHTML={{ __html: serializeDescriptionBlocks(work.body) }} />
        : work.description && <div className="canonical-work-description">{work.description}</div>}
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
  return <main className="canonical-space-page" data-theme={creator?.theme === 'default' ? undefined : creator?.theme}>
    <SpaceHeader creator={creator} section="Collections" />
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
  return <main className="canonical-space-page" data-theme={creator?.theme === 'default' ? undefined : creator?.theme}>
    <SpaceState loading={loading} error={error} />
    {creator && collection && <><SpaceHeader creator={creator} /><header className="canonical-space-heading"><p><Link to={`/creators/${creator.slug}/collections`}>Collections</Link></p><h1>{collection.title}</h1>{collection.description && <p>{collection.description}</p>}</header><section className="canonical-work-grid">{works.map((work) => <WorkCard key={work.workId} creator={creator} work={work} />)}</section></>}
  </main>;
}
