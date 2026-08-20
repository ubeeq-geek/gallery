import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { api } from '../../api';
import { brand } from '../../brand';
import { createDescriptionBlock, serializeDescriptionBlocks } from '../../blockContent';
import { BlockEditor } from '../../components/BlockEditor';
import type { PostBlock } from '../../domainTypes';
import { Card } from '../components/Card';
import { worksWorkspacePath } from '../workListNavigation';
import type { StudioCreator } from '../types';

const titleFromFilename = (filename: string): string => {
  const tokens = filename.replace(/\.[^.]+$/, '').split(/[-_\s]+/).filter(Boolean);
  let version = '';
  let number = '';
  if (/^v\d+$/i.test(tokens[tokens.length - 1] || '')) version = `, v${tokens.pop()!.slice(1)}`;
  if (/^\d+$/.test(tokens[tokens.length - 1] || '')) number = ` #${tokens.pop()!}`;
  const name = tokens.flatMap((token) => token.replace(/([a-z])([A-Z])/g, '$1 $2').split(' ')).filter(Boolean)
    .map((token) => /^\d+$/.test(token) ? token : `${token.slice(0, 1).toUpperCase()}${token.slice(1).toLowerCase()}`).join(' ');
  return `${name || 'Untitled work'}${number}${version}`;
};

