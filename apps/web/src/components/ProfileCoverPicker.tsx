import { useState } from 'react';
import { availableProfileCovers, defaultProfileCoverFor, defaultProfileCoverIdFor } from '../profileDefaults';

export function ProfileCoverPicker({
  identity,
  selectedPreset,
  customCoverSet = false,
  disabled = false,
  onChange
}: {
  identity: string;
  selectedPreset?: string;
  customCoverSet?: boolean;
  disabled?: boolean;
  onChange: (preset: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const options = availableProfileCovers();
  if (!options.length) return null;

  const resolvedPreset = selectedPreset || defaultProfileCoverIdFor(identity);
  const assignedCover = defaultProfileCoverFor(identity, resolvedPreset);
  const selectedLabel = options.find((option) => option.id === resolvedPreset)?.label || 'Choose a cover';

  return (
    <section className="studio-cover-preset-picker">
      <button
        type="button"
        className="studio-cover-preset-toggle"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => setOpen((current) => !current)}
      >
        {assignedCover && <img src={assignedCover} alt="" />}
        <span>
          <strong>{customCoverSet ? 'Default cover fallback' : 'Assigned cover'}</strong>
          <small>{selectedLabel}</small>
        </span>
        <span className="studio-cover-preset-chevron" aria-hidden="true">{open ? '⌃' : '⌄'}</span>
      </button>
      {open && (
        <div className="studio-cover-preset-options" role="listbox" aria-label="Available cover images">
          {options.map((option) => {
            const selected = option.id === resolvedPreset;
            return (
              <button
                type="button"
                role="option"
                aria-selected={selected}
                className={selected ? 'is-selected' : ''}
                key={option.id}
                onClick={() => {
                  onChange(option.id);
                  setOpen(false);
                }}
              >
                <img src={option.url} alt="" />
                <span>{option.label}</span>
                {selected && <b aria-hidden="true">✓</b>}
              </button>
            );
          })}
        </div>
      )}
      <p>{customCoverSet ? 'This cover will appear if the custom cover is removed.' : 'Choose the bundled cover shown on this public profile.'}</p>
    </section>
  );
}
