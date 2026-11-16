import { useRef, useState, type ReactElement, type ReactNode } from 'react';
import * as Select from '@radix-ui/react-select';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { Check, ChevronDown, ChevronUp } from 'lucide-react';
import { Link } from 'react-router-dom';

/* Portals must stay in the native modal/fullscreen top layer. The floating surface
   owns its theme tokens, so a menu on document.body keeps the member palette. */
function floatingContainer(trigger: HTMLElement | null) {
  return (
    trigger?.closest<HTMLElement>('dialog[open],[role="dialog"][aria-modal="true"]') ??
    (document.fullscreenElement as HTMLElement | null) ??
    document.body
  );
}

export type SelectOption = { value: string; label: string; disabled?: boolean };

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
}) {
  const trigger = useRef<HTMLButtonElement>(null);
  const [container, setContainer] = useState<HTMLElement | undefined>();
  return (
    <Select.Root
      value={value}
      onValueChange={onValueChange}
      disabled={disabled}
      onOpenChange={(open) => {
        if (open) setContainer(floatingContainer(trigger.current));
      }}
    >
      <Select.Trigger
        ref={trigger}
        id={id}
        className={'select-control ' + className}
        aria-label={label}
        data-keyboard-managed="true"
      >
        {icon && <span className="select-leading-icon">{icon}</span>}
        <Select.Value>{displayValue}</Select.Value>
        <Select.Icon className="select-chevron">
          <ChevronDown size={14} />
        </Select.Icon>
      </Select.Trigger>
      <Select.Portal container={container}>
        <Select.Content
          className="member-floating select-content"
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
                <Select.ItemText>{option.label}</Select.ItemText>
                <Select.ItemIndicator className="select-indicator">
                  <Check size={15} />
                </Select.ItemIndicator>
              </Select.Item>
            ))}
          </Select.Viewport>
          <Select.ScrollDownButton className="select-scroll">
            <ChevronDown size={15} />
          </Select.ScrollDownButton>
        </Select.Content>
      </Select.Portal>
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
  return (
    <DropdownMenu.Root
      modal={false}
      open={open}
      onOpenChange={(next) => {
        if (next) setContainer(floatingContainer(triggerRef.current));
        onOpenChange?.(next);
      }}
    >
      <DropdownMenu.Trigger asChild ref={triggerRef} data-keyboard-managed="true">
        {trigger}
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal container={container}>
        <DropdownMenu.Content
          className={'member-floating action-menu ' + className}
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
              {item.separatorBefore && <DropdownMenu.Separator className="action-menu-separator" />}
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
    </DropdownMenu.Root>
  );
}
