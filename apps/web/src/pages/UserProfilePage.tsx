import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api } from '../api';
import { PublicProfileHero } from '../components/PublicProfileHero';
import type { PublicUserProfile, UserProfile } from '../domainTypes';
import { sanitizeProfileBio } from '../profileBio';

const withVersion = (url?: string, version?: string) => {
  if (!url || !version) return url;
  const separator = url.includes('?') ? '&' : '?';
  return `${url}${separator}v=${encodeURIComponent(version)}`;
};

const externalHref = (value: string) => /^https?:\/\//i.test(value) ? value : `https://${value}`;

export default function UserProfilePage({ viewerProfile }: { viewerProfile?: UserProfile | null }) {
  const { slug = '' } = useParams();
  const [profile, setProfile] = useState<PublicUserProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [activeView, setActiveView] = useState<'collections' | 'about' | 'creator'>('collections');

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError('');
    api.getUserProfile(slug)
      .then((value) => {
        if (!cancelled) setProfile(value as PublicUserProfile);
      })
      .catch((reason) => {
        if (!cancelled) setError((reason as Error).message || 'Profile not found.');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [slug]);

  if (loading) return <main className="layout"><section className="panel">Loading profile…</section></main>;
  if (!profile) return <main className="layout"><section className="panel"><h1>Profile unavailable</h1><p>{error || 'Profile not found.'}</p></section></main>;

  const avatar = profile.branding?.profileImage;
  const cover = profile.branding?.coverImage;
  const avatarUrl = avatar?.thumbnailUrls?.square512 || avatar?.thumbnailUrls?.square256;
  const isOwnProfile = viewerProfile?.username === profile.username;
  const joined = new Date(profile.createdAt);
  const joinedLabel = Number.isNaN(joined.getTime()) ? undefined : `Joined ${joined.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })}`;
  const visibleCreatorCount = profile.creators.length;

  return (
    <main className="layout public-profile-page">
      <PublicProfileHero
        kind="member"
        name={profile.displayName}
        handle={profile.username}
        avatarUrl={withVersion(avatarUrl, avatar?.updatedAt)}
        avatarAlt={avatar?.altText}
        cover={{
          desktop: withVersion(cover?.renditionUrls?.desktop, cover?.updatedAt),
          tablet: withVersion(cover?.renditionUrls?.tablet, cover?.updatedAt),
          mobile: withVersion(cover?.renditionUrls?.mobile, cover?.updatedAt),
          alt: cover?.altText
        }}
        coverPreset={profile.coverPreset}
        meta={joinedLabel ? <span>{joinedLabel}</span> : undefined}
        stats={[
          { label: 'Public collections', value: profile.publicCollectionCount },
          { label: 'Public favourites', value: profile.publicFavoriteCount },
          ...(visibleCreatorCount ? [{ label: 'Creator identities', value: visibleCreatorCount }] : [])
        ]}
        actions={(
          <div className="public-profile-action-layout">
            <div className="public-profile-action-buttons">
              {isOwnProfile && <Link className="auth-primary-btn no-underline" to="/settings?section=profile">Edit profile</Link>}
              <button type="button" className={`auth-secondary-btn${activeView === 'collections' ? ' is-active' : ''}`} aria-pressed={activeView === 'collections'} onClick={() => setActiveView('collections')}>Collections</button>
              <button type="button" className={`auth-secondary-btn${activeView === 'about' ? ' is-active' : ''}`} aria-pressed={activeView === 'about'} onClick={() => setActiveView('about')}>About</button>
              {visibleCreatorCount > 0 && <button type="button" className={`auth-secondary-btn${activeView === 'creator' ? ' is-active' : ''}`} aria-pressed={activeView === 'creator'} onClick={() => setActiveView('creator')}>A Creator</button>}
            </div>
          </div>
        )}
      />

      {activeView === 'about' && (
        <section className="public-profile-section">
          <article className="panel public-profile-about">
          <p className="creator-section-kicker">About</p>
          <h2>{profile.displayName}</h2>
          {profile.bio ? <div className="limited-bio-content" dangerouslySetInnerHTML={{ __html: sanitizeProfileBio(profile.bio) }} /> : <p className="small">No biography has been added yet.</p>}
          <div className="public-profile-details">
            {profile.location && <span>Based in {profile.location}</span>}
            {profile.website && <a href={externalHref(profile.website)} rel="me noreferrer">Visit website</a>}
          </div>
          {Boolean(profile.externalLinks?.length) && (
            <nav className="public-profile-link-list" aria-label={`${profile.displayName} external links`}>
              {profile.externalLinks?.map((link) => <a key={link.url} href={link.url} target="_blank" rel="me noreferrer">{link.label}</a>)}
            </nav>
          )}
        </article>
        </section>
      )}

      {activeView === 'creator' && visibleCreatorCount > 0 && (
        <section className="public-profile-section">
        <article className="panel public-profile-creators">
          <p className="creator-section-kicker">Creator identities</p>
          <h2>Creates as</h2>
          <div className="public-profile-link-list">
            {profile.creators.map((creator) => (
              <Link key={creator.creatorId} to={`/creators/${encodeURIComponent(creator.slug)}`}>
                <strong>{creator.name}</strong>
                <span>@{creator.slug}</span>
              </Link>
            ))}
          </div>
        </article>
        </section>
      )}

      {activeView === 'collections' && <section className="public-profile-section">
        <div className="creator-section-heading">
          <div><p className="creator-section-kicker">Collections</p><h2>Public collections</h2></div>
          <span>{profile.publicCollectionCount} total</span>
        </div>
        {profile.publicCollections.length ? (
          <div className="public-profile-collection-grid">
            {profile.publicCollections.map((collection) => (
              <Link key={collection.collectionId} className="panel no-underline" to={`/collections/${encodeURIComponent(collection.collectionId)}`}>
                <strong>{collection.title}</strong>
                {collection.description && <p>{collection.description}</p>}
                <span>{collection.imageCount} items</span>
              </Link>
            ))}
          </div>
        ) : <div className="panel"><p className="small m-0">No public collections yet.</p></div>}
      </section>}
    </main>
  );
}
