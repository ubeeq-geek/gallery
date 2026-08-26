import { useEffect, useId, useState, type ChangeEvent, type KeyboardEvent } from "react";

export interface ComboboxOption {
  value: string;
  label: string;
  description?: string;
  disabled?: boolean;
}

export interface ComboboxProps {
  label: string;
  query: string;
  options: readonly ComboboxOption[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onQueryChange: (query: string) => void;
  onSelect: (option: ComboboxOption) => void;
  id?: string;
  description?: string;
  error?: string;
  placeholder?: string;
  emptyMessage?: string;
  loading?: boolean;
  disabled?: boolean;
  optional?: boolean;
}

/** Controlled searchable selection using the ARIA combobox/listbox interaction model. */
export function Combobox({ label, query, options, open, onOpenChange, onQueryChange, onSelect, id: suppliedId, description, error, placeholder, emptyMessage = "No options match", loading = false, disabled = false, optional = false }: ComboboxProps) {
  const generatedId = useId();
  const id = suppliedId ?? generatedId;
  const listboxId = `${id}-listbox`;
  const descriptionId = description ? `${id}-description` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  const enabledIndexes = options.map((option, index) => ({ option, index })).filter(({ option }) => !option.disabled).map(({ index }) => index);
  const [activeIndex, setActiveIndex] = useState(() => open ? enabledIndexes[0] ?? -1 : -1);

  useEffect(() => {
    setActiveIndex(open ? enabledIndexes[0] ?? -1 : -1);
  }, [open, options.length]);

  const move = (direction: 1 | -1) => {
    if (enabledIndexes.length === 0) return;
    const position = enabledIndexes.indexOf(activeIndex);
    const next = position === -1 ? direction === 1 ? 0 : enabledIndexes.length - 1 : (position + direction + enabledIndexes.length) % enabledIndexes.length;
    setActiveIndex(enabledIndexes[next]);
  };

  const select = (index: number) => {
    const option = options[index];
    if (!option || option.disabled) return;
    onSelect(option);
    onOpenChange(false);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (!open) onOpenChange(true);
      else move(event.key === "ArrowDown" ? 1 : -1);
    } else if (event.key === "Enter" && open && activeIndex >= 0) {
      event.preventDefault(); select(activeIndex);
    } else if (event.key === "Escape" && open) {
      event.preventDefault(); onOpenChange(false);
    }
  };

  const onChange = (event: ChangeEvent<HTMLInputElement>) => {
    onQueryChange(event.currentTarget.value);
    if (!open) onOpenChange(true);
  };

  return <div className="ds-field ds-combobox" onBlur={(event) => { if (open && !event.currentTarget.contains(event.relatedTarget)) onOpenChange(false); }}>
    <label className="ds-field-label" htmlFor={id}>{label}{optional && <> <span className="ds-field-label__optional">(optional)</span></>}</label>
    <div className="ds-combobox__control">
      <input id={id} className="ds-input" type="text" role="combobox" value={query} placeholder={placeholder} disabled={disabled} aria-autocomplete="list" aria-expanded={open} aria-controls={listboxId} aria-activedescendant={open && activeIndex >= 0 ? `${id}-option-${activeIndex}` : undefined} aria-invalid={Boolean(error) || undefined} aria-describedby={[descriptionId, errorId].filter(Boolean).join(" ") || undefined} onChange={onChange} onFocus={() => { if (!disabled) onOpenChange(true); }} onKeyDown={onKeyDown} />
      <span aria-hidden="true">⌄</span>
    </div>
    {description && <div className="ds-field-message" id={descriptionId}>{description}</div>}
    {error && <div className="ds-field-message ds-field-message--error" id={errorId} role="alert">{error}</div>}
    {open && <div className="ds-combobox__listbox" id={listboxId} role="listbox" aria-label={`${label} options`} aria-busy={loading || undefined}>
      {loading ? <div className="ds-combobox__state" role="status">Loading options…</div> : options.length === 0 ? <div className="ds-combobox__state">{emptyMessage}</div> : options.map((option, index) => <div key={option.value} id={`${id}-option-${index}`} role="option" aria-selected={index === activeIndex} aria-disabled={option.disabled || undefined} className={`ds-combobox__option${index === activeIndex ? " ds-combobox__option--active" : ""}${option.disabled ? " ds-combobox__option--disabled" : ""}`} onMouseDown={(event) => event.preventDefault()} onClick={() => select(index)}>
        <strong>{option.label}</strong>{option.description && <span>{option.description}</span>}
      </div>)}
    </div>}
  </div>;
}
