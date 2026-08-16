import { useState } from 'react';

export type ProfileExternalLink = { label: string; url: string };
export type ProfileExternalLinkValidationIssue = { index: number; message: string };

const linkPresetGroups = [
  {
    label: 'Social',
    links: ['Instagram', 'TikTok', 'Bluesky', 'X / Twitter', 'Threads', 'Mastodon', 'Facebook', 'Tumblr', 'Pinterest', 'LinkedIn', 'Reddit']
  },
  {
    label: 'Video & live',
    links: ['YouTube', 'Vimeo', 'Twitch']
  },
  {
    label: 'Art & portfolio',
    links: ['DeviantArt', 'Cara', 'Behance', 'ArtStation', 'Dribbble', 'Flickr', '500px']
  },
  {
    label: 'Audio',
    links: ['SoundCloud', 'Bandcamp', 'Spotify', 'Apple Music']
  },
  {
    label: 'Membership',
    links: ['FanVue', 'Patreon', 'Ko-fi', 'Buy Me a Coffee']
  },
  {
    label: 'Shop & publishing',
    links: ['Etsy', 'Gumroad', 'Substack']
  },
  {
    label: 'Development',
    links: ['GitHub']
  }
];

const linkExamples: Record<string, string> = {
  Instagram: 'https://instagram.com/your-name',
  TikTok: 'https://tiktok.com/@your-name',
  Bluesky: 'https://bsky.app/profile/your-handle.bsky.social',
  'X / Twitter': 'https://x.com/your-name',
  Threads: 'https://threads.net/@your-name',
  Mastodon: 'https://mastodon.social/@your-name',
  Facebook: 'https://facebook.com/your-page',
  Tumblr: 'https://your-name.tumblr.com',
  Pinterest: 'https://pinterest.com/your-name',
  LinkedIn: 'https://linkedin.com/in/your-name',
  Reddit: 'https://reddit.com/user/your-name',
  YouTube: 'https://youtube.com/@your-channel',
  Vimeo: 'https://vimeo.com/your-name',
  Twitch: 'https://twitch.tv/your-name',
  DeviantArt: 'https://deviantart.com/your-name',
  Cara: 'https://cara.app/your-name',
  Behance: 'https://behance.net/your-name',
  ArtStation: 'https://artstation.com/your-name',
  Dribbble: 'https://dribbble.com/your-name',
  Flickr: 'https://flickr.com/people/your-name',
  '500px': 'https://500px.com/p/your-name',
  SoundCloud: 'https://soundcloud.com/your-name',
  Bandcamp: 'https://your-name.bandcamp.com',
  Spotify: 'https://open.spotify.com/artist/your-id',
  'Apple Music': 'https://music.apple.com/artist/your-name/your-id',
  FanVue: 'https://fanvue.com/your-name',
  Patreon: 'https://patreon.com/your-name',
  'Ko-fi': 'https://ko-fi.com/your-name',
  'Buy Me a Coffee': 'https://buymeacoffee.com/your-name',
  Etsy: 'https://etsy.com/shop/your-shop',
  Gumroad: 'https://your-name.gumroad.com',
  Substack: 'https://your-name.substack.com',
  GitHub: 'https://github.com/your-name'
};

const supportedDomains: Record<string, string[]> = {
  Instagram: ['instagram.com', 'instagr.am'], TikTok: ['tiktok.com', 'vm.tiktok.com', 'vt.tiktok.com'], Bluesky: ['bsky.app', 'bsky.social'],
  'X / Twitter': ['x.com', 'twitter.com', 't.co'], Threads: ['threads.net'], Mastodon: ['mastodon.social', 'mastodon.online', 'mastodon.world', 'mastodon.art', 'mastodon.cloud'],
  Facebook: ['facebook.com', 'fb.me'], Tumblr: ['tumblr.com'], Pinterest: ['pinterest.com', 'pin.it'], LinkedIn: ['linkedin.com', 'lnkd.in'], Reddit: ['reddit.com', 'redd.it'],
  YouTube: ['youtube.com', 'youtu.be'], Vimeo: ['vimeo.com'], Twitch: ['twitch.tv'], DeviantArt: ['deviantart.com'], Cara: ['cara.app'], Behance: ['behance.net'],
  ArtStation: ['artstation.com'], Dribbble: ['dribbble.com'], Flickr: ['flickr.com', 'flic.kr'], '500px': ['500px.com'], SoundCloud: ['soundcloud.com', 'on.soundcloud.com'],
  Bandcamp: ['bandcamp.com'], Spotify: ['spotify.com', 'spotify.link'], 'Apple Music': ['music.apple.com', 'apple.co'], FanVue: ['fanvue.com'], Patreon: ['patreon.com'],
  'Ko-fi': ['ko-fi.com'], 'Buy Me a Coffee': ['buymeacoffee.com', 'bmc.link'], Etsy: ['etsy.com', 'etsy.me'], Gumroad: ['gumroad.com'],
  Substack: ['substack.com'], GitHub: ['github.com', 'github.io']
};

const knownLabel = (label: string) => Object.keys(supportedDomains).find((candidate) => candidate.toLowerCase() === label.trim().toLowerCase());

