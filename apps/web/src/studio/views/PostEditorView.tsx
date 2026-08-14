import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../api';
import { BlockEditor, type BlockEditorMediaOption } from '../../components/BlockEditor';
import type { PostBlock } from '../../domainTypes';
import { Card } from '../components/Card';
import type { StudioCreator, StudioPost } from '../types';

export function PostEditorView({
  post,
  creators,
  onSaved
}: {
  post: StudioPost;
  creators: StudioCreator[];
  onSaved?: (post: StudioPost) => void | Promise<void>;
}) {
  const [title, setTitle] = useState(post.title);
  const [summary, setSummary] = useState(post.summary || '');
  const [status, setStatus] = useState<'draft' | 'published' | 'archived'>(
    post.status === 'published' || post.status === 'archived' ? post.status : 'draft'
  );
  const [blocks, setBlocks] = useState<PostBlock[]>(post.blocks || []);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  useEffect(() => {
    setTitle(post.title);
    setSummary(post.summary || '');
    setStatus(post.status === 'published' || post.status === 'archived' ? post.status : 'draft');
    setBlocks(post.blocks || []);
  }, [post]);

  const creatorName = creators.find((creator) => creator.creatorId === post.creatorId)?.name || 'Creator';
  const mediaOptions = useMemo<BlockEditorMediaOption[]>(() => (post.media || []).map((media, index) => ({
    mediaId: media.mediaId,
    label: media.caption || `Attached image ${index + 1}`,
    assetType: 'image'
  })), [post.media]);

  const save = async () => {
    if (!title.trim()) {
      setError('A post title is required.');
      return;
    }
    setSaving(true);
    setError('');
    setSuccess('');
    try {
      const updated = await api.studioUpdatePost(post.postId, {
        title: title.trim(),
        summary: summary.trim(),
        status,
        blocks
      }) as StudioPost;
      setTitle(updated.title);
      setSummary(updated.summary || '');
      setStatus(updated.status === 'published' || updated.status === 'archived' ? updated.status : 'draft');
      setBlocks(updated.blocks || []);
      setSuccess('Post saved.');
      await onSaved?.(updated);
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : 'Unable to save this post.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="studio-post-editor-layout">
      <Card
        title="Edit post"
        eyebrow={`Posts / ${creatorName}`}
        actions={<Link className="auth-secondary-btn no-underline" to={`/studio/workspace?section=posts&creatorId=${encodeURIComponent(post.creatorId)}`}>Back to Posts</Link>}
      >
        <div className="studio-post-editor">
          {error && <p className="error">{error}</p>}
          <div className="studio-post-editor-settings">
            <label>
              <span>Post title</span>
              <input value={title} onChange={(event) => setTitle(event.target.value)} maxLength={300} />
            </label>
            <label>
              <span>Status</span>
              <select value={status} onChange={(event) => setStatus(event.target.value as 'draft' | 'published' | 'archived')}>
                <option value="draft">Draft</option>
                <option value="published">Published</option>
                <option value="archived">Archived</option>
              </select>
            </label>
            <label className="studio-post-editor-summary">
              <span>Summary</span>
              <textarea value={summary} onChange={(event) => setSummary(event.target.value)} rows={2} maxLength={2000} />
            </label>
          </div>

          <BlockEditor
            label="Post content"
            value={blocks}
            onChange={setBlocks}
            allowMedia
            mediaOptions={mediaOptions}
            helpText={mediaOptions.length
              ? 'Write in one continuous canvas and insert any image already attached to this post.'
              : 'Write in one continuous canvas. Attach media to the post to make image blocks available in the inserter.'}
          />

          <div className="studio-work-metadata-footer">
            <button type="button" className="auth-primary-btn" disabled={saving} onClick={() => void save()}>{saving ? 'Saving…' : 'Save post'}</button>
            <Link className="auth-secondary-btn no-underline" to={`/studio/workspace?section=posts&creatorId=${encodeURIComponent(post.creatorId)}`}>Cancel</Link>
          </div>
          {success && <p className="studio-work-metadata-success">{success}</p>}
        </div>
      </Card>
    </section>
  );
}

