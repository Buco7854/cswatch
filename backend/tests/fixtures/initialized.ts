import type { Store } from '../../src/db.js';
import { now } from '../../src/db.js';

/** Trusted fixture initialization keeps ordinary account/access tests focused on
 * their boundary. First-run enrollment itself has a separate adversarial suite. */
export function initializeFixture(db: Store) {
  db.run(
    'INSERT INTO users VALUES(?,?,?,?,?)',
    'fixture-instance-admin',
    'fixture_instance_admin',
    null,
    1,
    now(),
  );
}
