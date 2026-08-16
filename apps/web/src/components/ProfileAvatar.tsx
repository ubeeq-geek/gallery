import type { CSSProperties } from 'react';
import { stableProfileIndex } from '../profileIdentity';

const fallbackPalettes = [
  ['#c4a7d5', '#fbf4ff', '#d56b81'],
  ['#8fc7c1', '#f0fbfa', '#d49a45'],
  ['#d5aaa4', '#fff5ef', '#b96b5d'],
  ['#9db6d1', '#f4f7fb', '#d29a55'],
  ['#bfbd8b', '#fbf9e7', '#b8784d'],
  ['#c8a4c0', '#fff4fb', '#d06d84'],
  ['#91bea9', '#f0faf4', '#d19a4d'],
  ['#bda7c7', '#faf5fc', '#c27a58']
] as const;

export function ProfileAvatar({
  src,
  identity,
  alt = '',
  className = ''
}: {
  src?: string;
  identity: string;
  alt?: string;
  className?: string;
}) {
  if (src) return <img className={className} src={src} alt={alt} />;

  const [outer, inner, core] = fallbackPalettes[stableProfileIndex(identity || 'profile', fallbackPalettes.length)];
  const style = {
    '--profile-avatar-outer': outer,
    '--profile-avatar-inner': inner,
    '--profile-avatar-core': core
  } as CSSProperties;

  return (
    <span
      className={`${className} ubeeq-profile-fallback`.trim()}
      style={style}
      role={alt ? 'img' : undefined}
      aria-label={alt || undefined}
      aria-hidden={alt ? undefined : true}
    >
      <span className="ubeeq-profile-fallback-mark" aria-hidden="true" />
    </span>
  );
}
