import type { ReactNode } from 'react';

type CardTone = 'default' | 'success' | 'warning' | 'danger' | 'info';

export function Card({
  title,
  eyebrow,
  actions,
  tone = 'default',
  className = '',
  children
}: {
  title?: string;
  eyebrow?: string;
  actions?: ReactNode;
  tone?: CardTone;
  className?: string;
  children: ReactNode;
}) {
  return (
    <section className={`panel studio-module-card studio-module-card-${tone}${className ? ` ${className}` : ''}`}>
      {(title || eyebrow || actions) && (
        <div className="studio-module-card-header">
          <div>
            {eyebrow && <p className="studio-module-eyebrow">{eyebrow}</p>}
            {title && <h3>{title}</h3>}
          </div>
          {actions && <div className="studio-module-actions">{actions}</div>}
        </div>
      )}
      {children}
    </section>
  );
}
