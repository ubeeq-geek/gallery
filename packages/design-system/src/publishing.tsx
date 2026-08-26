import { useId, type ReactNode } from "react";
import { Button } from "./controls.js";

export type DestinationEligibility = "checking" | "eligible" | "ineligible" | "permission_restricted" | "unavailable";

const eligibilityPresentation: Record<DestinationEligibility, { label: string; tone: string; icon: string }> = {
  checking: { label: "Checking destination eligibility", tone: "pending", icon: "↻" },
  eligible: { label: "Eligible for this destination", tone: "success", icon: "✓" },
  ineligible: { label: "Not eligible for this destination", tone: "attention", icon: "!" },
  permission_restricted: { label: "You cannot publish to this destination", tone: "restricted", icon: "◆" },
  unavailable: { label: "Destination unavailable", tone: "unavailable", icon: "–" }
};

export interface PublishConfirmationProps {
  sourceLabel: string;
  sourceAuthority: string;
  destinationLabel: string;
  destinationAuthority: string;
  effect: string;
  unchangedFacts: readonly string[];
  eligibility: DestinationEligibility;
  eligibilityExplanation: string;
  disclosure?: ReactNode;
  confirmed: boolean;
  onConfirmedChange?: (confirmed: boolean) => void;
  onSubmit?: () => void;
  onCancel?: () => void;
  submitting?: boolean;
}

export function PublishConfirmation(props: PublishConfirmationProps) {
  const titleId = useId();
  const eligibility = eligibilityPresentation[props.eligibility];
  const canSubmit = props.eligibility === "eligible" && props.confirmed && !props.submitting;
  return <section className="ds-publish-confirmation" aria-labelledby={titleId}>
    <div><div className="ds-work-card__eyebrow">Final confirmation</div><h2 id={titleId}>Confirm publication request</h2></div>
    <dl className="ds-publish-summary">
      <div><dt>Selected source</dt><dd>{props.sourceLabel}</dd><dd className="ds-field-message">{props.sourceAuthority}</dd></div>
      <div><dt>Destination</dt><dd>{props.destinationLabel}</dd><dd className="ds-field-message">{props.destinationAuthority}</dd></div>
      <div><dt>This request will</dt><dd>{props.effect}</dd></div>
      <div><dt>This request will not</dt><dd><ul className="ds-unchanged-list">{props.unchangedFacts.map(fact => <li key={fact}>{fact}</li>)}</ul></dd></div>
    </dl>
    <div className={`ds-status ds-status--${eligibility.tone}`} role="status" aria-label={eligibility.label}>
      <span className="ds-status__icon" aria-hidden="true">{eligibility.icon}</span><div><div className="ds-status__title">{eligibility.label}</div><p className="ds-status__detail">{props.eligibilityExplanation}</p></div>
    </div>
    {props.disclosure}
    <label className="ds-confirmation-check"><input type="checkbox" checked={props.confirmed} disabled={props.eligibility !== "eligible" || props.submitting} onChange={event => props.onConfirmedChange?.(event.currentTarget.checked)} /><span><strong>I understand the destination and effect of this request.</strong><br /><span className="ds-field-message">Publication is not complete until the destination confirms it.</span></span></label>
    <div className="ds-page-header__actions">
      {props.onCancel && <Button variant="secondary" disabled={props.submitting} onClick={props.onCancel}>Cancel</Button>}
      <Button disabled={!canSubmit} loading={props.submitting} loadingLabel="Requesting publication…" onClick={props.onSubmit}>Request publication</Button>
    </div>
  </section>;
}
