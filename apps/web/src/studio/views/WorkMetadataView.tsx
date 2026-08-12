import { useEffect, useMemo, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { api } from '../../api';
import { Card } from '../components/Card';
import type { StudioCreator, StudioExternalAsset, StudioExternalPublication } from '../types';

const sourceLabel = (publication?: StudioExternalPublication): string => {
  if (publication?.platform === 'deviantart') return 'DeviantArt';
  if (publication?.platform) return publication.platform.replace(/(^|[-_ ])([a-z])/g, (_, prefix: string, letter: string) => `${prefix}${letter.toUpperCase()}`);
  return 'Integration source';
};

const isMetadataLinked = (asset: StudioExternalAsset): boolean => (
  asset.titleSyncPolicy === 'mirrored' || asset.titleSyncPolicy === 'initially_mirrored'
) && (
  asset.descriptionSyncPolicy === 'mirrored' || asset.descriptionSyncPolicy === 'initially_mirrored'
);

export function WorkMetadataView({ creators }: { creators: StudioCreator[] }) {
  const location = useLocation();
  const navigate = useNavigate();
  const params = useMemo(() => new URLSearchParams(location.search), [location.search]);
  const creatorId = params.get('creatorId') || '';
  const workId = params.get('workId') || '';
  const collectionId = params.get('collectionId') || '';
  const [asset, setAsset] = useState<StudioExternalAsset | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [linked, setLinked] = useState(true);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [integrationTitle, setIntegrationTitle] = useState('');
  const [integrationDescription, setIntegrationDescription] = useState('');
  const [tags, setTags] = useState<string[]>([]);
  const [allowComments, setAllowComments] = useState(true);
  const [isMature, setIsMature] = useState(false);
  const [matureLevel, setMatureLevel] = useState<'strict' | 'moderate'>('moderate');
  const [matureClassification, setMatureClassification] = useState<string[]>([]);
  const [isAiGenerated, setIsAiGenerated] = useState(false);
  const [allowAiTraining, setAllowAiTraining] = useState(true);
  const [success, setSuccess] = useState('');

  const backToWorks = () => {
    const next = new URLSearchParams({ section: 'works' });
    if (creatorId) next.set('creatorId', creatorId);
    if (collectionId) next.set('collectionId', collectionId);
    navigate(`/studio/workspace?${next.toString()}`);
  };

  useEffect(() => {
    if (!creatorId || !workId) {
      setLoading(false);
      setError('This work could not be opened. Return to Works and choose a work to edit.');
      return;
    }
    let active = true;
    setLoading(true);
    setError('');
    void api.studioListDeviantArtCatalogue(creatorId).then((result) => {
      if (!active) return;
      const found = ((result as { items?: StudioExternalAsset[] }).items || []).find((item) => item.assetId === workId) || null;
      if (!found) {
        setError('This work is no longer available in the selected creator catalogue.');
        return;
      }
      setAsset(found);
      setLinked(isMetadataLinked(found));
      setTitle(found.canonicalTitle || found.publications[0]?.externalTitle || '');
      setDescription(found.canonicalDescription || found.publications[0]?.externalDescription || '');
      setIntegrationTitle(found.publications[0]?.externalTitle || '');
      setIntegrationDescription(found.publications[0]?.externalDescription || '');
      setTags(found.publications[0]?.externalTags || []);
      setAllowComments(found.publications[0]?.displayOptions?.allowComments ?? true);
      setIsMature(found.publications[0]?.displayOptions?.isMature ?? false);
      setMatureLevel(found.publications[0]?.displayOptions?.matureLevel ?? 'moderate');
      setMatureClassification(found.publications[0]?.displayOptions?.matureClassification || []);
      setIsAiGenerated(found.publications[0]?.displayOptions?.isAiGenerated ?? false);
      setAllowAiTraining(found.publications[0]?.displayOptions?.allowAiTraining ?? true);
    }).catch((loadError: unknown) => {
      if (active) setError(loadError instanceof Error ? loadError.message : 'Unable to load this work.');
    }).finally(() => {
      if (active) setLoading(false);
    });
    return () => { active = false; };
  }, [creatorId, workId]);

  const integration = asset?.publications[0];
  const integrationLabel = sourceLabel(integration);
  const sourceTitle = integration?.externalTitle || '';
  const sourceDescription = integration?.externalDescription || '';
  const sourceTags = integration?.externalTags || [];
  const sourceAllowComments = integration?.displayOptions?.allowComments ?? true;
  const sourceIsMature = integration?.displayOptions?.isMature ?? false;
  const sourceMatureLevel = integration?.displayOptions?.matureLevel ?? 'moderate';
  const sourceMatureClassification = integration?.displayOptions?.matureClassification || [];
  const sourceIsAiGenerated = integration?.displayOptions?.isAiGenerated ?? false;
  const sourceAllowAiTraining = integration?.displayOptions?.allowAiTraining ?? true;
  const canLink = Boolean(integration);
  const creatorName = creators.find((creator) => creator.creatorId === creatorId)?.name || 'Creator';

  const handleLinkChange = (nextLinked: boolean) => {
    setLinked(nextLinked);
    if (nextLinked && integration) {
      setIntegrationTitle(title);
      setIntegrationDescription(description);
    }
  };

  const save = async () => {
    if (!asset) return;
    setSaving(true);
    setError('');
    setSuccess('');
    try {
      const nextIntegrationTitle = linked ? title : integrationTitle;
      const nextIntegrationDescription = linked ? description : integrationDescription;
      const normalizedTags = [...new Set(tags.map((tag) => tag.trim().replace(/\s+/g, '_')).filter(Boolean))];
      const normalizedMatureClassification = [...new Set(matureClassification.map((classification) => classification.trim().toLowerCase()).filter((classification): classification is 'nudity' | 'sexual' | 'gore' | 'language' | 'ideology' => (
        classification === 'nudity' || classification === 'sexual' || classification === 'gore' || classification === 'language' || classification === 'ideology'
      )))];
      const integrationMetadata = integration ? {
        ...(nextIntegrationTitle !== sourceTitle ? { title: nextIntegrationTitle } : {}),
        ...(nextIntegrationDescription !== sourceDescription ? { description: nextIntegrationDescription } : {}),
        ...(normalizedTags.join('\u0000') !== sourceTags.join('\u0000') ? { tags: normalizedTags } : {}),
        ...(allowComments !== sourceAllowComments ? { allowComments } : {}),
        ...(isMature !== sourceIsMature ? { isMature } : {}),
        ...(matureLevel !== sourceMatureLevel ? { matureLevel } : {}),
        ...(normalizedMatureClassification.join('\u0000') !== sourceMatureClassification.join('\u0000') ? { matureClassification: normalizedMatureClassification } : {}),
        ...(isAiGenerated !== sourceIsAiGenerated ? { isAiGenerated } : {}),
        ...(allowAiTraining !== sourceAllowAiTraining ? { allowAiTraining } : {})
      } : undefined;
      const updated = await api.studioUpdateExternalAsset(asset.assetId, {
        canonicalTitle: title,
        canonicalDescription: description,
        titleSyncPolicy: linked && canLink ? 'mirrored' : 'independent',
        descriptionSyncPolicy: linked && canLink ? 'mirrored' : 'independent',
        integrationMetadata
      }) as Pick<StudioExternalAsset, 'canonicalTitle' | 'canonicalDescription' | 'titleSyncPolicy' | 'descriptionSyncPolicy' | 'updatedAt'> & { remoteUpdateJobs?: unknown[] };
      setAsset((current) => current ? {
        ...current,
        ...updated,
        publications: current.publications.map((publication) => publication.externalPublicationId === integration?.externalPublicationId ? {
          ...publication,
          externalTitle: nextIntegrationTitle,
          externalDescription: nextIntegrationDescription,
          externalTags: normalizedTags,
          displayOptions: {
            ...publication.displayOptions,
            allowComments,
            isMature,
            matureLevel,
            matureClassification: normalizedMatureClassification,
            isAiGenerated,
            allowAiTraining
          }
        } : publication)
      } : current);
      setTitle(updated.canonicalTitle || '');
      setDescription(updated.canonicalDescription || '');
      setIntegrationTitle(nextIntegrationTitle);
      setIntegrationDescription(nextIntegrationDescription);
      setTags(normalizedTags);
      setMatureClassification(normalizedMatureClassification);
      setSuccess(updated.remoteUpdateJobs?.length ? `Saved. ${integrationLabel} updates are queued for synchronization.` : 'Metadata saved.');
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : 'Unable to save this work’s metadata.');
    } finally {
      setSaving(false);
    }
  };

  const integrationControls = integration && <>
    <label>
      <span>Tags</span>
      <input value={tags.join(', ')} onChange={(event) => setTags(event.target.value.split(','))} placeholder="Add comma-separated tags" />
    </label>
    <label className="studio-work-metadata-option">
      <input type="checkbox" checked={allowComments} onChange={(event) => setAllowComments(event.target.checked)} />
      <span>Allow comments on {integrationLabel}</span>
    </label>
    <label className="studio-work-metadata-option">
      <input type="checkbox" checked={isMature} onChange={(event) => setIsMature(event.target.checked)} />
      <span>Mature content</span>
    </label>
    {isMature && <>
      <label>
        <span>Mature level</span>
        <select value={matureLevel} onChange={(event) => setMatureLevel(event.target.value as 'strict' | 'moderate')}>
          <option value="moderate">Moderate</option>
          <option value="strict">Strict</option>
        </select>
      </label>
      <label>
        <span>Mature classifications</span>
        <input value={matureClassification.join(', ')} onChange={(event) => setMatureClassification(event.target.value.split(','))} placeholder="nudity, sexual, gore, language, ideology" />
      </label>
    </>}
    <label className="studio-work-metadata-option">
      <input type="checkbox" checked={isAiGenerated} onChange={(event) => setIsAiGenerated(event.target.checked)} />
      <span>Made with AI</span>
    </label>
    <label className="studio-work-metadata-option">
      <input type="checkbox" checked={!allowAiTraining} onChange={(event) => setAllowAiTraining(!event.target.checked)} />
      <span>No AI training</span>
    </label>
    <small>Changes to title, description, tags, display options, mature status, and AI settings are submitted to {integrationLabel} when you save.</small>
  </>;

  return (
    <section className="studio-work-metadata-layout">
      <Card
        title="Edit work metadata"
        eyebrow={`Works / ${creatorName}`}
        actions={<button type="button" className="auth-secondary-btn" onClick={backToWorks}>Back to Works</button>}
      >
        {loading && <p className="small">Loading work metadata…</p>}
        {error && <p className="error">{error}</p>}
        {!loading && asset && <div className="studio-work-metadata-editor">
          <div className="studio-work-metadata-heading">
            <div>
              <h4>{asset.canonicalTitle || sourceTitle || 'Untitled work'}</h4>
              <p>{integration ? `Connected to ${integrationLabel}${integration.externalUsername ? ` · ${integration.externalUsername}` : ''}` : 'Ubeeq work'}</p>
            </div>
            <span className="studio-collection-visibility">{asset.visibility}</span>
          </div>

          {canLink && <label className="studio-work-metadata-link">
            <input type="checkbox" checked={linked} onChange={(event) => handleLinkChange(event.target.checked)} />
            <span>
              <strong>Keep shared metadata combined with connected integrations</strong>
              <small>When enabled, title and description edits are shared with compatible integration fields. Turn this off to manage Ubeeq and integration metadata separately.</small>
            </span>
          </label>}

          {linked && canLink ? <div className="studio-work-metadata-fields">
            <section>
              <p className="studio-work-metadata-field-heading">Shared metadata</p>
              <label>
                <span>Title</span>
                <input value={title} onChange={(event) => setTitle(event.target.value)} maxLength={300} />
              </label>
              <label>
                <span>Description</span>
                <textarea value={description} onChange={(event) => setDescription(event.target.value)} rows={9} maxLength={20000} />
              </label>
            </section>
            <section className="studio-work-metadata-source-fields">
              <p className="studio-work-metadata-field-heading">Connected integration metadata</p>
              {integrationControls}
            </section>
          </div> : <div className="studio-work-metadata-fields">
            <section>
              <p className="studio-work-metadata-field-heading">Ubeeq metadata</p>
              <label>
                <span>Title</span>
                <input value={title} onChange={(event) => setTitle(event.target.value)} maxLength={300} />
              </label>
              <label>
                <span>Description</span>
                <textarea value={description} onChange={(event) => setDescription(event.target.value)} rows={9} maxLength={20000} />
              </label>
            </section>
            {integration && <section className="studio-work-metadata-source-fields">
              <p className="studio-work-metadata-field-heading">{integrationLabel} metadata</p>
              <label>
                <span>{integrationLabel} title</span>
                <input value={integrationTitle} onChange={(event) => setIntegrationTitle(event.target.value)} maxLength={300} />
              </label>
              <label>
                <span>{integrationLabel} description</span>
                <textarea value={integrationDescription} onChange={(event) => setIntegrationDescription(event.target.value)} rows={9} maxLength={20000} />
              </label>
              {integrationControls}
            </section>}
          </div>}

          <div className="studio-work-metadata-footer">
            <button type="button" className="auth-primary-btn" disabled={saving} onClick={() => void save()}>{saving ? 'Saving…' : 'Save metadata'}</button>
            <Link className="auth-secondary-btn no-underline" to={`/studio/workspace?section=works&creatorId=${encodeURIComponent(creatorId)}${collectionId ? `&collectionId=${encodeURIComponent(collectionId)}` : ''}`}>Cancel</Link>
          </div>
          {success && <p className="studio-work-metadata-success">{success}</p>}
        </div>}
      </Card>
    </section>
  );
}
