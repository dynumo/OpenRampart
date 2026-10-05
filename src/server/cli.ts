import { eq, sql } from 'drizzle-orm';
import { adminResetTotp, createAccount, operatorSetPassword } from './auth/accounts.js';
import { revokeAllSessions } from './auth/sessions.js';
import { closeDb, db, getPool } from './db/client.js';
import { runMigrations } from './db/migrator.js';
import { users } from './db/schema.js';
import { audit } from './domain/audit.js';
import { runMaintenance } from './jobs/maintenance.js';

/**
 * Operator command line (run inside the container):
 *   node dist/server/cli.js migrate
 *   node dist/server/cli.js create-admin <username> <display name>   (password read from OPENRAMPART_PASSWORD)
 *   node dist/server/cli.js reset-password <username>                (new password read from OPENRAMPART_PASSWORD)
 *   node dist/server/cli.js reset-totp <username>
 *   node dist/server/cli.js disable <username> | enable <username>
 *   node dist/server/cli.js maintenance
 */
async function findUser(username: string) {
  const [u] = await db()
    .select()
    .from(users)
    .where(sql`lower(${users.username}) = lower(${username})`)
    .limit(1);
  if (!u) throw new Error(`No account named ${username}`);
  return u;
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  switch (command) {
    case 'migrate': {
      const r = await runMigrations(getPool());
      console.log(`Applied ${r.applied.length} migration(s).`);
      break;
    }
    case 'create-admin': {
      const [username, ...name] = args;
      const password = process.env.OPENRAMPART_PASSWORD;
      if (!username || !password)
        throw new Error(
          'Usage: OPENRAMPART_PASSWORD=... cli.js create-admin <username> <display name>',
        );
      const u = await createAccount(
        { username, displayName: name.join(' ') || username, password },
        { ip: 'cli' },
        { forceAdmin: true },
      );
      console.log(
        `Created administrator ${u.username}. Two-step sign-in will be set up at first sign-in.`,
      );
      break;
    }
    case 'reset-password': {
      const password = process.env.OPENRAMPART_PASSWORD;
      if (!args[0] || !password)
        throw new Error('Usage: OPENRAMPART_PASSWORD=... cli.js reset-password <username>');
      const u = await findUser(args[0]);
      await operatorSetPassword(u.id, password);
      console.log(
        `New password set for ${u.username}; their sessions were signed out. Two-step sign-in is unchanged.`,
      );
      break;
    }
    case 'reset-totp': {
      const u = await findUser(args[0] ?? '');
      await adminResetTotp({ ...u, isAdmin: true }, u.id, { ip: 'cli' });
      console.log(
        `Two-step sign-in reset for ${u.username}; they will enrol again at next sign-in.`,
      );
      break;
    }
    case 'disable':
    case 'enable': {
      const u = await findUser(args[0] ?? '');
      await db()
        .update(users)
        .set({ disabledAt: command === 'disable' ? new Date() : null })
        .where(eq(users.id, u.id));
      if (command === 'disable') await revokeAllSessions(u.id, 'disabled_by_cli');
      await audit({
        action: 'admin.action',
        ownerId: u.id,
        via: 'cli',
        targetType: 'user',
        targetId: u.id,
        metadata: { operation: `${command}_account` },
      });
      console.log(`${command === 'disable' ? 'Disabled' : 'Enabled'} ${u.username}.`);
      break;
    }
    case 'maintenance':
      console.log(await runMaintenance());
      break;
    default:
      console.log(
        'Commands: migrate | create-admin <username> <name> | reset-password <username> | reset-totp <username> | disable <username> | enable <username> | maintenance',
      );
  }
}

main()
  .then(() => closeDb())
  .catch(async (err) => {
    console.error((err as Error).message);
    await closeDb().catch(() => undefined);
    process.exit(1);
  });
