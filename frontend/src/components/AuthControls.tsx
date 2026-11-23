import { useId, useState, type ComponentProps, type FocusEvent, type ReactNode } from 'react';
import { Eye, EyeOff } from 'lucide-react';
import type { Role } from '../../../shared/roles.mjs';
import { t, locale } from '../i18n';
import { useAction } from '../useAction';

export function roleLabel(role: Role): string {
  switch (role) {
    case 'admin':
      return t('Admin');
    case 'member':
      return t('Member');
  }
}

export function ActionError({ error, id }: { error: string; id?: string }) {
  return error ? (
    <p id={id} className="error auth-error" role="alert">
      {t(error)}
    </p>
  ) : null;
}

export function EmailField(props: Omit<ComponentProps<'input'>, 'type'>) {
  return (
    <label className="security-field">
      {t('Email address')}
      <input
        name="email"
        type="email"
        autoComplete="email"
        autoCapitalize="none"
        spellCheck={false}
        maxLength={254}
        required
        {...props}
      />
    </label>
  );
}

export function DisplayNameField(props: ComponentProps<'input'>) {
  return (
    <label className="security-field">
      {t('Display name')}
      <input name="display_name" autoComplete="nickname" maxLength={64} required {...props} />
    </label>
  );
}

export function PasswordField({
  label,
  ...props
}: Omit<ComponentProps<'input'>, 'type' | 'id'> & { label: string }) {
  const id = useId();
  const [show, setShow] = useState(false);
  return (
    <div className="security-field">
      <label htmlFor={id}>{label}</label>
      <div className="auth-password">
        <input {...props} id={id} type={show ? 'text' : 'password'} />
        <button
          type="button"
          className="icon-button"
          aria-label={t(show ? 'Hide password' : 'Show password')}
          aria-pressed={show}
          onClick={() => setShow(!show)}
        >
          {show ? <EyeOff size={18} aria-hidden="true" /> : <Eye size={18} aria-hidden="true" />}
        </button>
      </div>
    </div>
  );
}

export function CopyValue({
  label,
  value,
  wrap = false,
  canCopy,
}: {
  label: string;
  value: string;
  wrap?: boolean;
  canCopy?: () => boolean;
}) {
  const copy = useAction();
  const [copiedValue, setCopiedValue] = useState('');
  const id = useId();
  const field = {
    id,
    readOnly: true,
    value,
    spellCheck: false,
    autoComplete: 'off',
    onFocus: (event: FocusEvent<HTMLInputElement | HTMLTextAreaElement>) =>
      event.currentTarget.select(),
  };
  return (
    <div className="security-field">
      <label htmlFor={id}>{label}</label>
      <div className="secret-value">
        {wrap && value.length > 24 ? <textarea {...field} rows={2} /> : <input {...field} />}
        <button
          className="button"
          type="button"
          disabled={copy.busy}
          onClick={() =>
            void copy.run(async (active) => {
              if (canCopy && !canCopy()) return;
              try {
                await navigator.clipboard.writeText(value);
              } catch {
                document.getElementById(id)?.focus();
                throw new Error('Copy the selected text manually.');
              }
              if (active()) setCopiedValue(value);
            })
          }
        >
          {t(value === copiedValue ? 'Copied' : 'Copy')}
        </button>
      </div>
      <span className="visually-hidden" role="status">
        {value === copiedValue && t('Copied')}
      </span>
      <ActionError error={copy.error} />
    </div>
  );
}

export function AccountTime({ value }: { value: number | null }) {
  if (value === null) return t('Unavailable');
  const date = new Date(value * 1000);
  return <time dateTime={date.toISOString()}>{date.toLocaleString(locale())}</time>;
}

export function SecuritySection({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: ReactNode;
}) {
  const id = useId();
  return (
    <section className="settings-section security-section" aria-labelledby={id}>
      <div>
        <h2 id={id}>{title}</h2>
        {description && <p>{description}</p>}
      </div>
      {children}
    </section>
  );
}
