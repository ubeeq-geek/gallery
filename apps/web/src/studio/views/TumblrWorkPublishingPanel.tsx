import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../api';
import { Pill } from '../components/Pill';

type Mode = 'full' | 'selected_assets' | 'announcement';
type State = 'published' | 'draft' | 'queue' | 'private';
type Connector = { id: string; status: string; ownership: 'managed' | 'creator_owned'; tumblrUserName?: string };
type Blog = { id: string; connectorId: string; identifier: string; title?: string; enabled: boolean; defaults?: { publicationMode?: Mode; postState?: State } };
type Publication = { id: string; status: string; mode: Mode; tumblrPostUrl?: string };
type Preview = { eligibility: { decision: string }; npf: { content: unknown[]; tags?: string[] } };
type WorkAsset = { assetId: string; kind: string; url?: string; thumbnailUrl?: string; attachment?: { altText?: string; caption?: string } };

export function TumblrWorkPublishingPanel({ creatorId, workId }: { creatorId: string; workId: string }) {
  const [connectors, setConnectors] = useState<Connector[]>([]);
  const [blogs, setBlogs] = useState<Blog[]>([]);
  const [destinationId, setDestinationId] = useState('');
  const [mode, setMode] = useState<Mode>('full');
  const [state, setState] = useState<State>('published');
  const [includeTitle, setIncludeTitle] = useState(true);
  const [includeDescription, setIncludeDescription] = useState(true);
  const [includeSourceLink, setIncludeSourceLink] = useState(true);
  const [matureThemes, setMatureThemes] = useState(false);
  const [nudity, setNudity] = useState(false);
  const [sexuallyExplicit, setSexuallyExplicit] = useState(false);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [publications, setPublications] = useState<Publication[]>([]);
  const [assets, setAssets] = useState<WorkAsset[]>([]);
  const [selectedAssetIds, setSelectedAssetIds] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  const selectedBlog = useMemo(() => blogs.find((blog) => blog.id === destinationId), [blogs, destinationId]);
  const selectedConnector = connectors.find((connector) => connector.id === selectedBlog?.connectorId);
  const request = () => ({ connectorId: selectedBlog?.connectorId, destinationId, mode, state, ...(mode === 'selected_assets' ? { selectedAssetIds } : {}), includeTitle, includeDescription, includeSourceLink, declarations: { matureThemes, nudity, sexuallyExplicit } });

  const load = async () => {
    const nextConnectors = (await api.studioListTumblrConnectors(creatorId) as Connector[]).filter((connector) => connector.status === 'connected');
    const nextBlogs = (await Promise.all(nextConnectors.map((connector) => api.studioListTumblrBlogs(connector.id) as Promise<Blog[]>))).flat().filter((blog) => blog.enabled);
    setConnectors(nextConnectors);
    setBlogs(nextBlogs);
    setDestinationId((current) => nextBlogs.some((blog) => blog.id === current) ? current : nextBlogs[0]?.id || '');
    const [nextPublications, canonicalWork] = await Promise.all([api.studioListTumblrPublications(workId), api.studioGetCanonicalWork(workId)]) as [Publication[], { assets?: WorkAsset[] }];
    const nextAssets = canonicalWork.assets || [];
    setPublications(nextPublications);
    setAssets(nextAssets);
    setSelectedAssetIds((current) => current.length ? current.filter((id) => nextAssets.some((asset) => asset.assetId === id)) : nextAssets.map((asset) => asset.assetId));
  };

  useEffect(() => { void load().catch(() => setError('Unable to load Tumblr publishing destinations.')); }, [creatorId, workId]);
  useEffect(() => {
    if (selectedBlog?.defaults?.publicationMode) setMode(selectedBlog.defaults.publicationMode);
    if (selectedBlog?.defaults?.postState) setState(selectedBlog.defaults.postState);
  }, [selectedBlog?.id]);

  const run = async (publish: boolean) => {
    if (!destinationId) return;
    setBusy(true); setError(''); setMessage(''); setPreview(null);
    try {
      if (publish) {
        const publication = await api.studioPublishTumblrWork(workId, request()) as Publication;
        setMessage(`Tumblr publication queued (${publication.status}).`);
        await load();
      } else {
        setPreview(await api.studioPreviewTumblrWork(workId, request()) as Preview);
        setMessage('Preview rendered with the current Tumblr policy and media limits.');
      }
    } catch (runError) {
      setError(runError instanceof Error ? runError.message : 'Tumblr could not prepare this Work.');
    } finally { setBusy(false); }
  };

  const managePublication = async (publication: Publication, action: 'validate' | 'update' | 'delete') => {
    setBusy(true); setError(''); setMessage('');
    try {
      if (action === 'validate') {
        await api.studioGetTumblrRemotePublication(workId, publication.id);
        setMessage('The Tumblr post still exists and is accessible.');
      } else if (action === 'update') {
        try { await api.studioUpdateTumblrPublication(workId, publication.id); }
        catch (confirmationError) {
          if (!(confirmationError instanceof Error) || !confirmationError.message.includes('Review the current Tumblr post')) throw confirmationError;
          if (!window.confirm('Tumblr may have changed since publication. Replace the remote post with the stored Ubeeq publication snapshot?')) return;
          await api.studioUpdateTumblrPublication(workId, publication.id, true);
        }
        setMessage('Tumblr post updated after remote confirmation.');
      } else {
        if (!window.confirm('Remove this post from Tumblr? The canonical Work will not be deleted.')) return;
        await api.studioDeleteTumblrPublication(workId, publication.id);
        setMessage('Tumblr post removed. The canonical Work remains in Ubeeq.');
      }
      await load();
    } catch (manageError) { setError(manageError instanceof Error ? manageError.message : 'Tumblr publication management failed.'); }
    finally { setBusy(false); }
  };

  const toggleAsset = (assetId: string, selected: boolean) => setSelectedAssetIds((current) => selected ? [...current, assetId] : current.filter((id) => id !== assetId));
  const moveAsset = (assetId: string, offset: -1 | 1) => setSelectedAssetIds((current) => {
    const index = current.indexOf(assetId);
    const target = index + offset;
    if (index < 0 || target < 0 || target >= current.length) return current;
    const next = [...current];
    [next[index], next[target]] = [next[target], next[index]];
    return next;
  });

  return <section className="studio-tumblr-publish-panel">
    <div className="studio-work-destinations-heading"><div><p className="studio-work-metadata-field-heading">Tumblr publishing</p><p>Preview the NPF post and evaluate destination policy before queueing delivery.</p></div></div>
    {!blogs.length ? <div className="studio-work-destination-unavailable"><span>No enabled Tumblr blog is connected to this creator.</span><Link className="auth-secondary-btn no-underline" to={`/studio/workspace?section=integrations&creatorId=${encodeURIComponent(creatorId)}`}>Manage Tumblr connections</Link></div> : <>
      <div className="studio-integration-toolbar">
        <label><span>Blog</span><select value={destinationId} disabled={busy} onChange={(event) => setDestinationId(event.target.value)}>{blogs.map((blog) => <option key={blog.id} value={blog.id}>{blog.title || blog.identifier}</option>)}</select></label>
        <label><span>Publication</span><select value={mode} disabled={busy} onChange={(event) => setMode(event.target.value as Mode)}><option value="full">Full Work</option><option value="selected_assets">Selected Assets</option><option value="announcement">Announcement only</option></select></label>
        <label><span>Tumblr state</span><select value={state} disabled={busy} onChange={(event) => setState(event.target.value as State)}><option value="published">Publish now</option><option value="draft">Draft</option><option value="queue">Queue</option><option value="private">Private</option></select></label>
      </div>
      {selectedConnector && <p className="small">Using {selectedConnector.ownership === 'managed' ? 'the managed connector' : 'a creator-owned application'}{selectedConnector.tumblrUserName ? ` for ${selectedConnector.tumblrUserName}` : ''}.</p>}
      <fieldset className="studio-work-metadata-options"><legend>Content</legend>
        <label className="studio-work-metadata-option"><input type="checkbox" checked={includeTitle} onChange={(event) => setIncludeTitle(event.target.checked)} /><span>Title</span></label>
        <label className="studio-work-metadata-option"><input type="checkbox" checked={includeDescription} onChange={(event) => setIncludeDescription(event.target.checked)} /><span>Description and tags</span></label>
        <label className="studio-work-metadata-option"><input type="checkbox" checked={includeSourceLink} onChange={(event) => setIncludeSourceLink(event.target.checked)} /><span>Link to complete Work</span></label>
      </fieldset>
      <fieldset className="studio-work-metadata-options"><legend>Destination-relevant declarations</legend>
        <label className="studio-work-metadata-option"><input type="checkbox" checked={matureThemes} onChange={(event) => setMatureThemes(event.target.checked)} /><span>Mature themes</span></label>
        <label className="studio-work-metadata-option"><input type="checkbox" checked={nudity} onChange={(event) => setNudity(event.target.checked)} /><span>Nudity</span></label>
        <label className="studio-work-metadata-option"><input type="checkbox" checked={sexuallyExplicit} onChange={(event) => setSexuallyExplicit(event.target.checked)} /><span>Sexually explicit</span></label>
        <small>Declarations are evaluated separately from Work storage and Eversally discovery. Creator-owned credentials never bypass Tumblr API restrictions.</small>
      </fieldset>
      {mode === 'selected_assets' && <fieldset className="studio-tumblr-asset-picker"><legend>Selected Assets and display order</legend>{assets.map((asset) => {
        const checked = selectedAssetIds.includes(asset.assetId);
        const selectedIndex = selectedAssetIds.indexOf(asset.assetId);
        return <div key={asset.assetId}><label><input type="checkbox" checked={checked} disabled={busy} onChange={(event) => toggleAsset(asset.assetId, event.target.checked)} />{(asset.thumbnailUrl || asset.url) && <img src={asset.thumbnailUrl || asset.url} alt={asset.attachment?.altText || ''} />}<span><strong>{asset.attachment?.caption || asset.kind}</strong><small>{asset.assetId}</small></span></label>{checked && <span className="studio-inline-actions"><button type="button" className="auth-secondary-btn" aria-label="Move Asset earlier" disabled={busy || selectedIndex === 0} onClick={() => moveAsset(asset.assetId, -1)}>↑</button><button type="button" className="auth-secondary-btn" aria-label="Move Asset later" disabled={busy || selectedIndex === selectedAssetIds.length - 1} onClick={() => moveAsset(asset.assetId, 1)}>↓</button></span>}</div>;
      })}<small>Only checked Assets are included, in the order shown. Preview validates the selection against Tumblr’s current media limit.</small></fieldset>}
      <div className="studio-inline-actions"><button type="button" className="auth-secondary-btn" disabled={busy || (mode === 'selected_assets' && !selectedAssetIds.length)} onClick={() => void run(false)}>Preview Tumblr post</button><button type="button" className="auth-primary-btn" disabled={busy || (mode === 'selected_assets' && !selectedAssetIds.length)} onClick={() => void run(true)}>{busy ? 'Preparing…' : 'Publish to Tumblr'}</button></div>
      {message && <p className="success" role="status">{message}</p>}
      {error && <div className="studio-work-metadata-warning"><p>{error}</p><a href="https://www.tumblr.com/new" target="_blank" rel="noreferrer">Open the Tumblr editor for manual publishing</a></div>}
      {preview && <div className="studio-tumblr-preview"><strong>NPF preview</strong><Pill tone="success" label={preview.eligibility.decision.replace(/_/g, ' ')} /><span>{preview.npf.content.length} content block{preview.npf.content.length === 1 ? '' : 's'} · {preview.npf.tags?.length || 0} tags</span></div>}
    </>}
    {publications.length > 0 && <div className="studio-tumblr-publications"><strong>Publication history</strong>{publications.slice(0, 5).map((publication) => <div key={publication.id}><span>{publication.mode.replace(/_/g, ' ')}</span><Pill tone={publication.status === 'published' ? 'success' : publication.status === 'failed' ? 'danger' : 'default'} label={publication.status} />{publication.tumblrPostUrl && <a href={publication.tumblrPostUrl} target="_blank" rel="noreferrer">View on Tumblr</a>}{publication.tumblrPostUrl && publication.status !== 'deleted' && <><button type="button" className="auth-secondary-btn" disabled={busy} onClick={() => void managePublication(publication, 'validate')}>Check remote</button><button type="button" className="auth-secondary-btn" disabled={busy} onClick={() => void managePublication(publication, 'update')}>Update post</button><button type="button" className="auth-secondary-btn" disabled={busy} onClick={() => void managePublication(publication, 'delete')}>Remove from Tumblr</button></>}</div>)}</div>}
  </section>;
}
