import type { FastifyInstance } from 'fastify';
import type { Knex } from 'knex';
import { Type } from '@sinclair/typebox';
import * as conversationsRepo from '../repositories/conversations.repo.js';
import * as notesRepo from '../repositories/notes.repo.js';
import { hasLocationAccess } from '../lib/auth-helpers.js';

const IdParams = Type.Object({ id: Type.String({ format: 'uuid' }) });

const NoteIdParams = Type.Object({
  id: Type.String({ format: 'uuid' }),
  note_id: Type.String({ format: 'uuid' }),
});

const CreateNoteBody = Type.Object({
  body: Type.String({ minLength: 1 }),
});

export async function notesRoute(
  app: FastifyInstance,
  opts: { db: Knex },
): Promise<void> {
  const { db } = opts;

  // POST /conversations/:id/notes
  app.post('/:id/notes', { schema: { params: IdParams, body: CreateNoteBody } }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = req.body as { body: string };

    if (!req.user) {
      return reply.status(403).send({ error: 'forbidden' });
    }

    const conversation = await conversationsRepo.findById(db, id);
    if (!conversation) {
      return reply.status(404).send({ error: 'not_found' });
    }

    if (!hasLocationAccess(req.user.locations, conversation.location_id)) {
      return reply.status(403).send({ error: 'forbidden' });
    }

    const note = await notesRepo.create(db, {
      conversation_id: id,
      author_id: req.user.sub,
      body: body.body,
    });

    return reply.status(201).send(note);
  });

  // DELETE /conversations/:id/notes/:note_id
  app.delete('/:id/notes/:note_id', { schema: { params: NoteIdParams } }, async (req, reply) => {
    const { id, note_id } = req.params as { id: string; note_id: string };

    if (!req.user) {
      return reply.status(403).send({ error: 'forbidden' });
    }

    const conversation = await conversationsRepo.findById(db, id);
    if (!conversation) {
      return reply.status(404).send({ error: 'not_found' });
    }

    if (!hasLocationAccess(req.user.locations, conversation.location_id)) {
      return reply.status(403).send({ error: 'forbidden' });
    }

    const deleted = await notesRepo.deleteById(db, note_id, id);
    if (!deleted) {
      return reply.status(404).send({ error: 'not_found' });
    }

    return reply.send({ ok: true });
  });
}
