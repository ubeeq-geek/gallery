import { useEffect, useId, useRef, type ReactNode } from "react";
import { Button } from "./controls.js";

export interface DialogProps {
  open: boolean;
  title: string;
  description?: ReactNode;
  children?: ReactNode;
  actions?: ReactNode;
  closeLabel?: string;
  onOpenChange: (open: boolean) => void;
  variant?: "modal" | "drawer-start" | "drawer-end";
}

/**
 * A controlled modal surface built on the native dialog element. Applications
 * own the open state and must not use this presentational primitive as an
 * authorization boundary.
 */
export function Dialog({ open, title, description, children, actions, closeLabel = "Close", onOpenChange, variant = "modal" }: DialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const descriptionId = useId();

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  return <dialog
    ref={dialogRef}
    className={`ds-dialog ds-dialog--${variant}`}
    aria-labelledby={titleId}
    aria-describedby={description ? descriptionId : undefined}
    onCancel={(event) => { event.preventDefault(); onOpenChange(false); }}
    onClose={() => { if (open) onOpenChange(false); }}
  >
    <div className="ds-dialog__header">
      <h2 id={titleId}>{title}</h2>
      <Button variant="secondary" className="ds-dialog__close" aria-label={closeLabel} onClick={() => onOpenChange(false)}>×</Button>
    </div>
    {description && <div id={descriptionId} className="ds-dialog__description">{description}</div>}
    {children && <div className="ds-dialog__body">{children}</div>}
    {actions && <div className="ds-dialog__actions">{actions}</div>}
  </dialog>;
}

export interface DrawerProps extends Omit<DialogProps, "variant"> {
  placement?: "start" | "end";
}

/** A modal details workspace anchored to a viewport edge on wide screens. */
export function Drawer({ placement = "end", ...props }: DrawerProps) {
  return <Dialog {...props} variant={`drawer-${placement}`} />;
}

export interface ConfirmationDialogProps extends Omit<DialogProps, "children" | "actions"> {
  consequence: ReactNode;
  confirmLabel: string;
  cancelLabel?: string;
  destructive?: boolean;
  confirming?: boolean;
  confirmingLabel?: string;
  confirmDisabled?: boolean;
  onConfirm: () => void;
}

/** A deliberate confirmation checkpoint; permission must still be enforced server-side. */
export function ConfirmationDialog({ consequence, confirmLabel, cancelLabel = "Cancel", destructive = false, confirming = false, confirmingLabel = "Working…", confirmDisabled = false, onConfirm, onOpenChange, ...props }: ConfirmationDialogProps) {
  return <Dialog {...props} onOpenChange={onOpenChange} actions={<>
    <Button variant="secondary" disabled={confirming} onClick={() => onOpenChange(false)}>{cancelLabel}</Button>
    <Button variant={destructive ? "destructive" : "primary"} disabled={confirmDisabled} loading={confirming} loadingLabel={confirmingLabel} onClick={onConfirm}>{confirmLabel}</Button>
  </>}>
    <div className="ds-confirmation-consequence"><strong>What will happen</strong><div>{consequence}</div></div>
  </Dialog>;
}
