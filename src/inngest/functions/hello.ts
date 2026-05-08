import { inngest } from '../client';

/**
 * Phase 0 smoke-test function. Triggered by the `demo/hello` event,
 * it just runs a single step that echoes the supplied name (or "world").
 *
 * Used to verify that the Inngest serve handler is correctly wired.
 */
export const helloFn = inngest.createFunction(
  { id: 'hello', name: 'Hello (smoke test)' },
  { event: 'demo/hello' },
  async ({ event, step }) => {
    const result = await step.run('say-hi', () => ({
      message: `hello, ${event.data?.name ?? 'world'}`,
    }));

    return result;
  },
);
