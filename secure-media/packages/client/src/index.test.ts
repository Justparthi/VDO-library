import { describe, it, expect } from 'vitest';

/**
 * Smoke tests for client package exports.
 * Deep browser/Shaka tests require an E2E setup (playwright etc.)
 * and are out of scope for unit tests.
 */
describe('@secure-media/client exports', () => {
  it('exports mountPlayer as a function', async () => {
    const mod = await import('../src/index.js');
    expect(typeof mod.mountPlayer).toBe('function');
  });

  it('exports uploadVideo as a function', async () => {
    const mod = await import('../src/index.js');
    expect(typeof mod.uploadVideo).toBe('function');
  });

  it('exports SecureVideo as a function (React component)', async () => {
    const mod = await import('../src/index.js');
    expect(typeof mod.SecureVideo).toBe('function');
  });
});
