import { hashPassword, issueUnlockToken, verifyPassword, verifyUnlockToken } from '../src/unlock';
import { InMemoryStore } from '../src/inMemoryStore';

describe('unlock token and password', () => {
  it('hashes and verifies passwords', async () => {
    const hash = await hashPassword('secret123');
    await expect(verifyPassword('secret123', hash)).resolves.toBe(true);
    await expect(verifyPassword('wrong', hash)).resolves.toBe(false);
  });

  it('issues and verifies unlock token', () => {
    const token = issueUnlockToken({ galleryId: 'g1', userId: 'u1' }, 'secret', 60);
    const payload = verifyUnlockToken(token, 'secret');
    expect(payload.galleryId).toBe('g1');
    expect(payload.userId).toBe('u1');
  });
});

describe('in-memory store behaviors', () => {
  it('blocks users and prevents double favorites', async () => {
    const store = new InMemoryStore();

    await store.blockUser({ userId: 'u1', blockedAt: new Date().toISOString() });
    await expect(store.isUserBlocked('u1')).resolves.toBe(true);

    await store.addFavorite({ userId: 'u1', targetType: 'gallery', targetId: 'g1', createdAt: new Date().toISOString() });
    await store.addFavorite({ userId: 'u1', targetType: 'gallery', targetId: 'g1', createdAt: new Date().toISOString() });

    const favorites = await store.listFavoritesByUser('u1');
    expect(favorites.length).toBe(1);
  });

  it('filters hidden comments', async () => {
    const store = new InMemoryStore();

    await store.createComment({
      commentId: 'c1',
      userId: 'u1',
      displayName: 'User',
      targetType: 'gallery',
      targetId: 'g1',
      body: 'visible',
      hidden: false,
      createdAt: new Date().toISOString()
    });

    await store.createComment({
      commentId: 'c2',
      userId: 'u2',
      displayName: 'User2',
      targetType: 'gallery',
      targetId: 'g1',
      body: 'hidden',
      hidden: true,
      createdAt: new Date().toISOString()
    });

    const comments = await store.listComments('gallery', 'g1');
    expect(comments).toHaveLength(1);
    expect(comments[0].commentId).toBe('c1');
  });
});
