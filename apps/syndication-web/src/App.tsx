import { useEffect, useMemo, useState } from 'react';
import { getCurrentUser, getIdToken, signIn, signOut } from './cognitoAuth';

const apiBase = import.meta.env.VITE_SYNDICATION_API_BASE_URL || '';

type SourceStatus = 'active' | 'warning' | 'error';
type SourceTab = 'overview' | 'items' | 'logs' | 'settings';
type StatusFilter = 'all' | SourceStatus;
type SortOption = 'recent' | 'name' | 'status';
type PanelMode = 'create' | 'edit';
type SourceType = 'api' | 'rss' | 'manual';
type AuthType = 'apiKey' | 'none' | 'oauth';
type SyncFrequency = 'hourly' | '6hours' | 'daily' | 'weekly';
type Visibility = 'public' | 'internal';

interface SourceItem {
  sourceId: string;
  name: string;
  creatorUuid: string;
  creatorSlug: string;
  provider: 'openverse';
  createdAt: string;
}

interface SourceLogItem {
  time: string;
  level: 'success' | 'warning' | 'error';
  message: string;
}

interface SourceContentItem {
  id: string;
  kind: 'img' | 'vid' | 'txt';
  title: string;
  status: 'Published' | 'Pending' | 'Draft';
  dateLabel: string;
}

interface SourcePresentation {
  sourceId: string;
  name: string;
  slug: string;
  creatorName: string;
  creatorUuid: string;
  creatorSlug: string;
  status: SourceStatus;
  statusLabel: string;
  statusToneLabel: string;
  lastSyncLabel: string;
  nextSyncLabel: string;
  endpointUrl: string;
  sourceType: SourceType;
  authType: AuthType;
  syncFrequency: SyncFrequency;
  visibility: Visibility;
  contentTypes: Array<'Images' | 'Video' | 'Text'>;
  recentItems: SourceContentItem[];
  recentLogs: SourceLogItem[];
}

interface CreatorOption {
  id: string;
  label: string;
  slug: string;
}

interface SourceFormState {
  sourceName: string;
  slug: string;
  creatorId: string;
  customCreatorName: string;
  customCreatorUuid: string;
  sourceType: SourceType;
  endpointUrl: string;
  authType: AuthType;
  apiKey: string;
  syncFrequency: SyncFrequency;
  contentImages: boolean;
  contentVideo: boolean;
  contentText: boolean;
  visibility: Visibility;
}

const creatorOptions: CreatorOption[] = [
  { id: 'creator-jordan-lamden', label: 'Jordan Lamden', slug: 'jordan-lamden' },
  { id: 'creator-system', label: 'System', slug: 'system' },
  { id: 'creator-curation-team', label: 'Curation Team', slug: 'curation-team' }
];

const sourceFixtures: Record<string, Partial<SourcePresentation>> = {
  'daily-cosmos': {
    status: 'active',
    statusLabel: 'Active',
    statusToneLabel: 'Healthy',
    lastSyncLabel: '2h ago',
    nextSyncLabel: 'in 4h',
    endpointUrl: 'https://api.nasa.gov/planetary/apod',
    sourceType: 'api',
    authType: 'apiKey',
    syncFrequency: '6hours',
    visibility: 'public',
    contentTypes: ['Images', 'Video'],
    recentItems: [
      { id: 'item-1', kind: 'img', title: 'Galaxy Cluster', status: 'Published', dateLabel: 'Apr 16' },
      { id: 'item-2', kind: 'img', title: 'Nebula Composite', status: 'Pending', dateLabel: 'Apr 16' },
      { id: 'item-3', kind: 'img', title: 'Solar Flare', status: 'Published', dateLabel: 'Apr 15' }
    ],
    recentLogs: [
      { time: '12:01', level: 'success', message: '12 items ingested' },
      { time: '06:00', level: 'warning', message: '1 asset skipped for duplicate media' },
      { time: '00:00', level: 'success', message: '9 items ingested' }
    ]
  },
  'historic-archives-feed': {
    status: 'error',
    statusLabel: 'Error',
    statusToneLabel: 'Needs attention',
    lastSyncLabel: 'Failed',
    nextSyncLabel: 'retry pending',
    endpointUrl: 'https://archive.example.com/feed',
    sourceType: 'rss',
    authType: 'none',
    syncFrequency: 'daily',
    visibility: 'internal',
    contentTypes: ['Images', 'Text'],
    recentItems: [
      { id: 'item-4', kind: 'img', title: 'Historic Plate Scan', status: 'Draft', dateLabel: 'Apr 15' },
      { id: 'item-5', kind: 'txt', title: 'Archive Entry 184', status: 'Pending', dateLabel: 'Apr 14' }
    ],
    recentLogs: [
      { time: '06:00', level: 'error', message: 'Timeout while reading feed' },
      { time: '05:58', level: 'warning', message: 'Retry scheduled automatically' }
    ]
  }
};

