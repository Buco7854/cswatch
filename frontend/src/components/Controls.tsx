import { useLayoutEffect, useRef, useState, type ReactElement, type ReactNode } from 'react';
import * as Select from '@radix-ui/react-select';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import {
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  LockKeyhole,
} from 'lucide-react';
import { Link } from 'react-router-dom';
import { useWorkspaceConcealed } from '../context';
import { t } from '../i18n';

/* Portals must stay in the native modal/fullscreen top layer. The floating surface
   owns its theme tokens, so a menu on document.body keeps the member palette. */
function floatingContainer(trigger: HTMLElement | null) {
  return (
    trigger?.closest<HTMLElement>('dialog[open],[role="dialog"][aria-modal="true"]') ??
    (document.fullscreenElement as HTMLElement | null) ??
    document.body
  );
}

export type SelectOption = {
  value: string;
  label: string;
  compactLabel?: string;
  disabled?: boolean;
};

export function SelectControl({
  label,
  value,
  onValueChange,
  options,
  className = '',
  icon,
  disabled,
  id,
  displayValue,
  describedBy,
}: {
  label: string;
  value: string;
  onValueChange: (value: string) => void;
  options: SelectOption[];
  className?: string;
  icon?: ReactNode;
  disabled?: boolean;
  id?: string;
  displayValue?: ReactNode;
  describedBy?: string;
}) {
  const trigger = useRef<HTMLButtonElement>(null);
  const [container, setContainer] = useState<HTMLElement | undefined>();
  const [viewerUI, setViewerUI] = useState(false);
  const [open, setOpen] = useState(false);
  const concealed = useWorkspaceConcealed();
  useLayoutEffect(() => {
    if (concealed) setOpen(false);
  }, [concealed]);
  const selected = options.find((option) => option.value === value);
  return (
    <Select.Root
      value={value}
      onValueChange={onValueChange}
      disabled={disabled}
      open={!concealed && open}
      onOpenChange={(open) => {
        setOpen(open);
        if (open) {
          setContainer(floatingContainer(trigger.current));
          setViewerUI(Boolean(trigger.current?.closest('.viewer-frame')));
        }
      }}
    >
      <Select.Trigger
        ref={trigger}
        id={id}
        className={'select-control ' + className}
        aria-label={label}
        aria-describedby={describedBy}
        title={selected ? label + ' · ' + selected.label : label}
        data-keyboard-managed="true"
      >
        {icon && <span className="select-leading-icon">{icon}</span>}
        <Select.Value className="select-value">
          {displayValue ??
            (selected?.compactLabel ? (
              <>
                <span className="select-value-long">{selected.label}</span>
                <span
                  className="select-value-short"
                  aria-hidden="true"
                  data-label={selected.compactLabel}
                />
              </>
            ) : undefined)}
        </Select.Value>
        <Select.Icon className="select-chevron">
          <ChevronDown size={14} />
        </Select.Icon>
      </Select.Trigger>
      {!concealed && (
        <Select.Portal container={container}>
          <Select.Content
            className="member-floating select-content"
            data-viewer-ui={viewerUI || undefined}
            position="popper"
            sideOffset={6}
            collisionPadding={12}
            align="end"
            data-keyboard-managed="true"
          >
            <Select.ScrollUpButton className="select-scroll">
              <ChevronUp size={15} />
            </Select.ScrollUpButton>
            <Select.Viewport className="select-viewport">
              {options.map((option) => (
                <Select.Item
                  key={option.value}
                  value={option.value}
                  disabled={option.disabled}
                  className="select-item"
                >
                  <Select.ItemText className="select-item-label">{option.label}</Select.ItemText>
                  <span className="select-item-status" aria-hidden="true">
                    <Select.ItemIndicator className="select-indicator">
                      <Check size={15} />
                    </Select.ItemIndicator>
                  </span>
                </Select.Item>
              ))}
            </Select.Viewport>
            <Select.ScrollDownButton className="select-scroll">
              <ChevronDown size={15} />
            </Select.ScrollDownButton>
          </Select.Content>
        </Select.Portal>
      )}
    </Select.Root>
  );
}

