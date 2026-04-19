export function Pill({
  label,
  tone = 'default'
}: {
  label: string;
  tone?: 'default' | 'success' | 'warning' | 'danger' | 'info';
}) {
  return <span className={`studio-pill studio-pill-${tone}`}>{label}</span>;
}
