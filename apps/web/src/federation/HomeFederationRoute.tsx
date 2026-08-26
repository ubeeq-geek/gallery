import { useEffect, useRef, useState, type FormEvent } from 'react';
import { api } from '../api';
import { HomeFederationDashboard, type HomeFederationDashboardModel } from './FederationViews';

const INITIAL_SCOPES = ['profile:publish', 'publication:create', 'publication:update', 'publication:withdraw', 'publication:status'] as const;
type DialogState = { kind: 'connect' } | { kind: 'profile'; destinationInstanceId: string } | undefined;

export function HomeFederationRoute({ creatorId }: { creatorId: string }) {
  const [model, setModel] = useState<HomeFederationDashboardModel>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [dialog, setDialog] = useState<DialogState>();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const load = async () => {
    setError('');
    try { setModel(await api.studioFederationDashboard(creatorId) as HomeFederationDashboardModel); }
    catch (loadError) { setError(loadError instanceof Error ? loadError.message : 'Unable to load federation.'); }
  };
  useEffect(() => { void load(); }, [creatorId]);
  useEffect(() => {
    const element = dialogRef.current;
    if (dialog && element && !element.open) element.showModal();
    if (!dialog && element?.open) element.close();
  }, [dialog]);
  const act = async (operation: () => Promise<unknown>) => {
    setBusy(true); setError('');
    try { await operation(); setDialog(undefined); await load(); }
    catch (actionError) { setError(actionError instanceof Error ? actionError.message : 'Federation action failed.'); }
    finally { setBusy(false); }
  };
  const connect = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const destinationInstanceId = String(data.get('destinationInstanceId') || '');
    const destination = model?.destinations.find((item) => item.instanceId === destinationInstanceId);
    if (!destination) { setError('Choose an available destination.'); return; }
    const scopes = INITIAL_SCOPES.filter((scope) => data.getAll('scopes').includes(scope));
    if (!scopes.length || data.get('policyAccepted') !== 'yes') { setError('Accept the destination policy and choose at least one permission.'); return; }
    const expiryInput = String(data.get('expiresAt') || '');
    const expiresAt = expiryInput ? new Date(expiryInput).toISOString() : undefined;
    void act(() => api.studioFederationConnect(creatorId, { destinationInstanceId, scopes: [...scopes], policyVersion: destination.policyVersion, expiresAt }));
  };
  const updateProfile = (event: FormEvent<HTMLFormElement>, destinationInstanceId: string) => {
    event.preventDefault(); const data = new FormData(event.currentTarget);
    void act(() => api.studioFederationUpdateProfile(creatorId, destinationInstanceId, { displayName: String(data.get('displayName') || ''), handle: String(data.get('handle') || ''), shortBio: String(data.get('shortBio') || '') || undefined }));
  };
  if (!model && !error) return <p role="status">Loading federation destinations…</p>;
  return <div aria-busy={busy}>
    {error && <p className="error" role="alert">{error}</p>}
    {model && <HomeFederationDashboard model={model} onSelectDestination={() => setDialog({ kind: 'connect' })} onEditProfile={(destinationInstanceId) => setDialog({ kind: 'profile', destinationInstanceId })} onPublish={(sourceWorkUri, destinationInstanceId) => void act(() => api.studioFederationPublish(creatorId, { sourceWorkUri, destinationInstanceId }))} onWithdraw={(publicationId) => { if (window.confirm('Withdraw this destination publication? The canonical Work will remain at home.')) void act(() => api.studioFederationWithdraw(creatorId, publicationId)); }} onRevoke={(destinationInstanceId) => { if (window.confirm(`Revoke federation access for ${destinationInstanceId}? New operations will stop immediately.`)) void act(() => api.studioFederationRevoke(creatorId, destinationInstanceId)); }} />}
    <dialog ref={dialogRef} className="federation-form-dialog" onCancel={() => { if (!busy) setDialog(undefined); }} onClose={() => setDialog(undefined)}>
      {dialog?.kind === 'connect' && <form onSubmit={connect}><p className="eyebrow">Creator consent</p><h2>Connect a destination</h2><label>Destination<select name="destinationInstanceId" required defaultValue=""><option value="" disabled>Choose a destination</option>{model?.destinations.filter((item) => item.status === 'not_connected' || item.status === 'revoked').map((item) => <option value={item.instanceId} key={item.instanceId}>{item.name} · policy {item.policyVersion}</option>)}</select></label><fieldset><legend>Permissions</legend>{INITIAL_SCOPES.map((scope) => <label className="federation-check" key={scope}><input type="checkbox" name="scopes" value={scope} defaultChecked /> {scope}</label>)}</fieldset><label>Grant expiry (optional)<input name="expiresAt" type="datetime-local" /></label><label className="federation-check"><input type="checkbox" name="policyAccepted" value="yes" required /> I accept the selected destination’s current policy and understand it moderates each publication independently.</label><DialogActions busy={busy} close={() => setDialog(undefined)} submit="Request connection" /></form>}
      {dialog?.kind === 'profile' && <form onSubmit={(event) => updateProfile(event, dialog.destinationInstanceId)}><p className="eyebrow">Destination-only identity</p><h2>Edit distribution profile</h2><p>This does not change your canonical home profile.</p><label>Display name<input name="displayName" required maxLength={80} /></label><label>Handle<input name="handle" required maxLength={40} pattern="[A-Za-z0-9._-]+" /></label><label>Short bio<textarea name="shortBio" maxLength={280} rows={4} /></label><DialogActions busy={busy} close={() => setDialog(undefined)} submit="Publish profile revision" /></form>}
    </dialog>
  </div>;
}

function DialogActions({ busy, close, submit }: { busy: boolean; close: () => void; submit: string }) {
  return <div className="studio-inline-actions"><button type="submit" className="auth-primary-btn" disabled={busy}>{busy ? 'Saving…' : submit}</button><button type="button" disabled={busy} onClick={close}>Cancel</button></div>;
}
