// N03 — SF Integration route registration.
//
// Route map:
//   GET    /api/admin/sf-integration                       admin+  integration:sf:configure
//   PATCH  /api/admin/sf-integration                       admin+  integration:sf:configure
//   POST   /api/admin/sf-integration/connect               admin+  integration:sf:configure
//   GET    /admin/sf-integration/oauth/callback            public  (CSRF state check)
//   DELETE /api/admin/sf-integration/disconnect            admin+  integration:sf:configure
//   POST   /api/leads/sf-import                            agent+  integration:sf:click_to_dial

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { SfIntegrationService } from './service.js';
import { sfIntegrationSchemas } from './schema.js';
import { SfImportBodySchema } from './schema.js';
import { getPrisma } from '../../../lib/prisma.js';
import { audit } from '../../../auth/audit.js';
import { parsePhoneNumberFromString } from 'libphonenumber-js';
import type { AuthContext } from '../../../auth/middleware.js';

type AuthReq = FastifyRequest & { auth?: AuthContext };

function getAuth(req: FastifyRequest): AuthContext {
  const auth = (req as AuthReq).auth;
  if (!auth) throw new Error('Unauthenticated');
  return auth;
}

function normalizeToE164(raw: string): string | null {
  try {
    const parsed = parsePhoneNumberFromString(raw, 'US');
    if (parsed?.isValid()) return parsed.number;
  } catch { /* noop */ }
  return null;
}

export async function registerSfIntegrationRoutes(app: FastifyInstance): Promise<void> {
  const svc = new SfIntegrationService(app);

  // GET /api/admin/sf-integration
  app.get(
    '/api/admin/sf-integration',
    {
      preHandler: [app.requireAuth, app.requirePermission('integration:sf:configure')],
      schema: sfIntegrationSchemas.getConfig,
    },
    svc.getConfig.bind(svc),
  );

  // PATCH /api/admin/sf-integration
  app.patch(
    '/api/admin/sf-integration',
    {
      preHandler: [app.requireAuth, app.requirePermission('integration:sf:configure')],
      schema: sfIntegrationSchemas.patchConfig,
    },
    svc.patchConfig.bind(svc),
  );

  // POST /api/admin/sf-integration/connect
  app.post(
    '/api/admin/sf-integration/connect',
    {
      preHandler: [app.requireAuth, app.requirePermission('integration:sf:configure')],
      schema: sfIntegrationSchemas.connect,
    },
    svc.initiateOAuth.bind(svc),
  );

  // GET /admin/sf-integration/oauth/callback — no auth (CSRF state validates identity)
  app.get(
    '/admin/sf-integration/oauth/callback',
    { schema: sfIntegrationSchemas.oauthCallback },
    svc.oauthCallback.bind(svc),
  );

  // DELETE /api/admin/sf-integration/disconnect
  app.delete(
    '/api/admin/sf-integration/disconnect',
    {
      preHandler: [app.requireAuth, app.requirePermission('integration:sf:configure')],
      schema: sfIntegrationSchemas.disconnect,
    },
    svc.disconnect.bind(svc),
  );

  // POST /api/leads/sf-import — agent+ click-to-dial lead dedup/create
  app.post(
    '/api/leads/sf-import',
    {
      preHandler: [app.requireAuth, app.requirePermission('integration:sf:click_to_dial')],
      schema: { response: { 200: { type: 'object', additionalProperties: true }, 201: { type: 'object', additionalProperties: true } } },
    },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const auth = getAuth(req);
      const tenantId = BigInt(auth.tenantId);
      const db = getPrisma();

      const parsed = SfImportBodySchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ code: 'validation_error', message: parsed.error.message });
      }
      const { phone, sfRecordId, sfObjectType, firstName, lastName, email } = parsed.data;

      const e164 = normalizeToE164(phone);
      if (!e164) {
        return reply.code(422).send({ code: 'invalid_phone', error: 'Invalid phone number' });
      }

      // Dedup: prefer sf_record_id match, then phone match
      let lead = await db.lead.findFirst({
        where: {
          tenantId,
          OR: [
            { sfRecordId },
            { phoneE164: e164 },
          ],
        },
      });

      if (lead) {
        // Update sfRecordId if not set
        if (!lead.sfRecordId && sfRecordId) {
          lead = await db.lead.update({
            where: { id: lead.id },
            data: { sfRecordId, sfObjectType },
          });
        }
        return reply.send({ lead: toLeadDto(lead), created: false });
      }

      // Find or create a default list for SF-imported leads
      let defaultList = await db.list.findFirst({
        where: { tenantId, name: 'Salesforce Import' },
      });
      if (!defaultList) {
        defaultList = await db.list.create({
          data: {
            tenantId,
            name: 'Salesforce Import',
            description: 'Auto-created list for Salesforce click-to-dial imports',
            active: true,
          },
        });
      }

      lead = await db.lead.create({
        data: {
          tenantId,
          listId: defaultList.id,
          phoneE164: e164,
          firstName: firstName ?? '',
          lastName: lastName ?? '',
          email: email ?? null,
          sfRecordId,
          sfObjectType,
          status: 'NEW',
          customData: {},
        },
      });

      await audit({
        tx: db,
        actorUserId: auth.uid,
        actorKind: 'user',
        tenantId: auth.tenantId,
        action: 'sf_integration.lead_imported',
        entityType: 'lead',
        entityId: lead.id.toString(),
        afterJson: { sfRecordId, sfObjectType, phone: e164 },
      });

      return reply.code(201).send({ lead: toLeadDto(lead), created: true });
    },
  );
}

function toLeadDto(lead: {
  id: bigint;
  phoneE164: string;
  firstName: string | null;
  lastName: string | null;
  email: string | null;
  sfRecordId: string | null;
  sfObjectType: string | null;
  status: string;
}) {
  return {
    id: lead.id.toString(),
    phone: lead.phoneE164,
    firstName: lead.firstName,
    lastName: lead.lastName,
    email: lead.email,
    sfRecordId: lead.sfRecordId,
    sfObjectType: lead.sfObjectType,
    status: lead.status,
  };
}
