import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { api } from '../../api';
import { brand } from '../../brand';
import { Card } from '../components/Card';
import type { StudioCreator } from '../types';

export function WorkUploadView({ creators }: { creators: StudioCreator[] }) {
  const location = useLocation();
  const navigate = useNavigate();
  const requestedCreatorId = new URLSearchParams(location.search).get('creatorId') || '';
  const [creatorId, setCreatorId] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState('');
  const [progress, setProgress] = useState('');
  const [dragActive, setDragActive] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const activeCreator = useMemo(() => creators.find((creator) => creator.creatorId === creatorId), [creatorId, creators]);

  useEffect(() => {
    if (creatorId || !creators.length) return;
    setCreatorId(creators.some((creator) => creator.creatorId === requestedCreatorId) ? requestedCreatorId : creators[0].creatorId);
  }, [creatorId, creators, requestedCreatorId]);

  const submit = async () => {
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
        title="Upload works"
        eyebrow={`Works / ${activeCreator?.name || brand.creatorName}`}
        actions={<button type="button" className="auth-secondary-btn" onClick={() => navigate(`/studio/workspace?section=works${creatorId ? `&creatorId=${encodeURIComponent(creatorId)}` : ''}`)}>Back to Works</button>}
      >
        <p className="studio-work-upload-lede">Select one or more images. Each image becomes its own {brand.productName} work; multi-image works will arrive as a separate composition workflow.</p>
        <div className="studio-work-upload-form">
          <label>
            <span>{brand.creatorName}</span>
            <select value={creatorId} disabled={uploading} onChange={(event) => setCreatorId(event.target.value)}>
              {creators.map((creator) => <option key={creator.creatorId} value={creator.creatorId}>{creator.name}</option>)}
            </select>
          </label>
          <div className="studio-work-upload-files">
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
          </div>
        </div>
        {!!files.length && <ul className="studio-work-upload-file-list">
          {files.map((file) => <li key={`${file.name}:${file.lastModified}`}><strong>{file.name}</strong><span>{Math.ceil(file.size / 1024)} KB</span></li>)}
        </ul>}
        {progress && <p className="small">{progress}</p>}
        {error && <p className="error">{error}</p>}
        <div className="studio-work-metadata-footer">
          <button type="button" className="auth-primary-btn" disabled={uploading || !creatorId || !files.length} onClick={() => void submit()}>
            {uploading ? 'Uploading…' : `Create ${files.length || ''} work${files.length === 1 ? '' : 's'}`}
          </button>
          <Link className="auth-secondary-btn no-underline" to={`/studio/workspace?section=works${creatorId ? `&creatorId=${encodeURIComponent(creatorId)}` : ''}`}>Cancel</Link>
        </div>
      </Card>
    </section>
  );
}
