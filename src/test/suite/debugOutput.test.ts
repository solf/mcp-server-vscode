import * as assert from 'assert';
import { setupTest, teardownTest, callTool, TestContext } from '../helpers/testHelpers';

/**
 * These tests all exercise the same condition: no debug session is running.
 *
 * That used to come back as a successful result whose body happened to be
 * `{error: 'no_session'}`, which a caller could easily read straight past. It is
 * now a failure -- the tool could not answer, so it says so and the request
 * rejects. `format` no longer changes the outcome either; there is no longer a
 * "compact error" distinct from a detailed one.
 */
suite('Debug Output Tool Tests', () => {
  let context: TestContext;

  /** Asserts that a debug_getOutput call fails because nothing is being debugged. */
  async function expectNoSession(args: Record<string, unknown>): Promise<void> {
    await assert.rejects(
      () => callTool('debug_getOutput', args),
      (err: Error) => /No active debug session/.test(err.message),
      `Expected a no-session failure for ${JSON.stringify(args)}`
    );
  }

  suiteSetup(async () => {
    context = await setupTest();
  });

  suiteTeardown(async () => {
    await teardownTest(context);
  });

  test('should handle no debug session', async () => {
    await expectNoSession({ format: 'detailed' });
  });

  test('should fail the same way regardless of format', async () => {
    // Previously 'compact' returned the bare code 'no_session' while 'detailed'
    // returned a sentence -- two shapes for one condition.
    await expectNoSession({ category: 'console', limit: 10, format: 'compact' });
    await expectNoSession({ category: 'console', limit: 10, format: 'detailed' });
  });

  test('should validate category parameter', async () => {
    // 'category' is an enum, so an unknown value fails schema validation and the
    // request never reaches the tool -- a 400, which the helper returns as
    // {error} rather than rejecting. Note this outranks the missing session:
    // the request is malformed before the session is even consulted.
    const result = await callTool('debug_getOutput', {
      category: 'invalid' as unknown as string,
      format: 'detailed',
    });

    assert.ok(result.error, 'Invalid enum value should be rejected by validation');
    assert.ok(/category/i.test(result.error), 'Error should name the offending parameter');
  });

  test('should handle filter parameter', async () => {
    await expectNoSession({ filter: 'error', format: 'detailed' });
  });

  test('should handle limit parameter', async () => {
    await expectNoSession({ limit: 50, format: 'detailed' });
  });

  test('should say what to do about the missing session', async () => {
    // The message has to be actionable -- "no_session" told the caller nothing
    // about how to proceed.
    await assert.rejects(
      () => callTool('debug_getOutput', { format: 'compact' }),
      (err: Error) => /debug_startSession/.test(err.message),
      'Failure should point at the tool that fixes it'
    );
  });

  // Note: Full integration tests would require:
  // 1. Starting a debug session
  // 2. Running code that produces output
  // 3. Then calling debug_getOutput to retrieve it
  // This would be complex to set up in unit tests

  test.skip('should get console output during debug session', async () => {
    // This would require a full debug session setup
    // Including:
    // - Start debug session
    // - Execute code with console.log
    // - Then test debug_getOutput
  });

  test.skip('should filter by category', async () => {
    // Would need active session with different output types
  });

  test.skip('should apply text filter', async () => {
    // Would need active session with various output messages
  });
});
