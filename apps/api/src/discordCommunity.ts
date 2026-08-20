import { randomUUID } from 'crypto';
import type { AppConfig } from './config';
import type { AnnouncementPresetId, CommunityDelivery, CommunityDestination, CommunityEvent, CommunityInstallation } from './domain';
import type { DataStore } from './store';

export const DISCORD_INSTALL_PERMISSIONS = 1024 + 2048 + 16384; // View Channels, Send Messages, Embed Links

export const discordConfigured = (config: AppConfig): boolean => Boolean(
  config.discordClientId && config.discordClientSecret && config.discordBotToken && config.discordOAuthRedirectUri
);

const discordUrl = (config: AppConfig, pathname: string): string => `${config.discordApiBaseUrl.replace(/\/$/, '')}${pathname}`;

export class DiscordApiError extends Error {
  constructor(public readonly status: number, message: string, public readonly retryAfterSeconds?: number) {
    super(message);
  }
}

const discordFetch = async (config: AppConfig, path: string, init: RequestInit): Promise<Response> => {
  const response = await fetch(discordUrl(config, path), init);
  if (response.ok) return response;
  const body = await response.json().catch(() => ({})) as { message?: string; retry_after?: number };
  throw new DiscordApiError(response.status, body.message || `Discord request failed (${response.status})`, body.retry_after);
};

export const createDiscordAuthorizeUrl = (config: AppConfig, state: string): string => {
  if (!config.discordClientId || !config.discordOAuthRedirectUri) throw new Error('Discord is not configured');
  const url = new URL('https://discord.com/oauth2/authorize');
  url.searchParams.set('client_id', config.discordClientId);
  url.searchParams.set('redirect_uri', config.discordOAuthRedirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', 'identify guilds bot applications.commands');
  // Explicitly request a guild (server) install. This avoids a user-install
  // flow which cannot give a Creator a shared server/channel destination.
  url.searchParams.set('integration_type', '0');
  url.searchParams.set('disable_guild_select', 'false');
  url.searchParams.set('permissions', String(DISCORD_INSTALL_PERMISSIONS));
  url.searchParams.set('state', state);
  return url.toString();
};

export const exchangeDiscordCode = async (config: AppConfig, code: string) => {
  if (!config.discordClientId || !config.discordClientSecret || !config.discordOAuthRedirectUri) throw new Error('Discord is not configured');
  const body = new URLSearchParams({
    client_id: config.discordClientId,
    client_secret: config.discordClientSecret,
    grant_type: 'authorization_code',
    code,
    redirect_uri: config.discordOAuthRedirectUri
  });
  const response = await discordFetch(config, '/oauth2/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body
  });
  return response.json() as Promise<{ access_token: string; token_type: string; guild?: { id?: string; name?: string }; guild_id?: string }>;
};

export const listDiscordChannels = async (config: AppConfig, guildId: string): Promise<Array<{ id: string; name: string; type: number }>> => {
  if (!config.discordBotToken) throw new Error('Discord is not configured');
  const response = await discordFetch(config, `/guilds/${encodeURIComponent(guildId)}/channels`, {
    headers: { authorization: `Bot ${config.discordBotToken}` }
  });
  const channels = await response.json() as Array<{ id?: string; name?: string; type?: number }>;
  return channels
    .filter((channel) => typeof channel.id === 'string' && typeof channel.name === 'string' && (channel.type === 0 || channel.type === 5))
    .map((channel) => ({ id: channel.id!, name: channel.name!, type: channel.type! }));
};

export const getDiscordGuild = async (config: AppConfig, guildId: string): Promise<{ id: string; name: string; icon?: string }> => {
  if (!config.discordBotToken) throw new Error('Discord is not configured');
  const response = await discordFetch(config, `/guilds/${encodeURIComponent(guildId)}`, {
    headers: { authorization: `Bot ${config.discordBotToken}` }
  });
  const guild = await response.json() as { id?: string; name?: string; icon?: string };
  if (!guild.id || !guild.name) throw new Error('Discord returned an incomplete server record');
  return { id: guild.id, name: guild.name, icon: guild.icon };
};

