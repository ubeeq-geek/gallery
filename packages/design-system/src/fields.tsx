import { useId, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from "react";

export interface FieldPresentationProps {
  label: string;
  description?: string;
  error?: string;
  optional?: boolean;
}

function FieldFrame({ id, label, description, error, optional, children }: FieldPresentationProps & { id: string; children: ReactNode }) {
  const descriptionId = `${id}-description`;
  const errorId = `${id}-error`;
  return <div className="ds-field">
    <label className="ds-field-label" htmlFor={id}>{label}{optional && <> <span className="ds-field-label__optional">(optional)</span></>}</label>
    {children}
    {description && <div className="ds-field-message" id={descriptionId}>{description}</div>}
    {error && <div className="ds-field-message ds-field-message--error" id={errorId} role="alert">{error}</div>}
  </div>;
}

function describedBy(id: string, description?: string, error?: string) {
  return [description && `${id}-description`, error && `${id}-error`].filter(Boolean).join(" ") || undefined;
}

export type TextFieldProps = FieldPresentationProps & Omit<InputHTMLAttributes<HTMLInputElement>, "id"> & { id?: string };
export function TextField({ label, description, error, optional, id: suppliedId, className = "", ...input }: TextFieldProps) {
  const generatedId = useId(); const id = suppliedId ?? generatedId;
  return <FieldFrame {...{ id, label, description, error, optional }}><input {...input} id={id} className={`ds-input${className ? ` ${className}` : ""}`} aria-invalid={Boolean(error) || undefined} aria-describedby={describedBy(id, description, error)} /></FieldFrame>;
}

export type TextareaFieldProps = FieldPresentationProps & Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, "id"> & { id?: string };
export function TextareaField({ label, description, error, optional, id: suppliedId, className = "", ...input }: TextareaFieldProps) {
  const generatedId = useId(); const id = suppliedId ?? generatedId;
  return <FieldFrame {...{ id, label, description, error, optional }}><textarea {...input} id={id} className={`ds-input ds-input--textarea${className ? ` ${className}` : ""}`} aria-invalid={Boolean(error) || undefined} aria-describedby={describedBy(id, description, error)} /></FieldFrame>;
}

export interface SelectOption { value: string; label: string; disabled?: boolean }
export type SelectFieldProps = FieldPresentationProps & Omit<SelectHTMLAttributes<HTMLSelectElement>, "id"> & { id?: string; options: readonly SelectOption[] };
export function SelectField({ label, description, error, optional, options, id: suppliedId, className = "", ...input }: SelectFieldProps) {
  const generatedId = useId(); const id = suppliedId ?? generatedId;
  return <FieldFrame {...{ id, label, description, error, optional }}><select {...input} id={id} className={`ds-input${className ? ` ${className}` : ""}`} aria-invalid={Boolean(error) || undefined} aria-describedby={describedBy(id, description, error)}>{options.map(option => <option key={option.value} value={option.value} disabled={option.disabled}>{option.label}</option>)}</select></FieldFrame>;
}

export type CheckboxFieldProps = Omit<InputHTMLAttributes<HTMLInputElement>, "id" | "type"> & { id?: string; label: string; description?: string; error?: string };
export function CheckboxField({ label, description, error, id: suppliedId, ...input }: CheckboxFieldProps) {
  const generatedId = useId(); const id = suppliedId ?? generatedId;
  return <div className="ds-field"><label className="ds-checkbox-field"><input {...input} id={id} type="checkbox" aria-invalid={Boolean(error) || undefined} aria-describedby={describedBy(id, description, error)} /><span><strong>{label}</strong>{description && <span className="ds-checkbox-field__description" id={`${id}-description`}>{description}</span>}</span></label>{error && <div className="ds-field-message ds-field-message--error" id={`${id}-error`} role="alert">{error}</div>}</div>;
}

export interface RadioOption { value: string; label: string; description?: string; disabled?: boolean }
export interface RadioGroupProps extends FieldPresentationProps {
  name: string; options: readonly RadioOption[]; value?: string; defaultValue?: string;
  disabled?: boolean; required?: boolean; onChange?: (value: string) => void;
}
export function RadioGroup({ label, description, error, optional, name, options, value, defaultValue, disabled, required, onChange }: RadioGroupProps) {
  const id = useId();
  const descriptionId = description ? `${id}-description` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  const ariaDescription = [descriptionId, errorId].filter(Boolean).join(" ") || undefined;
  return <fieldset className="ds-field ds-choice-group" aria-describedby={ariaDescription} aria-invalid={Boolean(error) || undefined} disabled={disabled}>
    <legend className="ds-field-label">{label}{optional && <> <span className="ds-field-label__optional">(optional)</span></>}</legend>
    {description && <div className="ds-field-message" id={descriptionId}>{description}</div>}
    <div className="ds-choice-group__options">{options.map((option, index) => {
      const optionId = `${id}-${index}`;
      return <label className="ds-choice-field" key={option.value} htmlFor={optionId}>
        <input checked={value === undefined ? undefined : value === option.value} defaultChecked={value === undefined ? defaultValue === option.value : undefined} disabled={option.disabled} id={optionId} name={name} onChange={() => onChange?.(option.value)} required={required} type="radio" value={option.value} />
        <span><strong>{option.label}</strong>{option.description && <span className="ds-choice-field__description">{option.description}</span>}</span>
      </label>;
    })}</div>
    {error && <div className="ds-field-message ds-field-message--error" id={errorId} role="alert">{error}</div>}
  </fieldset>;
}

export type SwitchFieldProps = Omit<InputHTMLAttributes<HTMLInputElement>, "id" | "type" | "role"> & { id?: string; label: string; description?: string };
export function SwitchField({ id: suppliedId, label, description, disabled, ...input }: SwitchFieldProps) {
  const generatedId = useId(); const id = suppliedId ?? generatedId;
  const descriptionId = description ? `${id}-description` : undefined;
  return <div className="ds-field"><label className="ds-switch-field" htmlFor={id}>
    <input {...input} aria-describedby={descriptionId} disabled={disabled} id={id} role="switch" type="checkbox" />
    <span className="ds-switch-field__control" aria-hidden="true"><span /></span>
    <span><strong>{label}</strong>{description && <span className="ds-choice-field__description" id={descriptionId}>{description}</span>}</span>
  </label></div>;
}
