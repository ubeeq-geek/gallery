import type { ReactNode } from 'react';

export function InspectorPanel({
  title,
  subtitle,
  status,
  actions,
  children
}: {
  title: string;
  subtitle?: string;
  status?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="studio-inspector">
      <div className="studio-inspector-header">
        <div>
          <h3>{title}</h3>
          {subtitle && <p className="small">{subtitle}</p>}
        </div>
        {status && <div className="studio-module-actions">{status}</div>}
      </div>
      {actions && <div className="studio-inspector-actions">{actions}</div>}
      <div className="studio-inspector-body">{children}</div>
    </div>
  );
}
