import type { ReactNode } from 'react';
import { brand } from '../brand';
import { defaultProfileCoverFor } from '../profileDefaults';
import { ProfileAvatar } from './ProfileAvatar';

type ResponsiveImage = {
  desktop?: string;
  tablet?: string;
  mobile?: string;
  alt?: string;
};

export function PublicProfileHero({
  kind,
  name,
  handle,
  avatarUrl,
  avatarAlt,
  cover,
  coverPreset,
  meta,
  stats,
  actions,
  children
}: {
  kind: 'member' | 'creator';
  name: string;
  handle: string;
  avatarUrl?: string;
  avatarAlt?: string;
  cover?: ResponsiveImage;
  coverPreset?: string;
  meta?: ReactNode;
  stats?: Array<{ label: string; value: string | number }>;
  actions?: ReactNode;
  children?: ReactNode;
}) {
  const profileIdentity = `${kind}:${handle}`;
  const defaultCover = defaultProfileCoverFor(profileIdentity, coverPreset);
  const desktopCover = cover?.desktop || cover?.tablet || cover?.mobile || defaultCover;
  const tabletCover = cover?.tablet || cover?.desktop || cover?.mobile || defaultCover;
  const mobileCover = cover?.mobile || cover?.tablet || cover?.desktop || defaultCover;
  const hasCustomCover = Boolean(cover?.desktop || cover?.tablet || cover?.mobile);
  const hasCover = Boolean(desktopCover);

  return (
    <section className={`public-profile-hero public-profile-hero-${kind}`}>
      <div className={`public-profile-cover${hasCover ? ' has-image' : ''}${!hasCustomCover && hasCover ? ' has-default-image' : ''}`}>
        {hasCover && (
          <picture>
            {mobileCover && <source media="(max-width: 699px)" srcSet={mobileCover} />}
            {tabletCover && <source media="(max-width: 1099px)" srcSet={tabletCover} />}
            <img src={desktopCover} alt={hasCustomCover ? (cover?.alt || '') : ''} />
          </picture>
        )}
      </div>
      <div className="public-profile-identity">
        <ProfileAvatar
          className="public-profile-avatar"
          src={avatarUrl}
          identity={profileIdentity}
          alt={avatarAlt || `${name} profile image`}
        />
        <div className="public-profile-copy">
          <p className="public-profile-kind">{kind === 'creator' ? brand.creatorName : brand.memberName}</p>
          <h1>{name}</h1>
          <div className="public-profile-handle-row">
            <span>@{handle}</span>
            {meta}
          </div>
          {Boolean(stats?.length) && (
            <dl className="public-profile-stats">
              {stats?.map((stat) => (
                <div key={stat.label}>
                  <dt>{stat.label}</dt>
                  <dd>{stat.value}</dd>
                </div>
              ))}
            </dl>
          )}
          {children}
        </div>
        {actions && <div className="public-profile-actions">{actions}</div>}
      </div>
    </section>
  );
}
