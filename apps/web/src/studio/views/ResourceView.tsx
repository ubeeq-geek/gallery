import { useEffect, useMemo, useState } from 'react';
import { Card } from '../components/Card';
import { CrudTable, type CrudRow } from '../components/CrudTable';
import { DataToolbar } from '../components/DataToolbar';
import { InspectorPanel } from '../components/InspectorPanel';
import { Pill } from '../components/Pill';

type ResourceItem = {
  id: string;
  title: string;
  subtitle?: string;
  meta?: string;
  status?: string;
  detail?: Array<{ label: string; value: string }>;
};

export function ResourceView({
  title,
  eyebrow,
  searchPlaceholder,
  emptyMessage,
  items
}: {
  title: string;
  eyebrow: string;
  searchPlaceholder: string;
  emptyMessage: string;
  items: ResourceItem[];
}) {
  const [search, setSearch] = useState('');
  const [selectedId, setSelectedId] = useState('');
  const filtered = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) return items;
    return items.filter((item) =>
      item.title.toLowerCase().includes(query)
      || (item.subtitle || '').toLowerCase().includes(query)
      || (item.meta || '').toLowerCase().includes(query)
    );
  }, [items, search]);

  useEffect(() => {
    if (!filtered.length) {
      setSelectedId('');
      return;
    }
    if (!filtered.some((item) => item.id === selectedId)) {
      setSelectedId(filtered[0].id);
    }
  }, [filtered, selectedId]);

  const selected = filtered.find((item) => item.id === selectedId) || filtered[0];
  const rows: CrudRow[] = filtered.map((item) => ({
    id: item.id,
    title: item.title,
    subtitle: item.subtitle,
    meta: item.meta,
    badges: item.status ? <Pill label={item.status} tone={item.status === 'active' || item.status === 'approved' ? 'success' : 'warning'} /> : undefined
  }));

  return (
    <section className="studio-surface-grid">
      <Card title={title} eyebrow={eyebrow}>
        <DataToolbar
          search={search}
          onSearchChange={setSearch}
          searchPlaceholder={searchPlaceholder}
          primaryAction={<button type="button" className="auth-primary-btn">Create</button>}
        />
        <CrudTable rows={rows} selectedId={selected?.id} onSelect={(row) => setSelectedId(row.id)} emptyMessage={emptyMessage} />
      </Card>

      <Card title="Detail" eyebrow="Inspector">
        {selected ? (
          <InspectorPanel
            title={selected.title}
            subtitle={selected.subtitle}
            status={selected.status ? <Pill label={selected.status} tone={selected.status === 'active' || selected.status === 'approved' ? 'success' : 'warning'} /> : undefined}
            actions={
              <>
                <button type="button" className="auth-secondary-btn">Edit</button>
                <button type="button" className="auth-secondary-btn">Review</button>
              </>
            }
          >
            <div className="studio-inspector-list">
              {(selected.detail || []).map((detail) => (
                <div key={`${selected.id}-${detail.label}`}>
                  <strong>{detail.label}</strong>
                  <span>{detail.value}</span>
                </div>
              ))}
            </div>
          </InspectorPanel>
        ) : (
          <div className="studio-empty-state">{emptyMessage}</div>
        )}
      </Card>
    </section>
  );
}