export function WorkUploadView({ creators }: { creators: StudioCreator[] }) {
  const location = useLocation();
  const navigate = useNavigate();
  const requestedCreatorId = new URLSearchParams(location.search).get('creatorId') || '';
  const requestedKind = new URLSearchParams(location.search).get('kind');
  const isWriting = requestedKind === 'writing' || requestedKind === 'literature' || requestedKind === 'article';
  const [writingKind, setWritingKind] = useState<'article' | 'literature'>(requestedKind === 'literature' ? 'literature' : 'article');
  const [creatorId, setCreatorId] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState('');
  const [progress, setProgress] = useState('');
  const [title, setTitle] = useState('');
  const [body, setBody] = useState<PostBlock[]>(() => [createDescriptionBlock()]);
  const [dragActive, setDragActive] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const activeCreator = useMemo(() => creators.find((creator) => creator.creatorId === creatorId), [creatorId, creators]);

  useEffect(() => {
    if (creatorId || !creators.length) return;
    setCreatorId(creators.some((creator) => creator.creatorId === requestedCreatorId) ? requestedCreatorId : creators[0].creatorId);
  }, [creatorId, creators, requestedCreatorId]);

  const submit = async () => {
    if (isWriting) {
      if (!creatorId || !title.trim() || !serializeDescriptionBlocks(body).replace(/<[^>]+>/g, '').trim()) {
        setError('Add a title and some body text before creating this Work.');
        return;
      }
      setUploading(true);
      setError('');
      try {
        const created = await api.studioCreateWork({
          creatorId,
          originalFilename: title.trim(),
          title: title.trim(),
          kind: writingKind,
          body,
          description: serializeDescriptionBlocks(body)
        });
        navigate(`/studio/workspace?section=works&creatorId=${encodeURIComponent(creatorId)}&workId=${encodeURIComponent(created.work.workId)}`);
      } catch (createError) {
        setError(createError instanceof Error ? createError.message : 'Unable to create this writing Work.');
      } finally {
        setUploading(false);
      }
      return;
    }
    if (!creatorId || !files.length) return;
    setUploading(true);
    setError('');
    const failures: string[] = [];
    let completed = 0;
    for (const [index, file] of files.entries()) {
      setProgress(`Uploading ${index + 1} of ${files.length}: ${file.name}`);
      try {
        const created = await api.studioCreateWork({
          creatorId,
          originalFilename: file.name
        });
        await api.studioUploadWorkImage(created.work.workId, file);
        completed += 1;
      } catch (uploadError) {
        failures.push(`${file.name}: ${uploadError instanceof Error ? uploadError.message : 'Upload failed'}`);
      }
    }
    setUploading(false);
    setProgress('');
    if (completed) {
      setFiles([]);
      navigate(`/studio/workspace?section=works&creatorId=${encodeURIComponent(creatorId)}&status=draft`);
      return;
    }
    if (failures.length) setError(failures.join(' '));
  };

  const addImageFiles = (incoming: FileList | File[]) => {
    const images = Array.from(incoming).filter((file) => file.type.startsWith('image/'));
    if (!images.length) {
      setError('Choose image files only.');
      return;
    }
    setError('');
    setFiles((current) => {
      const existing = new Set(current.map((file) => `${file.name}:${file.size}:${file.lastModified}`));
      return [...current, ...images.filter((file) => !existing.has(`${file.name}:${file.size}:${file.lastModified}`))];
    });
  };

  return (
    <section className="studio-work-upload-layout">
      <Card
        title={isWriting ? 'Create Post or Story' : 'Upload works'}
        eyebrow={`Works / ${activeCreator?.name || brand.creatorName}`}
        actions={<button type="button" className="auth-secondary-btn" onClick={() => navigate(worksWorkspacePath(location.search))}>Back to Works</button>}
      >
        <p className="studio-work-upload-lede">{isWriting
          ? `Create a writing Work with the block editor. Posts and Stories use the same portable content model and can be reviewed, published to ${brand.workspaceFullName}, and adapted for connected platforms.`
          : `Select one or more images. Each image becomes its own ${brand.productName} work; multi-image works will arrive as a separate composition workflow.`}</p>
        <div className="studio-work-upload-form">
          <label>
            <span>{brand.creatorName}</span>
            <select value={creatorId} disabled={uploading} onChange={(event) => setCreatorId(event.target.value)}>
              {creators.map((creator) => <option key={creator.creatorId} value={creator.creatorId}>{creator.name}</option>)}
            </select>
          </label>
          {isWriting ? <>
            <label>
              <span>Writing type</span>
              <select value={writingKind} disabled={uploading} onChange={(event) => setWritingKind(event.target.value as 'article' | 'literature')}>
                <option value="article">Post</option>
                <option value="literature">Story</option>
              </select>
            </label>
            <label>
              <span>Title</span>
              <input value={title} disabled={uploading} onChange={(event) => setTitle(event.target.value)} maxLength={300} placeholder="A title for your Post or Story" />
            </label>
            <BlockEditor
              label="Body"
              value={body}
              onChange={setBody}
              helpText="Write portable blocks that can be shown in your Space and adapted for DeviantArt."
            />
          </> : <div className="studio-work-upload-files">
            <span>Images</span>
            <input
              ref={fileInputRef}
              className="studio-work-upload-file-input"
              type="file"
              accept="image/*"
              multiple
              disabled={uploading}
              onChange={(event) => {
                if (event.target.files) addImageFiles(event.target.files);
                event.target.value = '';
              }}
            />
            <p className="studio-work-upload-file-count" aria-live="polite">
              <strong>{files.length}</strong> {files.length === 1 ? 'file' : 'files'} added
            </p>
            <button
              type="button"
              className={`studio-work-upload-dropzone${dragActive ? ' studio-work-upload-dropzone-active' : ''}`}
              disabled={uploading}
              onClick={() => fileInputRef.current?.click()}
              onDragEnter={(event) => { event.preventDefault(); if (!uploading) setDragActive(true); }}
              onDragOver={(event) => event.preventDefault()}
              onDragLeave={(event) => { event.preventDefault(); setDragActive(false); }}
              onDrop={(event) => {
                event.preventDefault();
                setDragActive(false);
                if (!uploading) addImageFiles(event.dataTransfer.files);
              }}
            >
              <strong>Drop images here</strong>
              <span>or choose images from your computer</span>
              <small>Bulk upload is supported; every selected image becomes one work.</small>
            </button>
          </div>}
        </div>
        {!!files.length && <ul className="studio-work-upload-file-list">
          {files.map((file) => <li key={`${file.name}:${file.lastModified}`}><strong>{file.name}</strong><span>{titleFromFilename(file.name)} · {Math.ceil(file.size / 1024)} KB</span></li>)}
        </ul>}
        {progress && <p className="small">{progress}</p>}
        {error && <p className="error">{error}</p>}
        <div className="studio-work-metadata-footer">
          <button type="button" className="auth-primary-btn" disabled={uploading || !creatorId || (isWriting ? !title.trim() : !files.length)} onClick={() => void submit()}>
            {uploading ? (isWriting ? 'Creating…' : 'Uploading…') : isWriting ? `Create ${writingKind === 'article' ? 'Post' : 'Story'}` : `Create ${files.length || ''} work${files.length === 1 ? '' : 's'}`}
          </button>
          <Link className="auth-secondary-btn no-underline" to={`/studio/workspace?section=works${creatorId ? `&creatorId=${encodeURIComponent(creatorId)}` : ''}`}>Cancel</Link>
        </div>
      </Card>
    </section>
  );
}
