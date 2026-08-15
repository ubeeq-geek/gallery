import fs from 'node:fs/promises';
import path from 'node:path';

const [exportPath, apiBase = 'https://fanadmin.top:4000', mediaDirectory = '/tmp/eversally-media'] = process.argv.slice(2);

if (!exportPath) {
  throw new Error('Usage: node scripts/restore-local-creator-export.mjs <export.json> [api-base] [media-directory]');
}

const manifest = JSON.parse(await fs.readFile(exportPath, 'utf8'));
const authHeaders = { 'x-user-id': 'local-user', 'x-user-role': 'creator' };

const requestJson = async (url, init = {}) => {
  const response = await fetch(url, init);
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`${response.status} ${payload.message || response.statusText}`);
  return payload;
};

const existingResponse = await requestJson(`${apiBase}/studio/works?creatorId=${encodeURIComponent(manifest.creator.creatorId)}`, {
  headers: authHeaders
});
const existingSlugs = new Set((existingResponse.items || []).map((item) => item.slug));
let restored = 0;
let skipped = 0;

for (const record of manifest.works || []) {
  const work = record.work;
  const primary = (record.assets || []).find((asset) => asset.assetId === work.primaryAssetId) || record.assets?.[0];
  if (!primary?.storage?.objectKey) {
    console.warn(`Skipping ${work.title}: no hosted source asset in export.`);
    skipped += 1;
    continue;
  }
  if (existingSlugs.has(work.slug)) {
    console.warn(`Skipping ${work.title}: slug already exists.`);
    skipped += 1;
    continue;
  }

  const created = await requestJson(`${apiBase}/studio/works`, {
    method: 'POST',
    headers: { ...authHeaders, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      creatorId: work.creatorId,
      originalFilename: primary.originalFilename,
      title: work.title,
      slug: work.slug,
      description: work.description,
      tags: work.tags,
      contentRating: work.contentRating,
      aiDisclosure: work.aiDisclosure,
      heavyTopics: work.heavyTopics,
      kind: work.kind
    })
  });
  const sourcePath = path.resolve(mediaDirectory, primary.storage.objectKey);
  const mediaRoot = `${path.resolve(mediaDirectory)}${path.sep}`;
  if (!sourcePath.startsWith(mediaRoot)) throw new Error(`Unsafe exported object key: ${primary.storage.objectKey}`);
  const body = await fs.readFile(sourcePath);
  await requestJson(
    `${apiBase}/studio/works/${encodeURIComponent(created.work.workId)}/image?originalFilename=${encodeURIComponent(primary.originalFilename || path.basename(sourcePath))}`,
    {
      method: 'PUT',
      headers: { ...authHeaders, 'Content-Type': primary.mimeType || 'image/jpeg' },
      body
    }
  );
  existingSlugs.add(work.slug);
  restored += 1;
  console.log(`Restored ${restored}: ${work.title}`);
}

console.log(`Local restore complete: ${restored} restored, ${skipped} skipped.`);
