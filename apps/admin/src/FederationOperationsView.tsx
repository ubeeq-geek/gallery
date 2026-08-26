import { useEffect, useState, type FormEvent } from 'react';

type Snapshot = {
  projections: Array<{ actorUri: string; displayName: string; homeInstanceId: string; trustState: string; moderationState: string; profileVisible: boolean }>;
  failedDeliveries: Array<{ id: string; operation: string; attemptCount: number; lastError?: string; updatedAt: string }>;
  reconciliation: Array<{ publicationId: string; sourceRevision: number; appliedSourceRevision?: number; status: string; drifted: boolean; driftReason?: string }>;
};
type Request = (path: string, method?: string, body?: unknown) => Promise<unknown>;

export function FederationOperationsView({ request }: { request: Request }) {
  const [snapshot, setSnapshot] = useState<Snapshot>();
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [projectionAction, setProjectionAction] = useState<{ actorUri: string; visible: boolean }>();
  const [replayAction, setReplayAction] = useState<string>();
  const load = async () => {
    try { setError(''); setSnapshot(await request('/admin/federation/operator') as Snapshot); }
    catch (loadError) { setError(loadError instanceof Error ? loadError.message : 'Unable to load federation operations.'); }
  };
  useEffect(() => { void load(); }, []);
  const act = async (operation: () => Promise<unknown>, success: string) => {
    setBusy(true); setError(''); setMessage('');
    try { await operation(); setMessage(success); await load(); }
    catch (actionError) { setError(actionError instanceof Error ? actionError.message : 'Federation action failed.'); }
    finally { setBusy(false); }
  };
  const moderate = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); const data = new FormData(event.currentTarget);
    const publicationId = String(data.get('publicationId') || ''); const status = String(data.get('status') || ''); const reason = String(data.get('reason') || '');
    void act(() => request(`/admin/federation/publications/${encodeURIComponent(publicationId)}/moderation`, 'PATCH', { status, reason }), `Publication ${publicationId} updated.`);
  };
  return <div className="federation-operations">
    <header><p className="eyebrow">Managed federation</p><h2>Federation operations</h2><p className="muted">Destination-only controls never edit canonical home Works or profiles.</p><button type="button" onClick={() => void load()} disabled={busy}>Refresh</button></header>
    {error && <p className="error" role="alert">{error}</p>}{message && <p className="success" role="status">{message}</p>}
    {!snapshot && !error && <p role="status">Loading federation operations…</p>}
    {snapshot && <>
      <section className="content-card"><h3>Remote creator projections</h3>{snapshot.projections.length === 0 ? <p className="muted">No remote projections.</p> : <div className="list">{snapshot.projections.map((projection) => <div className="list-row" key={projection.actorUri}><div><strong>{projection.displayName}</strong><div className="muted">{projection.actorUri}</div><div>{projection.homeInstanceId} · {projection.trustState} · {projection.moderationState} · {projection.profileVisible ? 'visible' : 'suppressed'}</div></div><button type="button" disabled={busy} onClick={() => setProjectionAction({ actorUri: projection.actorUri, visible: !projection.profileVisible })}>{projection.profileVisible ? 'Suppress' : 'Restore'}</button></div>)}</div>}{projectionAction && <form className="federation-confirm-form" onSubmit={(event) => { event.preventDefault(); const reason = String(new FormData(event.currentTarget).get('reason') || ''); void act(() => request('/admin/federation/projections', 'PATCH', { ...projectionAction, reason }), `Projection ${projectionAction.visible ? 'restored' : 'suppressed'}.`).then(() => setProjectionAction(undefined)); }}><p><strong>{projectionAction.visible ? 'Restore' : 'Suppress'} projection</strong></p><code>{projectionAction.actorUri}</code><label>Reason<textarea name="reason" required rows={2} /></label><div><button type="submit" disabled={busy}>Confirm</button><button type="button" disabled={busy} onClick={() => setProjectionAction(undefined)}>Cancel</button></div></form>}</section>
      <section className="content-card"><h3>Publication moderation</h3><form className="federation-admin-form" onSubmit={moderate}><label>Publication ID<input name="publicationId" required /></label><label>Decision<select name="status" defaultValue="held"><option value="published">Publish</option><option value="held">Hold</option><option value="rejected">Reject</option><option value="removed">Remove</option></select></label><label>Reason<textarea name="reason" required rows={3} /></label><button type="submit" disabled={busy}>Apply destination decision</button></form></section>
      <section className="content-card"><h3>Dead-letter deliveries</h3>{snapshot.failedDeliveries.length === 0 ? <p className="muted">No failed deliveries.</p> : <div className="list">{snapshot.failedDeliveries.map((delivery) => <div className="list-row" key={delivery.id}><div><strong>{delivery.operation}</strong><div className="muted">{delivery.id} · {delivery.attemptCount} attempts · {delivery.lastError || 'No error detail'}</div></div><button type="button" disabled={busy} onClick={() => setReplayAction(delivery.id)}>Replay</button></div>)}</div>}{replayAction && <form className="federation-confirm-form" onSubmit={(event) => { event.preventDefault(); const data = new FormData(event.currentTarget); const reason = String(data.get('reason') || ''); const confirmation = String(data.get('confirmation') || ''); void act(() => request(`/admin/federation/deliveries/${encodeURIComponent(replayAction)}/replay`, 'POST', { reason, confirmation }), `Delivery ${replayAction} queued for replay.`).then(() => setReplayAction(undefined)); }}><p><strong>Replay dead-letter delivery</strong></p><label>Reason<textarea name="reason" required rows={2} /></label><label>Type <code>REPLAY {replayAction}</code><input name="confirmation" required pattern={`REPLAY ${replayAction.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`} autoComplete="off" /></label><div><button type="submit" disabled={busy}>Confirm replay</button><button type="button" disabled={busy} onClick={() => setReplayAction(undefined)}>Cancel</button></div></form>}</section>
      <section className="content-card"><h3>Reconciliation</h3><div className="list">{snapshot.reconciliation.map((entry) => <div className="list-row" key={entry.publicationId}><span>{entry.publicationId} · source revision {entry.sourceRevision} · applied {entry.appliedSourceRevision ?? 'none'} · {entry.status}</span><strong className={entry.drifted ? 'error' : 'success'}>{entry.drifted ? `Drift: ${entry.driftReason?.replace(/_/g, ' ')}` : 'Current'}</strong></div>)}</div></section>
    </>}
  </div>;
}
