import { and, eq, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { oauthPayloads } from '../db/schema.js';

/**
 * PostgreSQL storage adapter for oidc-provider models (grants, codes, tokens,
 * interactions, dynamically registered clients …). Payloads are stored as
 * JSON keyed by (model, id), following the library's documented adapter
 * interface. Tokens are looked up by their identifier, which is a random
 * value only known to the client.
 */
type Payload = Record<string, unknown> & { grantId?: string; userCode?: string; uid?: string; consumed?: number };

export class PostgresAdapter {
  constructor(private readonly model: string) {}

  async upsert(id: string, payload: Payload, expiresIn?: number): Promise<void> {
    const expiresAt = expiresIn ? new Date(Date.now() + expiresIn * 1000) : null;
    await db()
      .insert(oauthPayloads)
      .values({
        id,
        model: this.model,
        payload,
        grantId: payload.grantId ?? null,
        userCode: payload.userCode ?? null,
        uid: payload.uid ?? null,
        expiresAt,
      })
      .onConflictDoUpdate({
        target: [oauthPayloads.model, oauthPayloads.id],
        set: { payload, grantId: payload.grantId ?? null, userCode: payload.userCode ?? null, uid: payload.uid ?? null, expiresAt },
      });
  }

  private async findWhere(condition: ReturnType<typeof eq>): Promise<Payload | undefined> {
    const [row] = await db()
      .select()
      .from(oauthPayloads)
      .where(and(eq(oauthPayloads.model, this.model), condition, sql`(${oauthPayloads.expiresAt} IS NULL OR ${oauthPayloads.expiresAt} > now())`))
      .limit(1);
    if (!row) return undefined;
    return { ...row.payload, ...(row.consumedAt ? { consumed: Math.floor(row.consumedAt.getTime() / 1000) } : {}) };
  }

  find(id: string) {
    return this.findWhere(eq(oauthPayloads.id, id));
  }

  findByUserCode(userCode: string) {
    return this.findWhere(eq(oauthPayloads.userCode, userCode));
  }

  findByUid(uid: string) {
    return this.findWhere(eq(oauthPayloads.uid, uid));
  }

  async consume(id: string): Promise<void> {
    await db()
      .update(oauthPayloads)
      .set({ consumedAt: new Date() })
      .where(and(eq(oauthPayloads.model, this.model), eq(oauthPayloads.id, id)));
  }

  async destroy(id: string): Promise<void> {
    await db().delete(oauthPayloads).where(and(eq(oauthPayloads.model, this.model), eq(oauthPayloads.id, id)));
  }

  async revokeByGrantId(grantId: string): Promise<void> {
    await db().delete(oauthPayloads).where(eq(oauthPayloads.grantId, grantId));
  }
}

/** Remove every artefact belonging to a grant, across all models. */
export async function destroyGrantArtefacts(grantId: string): Promise<void> {
  await db().delete(oauthPayloads).where(eq(oauthPayloads.grantId, grantId));
  await db().delete(oauthPayloads).where(and(eq(oauthPayloads.model, 'Grant'), eq(oauthPayloads.id, grantId)));
}