const defaultRecentItems = (name: string): SourceContentItem[] => [
  { id: `${name}-1`, kind: 'img', title: `${name} Hero Asset`, status: 'Published', dateLabel: 'Apr 16' },
  { id: `${name}-2`, kind: 'vid', title: `${name} Motion Clip`, status: 'Pending', dateLabel: 'Apr 15' }
];

const defaultRecentLogs = (): SourceLogItem[] => [
  { time: '09:30', level: 'success', message: 'Sync finished without errors' },
  { time: '03:30', level: 'success', message: '6 items processed' }
];

const slugify = (value: string) =>
  value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'new-source';

const titleCase = (value: string) =>
  value
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');

const buildSourcePresentation = (source: SourceItem): SourcePresentation => {
  const slug = slugify(source.name);
  const fixture = sourceFixtures[slug] || {};
  const fallbackCreatorName = source.creatorSlug === 'system' ? 'System' : titleCase(source.creatorSlug || 'Jordan Lamden');

  return {
    sourceId: source.sourceId,
    name: source.name,
    slug,
    creatorName: fixture.creatorName || fallbackCreatorName,
    creatorUuid: source.creatorUuid,
    creatorSlug: source.creatorSlug,
    status: fixture.status || 'active',
    statusLabel: fixture.statusLabel || 'Active',
    statusToneLabel: fixture.statusToneLabel || 'Healthy',
    lastSyncLabel: fixture.lastSyncLabel || '3h ago',
    nextSyncLabel: fixture.nextSyncLabel || 'in 6h',
    endpointUrl: fixture.endpointUrl || 'https://api.openverse.org/v1/images/',
    sourceType: fixture.sourceType || 'api',
    authType: fixture.authType || 'apiKey',
    syncFrequency: fixture.syncFrequency || '6hours',
    visibility: fixture.visibility || 'public',
    contentTypes: fixture.contentTypes || ['Images'],
    recentItems: fixture.recentItems || defaultRecentItems(source.name),
    recentLogs: fixture.recentLogs || defaultRecentLogs()
  };
};

const initialSourceForm = (): SourceFormState => ({
  sourceName: 'Daily Cosmos / NASA',
  slug: 'daily-cosmos',
  creatorId: creatorOptions[0].id,
  customCreatorName: '',
  customCreatorUuid: '',
  sourceType: 'api',
  endpointUrl: 'https://api.nasa.gov/planetary/apod',
  authType: 'apiKey',
  apiKey: '',
  syncFrequency: '6hours',
  contentImages: true,
  contentVideo: true,
  contentText: false,
  visibility: 'public'
});

