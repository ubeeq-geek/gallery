import { useEffect, useMemo, useState } from 'react';
import { Card } from '../components/Card';
import { CrudTable, type CrudRow } from '../components/CrudTable';
import { DataToolbar } from '../components/DataToolbar';
import { InspectorPanel } from '../components/InspectorPanel';
import { Pill } from '../components/Pill';
import type { StudioCreator, StudioFile } from '../types';

export function FilesMediaView({
  files,
  creators,
  onCreateFile
}: {
  files: StudioFile[];
  creators: StudioCreator[];
  onCreateFile: (payload: { creatorId: string; originalFilename: string; mimeType: string; storageKey: string }) => Promise<void>;
}) {
  const [search, setSearch] = useState('');
  const [selectedId, setSelectedId] = useState('');
  const [creatorId, setCreatorId] = useState(creators[0]?.creatorId || '');
  const [filename, setFilename] = useState('');
  const [mimeType, setMimeType] = useState('image/jpeg');

  useEffect(() => {
    if (!creatorId && creators[0]?.creatorId) {
      setCreatorId(creators[0].creatorId);
    }
  }, [creatorId, creators]);

  const filtered = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) return files;
    return files.filter((file) =>
      (file.originalFilename || '').toLowerCase().includes(query)
      || file.storageKey.toLowerCase().includes(query)
      || file.sourceKind.toLowerCase().includes(query)
    );
  }, [files, search]);

  useEffect(() => {
    if (!filtered.length) {
      setSelectedId('');
      return;
    }
    if (!filtered.some((file) => file.fileId === selectedId)) {
      setSelectedId(filtered[0].fileId);
    }
  }, [filtered, selectedId]);

  const selected = filtered.find((file) => file.fileId === selectedId) || filtered[0];
  const creatorById = new Map(creators.map((creator) => [creator.creatorId, creator]));
  const rows: CrudRow[] = filtered.map((file) => ({
    id: file.fileId,
    title: file.originalFilename || file.fileId,
    subtitle: file.mimeType,
    meta: `creator: ${creatorById.get(file.creatorId)?.name || file.creatorId}`,
    badges: (
      <>
        <Pill label={file.sourceKind} tone="info" />
        {file.restricted ? <Pill label="Restricted" tone="warning" /> : null}
        {file.premium ? <Pill label="Premium" tone="danger" /> : null}
      </>
    )
  }));

  const submit = async () => {
    const trimmedFilename = filename.trim();
    if (!creatorId || !trimmedFilename) return;
    await onCreateFile({
      creatorId,
      originalFilename: trimmedFilename,
      mimeType,
      storageKey: `uploads/${trimmedFilename.replace(/\s+/g, '-').toLowerCase()}`
    });
    setFilename('');
  };

  return (
    <section className="studio-surface-grid">
      <Card title="Files" eyebrow="Canonical sources">
        <DataToolbar
          search={search}
          onSearchChange={setSearch}
          searchPlaceholder="Search files..."
          primaryAction={<button type="button" className="auth-primary-btn" onClick={() => void submit()}>+ New File</button>}
        />
        <div className="studio-inline-form">
          <select value={creatorId} onChange={(event) => setCreatorId(event.target.value)}>
            <option value="">Select creator</option>
            {creators.map((creator) => (
              <option key={creator.creatorId} value={creator.creatorId}>{creator.name}</option>
            ))}
          </select>
          <input value={filename} onChange={(event) => setFilename(event.target.value)} placeholder="original-filename.jpg" />
          <input value={mimeType} onChange={(event) => setMimeType(event.target.value)} placeholder="mime type" />
        </div>
        <CrudTable rows={rows} selectedId={selected?.fileId} onSelect={(row) => setSelectedId(row.id)} emptyMessage="No files match this search." />
      </Card>

      <Card title="File detail" eyebrow="Inspector">
        {selected ? (
          <InspectorPanel
            title={selected.originalFilename || selected.fileId}
            subtitle={selected.mimeType}
            status={<Pill label={selected.sourceKind} tone="info" />}
            actions={
              <>
                <button type="button" className="auth-secondary-btn">Derive media</button>
                <button type="button" className="auth-secondary-btn">Metadata</button>
              </>
            }
          >
            <div className="studio-inspector-list">
              <div><strong>Storage key</strong><span>{selected.storageKey}</span></div>
              <div><strong>Creator</strong><span>{creatorById.get(selected.creatorId)?.name || selected.creatorId}</span></div>
              <div><strong>Flags</strong><span>{selected.restricted ? 'Restricted' : 'Standard'} · {selected.premium ? 'Premium' : 'Public'}</span></div>
            </div>
          </InspectorPanel>
        ) : (
          <div className="studio-empty-state">Select a file to inspect storage and derivation details.</div>
        )}
      </Card>
    </section>
  );
}