export const sendDiscordMessage = async (
  config: AppConfig,
  channelId: string,
  content: string,
  embed?: { title: string; description?: string; url?: string; imageUrl?: string }
): Promise<{ id: string }> => {
  if (!config.discordBotToken) throw new Error('Discord is not configured');
  const response = await discordFetch(config, `/channels/${encodeURIComponent(channelId)}/messages`, {
    method: 'POST',
    headers: { authorization: `Bot ${config.discordBotToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      content: content.slice(0, 2000),
      ...(embed ? { embeds: [{
        title: embed.title.slice(0, 256),
        description: embed.description?.slice(0, 4096),
        url: embed.url,
        ...(embed.imageUrl ? { image: { url: embed.imageUrl } } : {})
      }] } : {}),
      allowed_mentions: { parse: [], users: [], roles: [], replied_user: false }
    })
  });
  return response.json() as Promise<{ id: string }>;
};

export const announcementPresetOptions: Array<{ id: AnnouncementPresetId; label: string; description: string; kinds: string[] }> = [
  { id: 'recommended', label: 'Recommended', description: 'A polished announcement matched to the Work type.', kinds: ['all'] },
  { id: 'image_showcase', label: 'Image showcase', description: 'Lead with the image preview and title.', kinds: ['image', 'multiple_images', 'gallery'] },
  { id: 'writing_release', label: 'Post or story', description: 'A reading-focused title and excerpt.', kinds: ['post', 'story', 'literature', 'article', 'multi_chapter_post'] },
  { id: 'video_premiere', label: 'Video premiere', description: 'A video-first announcement.', kinds: ['video', 'video_series'] },
  { id: 'audio_release', label: 'Audio release', description: 'A track, album, or audio collection announcement.', kinds: ['audio', 'album', 'audio_collection'] },
  { id: 'compact_link', label: 'Compact link', description: 'A short message and direct link.', kinds: ['all'] },
  { id: 'text_only', label: 'Text only', description: 'No rich preview or media.', kinds: ['all'] },
  { id: 'collection_digest', label: 'Collection digest', description: 'One announcement for an image gallery or collection.', kinds: ['gallery', 'multiple_images', 'collection'] },
  { id: 'series_digest', label: 'Series or album digest', description: 'One announcement for a story series, video series, or album.', kinds: ['multi_chapter_post', 'video_series', 'audio_collection', 'album'] }
];

type AnnouncementPayload = {
  title?: string;
  description?: string;
  url?: string;
  creatorName?: string;
  kind?: string;
  imageUrl?: string;
  works?: Array<{ title: string; url: string; description?: string; imageUrl?: string }>;
  preset?: AnnouncementPresetId;
  includePrimaryMedia?: boolean;
};

const renderTemplate = (template: string | undefined, event: CommunityEvent): string => {
  const work = event.payload as AnnouncementPayload;
  return (template || '**{title}** is now live: {url}')
    .replaceAll('{title}', work.title || 'A new work')
    .replaceAll('{url}', work.url || '')
    .replaceAll('{creator}', work.creatorName || 'A creator');
};

const recommendedPresetForKind = (kind?: string): AnnouncementPresetId => {
  switch (kind) {
    case 'literature':
    case 'article':
      return 'writing_release';
    case 'video':
    case 'animation':
      return 'video_premiere';
    case 'audio':
      return 'audio_release';
    case 'gallery':
    case 'image':
    case 'mixed':
      return 'image_showcase';
    default:
      return 'recommended';
  }
};

const renderDiscordAnnouncement = (destination: CommunityDestination, event: CommunityEvent): {
  content: string;
  embed?: { title: string; description?: string; url?: string; imageUrl?: string };
} => {
  const payload = event.payload as AnnouncementPayload;
  // Existing installations retain their custom template until a Creator
  // deliberately chooses one of the managed presets.
  if (destination.template && !destination.defaultAnnouncementPreset) {
    return { content: renderTemplate(destination.template, event), embed: { title: payload.title || 'New work', description: payload.description, url: payload.url } };
  }
  const requestedPreset = payload.preset || destination.defaultAnnouncementPreset || 'recommended';
  const preset = requestedPreset === 'recommended' ? recommendedPresetForKind(payload.kind) : requestedPreset;
  const creator = payload.creatorName || 'A creator';
  const items = payload.works || [];
  if (items.length) {
    const maxItems = 5;
    const lines = items.slice(0, maxItems).map((work) => `• **${work.title}** — ${work.url}`);
    if (items.length > maxItems) lines.push(`• and ${items.length - maxItems} more`);
    const digestTitle = preset === 'series_digest' ? `New series from ${creator}` : `New collection from ${creator}`;
    return {
      content: preset === 'text_only' ? `${digestTitle}\n${lines.join('\n')}` : `${digestTitle}: ${items.length} new Works`,
      ...(preset === 'text_only' ? {} : { embed: { title: digestTitle, description: lines.join('\n'), url: items[0]?.url, imageUrl: payload.includePrimaryMedia ? items[0]?.imageUrl : undefined } })
    };
  }
  const title = payload.title || 'New work';
  const typeLabel = preset === 'writing_release' ? 'New post or story' : preset === 'video_premiere' ? 'Video premiere' : preset === 'audio_release' ? 'New audio release' : 'New from';
  if (preset === 'text_only') return { content: `${typeLabel} ${creator}: **${title}**${payload.url ? `\n${payload.url}` : ''}` };
  if (preset === 'compact_link') return { content: `New from ${creator}: **${title}**${payload.url ? `\n${payload.url}` : ''}` };
  return {
    content: `${typeLabel} ${creator}: **${title}**${payload.url ? `\n${payload.url}` : ''}`,
    embed: { title, description: payload.description, url: payload.url, imageUrl: payload.includePrimaryMedia ? payload.imageUrl : undefined }
  };
};

export const queueDiscordWorkPublished = async (
  store: DataStore,
  config: AppConfig,
  input: { userId: string; creatorIdentityId: string; workId: string; title: string; description?: string; url: string; creatorName: string; kind?: string; imageUrl?: string; preset?: AnnouncementPresetId; includePrimaryMedia?: boolean; idempotencyKey: string },
  enqueue: (communityDeliveryId: string, delaySeconds?: number) => Promise<void>
): Promise<void> => {
  if (!discordConfigured(config)) return;
  const destinations = (await store.listCommunityDestinationsByCreator(input.creatorIdentityId))
    .filter((destination) => destination.provider === 'discord' && destination.status === 'active' && destination.eventTypes.includes('work_published'));
  if (!destinations.length) return;
  const existing = await store.getCommunityEventByIdempotency(config.tenantId, input.idempotencyKey);
  if (existing) return;
  const now = new Date().toISOString();
  const event: CommunityEvent = {
    communityEventId: randomUUID(), tenantId: config.tenantId, userId: input.userId, creatorIdentityId: input.creatorIdentityId,
    workId: input.workId, type: 'work_published', idempotencyKey: input.idempotencyKey,
    payload: { title: input.title, description: input.description, url: input.url, creatorName: input.creatorName, kind: input.kind, imageUrl: input.imageUrl, preset: input.preset, includePrimaryMedia: input.includePrimaryMedia }, createdAt: now
  };
  await store.createCommunityEvent(event);
  for (const destination of destinations) {
    const delivery: CommunityDelivery = {
      communityDeliveryId: randomUUID(), tenantId: config.tenantId, userId: input.userId, creatorIdentityId: input.creatorIdentityId,
      communityEventId: event.communityEventId, communityDestinationId: destination.communityDestinationId, provider: 'discord',
      status: 'queued', attemptCount: 0, createdAt: now, updatedAt: now
    };
    await store.upsertCommunityDelivery(delivery);
    await enqueue(delivery.communityDeliveryId);
  }
};

export const queueDiscordWorksPublished = async (
  store: DataStore,
  config: AppConfig,
  input: { userId: string; creatorIdentityId: string; creatorName: string; works: Array<{ workId: string; title: string; description?: string; url: string; imageUrl?: string }>; preset?: AnnouncementPresetId; includePrimaryMedia?: boolean; idempotencyKey: string },
  enqueue: (communityDeliveryId: string, delaySeconds?: number) => Promise<void>
): Promise<void> => {
  if (!discordConfigured(config) || !input.works.length) return;
  const destinations = (await store.listCommunityDestinationsByCreator(input.creatorIdentityId))
    .filter((destination) => destination.provider === 'discord' && destination.status === 'active' && (destination.eventTypes.includes('works_published') || destination.eventTypes.includes('work_published')));
  if (!destinations.length || await store.getCommunityEventByIdempotency(config.tenantId, input.idempotencyKey)) return;
  const now = new Date().toISOString();
  const event: CommunityEvent = {
    communityEventId: randomUUID(), tenantId: config.tenantId, userId: input.userId, creatorIdentityId: input.creatorIdentityId,
    type: 'works_published', idempotencyKey: input.idempotencyKey,
    payload: { creatorName: input.creatorName, works: input.works, preset: input.preset || 'collection_digest', includePrimaryMedia: input.includePrimaryMedia }, createdAt: now
  };
  await store.createCommunityEvent(event);
  for (const destination of destinations) {
    const delivery: CommunityDelivery = { communityDeliveryId: randomUUID(), tenantId: config.tenantId, userId: input.userId, creatorIdentityId: input.creatorIdentityId, communityEventId: event.communityEventId, communityDestinationId: destination.communityDestinationId, provider: 'discord', status: 'queued', attemptCount: 0, createdAt: now, updatedAt: now };
    await store.upsertCommunityDelivery(delivery);
    await enqueue(delivery.communityDeliveryId);
  }
};

export const processDiscordDelivery = async (store: DataStore, config: AppConfig, communityDeliveryId: string, enqueue: (id: string, delaySeconds?: number) => Promise<void>): Promise<void> => {
  const delivery = await store.getCommunityDelivery(communityDeliveryId);
  if (!delivery || ['sent', 'cancelled'].includes(delivery.status)) return;
  // SQS can delay a message for at most 15 minutes. Persisted schedules may
  // be longer, so honour the remaining backoff every time the message runs.
  if (delivery.nextAttemptAt) {
    const remainingSeconds = Math.ceil((Date.parse(delivery.nextAttemptAt) - Date.now()) / 1000);
    if (remainingSeconds > 0) {
      await enqueue(delivery.communityDeliveryId, Math.min(900, remainingSeconds));
      return;
    }
  }
  const destination = await store.getCommunityDestination(delivery.communityDestinationId);
  if (!destination || destination.status !== 'active') return;
  const event = await store.getCommunityEvent(delivery.communityEventId);
  if (!event) return;
  const now = new Date().toISOString();
  try {
    await store.upsertCommunityDelivery({ ...delivery, status: 'sending', updatedAt: now, errorCode: undefined, errorMessage: undefined });
    const announcement = renderDiscordAnnouncement(destination, event);
    const sent = await sendDiscordMessage(config, destination.remoteChannelId, announcement.content, announcement.embed);
    await store.upsertCommunityDelivery({ ...delivery, status: 'sent', attemptCount: delivery.attemptCount + 1, remoteMessageId: sent.id, sentAt: now, updatedAt: now, nextAttemptAt: undefined, errorCode: undefined, errorMessage: undefined });
  } catch (error) {
    const apiError = error instanceof DiscordApiError ? error : undefined;
    const attempts = delivery.attemptCount + 1;
    const retrySeconds = apiError?.retryAfterSeconds ?? Math.min(60 * 60, 30 * (2 ** Math.min(attempts, 6)));
    const retryable = !apiError || apiError.status === 429 || apiError.status >= 500;
    const failed: CommunityDelivery = {
      ...delivery, status: retryable && attempts < 6 ? 'retry_scheduled' : 'failed', attemptCount: attempts,
      nextAttemptAt: retryable && attempts < 6 ? new Date(Date.now() + retrySeconds * 1000).toISOString() : undefined,
      errorCode: apiError ? `discord_${apiError.status}` : 'discord_delivery_error', errorMessage: error instanceof Error ? error.message : String(error), updatedAt: new Date().toISOString()
    };
    await store.upsertCommunityDelivery(failed);
    // Missing-channel and permission responses generally mean the bot was
    // removed or lost access. Keep the destination record for diagnosis, but
    // stop automatic attempts until the Creator deliberately resumes it.
    if (apiError && (apiError.status === 403 || apiError.status === 404)) {
      await store.upsertCommunityDestination({
        ...destination,
        status: 'needs_attention',
        updatedAt: new Date().toISOString()
      });
    }
    if (failed.status === 'retry_scheduled') await enqueue(delivery.communityDeliveryId, retrySeconds);
  }
};
