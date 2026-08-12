import { useEffect, useMemo, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { api } from '../../api';
import { Card } from '../components/Card';
import type { StudioCreator, StudioDeviantArtAccount, StudioExternalAsset, StudioExternalPublication } from '../types';

const sourceLabel = (publication?: StudioExternalPublication): string => {
  if (publication?.platform === 'deviantart') return 'DeviantArt';
  if (publication?.platform) return publication.platform.replace(/(^|[-_ ])([a-z])/g, (_, prefix: string, letter: string) => `${prefix}${letter.toUpperCase()}`);
  return 'Integration';
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
  const [accounts, setAccounts] = useState<StudioDeviantArtAccount[]>([]);
  const [selectedPublicationId, setSelectedPublicationId] = useState('');
  const [newDestinationAccountId, setNewDestinationAccountId] = useState('');
  const [destinationBusy, setDestinationBusy] = useState(false);
  const [destinationMessage, setDestinationMessage] = useState('');
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
    void Promise.all([api.studioListDeviantArtCatalogue(creatorId), api.studioListDeviantArtAccounts(creatorId)]).then(([result, accountResult]) => {
      if (!active) return;
      const found = ((result as { items?: StudioExternalAsset[] }).items || []).find((item) => item.assetId === workId) || null;
      if (!found) {
        setError('This work is no longer available in the selected creator catalogue.');
        return;
      }
      setAsset(found);
      const destinations = found.publications.filter((publication) => publication.syncStatus !== 'deleted');
      const selected = destinations[0];
      setAccounts(((accountResult as { accounts?: StudioDeviantArtAccount[] }).accounts || []).filter((account) => account.connectionStatus === 'connected'));
      setSelectedPublicationId(selected?.externalPublicationId || '');
      setLinked(selected ? isMetadataLinked(found) : false);
      setTitle(found.canonicalTitle || selected?.externalTitle || '');
      setDescription(found.canonicalDescription || selected?.externalDescription || '');
      setIntegrationTitle(selected?.externalTitle || '');
      setIntegrationDescription(selected?.externalDescription || '');
      setTags(selected?.externalTags || []);
      setAllowComments(selected?.displayOptions?.allowComments ?? true);
      setIsMature(selected?.displayOptions?.isMature ?? false);
      setMatureLevel(selected?.displayOptions?.matureLevel ?? 'moderate');
      setMatureClassification(selected?.displayOptions?.matureClassification || []);
      setIsAiGenerated(selected?.displayOptions?.isAiGenerated ?? false);
      setAllowAiTraining(selected?.displayOptions?.allowAiTraining ?? true);
    }).catch((loadError: unknown) => {
      if (active) setError(loadError instanceof Error ? loadError.message : 'Unable to load this work.');
    }).finally(() => {
      if (active) setLoading(false);
    });
    return () => { active = false; };
  }, [creatorId, workId]);

  const destinations = (asset?.publications || []).filter((publication) => publication.syncStatus !== 'deleted');
  const integration = destinations.find((publication) => publication.externalPublicationId === selectedPublicationId) || destinations[0];
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
  const availableDestinationAccounts = accounts.filter((account) => !destinations.some((publication) => publication.externalAccountId === account.externalAccountId));

  const selectDestination = (publication: StudioExternalPublication) => {
    setSelectedPublicationId(publication.externalPublicationId);
    setIntegrationTitle(publication.externalTitle || '');
    setIntegrationDescription(publication.externalDescription || '');
    setTags(publication.externalTags || []);
    setAllowComments(publication.displayOptions?.allowComments ?? true);
    setIsMature(publication.displayOptions?.isMature ?? false);
    setMatureLevel(publication.displayOptions?.matureLevel ?? 'moderate');
    setMatureClassification(publication.displayOptions?.matureClassification || []);
    setIsAiGenerated(publication.displayOptions?.isAiGenerated ?? false);
    setAllowAiTraining(publication.displayOptions?.allowAiTraining ?? true);
  };

  const addDestination = async () => {
    if (!asset || !newDestinationAccountId) return;
    setDestinationBusy(true);
    setError('');
    setDestinationMessage('');
    try {
      const result = await api.studioAddDeviantArtWorkDestination(asset.assetId, newDestinationAccountId) as { publication: Omit<StudioExternalPublication, 'externalUsername' | 'externalCollectionIds' | 'displayOptions'> };
      const account = accounts.find((item) => item.externalAccountId === newDestinationAccountId);
      const publication: StudioExternalPublication = {
        ...result.publication,
        externalUsername: account?.externalUsername || 'connected account',
        externalCollectionIds: [],
        displayOptions: { allowComments: true, isMature: false, isAiGenerated: false, allowAiTraining: true }
      };
      setAsset((current) => current ? { ...current, titleSyncPolicy: 'mirrored', descriptionSyncPolicy: 'mirrored', publications: [...current.publications.filter((item) => item.externalPublicationId !== publication.externalPublicationId), publication] } : current);
      setLinked(true);
      setNewDestinationAccountId('');
      selectDestination(publication);
      setDestinationMessage(`DeviantArt was added as a destination. Review its settings, then sync when ready.`);
    } catch (destinationError) {
      setError(destinationError instanceof Error ? destinationError.message : 'Unable to add this destination.');
    } finally {
      setDestinationBusy(false);
    }
  };

  const removeDestination = async (publication: StudioExternalPublication) => {
    const isPublished = publication.syncStatus === 'active';
    const confirmation = isPublished
      ? `Unpublish ${sourceLabel(publication)} for ${publication.externalUsername}? The Ubeeq copy will remain private. On DeviantArt this will ultimately move the work back to Sta.sh, rather than delete it.`
      : `Remove ${sourceLabel(publication)} as a destination for ${publication.externalUsername}? The work will remain a private draft in Ubeeq Space.`;
    if (!asset || !window.confirm(confirmation)) return;
    if (isPublished) {
      setDestinationMessage(`Unpublishing ${sourceLabel(publication)} is not available through its connected API yet, so this destination remains published for now.`);
      return;
    }
    setDestinationBusy(true);
    setError('');
    setDestinationMessage('');
    try {
      await api.studioRemoveDeviantArtWorkDestination(asset.assetId, publication.externalAccountId);
      const remaining = destinations.filter((item) => item.externalPublicationId !== publication.externalPublicationId);
      setAsset((current) => current ? { ...current, publications: current.publications.filter((item) => item.externalPublicationId !== publication.externalPublicationId) } : current);
      if (publication.externalPublicationId === integration?.externalPublicationId) {
        const next = remaining[0];
        setSelectedPublicationId(next?.externalPublicationId || '');
        if (next) selectDestination(next);
      }
      setDestinationMessage(`${sourceLabel(publication)} destination removed.`);
    } catch (destinationError) {
      setError(destinationError instanceof Error ? destinationError.message : 'Unable to remove this destination.');
    } finally {
      setDestinationBusy(false);
    }
  };

  const syncDestination = async (publication: StudioExternalPublication) => {
    if (!asset) return;
    setDestinationBusy(true);
    setError('');
    setDestinationMessage('');
    try {
      await api.studioSyncDeviantArtWorkDestination(asset.assetId, publication.externalAccountId);
      setDestinationMessage(`Sync to ${sourceLabel(publication)} has been queued.`);
    } catch (destinationError) {
      setError(destinationError instanceof Error ? destinationError.message : 'Unable to start this sync.');
    } finally {
      setDestinationBusy(false);
    }
  };

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
        externalPublicationId: integration.externalPublicationId,
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
              <p>{integration ? `Destination settings for ${integrationLabel}${integration.externalUsername ? ` · ${integration.externalUsername}` : ''}` : 'Stored in Ubeeq Space'}</p>
            </div>
            <span className="studio-collection-visibility">{asset.visibility}</span>
          </div>

          <section className="studio-work-destinations">
            <div className="studio-work-destinations-heading">
              <div>
                <p className="studio-work-metadata-field-heading">Destinations</p>
                <p>Keep this work in Ubeeq Space, then add a platform only when you are ready to prepare and sync it.</p>
              </div>
              {availableDestinationAccounts.length > 0 && <div className="studio-work-destination-add">
                <select value={newDestinationAccountId} disabled={destinationBusy} onChange={(event) => setNewDestinationAccountId(event.target.value)} aria-label="Add DeviantArt destination">
                  <option value="">Add DeviantArt destination…</option>
                  {availableDestinationAccounts.map((account) => (
                    <option key={account.externalAccountId} value={account.externalAccountId}>DeviantArt · {account.externalUsername}</option>
                  ))}
                </select>
                <button type="button" className="auth-secondary-btn" disabled={destinationBusy || !newDestinationAccountId} onClick={() => void addDestination()}>Add destination</button>
              </div>}
            </div>
            {destinations.length ? <div className="studio-work-destination-list">
              {destinations.map((publication) => <article key={publication.externalPublicationId} className={`studio-work-destination-row${publication.externalPublicationId === integration?.externalPublicationId ? ' studio-work-destination-row-active' : ''}`}>
                <button type="button" className="studio-work-destination-select" onClick={() => selectDestination(publication)}>
                  <strong>{sourceLabel(publication)} · {publication.externalUsername}</strong>
                  <span>{publication.syncStatus === 'pending_publish' ? 'Ready to sync' : publication.syncStatus === 'active' ? 'Synced' : publication.syncStatus}</span>
                </button>
                <div className="studio-work-destination-actions">
                  {publication.syncStatus === 'pending_publish' && <button type="button" className="auth-primary-btn" disabled={destinationBusy} onClick={() => void syncDestination(publication)}>Sync to {sourceLabel(publication)}</button>}
                  <button type="button" className="auth-secondary-btn" disabled={destinationBusy} onClick={() => void removeDestination(publication)}>{publication.syncStatus === 'active' ? 'Unpublish…' : 'Remove destination'}</button>
                </div>
              </article>)}
            </div> : <p className="small">No destinations yet. You can edit Ubeeq metadata now, then add DeviantArt or another connected platform when you are ready.</p>}
          </section>

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
