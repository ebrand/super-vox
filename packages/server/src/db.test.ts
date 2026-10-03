import { describe, expect, it } from 'vitest';
import { schemaFrom } from './db.js';

describe('the database schema', () => {
  it('is "super-vox" unless DB_SCHEMA says (staging), and only a safe name', () => {
    expect(schemaFrom({})).toBe('"super-vox"');
    expect(schemaFrom({ DB_SCHEMA: '' })).toBe('"super-vox"');
    expect(schemaFrom({ DB_SCHEMA: 'super-vox-staging' })).toBe('"super-vox-staging"');
    expect(() => schemaFrom({ DB_SCHEMA: 'x"; drop table y; --' })).toThrow(RangeError);
    expect(() => schemaFrom({ DB_SCHEMA: 'Staging' })).toThrow(RangeError);
  });
});
