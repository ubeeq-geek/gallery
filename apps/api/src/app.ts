import express from 'express';
import cors from 'cors';
import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { randomUUID } from 'crypto';
import { createOptionalAuthMiddleware, requireAdmin, requireArtistOrAdmin, requireAuth, resolveRole } from './auth';
import { checkRateLimit } from './rateLimit';
import { issueUnlockToken, verifyPassword, verifyUnlockToken } from './unlock';
import type { AppConfig } from './config';
import type { DataStore } from './store';
import { hashPassword } from './unlock';
import type { Artist, Gallery, Image } from './domain';

interface CreateAppOptions {
  config: AppConfig;
  store: DataStore;
}

export const createApp = ({ config, store }: CreateAppOptions) => {
  const app = express();
  const s3Client = new S3Client({ region: config.awsRegion });

  app.use(cors());
  app.use(express.json());
  app.use(createOptionalAuthMiddleware(config));

  app.get('/health', (_req, res) => res.json({ ok: true }));

  app.get('/artists', async (_req, res) => {
    const artists = await store.listArtists();
    res.json(artists.filter((artist) => artist.status === 'active'));
  });

  app.get('/artists/:slug/galleries', async (req, res) => {
    const galleries = await store.listGalleriesByArtistSlug(req.params.slug);
    res.json(galleries.filter((gallery) => gallery.status === 'published').map((gallery) => ({ ...gallery, premiumPasswordHash: undefined })));
  });

  app.get('/galleries/:slug', async (req, res) => {
    const gallery = await store.getGalleryBySlug(req.params.slug);
    if (!gallery || gallery.status !== 'published') {
      return res.status(404).json({ message: 'Gallery not found' });
    }

    const images = await store.getImagesByGallery(gallery.galleryId);
    const mediaPayload = await Promise.all(images.map(async (image) => ({
      ...image,
      assetType: image.assetType || 'image',
      premiumKey: undefined,
      previewUrl: await getSignedUrl(
        s3Client,
        new GetObjectCommand({ Bucket: config.mediaBucket, Key: image.previewKey }),
        { expiresIn: config.signedUrlTtlSeconds }
      ),
      previewPosterUrl: image.previewPosterKey
        ? await getSignedUrl(
            s3Client,
            new GetObjectCommand({ Bucket: config.mediaBucket, Key: image.previewPosterKey }),
            { expiresIn: config.signedUrlTtlSeconds }
          )
        : undefined,
      favoriteCount: await store.countFavorites('image', image.imageId)
    })));

    return res.json({
      ...gallery,
      premiumPasswordHash: undefined,
      favoriteCount: await store.countFavorites('gallery', gallery.galleryId),
      media: mediaPayload,
      images: mediaPayload.filter((asset) => asset.assetType === 'image'),
      videos: mediaPayload.filter((asset) => asset.assetType === 'video')
    });
  });

  app.post('/galleries/:slug/unlock', async (req, res) => {
    const gallery = await store.getGalleryBySlug(req.params.slug);
    if (!gallery || gallery.status !== 'published') {
      return res.status(404).json({ message: 'Gallery not found' });
    }
    if (gallery.visibility !== 'premium') {
      return res.status(400).json({ message: 'Gallery is not premium' });
    }

    const ip = req.ip || 'unknown';
    if (!checkRateLimit(`unlock:${gallery.galleryId}:${ip}`, 60_000, 10)) {
      return res.status(429).json({ message: 'Too many unlock attempts, try again later' });
    }

    const password = String(req.body?.password || '');
    if (!gallery.premiumPasswordHash || !(await verifyPassword(password, gallery.premiumPasswordHash))) {
      return res.status(401).json({ message: 'Invalid password' });
    }

    const token = issueUnlockToken({ galleryId: gallery.galleryId, userId: req.authUser?.userId }, config.unlockJwtSecret, config.unlockTokenTtlSeconds);
    return res.json({ unlockToken: token, expiresInSeconds: config.unlockTokenTtlSeconds });
  });

  app.get('/galleries/:slug/premium-images', async (req, res) => {
    const gallery = await store.getGalleryBySlug(req.params.slug);
    if (!gallery || gallery.status !== 'published') {
      return res.status(404).json({ message: 'Gallery not found' });
    }

    const unlockToken = req.headers['x-unlock-token'];
    if (typeof unlockToken !== 'string') {
      return res.status(401).json({ message: 'Unlock token required' });
    }

    try {
      const payload = verifyUnlockToken(unlockToken, config.unlockJwtSecret);
      if (payload.galleryId !== gallery.galleryId) {
        return res.status(403).json({ message: 'Invalid unlock token scope' });
      }
    } catch {
      return res.status(401).json({ message: 'Invalid unlock token' });
    }

    const images = await store.getImagesByGallery(gallery.galleryId);
    const premiumMedia = await Promise.all(images
      .filter((image) => Boolean(image.premiumKey))
      .map(async (image) => ({
        imageId: image.imageId,
        assetType: image.assetType || 'image',
        premiumUrl: await getSignedUrl(
          s3Client,
          new GetObjectCommand({ Bucket: config.mediaBucket, Key: image.premiumKey! }),
          { expiresIn: config.signedUrlTtlSeconds }
        ),
        premiumPosterUrl: image.premiumPosterKey
          ? await getSignedUrl(
              s3Client,
              new GetObjectCommand({ Bucket: config.mediaBucket, Key: image.premiumPosterKey }),
              { expiresIn: config.signedUrlTtlSeconds }
            )
          : undefined
      })));

    return res.json(premiumMedia);
  });

  app.get('/galleries/:slug/comments', async (req, res) => {
    const gallery = await store.getGalleryBySlug(req.params.slug);
    if (!gallery) {
      return res.status(404).json({ message: 'Gallery not found' });
    }
    const comments = await store.listComments('gallery', gallery.galleryId);
    return res.json(comments);
  });

  app.post('/galleries/:slug/comments', requireAuth, async (req, res) => {
    const gallery = await store.getGalleryBySlug(req.params.slug);
    if (!gallery) {
      return res.status(404).json({ message: 'Gallery not found' });
    }
    if (await store.isUserBlocked(req.authUser!.userId)) {
      return res.status(403).json({ message: 'User blocked' });
    }

    const ip = req.ip || 'unknown';
    if (!checkRateLimit(`comment:${ip}`, 60_000, 20)) {
      return res.status(429).json({ message: 'Too many comments, try again later' });
    }

    const body = String(req.body?.body || '').trim();
    if (!body) {
      return res.status(400).json({ message: 'Comment body is required' });
    }

    const comment = {
      commentId: randomUUID(),
      userId: req.authUser!.userId,
      displayName: req.authUser!.displayName,
      targetType: 'gallery' as const,
      targetId: gallery.galleryId,
      body,
      hidden: false,
      createdAt: new Date().toISOString()
    };

    await store.createComment(comment);
    return res.status(201).json(comment);
  });

  app.get('/images/:imageId/comments', async (req, res) => {
    const comments = await store.listComments('image', req.params.imageId);
    return res.json(comments);
  });

  app.post('/images/:imageId/comments', requireAuth, async (req, res) => {
    if (await store.isUserBlocked(req.authUser!.userId)) {
      return res.status(403).json({ message: 'User blocked' });
    }

    const body = String(req.body?.body || '').trim();
    if (!body) {
      return res.status(400).json({ message: 'Comment body is required' });
    }

    const comment = {
      commentId: randomUUID(),
      userId: req.authUser!.userId,
      displayName: req.authUser!.displayName,
      targetType: 'image' as const,
      targetId: req.params.imageId,
      body,
      hidden: false,
      createdAt: new Date().toISOString()
    };

    await store.createComment(comment);
    return res.status(201).json(comment);
  });

  app.get('/me/favorites', requireAuth, async (req, res) => {
    const favorites = await store.listFavoritesByUser(req.authUser!.userId);
    return res.json(favorites);
  });

  app.get('/me', requireAuth, async (req, res) => {
    return res.json({
      userId: req.authUser!.userId,
      displayName: req.authUser!.displayName,
      role: resolveRole(req.authUser!),
      groups: req.authUser!.groups
    });
  });

  app.post('/favorites', requireAuth, async (req, res) => {
    const targetType = req.body?.targetType;
    const targetId = req.body?.targetId;
    if ((targetType !== 'gallery' && targetType !== 'image') || !targetId) {
      return res.status(400).json({ message: 'targetType and targetId are required' });
    }

    const favorite = {
      userId: req.authUser!.userId,
      targetType,
      targetId,
      createdAt: new Date().toISOString()
    };
    await store.addFavorite(favorite);
    return res.status(201).json(favorite);
  });

  app.delete('/favorites', requireAuth, async (req, res) => {
    const targetType = req.body?.targetType;
    const targetId = req.body?.targetId;
    if ((targetType !== 'gallery' && targetType !== 'image') || !targetId) {
      return res.status(400).json({ message: 'targetType and targetId are required' });
    }

    await store.removeFavorite(req.authUser!.userId, targetType, targetId);
    return res.status(204).send();
  });

  app.get('/admin/artists', requireAdmin, async (_req, res) => {
    const artists = await store.listArtists();
    return res.json(artists);
  });

  app.post('/admin/artists', requireAdmin, async (req, res) => {
    const artist: Artist = {
      artistId: randomUUID(),
      name: String(req.body?.name || ''),
      slug: String(req.body?.slug || ''),
      status: req.body?.status === 'inactive' ? 'inactive' : 'active',
      sortOrder: Number(req.body?.sortOrder || 0),
      createdAt: new Date().toISOString()
    };
    await store.createArtist(artist);
    return res.status(201).json(artist);
  });

  app.patch('/admin/artists/:artistId', requireAdmin, async (req, res) => {
    const existing = (await store.listArtists()).find((artist) => artist.artistId === req.params.artistId);
    if (!existing) {
      return res.status(404).json({ message: 'Artist not found' });
    }

    const updated: Artist = {
      ...existing,
      name: req.body?.name ? String(req.body.name) : existing.name,
      slug: req.body?.slug ? String(req.body.slug) : existing.slug,
      status: req.body?.status === 'inactive' ? 'inactive' : (req.body?.status === 'active' ? 'active' : existing.status),
      sortOrder: req.body?.sortOrder !== undefined ? Number(req.body.sortOrder) : existing.sortOrder
    };

    await store.updateArtist(updated);
    return res.json(updated);
  });

  app.delete('/admin/artists/:artistId', requireAdmin, async (req, res) => {
    await store.deleteArtist(req.params.artistId);
    return res.status(204).send();
  });

  app.get('/admin/galleries', requireArtistOrAdmin, async (_req, res) => {
    const galleries = await store.listAllGalleries();
    return res.json(galleries.map((gallery) => ({ ...gallery, premiumPasswordHash: undefined })));
  });

  app.post('/admin/galleries', requireArtistOrAdmin, async (req, res) => {
    const visibility: Gallery['visibility'] = req.body?.visibility === 'premium' ? 'premium' : 'free';
    const passwordHash = visibility === 'premium' && req.body?.premiumPassword
      ? await hashPassword(String(req.body.premiumPassword))
      : undefined;

    const gallery: Gallery = {
      galleryId: randomUUID(),
      artistId: String(req.body?.artistId || ''),
      artistSlug: String(req.body?.artistSlug || ''),
      title: String(req.body?.title || ''),
      slug: String(req.body?.slug || ''),
      visibility,
      status: req.body?.status === 'published' ? 'published' : 'draft',
      premiumPasswordHash: passwordHash,
      createdAt: new Date().toISOString()
    };

    await store.createGallery(gallery);
    return res.status(201).json({ ...gallery, premiumPasswordHash: undefined });
  });

  app.patch('/admin/galleries/:galleryId', requireAdmin, async (req, res) => {
    const galleries = await store.listAllGalleries();
    const existing = galleries.find((gallery) => gallery.galleryId === req.params.galleryId);
    if (!existing) {
      return res.status(404).json({ message: 'Gallery not found' });
    }

    const visibility: Gallery['visibility'] = req.body?.visibility === 'premium'
      ? 'premium'
      : (req.body?.visibility === 'free' ? 'free' : existing.visibility);

    const updated: Gallery = {
      ...existing,
      artistId: req.body?.artistId ? String(req.body.artistId) : existing.artistId,
      artistSlug: req.body?.artistSlug ? String(req.body.artistSlug) : existing.artistSlug,
      title: req.body?.title ? String(req.body.title) : existing.title,
      slug: req.body?.slug ? String(req.body.slug) : existing.slug,
      visibility,
      status: req.body?.status === 'published' ? 'published' : (req.body?.status === 'draft' ? 'draft' : existing.status)
    };

    if (req.body?.premiumPassword && visibility === 'premium') {
      updated.premiumPasswordHash = await hashPassword(String(req.body.premiumPassword));
    } else if (visibility === 'free') {
      updated.premiumPasswordHash = undefined;
    }

    await store.updateGallery(updated);
    return res.json({ ...updated, premiumPasswordHash: undefined });
  });

  app.delete('/admin/galleries/:galleryId', requireAdmin, async (req, res) => {
    await store.deleteGallery(req.params.galleryId);
    return res.status(204).send();
  });

  app.get('/admin/galleries/:galleryId/images', requireArtistOrAdmin, async (req, res) => {
    const images = await store.getImagesByGallery(req.params.galleryId);
    return res.json(images);
  });

  app.post('/admin/images', requireArtistOrAdmin, async (req, res) => {
    const image: Image = {
      imageId: randomUUID(),
      galleryId: String(req.body?.galleryId || ''),
      assetType: req.body?.assetType === 'video' ? 'video' : 'image',
      previewKey: String(req.body?.previewKey || ''),
      premiumKey: req.body?.premiumKey ? String(req.body?.premiumKey) : undefined,
      previewPosterKey: req.body?.previewPosterKey ? String(req.body?.previewPosterKey) : undefined,
      premiumPosterKey: req.body?.premiumPosterKey ? String(req.body?.premiumPosterKey) : undefined,
      width: Number(req.body?.width || 0),
      height: Number(req.body?.height || 0),
      durationSeconds: req.body?.durationSeconds ? Number(req.body.durationSeconds) : undefined,
      sortOrder: Number(req.body?.sortOrder || 0),
      altText: req.body?.altText ? String(req.body.altText) : undefined,
      createdAt: new Date().toISOString()
    };

    await store.createImage(image);
    return res.status(201).json(image);
  });

  app.patch('/admin/images/:galleryId/:imageId', requireAdmin, async (req, res) => {
    const images = await store.getImagesByGallery(req.params.galleryId);
    const existing = images.find((image) => image.imageId === req.params.imageId);
    if (!existing) {
      return res.status(404).json({ message: 'Image not found' });
    }

    const updated: Image = {
      ...existing,
      galleryId: req.params.galleryId,
      imageId: req.params.imageId,
      assetType: req.body?.assetType === 'video' ? 'video' : (req.body?.assetType === 'image' ? 'image' : existing.assetType),
      previewKey: req.body?.previewKey ? String(req.body.previewKey) : existing.previewKey,
      premiumKey: req.body?.premiumKey !== undefined ? (req.body.premiumKey ? String(req.body.premiumKey) : undefined) : existing.premiumKey,
      previewPosterKey: req.body?.previewPosterKey !== undefined ? (req.body.previewPosterKey ? String(req.body.previewPosterKey) : undefined) : existing.previewPosterKey,
      premiumPosterKey: req.body?.premiumPosterKey !== undefined ? (req.body.premiumPosterKey ? String(req.body.premiumPosterKey) : undefined) : existing.premiumPosterKey,
      width: req.body?.width !== undefined ? Number(req.body.width) : existing.width,
      height: req.body?.height !== undefined ? Number(req.body.height) : existing.height,
      durationSeconds: req.body?.durationSeconds !== undefined ? (req.body.durationSeconds ? Number(req.body.durationSeconds) : undefined) : existing.durationSeconds,
      sortOrder: req.body?.sortOrder !== undefined ? Number(req.body.sortOrder) : existing.sortOrder,
      altText: req.body?.altText !== undefined ? (req.body.altText ? String(req.body.altText) : undefined) : existing.altText
    };

    await store.updateImage(updated, existing.sortOrder);
    return res.json(updated);
  });

  app.delete('/admin/images/:galleryId/:imageId', requireAdmin, async (req, res) => {
    const sortOrder = req.query.sortOrder ? Number(req.query.sortOrder) : undefined;
    await store.deleteImage(req.params.galleryId, req.params.imageId, sortOrder);
    return res.status(204).send();
  });

  app.patch('/admin/comments/:commentId', requireAdmin, async (req, res) => {
    await store.updateCommentVisibility(req.params.commentId, Boolean(req.body?.hidden));
    return res.status(204).send();
  });

  app.delete('/admin/comments/:commentId', requireAdmin, async (req, res) => {
    await store.deleteComment(req.params.commentId);
    return res.status(204).send();
  });

  app.post('/admin/users/:userId/block', requireAdmin, async (req, res) => {
    await store.blockUser({ userId: req.params.userId, reason: req.body?.reason, blockedAt: new Date().toISOString() });
    return res.status(201).json({ userId: req.params.userId, blocked: true });
  });

  app.delete('/admin/users/:userId/block', requireAdmin, async (req, res) => {
    await store.unblockUser(req.params.userId);
    return res.status(204).send();
  });

  return app;
};
