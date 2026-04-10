import { type FastifyInstance } from 'fastify';
import { requirePermission } from '@ortho/auth-middleware';
import { Type } from '@sinclair/typebox';
import db from '../db.js';
import * as revenueConfigRepo from '../repositories/revenue-config.js';
import { RevenueConfigBody } from '../schemas/revenue-config.js';

const readPerm = requirePermission('reporting:read');
const writePerm = requirePermission('reporting:write');

const SCOPED_ROLES = new Set(['call_center_agent', 'call_center_manager']);

const LocationParams = Type.Object({ location_id: Type.String() });

export async function configRoutes(app: FastifyInstance): Promise<void> {
  /**
   * GET /reporting/config/revenue
   *
   * call_center_agent/manager: rows scoped to req.user.locations.
   * marketing_staff/manager/super_admin: all rows.
   */
  app.get(
    '/reporting/config/revenue',
    { preHandler: [readPerm] },
    async (req, reply) => {
      const configs = SCOPED_ROLES.has(req.user!.role)
        ? await revenueConfigRepo.findByLocationIds(db, req.user!.locations)
        : await revenueConfigRepo.findAll(db);
      return reply.code(200).send({ data: configs });
    },
  );

  /**
   * PUT /reporting/config/revenue/:location_id
   *
   * Upserts a revenue config entry. Requires reporting:write (marketing_manager+).
   */
  app.put(
    '/reporting/config/revenue/:location_id',
    {
      schema: { params: LocationParams, body: RevenueConfigBody },
      preHandler: [writePerm],
    },
    async (req, reply) => {
      const { location_id } = req.params as { location_id: string };
      const body = req.body as typeof RevenueConfigBody._type;

      const config = await revenueConfigRepo.upsert(
        db,
        location_id,
        body.avg_contract_value,
        req.user!.sub,
      );

      return reply.code(200).send(config);
    },
  );
}