export type MenuAction = {
  id: string;
  label: string;
  icon?: ReactNode;
  to?: string;
  onSelect?: () => void;
  disabled?: boolean;
  danger?: boolean;
  separatorBefore?: boolean;
};

export function ActionMenu({
  label,
  trigger,
  items,
  heading,
  className = '',
  open,
  onOpenChange,
}: {
  label: string;
  trigger: ReactElement;
  items: MenuAction[];
  heading?: ReactNode;
  className?: string;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [container, setContainer] = useState<HTMLElement | undefined>();
  const [viewerUI, setViewerUI] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const concealed = useWorkspaceConcealed();
  const requestedOpen = open ?? menuOpen;
  useLayoutEffect(() => {
    if (!concealed || !requestedOpen) return;
    setMenuOpen(false);
    onOpenChange?.(false);
  }, [concealed, requestedOpen, onOpenChange]);
  return (
    <DropdownMenu.Root
      modal={false}
      open={!concealed && requestedOpen}
      onOpenChange={(next) => {
        setMenuOpen(next);
        if (next) {
          setContainer(floatingContainer(triggerRef.current));
          setViewerUI(Boolean(triggerRef.current?.closest('.viewer-frame')));
        }
        onOpenChange?.(next);
      }}
    >
      <DropdownMenu.Trigger asChild ref={triggerRef} data-keyboard-managed="true">
        {trigger}
      </DropdownMenu.Trigger>
      {!concealed && (
        <DropdownMenu.Portal container={container}>
          <DropdownMenu.Content
            className={'member-floating action-menu ' + className}
            data-viewer-ui={viewerUI || undefined}
            aria-label={label}
            aria-labelledby={undefined}
            align="end"
            sideOffset={8}
            collisionPadding={12}
            loop
            data-keyboard-managed="true"
          >
            {heading && (
              <DropdownMenu.Label className="action-menu-heading">{heading}</DropdownMenu.Label>
            )}
            {items.map((item) => (
              <div key={item.id} role="none">
                {item.separatorBefore && (
                  <DropdownMenu.Separator className="action-menu-separator" />
                )}
                <DropdownMenu.Item
                  asChild={Boolean(item.to)}
                  disabled={item.disabled}
                  onSelect={item.onSelect}
                  className={'action-menu-item' + (item.danger ? ' action-menu-danger' : '')}
                >
                  {item.to ? (
                    <Link to={item.to}>
                      {item.icon}
                      <span>{item.label}</span>
                    </Link>
                  ) : (
                    <>
                      {item.icon}
                      <span>{item.label}</span>
                    </>
                  )}
                </DropdownMenu.Item>
              </div>
            ))}
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      )}
    </DropdownMenu.Root>
  );
}

/** Previous and next page buttons around the current position. A missing handler
    disables its button. */
export function Pagination({
  status,
  previous,
  next,
}: {
  status: string;
  previous?: () => void;
  next?: () => void;
}) {
  return (
    <nav className="pagination" aria-label={t('Results pages')}>
      <button
        type="button"
        className="icon-button"
        title={t('Previous page')}
        aria-label={t('Previous page')}
        disabled={!previous}
        onClick={previous}
      >
        <ChevronLeft size={18} aria-hidden="true" />
      </button>
      <span role="status">{status}</span>
      <button
        type="button"
        className="icon-button"
        title={t('Next page')}
        aria-label={t('Next page')}
        disabled={!next}
        onClick={next}
      >
        <ChevronRight size={18} aria-hidden="true" />
      </button>
    </nav>
  );
}

/** A labelled on/off switch. A locked switch shows that the environment sets it. */
export function SwitchRow({
  label,
  description,
  locked = false,
  checked,
  disabled = false,
  onChange,
}: {
  label: string;
  description?: string;
  locked?: boolean;
  checked: boolean;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className="toggle-row">
      <span>
        {label}
        {description && <small>{description}</small>}
        {locked && (
          <small>
            <LockKeyhole size={12} aria-hidden="true" />
            {t('Managed by environment')}
          </small>
        )}
      </span>
      <input
        type="checkbox"
        role="switch"
        checked={checked}
        disabled={locked || disabled}
        onChange={(event) => onChange(event.target.checked)}
      />
    </label>
  );
}