export function validateProfileExternalLinks(value: ProfileExternalLink[], allowCustom = true): ProfileExternalLinkValidationIssue[] {
  return value.flatMap((link, index) => {
    const label = link.label.trim();
    const url = link.url.trim();
    if (!label) return [{ index, message: `External link ${index + 1} needs a platform or label.` }];
    if (!url) return [{ index, message: `${label} needs a URL.` }];
    let parsed: URL;
    try { parsed = new URL(url); } catch { return [{ index, message: `${label} needs a valid http:// or https:// URL.` }]; }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return [{ index, message: `${label} needs a valid http:// or https:// URL.` }];
    const platform = knownLabel(label);
    if (!platform && !allowCustom) return [{ index, message: `${label} is not a supported member-profile platform.` }];
    const domains = platform ? supportedDomains[platform] : undefined;
    if (domains && !domains.some((domain) => parsed.hostname === domain || parsed.hostname.endsWith(`.${domain}`))) {
      return [{ index, message: `${label} links must use ${domains.map((domain) => `“${domain}”`).join(' or ')}.` }];
    }
    return [];
  });
}

export function ProfileExternalLinksEditor({
  value,
  onChange,
  maxLinks = 12,
  allowCustom = true,
  invalidIndexes = []
}: {
  value: ProfileExternalLink[];
  onChange: (value: ProfileExternalLink[]) => void;
  maxLinks?: number;
  allowCustom?: boolean;
  invalidIndexes?: number[];
}) {
  const [presetQuery, setPresetQuery] = useState('');
  const [presetCategory, setPresetCategory] = useState('all');
  const normalizedPresetQuery = presetQuery.trim().toLowerCase();
  const filteredPresetGroups = linkPresetGroups.flatMap((group) => {
    if (presetCategory !== 'all' && presetCategory !== group.label) return [];
    const links = !normalizedPresetQuery || group.label.toLowerCase().includes(normalizedPresetQuery)
      ? group.links
      : group.links.filter((label) => label.toLowerCase().includes(normalizedPresetQuery));
    return links.length ? [{ ...group, links }] : [];
  });
  const update = (index: number, patch: Partial<ProfileExternalLink>) => {
    onChange(value.map((link, linkIndex) => linkIndex === index ? { ...link, ...patch } : link));
  };
  const add = (label = '') => {
    if (value.length >= maxLinks) return;
    onChange([...value, { label, url: '' }]);
  };
  const remove = (index: number) => onChange(value.filter((_, linkIndex) => linkIndex !== index));

  return (
    <div className="profile-external-links-editor">
      <div className="profile-external-link-rows">
        {value.map((link, index) => (
          <div className="profile-external-link-row" key={`external-link-${index}`}>
            <input
              aria-label={`External link ${index + 1} label`}
              value={link.label}
              onChange={allowCustom ? (event) => update(index, { label: event.target.value }) : undefined}
              placeholder="Label"
              maxLength={80}
              readOnly={!allowCustom}
              aria-invalid={invalidIndexes.includes(index) || undefined}
            />
            <input
              aria-label={`External link ${index + 1} URL`}
              type="url"
              value={link.url}
              onChange={(event) => update(index, { url: event.target.value })}
              placeholder={linkExamples[link.label] || (allowCustom ? 'https://example.com/profile' : 'Choose a supported platform below')}
              maxLength={1000}
              aria-invalid={invalidIndexes.includes(index) || undefined}
            />
            <button type="button" className="profile-external-link-remove" onClick={() => remove(index)} aria-label={`Remove ${link.label || `link ${index + 1}`}`}>×</button>
          </div>
        ))}
        {value.length === 0 && <p className="small m-0">No external links added yet.</p>}
      </div>
      <div className="profile-external-link-add">
        <span>{allowCustom ? 'Add a link' : 'Add a platform'}</span>
        <div className="profile-external-link-filters">
          <input
            type="search"
            aria-label="Filter external link platforms"
            value={presetQuery}
            onChange={(event) => setPresetQuery(event.target.value)}
            placeholder="Filter platforms…"
          />
          <select
            aria-label="Filter external link platform category"
            value={presetCategory}
            onChange={(event) => setPresetCategory(event.target.value)}
          >
            <option value="all">All categories</option>
            {linkPresetGroups.map((group) => <option value={group.label} key={group.label}>{group.label}</option>)}
          </select>
        </div>
        <div className="profile-external-link-preset-groups">
          {filteredPresetGroups.map((group) => (
            <div className="profile-external-link-preset-group" key={group.label}>
              <span>{group.label}</span>
              <div className="profile-external-link-preset-buttons">
                {group.links.map((label) => <button type="button" key={label} disabled={value.length >= maxLinks} onClick={() => add(label)}>{label}</button>)}
              </div>
            </div>
          ))}
          {filteredPresetGroups.length === 0 && <p className="small m-0">No platforms match this filter.</p>}
          {allowCustom && <button type="button" className="is-custom" disabled={value.length >= maxLinks} onClick={() => add('')}>+ Custom URL</button>}
        </div>
        <small>{value.length} of {maxLinks} links</small>
      </div>
    </div>
  );
}
