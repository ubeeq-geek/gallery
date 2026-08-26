import { cloneElement, useEffect, useId, useRef, type KeyboardEvent, type ReactElement, type ReactNode } from "react";
import { Button, type ButtonVariant } from "./controls.js";

export interface TooltipProps {
  content: ReactNode;
  children: ReactElement<{ "aria-describedby"?: string }>;
  placement?: "top" | "bottom";
}

/** Supplemental text available on pointer hover and keyboard focus. Never place essential instructions only here. */
export function Tooltip({ content, children, placement = "top" }: TooltipProps) {
  const id = useId();
  const describedBy = [children.props["aria-describedby"], id].filter(Boolean).join(" ");
  return <span className={`ds-tooltip ds-tooltip--${placement}`}>
    {cloneElement(children, { "aria-describedby": describedBy })}
    <span className="ds-tooltip__content" id={id} role="tooltip">{content}</span>
  </span>;
}

export interface MenuItem {
  id: string;
  label: ReactNode;
  onSelect: () => void;
  disabled?: boolean;
  destructive?: boolean;
}

export interface MenuButtonProps {
  label: string;
  items: readonly MenuItem[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  disabled?: boolean;
  variant?: ButtonVariant;
}

/** Controlled action menu with roving keyboard focus. Applications supply only permitted actions. */
export function MenuButton({ label, items, open, onOpenChange, disabled = false, variant = "secondary" }: MenuButtonProps) {
  const menuId = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);

  const enabledIndexes = () => items.map((item, index) => ({ item, index })).filter(({ item }) => !item.disabled).map(({ index }) => index);
  const focusItem = (index: number) => itemRefs.current[index]?.focus();

  useEffect(() => {
    if (!open) return;
    const first = enabledIndexes()[0];
    if (first !== undefined) focusItem(first);
  }, [open]);

  const onMenuKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      onOpenChange(false);
      triggerRef.current?.focus();
      return;
    }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const enabled = enabledIndexes();
    if (enabled.length === 0) return;
    const current = enabled.findIndex((index) => itemRefs.current[index] === document.activeElement);
    if (event.key === "Home") focusItem(enabled[0]);
    else if (event.key === "End") focusItem(enabled[enabled.length - 1]);
    else if (event.key === "ArrowDown") focusItem(enabled[(current + 1) % enabled.length]);
    else focusItem(enabled[(current - 1 + enabled.length) % enabled.length]);
  };

  return <div className="ds-menu" onBlur={(event) => { if (open && !event.currentTarget.contains(event.relatedTarget)) onOpenChange(false); }}>
    <Button ref={triggerRef} variant={variant} disabled={disabled} aria-haspopup="menu" aria-expanded={open} aria-controls={open ? menuId : undefined} onClick={() => onOpenChange(!open)}>{label} <span aria-hidden="true">▾</span></Button>
    {open && <div ref={menuRef} className="ds-menu__content" id={menuId} role="menu" aria-label={label} onKeyDown={onMenuKeyDown}>
      {items.length === 0 && <span className="ds-menu__empty">No actions available</span>}
      {items.map((item, index) => <button
        key={item.id}
        ref={(node) => { itemRefs.current[index] = node; }}
        type="button"
        role="menuitem"
        className={item.destructive ? "ds-menu__item--destructive" : undefined}
        disabled={item.disabled}
        tabIndex={item.disabled || index !== enabledIndexes()[0] ? -1 : 0}
        onClick={() => { item.onSelect(); onOpenChange(false); }}
      >{item.label}</button>)}
    </div>}
  </div>;
}

export interface SplitButtonProps {
  primaryLabel: ReactNode;
  onPrimaryAction: () => void;
  menuLabel: string;
  items: readonly MenuItem[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  variant?: ButtonVariant;
  disabled?: boolean;
  loading?: boolean;
  loadingLabel?: string;
}

/** Primary action paired with a separately named menu of application-permitted alternatives. */
export function SplitButton({ primaryLabel, onPrimaryAction, menuLabel, items, open, onOpenChange, variant = "primary", disabled = false, loading = false, loadingLabel = "Working…" }: SplitButtonProps) {
  return <div className={`ds-split-button ds-split-button--${variant}`} role="group" aria-label={menuLabel}>
    <Button variant={variant} disabled={disabled} loading={loading} loadingLabel={loadingLabel} onClick={onPrimaryAction}>{primaryLabel}</Button>
    <MenuButton label={menuLabel} items={items} open={open} onOpenChange={onOpenChange} disabled={disabled || loading} variant={variant} />
  </div>;
}
