import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { retireAccountMail, type AccountMail } from './account-mail.js';
import { adminAccess, auditAdmin, recheckAdminAccessOnFailure } from './admin-access.js';
import { adminUserRoutes, requireSignableAdmin } from './admin-users.js';
import { emailDeliveryEnabled, flagDefaults, type Config, type Flag } from './config.js';
import type { Store } from './db.js';
import { readMapPreparationState } from './map-readiness.js';
import { readPresentationStatus } from './presentation-assets.js';
import { roles } from './roles.js';
import { hasSteamOnlyAccounts, HttpError } from './security.js';

const roleSet = z
  .array(z.enum(roles))
  .max(roles.length)
  .refine((value) => new Set(value).size === value.length);

export function adminRoutes(app: FastifyInstance, db: Store, c: Config, mail?: AccountMail) {
  adminUserRoutes(app, db, c, mail);
  app.get('/api/admin', async (r) => {
    const [mapState, presentationAssets] = await Promise.all([
      readMapPreparationState(c),
      readPresentationStatus(c.mapJobsDir),
    ]).catch(recheckAdminAccessOnFailure(db, c, r, false));
    return db.transaction(() => {
      adminAccess(db, c, r, false);
      const flags = Object.fromEntries(
        Object.keys(flagDefaults).map((k) => [
          k,
          { value: db.flag(c, k as Flag), locked: c.flags[k as Flag] !== undefined },
        ]),
      );
      flags.email_delivery_enabled = {
        value: emailDeliveryEnabled(db, c),
        locked: !c.smtp || c.flags.email_delivery_enabled !== undefined,
      };
      return {
        mapReadiness: { ...mapState.diagnostics, enabled: flags.auto_official_maps_enabled.value },
        presentationAssets,
        flags,
        email_delivery_configured: Boolean(c.smtp),
        mfa_required_roles: {
          value: db.mfaRequiredRoles(c),
          locked: c.mfaRequiredRoles !== undefined,
        },
        queue: db.all('SELECT status,count(*) AS count FROM demos GROUP BY status'),
      };
    });
  });

  app.patch('/api/admin', (r) => {
    const flags = z
      .partialRecord(z.enum(Object.keys(flagDefaults) as [Flag, ...Flag[]]), z.boolean())
      .refine((values) => Object.keys(values).length > 0)
      .parse(r.body);
    const disabledMail = db.transaction(() => {
      adminAccess(db, c, r, true);
      const steamWasEnabled = db.flag(c, 'steam_enabled');
      const mailWasEnabled = emailDeliveryEnabled(db, c);
      if (flags.email_delivery_enabled && !c.smtp && c.flags.email_delivery_enabled === undefined)
        throw new HttpError(
          409,
          'Configure the SMTP relay before enabling email delivery.',
          undefined,
          'email_delivery_unavailable',
        );
      for (const [key, value] of Object.entries(flags))
        if (c.flags[key as Flag] === undefined)
          db.run(
            'INSERT INTO settings VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
            key,
            Number(value),
          );
      if (steamWasEnabled && !db.flag(c, 'steam_enabled')) {
        requireSignableAdmin(db, c);
        if (hasSteamOnlyAccounts(db))
          throw new HttpError(
            409,
            'Some accounts sign in only with Steam. Before disabling it, ask those members to add a password or passkey, or help them reset their password in Users.',
          );
        db.retireSteamAttempts();
      }
      const disabledMail = mailWasEnabled && !emailDeliveryEnabled(db, c);
      if (disabledMail) retireAccountMail(db);
      auditAdmin(db, c, r, 'success');
      return disabledMail;
    });
    if (disabledMail) mail?.clearPending();
    return { ok: true };
  });

  app.put('/api/admin/mfa-policy', (r) => {
    const body = z.strictObject({ roles: roleSet, expected_roles: roleSet }).parse(r.body);
    return db.transaction(() => {
      adminAccess(db, c, r, true);
      if (c.mfaRequiredRoles !== undefined)
        throw new HttpError(409, 'Second-factor policy is locked by the instance configuration.');
      const current = db.mfaRequiredRoles(c);
      const expected = body.expected_roles;
      if (current.length !== expected.length || !current.every((role) => expected.includes(role)))
        throw new HttpError(
          409,
          'The second-factor policy changed while you were editing.',
          undefined,
          'mfa_policy_conflict',
        );
      db.setMfaRequiredRoles(c, body.roles);
      auditAdmin(db, c, r, 'success');
      return { ok: true };
    });
  });
}
