import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../src/repositories/tag-repository.js', () => ({
  findTagsByLocation: vi.fn(),
  createTag: vi.fn(),
  deleteTag: vi.fn(),
  applyTagToLead: vi.fn(),
  removeTagFromLead: vi.fn(),
}));

import type { Knex } from 'knex';
import {
  listTags,
  createTag,
  deleteTag,
  applyTagToLead,
  removeTagFromLead,
} from '../../../src/services/tag-service.js';
import * as tagRepository from '../../../src/repositories/tag-repository.js';

const db = {} as Knex;

const fakeTag = {
  id: 'tag-1',
  name: 'VIP',
  location_id: null,
  created_by: 'user-1',
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('listTags', () => {
  it('passes locationId to repository', async () => {
    vi.mocked(tagRepository.findTagsByLocation).mockResolvedValue([fakeTag]);

    const result = await listTags(db, 'loc-1');

    expect(tagRepository.findTagsByLocation).toHaveBeenCalledWith(db, 'loc-1');
    expect(result).toEqual([fakeTag]);
  });

  it('passes null when locationId is undefined', async () => {
    vi.mocked(tagRepository.findTagsByLocation).mockResolvedValue([fakeTag]);

    await listTags(db);

    expect(tagRepository.findTagsByLocation).toHaveBeenCalledWith(db, null);
  });
});

describe('createTag', () => {
  it('calls tagRepository.createTag', async () => {
    vi.mocked(tagRepository.createTag).mockResolvedValue(fakeTag);

    const result = await createTag(db, { name: 'VIP', location_id: null, created_by: 'user-1' });

    expect(tagRepository.createTag).toHaveBeenCalledWith(db, {
      name: 'VIP',
      location_id: null,
      created_by: 'user-1',
    });
    expect(result).toEqual(fakeTag);
  });
});

describe('deleteTag', () => {
  it('calls tagRepository.deleteTag', async () => {
    vi.mocked(tagRepository.deleteTag).mockResolvedValue(undefined);

    await deleteTag(db, 'tag-1');

    expect(tagRepository.deleteTag).toHaveBeenCalledWith(db, 'tag-1');
  });
});

describe('applyTagToLead', () => {
  it('calls tagRepository.applyTagToLead', async () => {
    vi.mocked(tagRepository.applyTagToLead).mockResolvedValue(undefined);

    await applyTagToLead(db, 'lead-1', 'tag-1', 'user-1');

    expect(tagRepository.applyTagToLead).toHaveBeenCalledWith(db, 'lead-1', 'tag-1', 'user-1');
  });
});

describe('removeTagFromLead', () => {
  it('calls tagRepository.removeTagFromLead', async () => {
    vi.mocked(tagRepository.removeTagFromLead).mockResolvedValue(undefined);

    await removeTagFromLead(db, 'lead-1', 'tag-1');

    expect(tagRepository.removeTagFromLead).toHaveBeenCalledWith(db, 'lead-1', 'tag-1');
  });
});
