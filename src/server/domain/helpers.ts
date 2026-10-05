import { and, desc, eq, gt, inArray, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { GrantDTO, HelperDTO } from '../../shared/types.js';
import { config } from '../config.js';
import { db } from '../db/client.js';
import {
  accessGrants,
  actors,
  grantActors,
  grantIncidents,
  helperRelationships,
  incidents,
  invitations,
  users,
} from '../db/schema.js';
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '../lib/errors.js';
import { randomToken, tokenHash } from '../lib/crypto.js';
import { invitationEmail } from '../mail/templates.js';
import { mailConfigured, sendMail, sendNotification } from '../mail/index.js';
import { securityNotificationEmail } from '../mail/templates.js';
import { audit, auditCtx } from './audit.js';
import { isOwner, type AccessContext } from './context.js';
import { cleanIds, isUuid, iso } from './sqlutil.js';

/**
 * Helpers: trusted people the owner invites to view (and optionally add to,
 * or export) part or all of their record. Helpers are not administrators.
 *
 * A HelperRelationship links an owner to one helper account. It holds one or
 * more AccessGrants, each scoped by Actors, Incidents or "all records", an
 * optional date range, and the View / Add / Export capabilities. See
 * docs/authorisation.md for the evaluation rules.
 */

const dateString = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((v) => !Number.isNaN(Date.parse(v)), 'Enter a valid date');

export const grantInputSchema = z
  .object({
    scopeType: z.enum(['all', 'actors', 'incidents']),
    actorIds: z.array(z.string()).max(500).optional(),
    incidentIds: z.array(z.string()).max(500).optional(),
    dateFrom: dateString.nullish(),
    dateTo: dateString.nullish(),
    canAdd: z.boolean().default(false),
    canExport: z.boolean().default(false),
    coActorVisibility: z.enum(['redacted', 'name']).optional(),
    note: z.string().max(500).nullish(),
  })
  .refine((g) => !g.dateFrom || !g.dateTo || g.dateFrom <= g.dateTo, {
    message: 'The end date must be on or after the start date',
    path: ['dateTo'],
  });

export type GrantInput = z.input<typeof grantInputSchema>;

function parse<T extends z.ZodTypeAny>(schema: T, input: unknown): z.output<T> {
  const r = schema.safeParse(input);
  if (!r.success) {
    const fields: Record<string, string> = {};
    for (const i of r.error.issues) fields[i.path.join('.') || 'input'] = i.message;
    throw new ValidationError('Please check the access settings', fields);
  }
  return r.data;
}

/** Validate grant targets belong to the owner; returns cleaned ids. */
async function validateTargets(ownerId: string, g: z.output<typeof grantInputSchema>) {
  const actorIds = cleanIds(g.actorIds ?? []);
  const incidentIds = cleanIds(g.incidentIds ?? []);
  if (g.scopeType === 'actors') {
    if (!actorIds.length)
      throw new ValidationError('Choose at least one Actor', {
        actorIds: 'Choose at least one Actor.',
      });
    const found = await db()
      .select({ id: actors.id })
      .from(actors)
      .where(
        and(eq(actors.ownerId, ownerId), inArray(actors.id, actorIds), isNull(actors.deletedAt)),
      );
    if (found.length !== actorIds.length)
      throw new ValidationError('Unknown Actor', {
        actorIds: 'One of the Actors could not be found.',
      });
  }
  if (g.scopeType === 'incidents') {
    if (!incidentIds.length)
      throw new ValidationError('Choose at least one Incident', {
        incidentIds: 'Choose at least one Incident.',
      });
    const found = await db()
      .select({ id: incidents.id })
      .from(incidents)
      .where(
        and(
          eq(incidents.ownerId, ownerId),
          inArray(incidents.id, incidentIds),
          isNull(incidents.deletedAt),
        ),
      );
    if (found.length !== incidentIds.length)
      throw new ValidationError('Unknown Incident', {
        incidentIds: 'One of the Incidents could not be found.',
      });
  }
  return {
    actorIds: g.scopeType === 'actors' ? actorIds : [],
    incidentIds: g.scopeType === 'incidents' ? incidentIds : [],
  };
}

function scopeSummary(g: GrantDTO): string {
  const what =
    g.scopeType === 'all'
      ? 'all records'
      : g.scopeType === 'actors'
        ? `Events involving ${g.actors.map((a) => a.name).join(', ')}`
        : `the Incident${g.incidents.length === 1 ? '' : 's'} ${g.incidents.map((i) => `"${i.title}"`).join(', ')}`;
  const when =
    g.dateFrom && g.dateTo
      ? ` from ${g.dateFrom} to ${g.dateTo}`
      : g.dateFrom
        ? ` from ${g.dateFrom} onwards`
        : g.dateTo
          ? ` up to ${g.dateTo}`
          : '';
  const caps = ['view', ...(g.canAdd ? ['add'] : []), ...(g.canExport ? ['export'] : [])].join(
    ', ',
  );
  return `${what}${when} (${caps})`;
}

async function loadGrantDTOs(relationshipIds: string[]): Promise<Map<string, GrantDTO[]>> {
  const out = new Map<string, GrantDTO[]>();
  if (!relationshipIds.length) return out;
  const grants = await db()
    .select()
    .from(accessGrants)
    .where(inArray(accessGrants.relationshipId, relationshipIds))
    .orderBy(accessGrants.createdAt);
  const ids = grants.map((g) => g.id);
  const ga = ids.length
    ? await db()
        .select({ grantId: grantActors.grantId, id: actors.id, name: actors.name })
        .from(grantActors)
        .innerJoin(actors, eq(actors.id, grantActors.actorId))
        .where(inArray(grantActors.grantId, ids))
    : [];
  const gi = ids.length
    ? await db()
        .select({ grantId: grantIncidents.grantId, id: incidents.id, title: incidents.title })
        .from(grantIncidents)
        .innerJoin(incidents, eq(incidents.id, grantIncidents.incidentId))
        .where(inArray(grantIncidents.grantId, ids))
    : [];
  for (const g of grants) {
    const dto: GrantDTO = {
      id: g.id,
      scopeType: g.scopeType,
      actors: ga.filter((a) => a.grantId === g.id).map(({ id, name }) => ({ id, name })),
      incidents: gi.filter((i) => i.grantId === g.id).map(({ id, title }) => ({ id, title })),
      dateFrom: g.dateFrom,
      dateTo: g.dateTo,
      canAdd: g.canAdd,
      canExport: g.canExport,
      coActorVisibility: g.coActorVisibility,
      note: g.note,
      createdAt: iso(g.createdAt)!,
      revokedAt: iso(g.revokedAt),
    };
    out.set(g.relationshipId, [...(out.get(g.relationshipId) ?? []), dto]);
  }
  return out;
}

export async function listHelpers(ctx: AccessContext): Promise<HelperDTO[]> {
  if (!isOwner(ctx) || ctx.oauth) throw new ForbiddenError();
  const rels = await db()
    .select({
      rel: helperRelationships,
      helper: { id: users.id, displayName: users.displayName, username: users.username },
    })
    .from(helperRelationships)
    .leftJoin(users, eq(users.id, helperRelationships.helperUserId))
    .where(eq(helperRelationships.ownerId, ctx.ownerId))
    .orderBy(desc(helperRelationships.createdAt));
  const grants = await loadGrantDTOs(rels.map((r) => r.rel.id));
  const invites = rels.length
    ? await db()
        .select()
        .from(invitations)
        .where(
          and(
            inArray(
              invitations.relationshipId,
              rels.map((r) => r.rel.id),
            ),
            isNull(invitations.usedAt),
            isNull(invitations.revokedAt),
            gt(invitations.expiresAt, new Date()),
          ),
        )
    : [];
  return rels.map(({ rel, helper }) => {
    const invite = invites.find((i) => i.relationshipId === rel.id);
    return {
      id: rel.id,
      label: rel.label,
      status: rel.status,
      helper: helper?.id ? helper : null,
      invitedEmail: rel.invitedEmail,
      createdAt: iso(rel.createdAt)!,
      acceptedAt: iso(rel.acceptedAt),
      endedAt: iso(rel.endedAt),
      grants: grants.get(rel.id) ?? [],
      pendingInvitation: invite ? { id: invite.id, expiresAt: iso(invite.expiresAt)! } : null,
    };
  });
}

export interface InvitationResult {
  helper: HelperDTO;
  /** The one-time link. Shown to the owner once; only its hash is stored. */
  url: string;
  emailed: boolean;
}

async function createInvitationRecord(
  ownerId: string,
  relationshipId: string,
  email: string | null,
  createdBy: string,
) {
  const token = randomToken(32);
  const expiresAt = new Date(Date.now() + config().INVITATION_TTL_HOURS * 3600_000);
  // Any earlier unused invitation for this relationship stops working.
  await db()
    .update(invitations)
    .set({ revokedAt: new Date() })
    .where(
      and(
        eq(invitations.relationshipId, relationshipId),
        isNull(invitations.usedAt),
        isNull(invitations.revokedAt),
      ),
    );
  await db()
    .insert(invitations)
    .values({
      ownerId,
      relationshipId,
      tokenHash: tokenHash(token, 'invitation'),
      email,
      expiresAt,
      createdBy,
    });
  return { token, expiresAt, url: `${config().APP_URL}/invite/${token}` };
}

export async function inviteHelper(
  ctx: AccessContext,
  input: { label: string; email?: string | null; grant: GrantInput; sendEmail?: boolean },
): Promise<InvitationResult> {
  if (!isOwner(ctx) || ctx.oauth) throw new ForbiddenError();
  const label = input.label?.trim();
  if (!label || label.length > 120)
    throw new ValidationError('Enter a name for this Helper', {
      label: 'Enter a name of up to 120 characters.',
    });
  const email = input.email?.trim() || null;
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
    throw new ValidationError('Enter a valid email address', {
      email: 'Enter a valid email address.',
    });
  const grant = parse(grantInputSchema, input.grant);
  const targets = await validateTargets(ctx.ownerId, grant);
  const relationshipId = await db().transaction(async (tx) => {
    const [rel] = await tx
      .insert(helperRelationships)
      .values({ ownerId: ctx.ownerId, label, invitedEmail: email, createdBy: ctx.userId })
      .returning({ id: helperRelationships.id });
    await insertGrant(tx, ctx, rel!.id, grant, targets);
    return rel!.id;
  });
  const invite = await createInvitationRecord(ctx.ownerId, relationshipId, email, ctx.userId);
  await auditCtx(ctx, 'helper.invited', {
    type: 'helper',
    id: relationshipId,
    metadata: { emailed: Boolean(email && input.sendEmail) },
  });
  const helper = (await listHelpers(ctx)).find((h) => h.id === relationshipId)!;
  let emailed = false;
  if (email && input.sendEmail !== false && mailConfigured()) {
    const [owner] = await db()
      .select({ name: users.displayName })
      .from(users)
      .where(eq(users.id, ctx.ownerId));
    await sendMail(
      invitationEmail({
        to: email,
        ownerName: owner?.name ?? 'Someone',
        label,
        scopeSummary: helper.grants.map(scopeSummary).join('; '),
        url: invite.url,
        expiresAt: invite.expiresAt,
      }),
    );
    emailed = true;
  }
  return { helper, url: invite.url, emailed };
}

export async function reissueInvitation(
  ctx: AccessContext,
  relationshipId: string,
  sendEmail = true,
): Promise<InvitationResult> {
  if (!isOwner(ctx) || ctx.oauth) throw new ForbiddenError();
  const rel = await loadRelationship(ctx, relationshipId);
  if (rel.status !== 'pending')
    throw new ConflictError('This invitation has already been accepted or ended');
  const invite = await createInvitationRecord(ctx.ownerId, rel.id, rel.invitedEmail, ctx.userId);
  await auditCtx(ctx, 'helper.invited', {
    type: 'helper',
    id: rel.id,
    metadata: { reissued: true },
  });
  const helper = (await listHelpers(ctx)).find((h) => h.id === rel.id)!;
  let emailed = false;
  if (rel.invitedEmail && sendEmail && mailConfigured()) {
    const [owner] = await db()
      .select({ name: users.displayName })
      .from(users)
      .where(eq(users.id, ctx.ownerId));
    await sendMail(
      invitationEmail({
        to: rel.invitedEmail,
        ownerName: owner?.name ?? 'Someone',
        label: rel.label,
        scopeSummary: helper.grants.map(scopeSummary).join('; '),
        url: invite.url,
        expiresAt: invite.expiresAt,
      }),
    );
    emailed = true;
  }
  return { helper, url: invite.url, emailed };
}

async function loadRelationship(ctx: AccessContext, id: string) {
  if (!isUuid(id)) throw new NotFoundError('Helper');
  const [rel] = await db()
    .select()
    .from(helperRelationships)
    .where(and(eq(helperRelationships.id, id), eq(helperRelationships.ownerId, ctx.ownerId)))
    .limit(1);
  if (!rel) throw new NotFoundError('Helper');
  return rel;
}

async function insertGrant(
  tx: Parameters<Parameters<ReturnType<typeof db>['transaction']>[0]>[0],
  ctx: AccessContext,
  relationshipId: string,
  g: z.output<typeof grantInputSchema>,
  targets: { actorIds: string[]; incidentIds: string[] },
): Promise<string> {
  const [grant] = await tx
    .insert(accessGrants)
    .values({
      relationshipId,
      ownerId: ctx.ownerId,
      scopeType: g.scopeType,
      dateFrom: g.dateFrom ?? null,
      dateTo: g.dateTo ?? null,
      canAdd: g.canAdd,
      canExport: g.canExport,
      // Incident Helpers usually need to see who was involved; Actor-scoped
      // Helpers default to redaction of other Actors.
      coActorVisibility: g.coActorVisibility ?? (g.scopeType === 'incidents' ? 'name' : 'redacted'),
      note: g.note?.trim() || null,
      createdBy: ctx.userId,
    })
    .returning({ id: accessGrants.id });
  for (const actorId of targets.actorIds)
    await tx.insert(grantActors).values({ grantId: grant!.id, actorId });
  for (const incidentId of targets.incidentIds)
    await tx.insert(grantIncidents).values({ grantId: grant!.id, incidentId });
  await auditCtx(
    ctx,
    'grant.created',
    {
      type: 'grant',
      id: grant!.id,
      metadata: {
        relationshipId,
        scopeType: g.scopeType,
        dateFrom: g.dateFrom,
        dateTo: g.dateTo,
        canAdd: g.canAdd,
        canExport: g.canExport,
        actorIds: targets.actorIds,
        incidentIds: targets.incidentIds,
      },
    },
    tx,
  );
  return grant!.id;
}

export async function addGrant(
  ctx: AccessContext,
  relationshipId: string,
  raw: unknown,
): Promise<HelperDTO> {
  if (!isOwner(ctx) || ctx.oauth) throw new ForbiddenError();
  const rel = await loadRelationship(ctx, relationshipId);
  if (rel.status === 'ended') throw new ConflictError('This Helper relationship has ended');
  const g = parse(grantInputSchema, raw);
  const targets = await validateTargets(ctx.ownerId, g);
  await db().transaction((tx) => insertGrant(tx, ctx, rel.id, g, targets));
  return (await listHelpers(ctx)).find((h) => h.id === rel.id)!;
}

/**
 * Change a grant. Implemented as revoke-and-replace so the audit trail shows
 * exactly what access existed when.
 */
export async function updateGrant(
  ctx: AccessContext,
  grantId: string,
  raw: unknown,
): Promise<HelperDTO> {
  if (!isOwner(ctx) || ctx.oauth) throw new ForbiddenError();
  if (!isUuid(grantId)) throw new NotFoundError('Access grant');
  const [existing] = await db()
    .select()
    .from(accessGrants)
    .where(
      and(
        eq(accessGrants.id, grantId),
        eq(accessGrants.ownerId, ctx.ownerId),
        isNull(accessGrants.revokedAt),
      ),
    )
    .limit(1);
  if (!existing) throw new NotFoundError('Access grant');
  const g = parse(grantInputSchema, raw);
  const targets = await validateTargets(ctx.ownerId, g);
  await db().transaction(async (tx) => {
    await tx
      .update(accessGrants)
      .set({ revokedAt: new Date(), revokedBy: ctx.userId })
      .where(eq(accessGrants.id, grantId));
    const newId = await insertGrant(tx, ctx, existing.relationshipId, g, targets);
    await auditCtx(
      ctx,
      'grant.updated',
      { type: 'grant', id: grantId, metadata: { replacedBy: newId } },
      tx,
    );
  });
  return (await listHelpers(ctx)).find((h) => h.id === existing.relationshipId)!;
}

export async function revokeGrant(ctx: AccessContext, grantId: string): Promise<void> {
  if (!isOwner(ctx) || ctx.oauth) throw new ForbiddenError();
  if (!isUuid(grantId)) throw new NotFoundError('Access grant');
  const updated = await db()
    .update(accessGrants)
    .set({ revokedAt: new Date(), revokedBy: ctx.userId })
    .where(
      and(
        eq(accessGrants.id, grantId),
        eq(accessGrants.ownerId, ctx.ownerId),
        isNull(accessGrants.revokedAt),
      ),
    )
    .returning({ id: accessGrants.id });
  if (!updated.length) throw new NotFoundError('Access grant');
  await auditCtx(ctx, 'grant.revoked', { type: 'grant', id: grantId });
}

/** End a Helper relationship: all grants stop working immediately. */
export async function endHelper(ctx: AccessContext, relationshipId: string): Promise<void> {
  if (!isOwner(ctx) || ctx.oauth) throw new ForbiddenError();
  const rel = await loadRelationship(ctx, relationshipId);
  const now = new Date();
  await db().transaction(async (tx) => {
    await tx
      .update(helperRelationships)
      .set({ status: 'ended', endedAt: now })
      .where(eq(helperRelationships.id, rel.id));
    await tx
      .update(accessGrants)
      .set({ revokedAt: now, revokedBy: ctx.userId })
      .where(and(eq(accessGrants.relationshipId, rel.id), isNull(accessGrants.revokedAt)));
    await tx
      .update(invitations)
      .set({ revokedAt: now })
      .where(
        and(
          eq(invitations.relationshipId, rel.id),
          isNull(invitations.usedAt),
          isNull(invitations.revokedAt),
        ),
      );
    // OAuth connections the helper made to this record stop working too.
    if (rel.helperUserId) {
      await tx.execute(
        sql`UPDATE oauth_connections SET revoked_at = now() WHERE user_id = ${rel.helperUserId}::uuid AND owner_id = ${ctx.ownerId}::uuid AND revoked_at IS NULL`,
      );
    }
    await auditCtx(
      ctx,
      rel.status === 'pending' ? 'helper.invitation_revoked' : 'helper.ended',
      { type: 'helper', id: rel.id },
      tx,
    );
  });
}

// ---------------------------------------------------------------------------
// Accepting invitations
// ---------------------------------------------------------------------------

async function findInvitation(token: string) {
  if (!token || token.length > 100) return null;
  const [row] = await db()
    .select({
      inv: invitations,
      rel: helperRelationships,
      owner: { id: users.id, displayName: users.displayName },
    })
    .from(invitations)
    .innerJoin(helperRelationships, eq(helperRelationships.id, invitations.relationshipId))
    .innerJoin(users, eq(users.id, invitations.ownerId))
    .where(eq(invitations.tokenHash, tokenHash(token, 'invitation')))
    .limit(1);
  return row ?? null;
}

export type InvitationState = 'valid' | 'expired' | 'used' | 'revoked' | 'invalid';

/**
 * Describe an invitation to the person holding its link so they can decide
 * whether to accept. Identifies the grant being offered.
 */
export async function describeInvitation(token: string): Promise<
  | { state: Exclude<InvitationState, 'valid'> }
  | {
      state: 'valid';
      ownerName: string;
      label: string;
      expiresAt: string;
      grants: GrantDTO[];
      summary: string[];
    }
> {
  const row = await findInvitation(token);
  if (!row) return { state: 'invalid' };
  if (row.inv.usedAt) return { state: 'used' };
  if (row.inv.revokedAt || row.rel.status === 'ended') return { state: 'revoked' };
  if (row.inv.expiresAt < new Date()) return { state: 'expired' };
  const grants = ((await loadGrantDTOs([row.rel.id])).get(row.rel.id) ?? []).filter(
    (g) => !g.revokedAt,
  );
  return {
    state: 'valid',
    ownerName: row.owner.displayName,
    label: row.rel.label,
    expiresAt: iso(row.inv.expiresAt)!,
    grants,
    summary: grants.map(scopeSummary),
  };
}

/**
 * Accept an invitation as `userId`. Single use: the invitation is consumed
 * atomically, so a link can never become a standing credential.
 */
export async function acceptInvitation(
  token: string,
  userId: string,
  meta: { ip?: string | null; userAgent?: string | null },
) {
  const row = await findInvitation(token);
  if (
    !row ||
    row.inv.usedAt ||
    row.inv.revokedAt ||
    row.rel.status !== 'pending' ||
    row.inv.expiresAt < new Date()
  ) {
    throw new ValidationError('This invitation link is no longer valid. Ask for a new one.');
  }
  if (row.inv.ownerId === userId)
    throw new ValidationError('You cannot accept an invitation to your own record.');
  await db().transaction(async (tx) => {
    const consumed = await tx
      .update(invitations)
      .set({ usedAt: new Date(), usedBy: userId })
      .where(
        and(
          eq(invitations.id, row.inv.id),
          isNull(invitations.usedAt),
          isNull(invitations.revokedAt),
        ),
      )
      .returning({ id: invitations.id });
    if (!consumed.length) throw new ValidationError('This invitation link has already been used.');
    // If this person already helps this owner, move the new grants onto that relationship.
    const [existing] = await tx
      .select()
      .from(helperRelationships)
      .where(
        and(
          eq(helperRelationships.ownerId, row.inv.ownerId),
          eq(helperRelationships.helperUserId, userId),
          eq(helperRelationships.status, 'active'),
        ),
      )
      .limit(1);
    if (existing) {
      await tx
        .update(accessGrants)
        .set({ relationshipId: existing.id })
        .where(eq(accessGrants.relationshipId, row.rel.id));
      await tx
        .update(helperRelationships)
        .set({ status: 'ended', endedAt: new Date(), helperUserId: userId })
        .where(eq(helperRelationships.id, row.rel.id));
    } else {
      await tx
        .update(helperRelationships)
        .set({ helperUserId: userId, status: 'active', acceptedAt: new Date() })
        .where(eq(helperRelationships.id, row.rel.id));
    }
    await audit(
      {
        action: 'helper.accepted',
        ownerId: row.inv.ownerId,
        actorUserId: userId,
        targetType: 'helper',
        targetId: row.rel.id,
        ip: meta.ip,
        userAgent: meta.userAgent,
      },
      tx,
    );
  });
  const [owner] = await db()
    .select({ email: users.email })
    .from(users)
    .where(eq(users.id, row.inv.ownerId));
  const [helper] = await db()
    .select({ displayName: users.displayName })
    .from(users)
    .where(eq(users.id, userId));
  if (owner?.email) {
    await sendNotification(
      securityNotificationEmail({
        to: owner.email,
        summary: 'a Helper accepted your invitation',
        detail: `${helper?.displayName ?? 'Someone'} accepted your invitation and can now access your record as "${row.rel.label}".`,
        url: `${config().APP_URL}/settings/helpers`,
      }),
    );
  }
  return { ownerId: row.inv.ownerId, ownerName: row.owner.displayName };
}

/** Helper leaves a record they were helping with. */
export async function leaveRecord(userId: string, ownerId: string): Promise<void> {
  const rels = await db()
    .update(helperRelationships)
    .set({ status: 'ended', endedAt: new Date() })
    .where(
      and(
        eq(helperRelationships.ownerId, ownerId),
        eq(helperRelationships.helperUserId, userId),
        eq(helperRelationships.status, 'active'),
      ),
    )
    .returning({ id: helperRelationships.id });
  if (!rels.length) throw new NotFoundError('Record');
  for (const r of rels) {
    await db()
      .update(accessGrants)
      .set({ revokedAt: new Date(), revokedBy: userId })
      .where(and(eq(accessGrants.relationshipId, r.id), isNull(accessGrants.revokedAt)));
    await audit({
      action: 'helper.ended',
      ownerId,
      actorUserId: userId,
      targetType: 'helper',
      targetId: r.id,
      metadata: { byHelper: true },
    });
  }
}