const authFetch = async (path: string, init?: RequestInit) => {
  const token = getIdToken();
  if (!token) throw new Error('Not authenticated');
  const response = await fetch(`${apiBase}${path}`, {
    ...init,
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${token}`,
      ...(init?.headers || {})
    }
  });
  if (!response.ok) {
    const message = await response.text();
    throw new Error(message || `Request failed with ${response.status}`);
  }
  return response.json();
};

export const App = () => {
  const [user, setUser] = useState(() => getCurrentUser());
  const [sources, setSources] = useState<SourceItem[]>([]);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [loading, setLoading] = useState(false);
  const [syncingId, setSyncingId] = useState('');

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');

  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [sortBy, setSortBy] = useState<SortOption>('recent');
  const [selectedSourceId, setSelectedSourceId] = useState('');
  const [activeTab, setActiveTab] = useState<SourceTab>('overview');

  const [panelOpen, setPanelOpen] = useState(false);
  const [panelMode, setPanelMode] = useState<PanelMode>('create');
  const [form, setForm] = useState<SourceFormState>(initialSourceForm());

  const sourceViews = useMemo(() => sources.map(buildSourcePresentation), [sources]);

  const filteredSources = useMemo(() => {
    const needle = search.trim().toLowerCase();
    const filtered = sourceViews.filter((source) => {
      const matchesSearch = !needle
        || source.name.toLowerCase().includes(needle)
        || source.slug.toLowerCase().includes(needle)
        || source.creatorName.toLowerCase().includes(needle);
      const matchesStatus = statusFilter === 'all' || source.status === statusFilter;
      return matchesSearch && matchesStatus;
    });

    return filtered.sort((a, b) => {
      if (sortBy === 'name') return a.name.localeCompare(b.name);
      if (sortBy === 'status') return a.statusLabel.localeCompare(b.statusLabel) || a.name.localeCompare(b.name);
      return b.name.localeCompare(a.name);
    });
  }, [search, sortBy, sourceViews, statusFilter]);

  const selectedSource = useMemo(
    () => filteredSources.find((source) => source.sourceId === selectedSourceId) || filteredSources[0] || null,
    [filteredSources, selectedSourceId]
  );

  useEffect(() => {
    if (selectedSource && selectedSource.sourceId !== selectedSourceId) {
      setSelectedSourceId(selectedSource.sourceId);
    }
  }, [selectedSource, selectedSourceId]);

  const loadSources = async () => {
    setLoading(true);
    setError('');
    try {
      const payload = await authFetch('/sources');
      setSources(Array.isArray(payload.items) ? payload.items : []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load sources');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (user) {
      void loadSources();
    }
  }, [user]);

  const openCreatePanel = () => {
    setPanelMode('create');
    setForm(initialSourceForm());
    setNotice('');
    setPanelOpen(true);
  };

  const openEditPanel = (source: SourcePresentation) => {
    const matchingCreator = creatorOptions.find((creator) => creator.slug === source.creatorSlug || creator.label === source.creatorName);
    setPanelMode('edit');
    setForm({
      sourceName: source.name,
      slug: source.slug,
      creatorId: matchingCreator?.id || 'custom',
      customCreatorName: matchingCreator ? '' : source.creatorName,
      customCreatorUuid: matchingCreator ? '' : source.creatorUuid,
      sourceType: source.sourceType,
      endpointUrl: source.endpointUrl,
      authType: source.authType,
      apiKey: '',
      syncFrequency: source.syncFrequency,
      contentImages: source.contentTypes.includes('Images'),
      contentVideo: source.contentTypes.includes('Video'),
      contentText: source.contentTypes.includes('Text'),
      visibility: source.visibility
    });
    setNotice('');
    setPanelOpen(true);
  };

  const handleRunSync = async (sourceId: string) => {
    setSyncingId(sourceId);
    setError('');
    setNotice('');
    try {
      await authFetch(`/sources/${sourceId}/run`, { method: 'POST' });
      setNotice('Sync triggered successfully.');
      await loadSources();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Run failed');
    } finally {
      setSyncingId('');
    }
  };

  const onSubmitSourceForm = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError('');
    setNotice('');

    if (panelMode === 'edit') {
      setNotice('Editing UI is staged, but update/save is not wired to the API yet.');
      return;
    }

    const selectedCreator = creatorOptions.find((creator) => creator.id === form.creatorId);
    const creatorUuid = form.creatorId === 'custom' ? form.customCreatorUuid.trim() : (selectedCreator?.id || '');
    const creatorSlug = form.slug.trim() || slugify(form.sourceName);

    if (!form.sourceName.trim() || !creatorUuid || !creatorSlug) {
      setError('Source name, slug, and creator are required.');
      return;
    }

    try {
      await authFetch('/sources', {
        method: 'POST',
        body: JSON.stringify({
          name: form.sourceName.trim(),
          creatorUuid,
          creatorSlug,
          clientId: form.endpointUrl.trim() || 'manual-source',
          clientSecret: form.authType === 'none' ? 'none' : (form.apiKey.trim() || 'placeholder-secret')
        })
      });
      setNotice('Source registered successfully.');
      setPanelOpen(false);
      setForm(initialSourceForm());
      await loadSources();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save');
    }
  };

  const selectedCreatorIsCustom = form.creatorId === 'custom';

  if (!user) {
    return (
      <main className="syndication-auth-shell">
        <section className="syndication-auth-card">
          <div className="syndication-brand-lockup">
            <span className="syndication-brand-kicker">Ubeeq Operations</span>
            <h1>Syndication Source Admin</h1>
            <p>Sign in with an Admin user to manage incoming content sources.</p>
          </div>
          <form
            className="syndication-auth-form"
            onSubmit={async (event) => {
              event.preventDefault();
              setError('');
              try {
                await signIn(email, password);
                setUser(getCurrentUser());
              } catch (err) {
                setError(err instanceof Error ? err.message : 'Sign in failed');
              }
            }}
          >
            <label className="field">
              <span>Email</span>
              <input value={email} onChange={(event) => setEmail(event.target.value)} placeholder="jordan@example.com" />
            </label>
            <label className="field">
              <span>Password</span>
              <input
                type="password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                placeholder="Enter your password"
              />
            </label>
            <button className="btn btn-primary btn-block" type="submit">Sign in</button>
          </form>
          {error && <p className="feedback feedback-error">{error}</p>}
        </section>
      </main>
    );
  }

  return (
    <div className="syndication-shell">
      <header className="syndication-topbar">
        <div>
          <p className="syndication-topbar-kicker">Content Operations</p>
          <h1>Syndication Admin</h1>
        </div>
        <div className="syndication-usercard">
          <div className="syndication-usercard-avatar">{user.username.charAt(0).toUpperCase()}</div>
          <div>
            <strong>{titleCase(user.username.split('@')[0].replace(/\./g, ' '))}</strong>
            <p>{user.username}</p>
          </div>
          <button
            className="btn btn-ghost"
            onClick={async () => {
              await signOut();
              setUser(null);
            }}
            type="button"
          >
            Sign out
          </button>
        </div>
      </header>

      <main className="syndication-content">
        <section className="content-card">
          <div className="section-header">
            <div>
              <p className="eyebrow">Source Catalog</p>
              <h2>Sources</h2>
            </div>
            <button className="btn btn-primary" onClick={openCreatePanel} type="button">+ New Source</button>
          </div>

          <div className="toolbar-card">
            <label className="field field-grow">
              <span>Search</span>
              <input
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Search sources, slugs, or creators..."
              />
            </label>
            <label className="field field-compact">
              <span>Status</span>
              <select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value as StatusFilter)}>
                <option value="all">All statuses</option>
                <option value="active">Active</option>
                <option value="warning">Warning</option>
                <option value="error">Error</option>
              </select>
            </label>
            <label className="field field-compact">
              <span>Sort</span>
              <select value={sortBy} onChange={(event) => setSortBy(event.target.value as SortOption)}>
                <option value="recent">Recent</option>
                <option value="name">Name</option>
                <option value="status">Status</option>
              </select>
            </label>
          </div>

          <div className="sources-layout">
            <div className="sources-list">
              {loading && <p className="muted">Loading sources...</p>}
              {!loading && filteredSources.length === 0 && (
                <div className="empty-card">
                  <h3>No sources yet</h3>
                  <p>Create a source to start managing ingest schedules and review logs in one place.</p>
                  <button className="btn btn-primary" onClick={openCreatePanel} type="button">Create source</button>
                </div>
              )}
              {filteredSources.map((source) => (
                <article
                  key={source.sourceId}
                  className={`source-card${selectedSource?.sourceId === source.sourceId ? ' is-selected' : ''}`}
                  onClick={() => {
                    setSelectedSourceId(source.sourceId);
                    setActiveTab('overview');
                  }}
                >
                  <div className="source-card-topline">
                    <div>
                      <h3>{source.name}</h3>
                      <p className="source-subline">slug: {source.slug}</p>
                    </div>
                    <span className={`status-pill status-${source.status}`}>
                      <span className="status-dot" />
                      {source.statusLabel}
                    </span>
                  </div>
                  <p className="source-subline">Creator: {source.creatorName}</p>
                  <div className="source-metrics">
                    <span>Last Sync: {source.lastSyncLabel}</span>
                    <span>Next: {source.nextSyncLabel}</span>
                  </div>
                  <div className="source-actions">
                    <button
                      className="btn btn-ghost"
                      onClick={(event) => {
                        event.stopPropagation();
                        openEditPanel(source);
                      }}
                      type="button"
                    >
                      Edit
                    </button>
                    <button
                      className="btn btn-primary"
                      disabled={syncingId === source.sourceId}
                      onClick={(event) => {
                        event.stopPropagation();
                        void handleRunSync(source.sourceId);
                      }}
                      type="button"
                    >
                      {syncingId === source.sourceId ? 'Syncing...' : source.status === 'error' ? 'Retry' : 'Sync Now'}
                    </button>
                    <button
                      className="btn btn-ghost"
                      onClick={(event) => {
                        event.stopPropagation();
                        setSelectedSourceId(source.sourceId);
                        setActiveTab('items');
                      }}
                      type="button"
                    >
                      View Items
                    </button>
                    <button
                      className="btn btn-ghost"
                      onClick={(event) => {
                        event.stopPropagation();
                        setSelectedSourceId(source.sourceId);
                        setActiveTab('logs');
                      }}
                      type="button"
                    >
                      Logs
                    </button>
                  </div>
                </article>
              ))}
            </div>

            <aside className="detail-card">
              {selectedSource ? (
                <>
                  <div className="detail-header">
                    <button className="btn btn-ghost btn-inline" onClick={() => setActiveTab('overview')} type="button">
                      Back
                    </button>
                    <div>
                      <h2>{selectedSource.name}</h2>
                      <p className="muted">Source detail</p>
                    </div>
                  </div>

                  <div className="tab-row">
                    {(['overview', 'items', 'logs', 'settings'] as SourceTab[]).map((tab) => (
                      <button
                        key={tab}
                        className={`tab-btn${activeTab === tab ? ' is-active' : ''}`}
                        onClick={() => setActiveTab(tab)}
                        type="button"
                      >
                        {tab.charAt(0).toUpperCase() + tab.slice(1)}
                      </button>
                    ))}
                  </div>

                  {activeTab === 'overview' && (
                    <div className="detail-section-stack">
                      <section className="detail-stat-grid">
                        <div className="detail-stat">
                          <span>Status</span>
                          <strong className={`status-text status-${selectedSource.status}`}>{selectedSource.statusLabel}</strong>
                        </div>
                        <div className="detail-stat">
                          <span>Last Sync</span>
                          <strong>{selectedSource.lastSyncLabel}</strong>
                        </div>
                        <div className="detail-stat">
                          <span>Next Sync</span>
                          <strong>{selectedSource.nextSyncLabel}</strong>
                        </div>
                      </section>

                      <section className="detail-block">
                        <p className="eyebrow">Endpoint</p>
                        <p className="endpoint-value">{selectedSource.endpointUrl}</p>
                        <div className="source-actions">
                          <button className="btn btn-primary" onClick={() => void handleRunSync(selectedSource.sourceId)} type="button">
                            Run Sync
                          </button>
                          <button className="btn btn-ghost" onClick={() => openEditPanel(selectedSource)} type="button">
                            Edit
                          </button>
                          <button
                            className="btn btn-danger"
                            onClick={() => setNotice('Disable flow is not wired yet, but the action is staged in the UI.')}
                            type="button"
                          >
                            Disable
                          </button>
                        </div>
                      </section>

                      <section className="detail-block">
                        <div className="detail-block-header">
                          <h3>Recent Items</h3>
                        </div>
                        <div className="detail-list">
                          {selectedSource.recentItems.map((item) => (
                            <div className="detail-list-row" key={item.id}>
                              <div className="item-title-wrap">
                                <span className="item-kind">{item.kind}</span>
                                <span>{item.title}</span>
                              </div>
                              <div className="item-meta">
                                <span>{item.status}</span>
                                <span>{item.dateLabel}</span>
                              </div>
                            </div>
                          ))}
                        </div>
                      </section>

                      <section className="detail-block">
                        <div className="detail-block-header">
                          <h3>Recent Logs</h3>
                        </div>
                        <div className="detail-list">
                          {selectedSource.recentLogs.map((log, index) => (
                            <div className="detail-list-row" key={`${log.time}-${index}`}>
                              <div className="item-title-wrap">
                                <span className={`log-pill log-${log.level}`}>{log.level}</span>
                                <span>{log.message}</span>
                              </div>
                              <div className="item-meta">
                                <span>{log.time}</span>
                              </div>
                            </div>
                          ))}
                        </div>
                      </section>
                    </div>
                  )}

                  {activeTab === 'items' && (
                    <section className="detail-block">
                      <div className="detail-block-header">
                        <h3>Recent Items</h3>
                        <span className="muted">{selectedSource.recentItems.length} tracked items</span>
                      </div>
                      <div className="detail-list">
                        {selectedSource.recentItems.map((item) => (
                          <div className="detail-list-row" key={item.id}>
                            <div className="item-title-wrap">
                              <span className="item-kind">{item.kind}</span>
                              <span>{item.title}</span>
                            </div>
                            <div className="item-meta">
                              <span>{item.status}</span>
                              <span>{item.dateLabel}</span>
                            </div>
                          </div>
                        ))}
                      </div>
                    </section>
                  )}

                  {activeTab === 'logs' && (
                    <section className="detail-block">
                      <div className="detail-block-header">
                        <h3>Recent Logs</h3>
                        <span className="muted">{selectedSource.statusToneLabel}</span>
                      </div>
                      <div className="detail-list">
                        {selectedSource.recentLogs.map((log, index) => (
                          <div className="detail-list-row" key={`${log.time}-${index}`}>
                            <div className="item-title-wrap">
                              <span className={`log-pill log-${log.level}`}>{log.level}</span>
                              <span>{log.message}</span>
                            </div>
                            <div className="item-meta">
                              <span>{log.time}</span>
                            </div>
                          </div>
                        ))}
                      </div>
                    </section>
                  )}

                  {activeTab === 'settings' && (
                    <section className="detail-block">
                      <div className="detail-block-header">
                        <h3>Source Settings</h3>
                      </div>
                      <div className="settings-grid">
                        <div className="detail-stat">
                          <span>Source Type</span>
                          <strong>{selectedSource.sourceType.toUpperCase()}</strong>
                        </div>
                        <div className="detail-stat">
                          <span>Auth</span>
                          <strong>{selectedSource.authType === 'apiKey' ? 'API Key' : selectedSource.authType.toUpperCase()}</strong>
                        </div>
                        <div className="detail-stat">
                          <span>Visibility</span>
                          <strong>{selectedSource.visibility}</strong>
                        </div>
                        <div className="detail-stat">
                          <span>Content Types</span>
                          <strong>{selectedSource.contentTypes.join(', ')}</strong>
                        </div>
                      </div>
                    </section>
                  )}
                </>
              ) : (
                <div className="empty-card">
                  <h3>Select a source</h3>
                  <p>Choose a source from the list to view overview, items, logs, and settings.</p>
                </div>
              )}
            </aside>
          </div>

          {(error || notice) && (
            <div className="feedback-stack">
              {error && <p className="feedback feedback-error">{error}</p>}
              {notice && <p className="feedback feedback-success">{notice}</p>}
            </div>
          )}
        </section>
      </main>

      <div className={`panel-backdrop${panelOpen ? ' is-open' : ''}`} onClick={() => setPanelOpen(false)} />
      <aside className={`slideover${panelOpen ? ' is-open' : ''}`}>
        <div className="slideover-header">
          <div>
            <p className="eyebrow">{panelMode === 'create' ? 'Register source' : 'Edit source'}</p>
            <h2>{panelMode === 'create' ? 'Register Source' : 'Update Source'}</h2>
          </div>
          <button className="btn btn-ghost" onClick={() => setPanelOpen(false)} type="button">Close</button>
        </div>

        <form className="slideover-form" onSubmit={onSubmitSourceForm}>
          <label className="field">
            <span>Source Name</span>
            <input
              value={form.sourceName}
              onChange={(event) => {
                const sourceName = event.target.value;
                setForm((current) => ({
                  ...current,
                  sourceName,
                  slug: current.slug === slugify(current.sourceName) || !current.slug ? slugify(sourceName) : current.slug
                }));
              }}
            />
          </label>

          <label className="field">
            <span>Slug</span>
            <input value={form.slug} onChange={(event) => setForm((current) => ({ ...current, slug: slugify(event.target.value) }))} />
          </label>

          <div className="field-row">
            <label className="field field-grow">
              <span>Creator</span>
              <select value={form.creatorId} onChange={(event) => setForm((current) => ({ ...current, creatorId: event.target.value }))}>
                {creatorOptions.map((creator) => (
                  <option key={creator.id} value={creator.id}>{creator.label}</option>
                ))}
                <option value="custom">Custom creator</option>
              </select>
            </label>
            <button className="btn btn-ghost field-inline-btn" onClick={() => setForm((current) => ({ ...current, creatorId: 'custom' }))} type="button">
              + New
            </button>
          </div>

          {selectedCreatorIsCustom && (
            <div className="field-row">
              <label className="field field-grow">
                <span>Creator Name</span>
                <input
                  value={form.customCreatorName}
                  onChange={(event) => setForm((current) => ({ ...current, customCreatorName: event.target.value }))}
                  placeholder="Jordan Lamden"
                />
              </label>
              <label className="field field-grow">
                <span>Creator ID</span>
                <input
                  value={form.customCreatorUuid}
                  onChange={(event) => setForm((current) => ({ ...current, customCreatorUuid: event.target.value }))}
                  placeholder="creator-jordan-lamden"
                />
              </label>
            </div>
          )}

          <fieldset className="choice-group">
            <legend>Source Type</legend>
            <div className="choice-row">
              <label><input checked={form.sourceType === 'api'} name="source-type" onChange={() => setForm((current) => ({ ...current, sourceType: 'api' }))} type="radio" /> API</label>
              <label><input checked={form.sourceType === 'rss'} name="source-type" onChange={() => setForm((current) => ({ ...current, sourceType: 'rss' }))} type="radio" /> RSS</label>
              <label><input checked={form.sourceType === 'manual'} name="source-type" onChange={() => setForm((current) => ({ ...current, sourceType: 'manual' }))} type="radio" /> Manual</label>
            </div>
          </fieldset>

          <label className="field">
            <span>Endpoint URL</span>
            <input
              value={form.endpointUrl}
              onChange={(event) => setForm((current) => ({ ...current, endpointUrl: event.target.value }))}
              placeholder="https://api.nasa.gov/planetary/apod"
            />
          </label>

          <fieldset className="choice-group">
            <legend>Auth Type</legend>
            <div className="choice-row">
              <label><input checked={form.authType === 'apiKey'} name="auth-type" onChange={() => setForm((current) => ({ ...current, authType: 'apiKey' }))} type="radio" /> API Key</label>
              <label><input checked={form.authType === 'none'} name="auth-type" onChange={() => setForm((current) => ({ ...current, authType: 'none' }))} type="radio" /> None</label>
              <label><input checked={form.authType === 'oauth'} name="auth-type" onChange={() => setForm((current) => ({ ...current, authType: 'oauth' }))} type="radio" /> OAuth</label>
            </div>
          </fieldset>

          <label className="field">
            <span>{form.authType === 'apiKey' ? 'API Key' : form.authType === 'oauth' ? 'OAuth Secret' : 'Credential'}</span>
            <input
              type="password"
              value={form.apiKey}
              onChange={(event) => setForm((current) => ({ ...current, apiKey: event.target.value }))}
              placeholder="****************"
            />
          </label>

          <label className="field">
            <span>Sync Frequency</span>
            <select value={form.syncFrequency} onChange={(event) => setForm((current) => ({ ...current, syncFrequency: event.target.value as SyncFrequency }))}>
              <option value="hourly">Every hour</option>
              <option value="6hours">Every 6 hours</option>
              <option value="daily">Daily</option>
              <option value="weekly">Weekly</option>
            </select>
          </label>

          <fieldset className="choice-group">
            <legend>Content Types</legend>
            <div className="choice-row choice-row-wrap">
              <label><input checked={form.contentImages} onChange={() => setForm((current) => ({ ...current, contentImages: !current.contentImages }))} type="checkbox" /> Images</label>
              <label><input checked={form.contentVideo} onChange={() => setForm((current) => ({ ...current, contentVideo: !current.contentVideo }))} type="checkbox" /> Video</label>
              <label><input checked={form.contentText} onChange={() => setForm((current) => ({ ...current, contentText: !current.contentText }))} type="checkbox" /> Text</label>
            </div>
          </fieldset>

          <fieldset className="choice-group">
            <legend>Visibility</legend>
            <div className="choice-row">
              <label><input checked={form.visibility === 'public'} name="visibility" onChange={() => setForm((current) => ({ ...current, visibility: 'public' }))} type="radio" /> Public</label>
              <label><input checked={form.visibility === 'internal'} name="visibility" onChange={() => setForm((current) => ({ ...current, visibility: 'internal' }))} type="radio" /> Internal</label>
            </div>
          </fieldset>

          <div className="slideover-footer">
            <button className="btn btn-ghost" onClick={() => setPanelOpen(false)} type="button">Cancel</button>
            <button className="btn btn-primary" type="submit">{panelMode === 'create' ? 'Register' : 'Save Changes'}</button>
          </div>
        </form>
      </aside>
    </div>
  );
};
