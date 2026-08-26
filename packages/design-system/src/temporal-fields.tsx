import { useId, type InputHTMLAttributes } from "react";
import { TextField, type FieldPresentationProps } from "./fields.js";

type NativeTemporalProps = FieldPresentationProps & Omit<InputHTMLAttributes<HTMLInputElement>, "type" | "id"> & { id?: string };

export function DateField(props: NativeTemporalProps) { return <TextField {...props} type="date" />; }
export function TimeField(props: NativeTemporalProps) { return <TextField {...props} type="time" />; }

export interface DateTimeFieldProps extends FieldPresentationProps {
  id?: string; dateLabel?: string; timeLabel?: string; timezone?: string;
  dateInput?: Omit<InputHTMLAttributes<HTMLInputElement>, "type" | "id" | "aria-describedby" | "aria-invalid">;
  timeInput?: Omit<InputHTMLAttributes<HTMLInputElement>, "type" | "id" | "aria-describedby" | "aria-invalid">;
  disabled?: boolean; required?: boolean;
}

/** Grouped local date and time inputs. Applications remain responsible for UTC conversion. */
export function DateTimeField({ id: suppliedId, label, description, error, optional, dateLabel = "Date", timeLabel = "Time", timezone, dateInput = {}, timeInput = {}, disabled = false, required = false }: DateTimeFieldProps) {
  const generatedId = useId(); const id = suppliedId ?? generatedId;
  const descriptionId = description ? `${id}-description` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  const describedBy = [descriptionId, errorId].filter(Boolean).join(" ") || undefined;
  return <fieldset className="ds-field ds-date-time-field" aria-describedby={describedBy} aria-invalid={Boolean(error) || undefined} disabled={disabled}>
    <legend className="ds-field-label">{label}{optional && <> <span className="ds-field-label__optional">(optional)</span></>}</legend>
    {description && <div className="ds-field-message" id={descriptionId}>{description}</div>}
    <div className="ds-date-time-field__inputs">
      <label htmlFor={`${id}-date`}><span>{dateLabel}</span><input {...dateInput} id={`${id}-date`} className="ds-input" type="date" required={required} aria-describedby={describedBy} aria-invalid={Boolean(error) || undefined} /></label>
      <label htmlFor={`${id}-time`}><span>{timeLabel}</span><input {...timeInput} id={`${id}-time`} className="ds-input" type="time" required={required} aria-describedby={describedBy} aria-invalid={Boolean(error) || undefined} /></label>
    </div>
    {timezone && <div className="ds-date-time-field__timezone">Time zone: <strong>{timezone}</strong></div>}
    {error && <div className="ds-field-message ds-field-message--error" id={errorId} role="alert">{error}</div>}
  </fieldset>;
}
