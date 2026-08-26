import { forwardRef, type AnchorHTMLAttributes, type ButtonHTMLAttributes, type ReactNode } from "react";

export type ButtonVariant = "primary" | "secondary" | "destructive";
export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  loading?: boolean;
  loadingLabel?: string;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button({ variant = "primary", loading = false, loadingLabel = "Working…", disabled, className = "", children, type = "button", ...props }, ref) {
  return <button {...props} ref={ref} type={type} className={`ds-button ds-button--${variant}${className ? ` ${className}` : ""}`} disabled={disabled || loading} aria-busy={loading || undefined}>
    {loading && <span className="ds-button__spinner" aria-hidden="true" />}<span>{loading ? loadingLabel : children}</span>
  </button>;
});

export interface IconButtonProps extends Omit<ButtonProps, "children" | "aria-label"> {
  accessibleName: string;
  icon: ReactNode;
}
export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton({ accessibleName, icon, className = "", ...props }, ref) {
  return <Button {...props} ref={ref} className={`ds-button--icon${className ? ` ${className}` : ""}`} aria-label={accessibleName}><span aria-hidden="true">{icon}</span></Button>;
});

export interface LinkButtonProps extends AnchorHTMLAttributes<HTMLAnchorElement> { variant?: ButtonVariant; disabled?: boolean }
export const LinkButton = forwardRef<HTMLAnchorElement, LinkButtonProps>(function LinkButton({ variant = "primary", disabled = false, className = "", children, href, onClick, ...props }, ref) {
  return <a {...props} ref={ref} className={`ds-button ds-button--${variant}${className ? ` ${className}` : ""}`} href={disabled ? undefined : href} aria-disabled={disabled || undefined} tabIndex={disabled ? -1 : props.tabIndex} onClick={disabled ? event => event.preventDefault() : onClick}>{children}</a>;
});
