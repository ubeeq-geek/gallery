import { brand } from './brand';
import { stableProfileIndex } from './profileIdentity';

export type ProfileCoverOption = {
  id: string;
  label: string;
  url: string;
};

const eversallyDefaultCovers: ProfileCoverOption[] = Array.from(
  { length: 16 },
  (_, index) => ({
    id: `eversally-cover-${index + 1}`,
    label: `Cover ${index + 1}`,
    url: `/covers/eversally-cover-${index + 1}.jpg`
  })
);

export function availableProfileCovers(): ProfileCoverOption[] {
  return brand.id === 'eversally' ? eversallyDefaultCovers : [];
}

export function profileCoverUrlFor(preset?: string): string | undefined {
  if (!preset) return undefined;
  return availableProfileCovers().find((cover) => cover.id === preset)?.url;
}

export function defaultProfileCoverIdFor(identity: string): string | undefined {
  const covers = availableProfileCovers();
  if (!covers.length) return undefined;
  return covers[stableProfileIndex(identity || 'profile', covers.length)]?.id;
}

export function defaultProfileCoverFor(identity: string, preset?: string): string | undefined {
  const selected = profileCoverUrlFor(preset);
  if (selected) return selected;
  return profileCoverUrlFor(defaultProfileCoverIdFor(identity));
}
