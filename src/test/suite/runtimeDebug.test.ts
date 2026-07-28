import * as assert from 'assert';
import * as vscode from 'vscode';
import { setupTest, teardownTest, callTool, TestContext } from '../helpers/testHelpers';

suite('Runtime Debug Tools Tests', () => {
  let context: TestContext;

  suiteSetup(async () => {
    context = await setupTest();
  });

  suiteTeardown(async () => {
    await teardownTest(context);
    // Ensure debugging is stopped
    try {
      await vscode.debug.stopDebugging();
    } catch {
      // Ignore errors if no debug session
    }
  });

  // Clean up after each test
  teardown(async () => {
    if (vscode.debug.activeDebugSession) {
      await vscode.debug.stopDebugging();
    }
  });

  /** Asserts a runtime debug tool fails because nothing is being debugged. */
  async function expectNoSession(tool: string, args: Record<string, unknown> = {}): Promise<void> {
    await assert.rejects(
      () => callTool(tool, { format: 'detailed', ...args }),
      (err: Error) => /No active debug session/.test(err.message),
      `${tool} should report the missing session as a failure`
    );
  }

  test('should handle pause/continue when no debug session', async () => {
    await expectNoSession('debug_pauseExecution');
    await expectNoSession('debug_continueExecution');
  });

  test('should handle step controls when no debug session', async () => {
    await expectNoSession('debug_stepOver');
    await expectNoSession('debug_stepInto');
    await expectNoSession('debug_stepOut');
  });

  test('should handle call stack when no debug session', async () => {
    await expectNoSession('debug_getCallStack');
  });

  test('should handle variable inspection when no debug session', async () => {
    await expectNoSession('debug_inspectVariables', { scope: 'locals' });
  });

  test('should handle expression evaluation when no debug session', async () => {
    await expectNoSession('debug_evaluateExpression', { expression: 'myVariable' });
  });

  test('should validate expression parameter', async () => {
    // Schema validation rejects the request before the tool runs, so this comes
    // back as a 400 the helper surfaces as {error} -- distinct from the tool
    // running and failing, which rejects.
    const result = await callTool('debug_evaluateExpression', {
      format: 'detailed',
    } as any);

    assert.ok(result.error, 'Should have error for missing expression');
    assert.ok(
      result.error.toLowerCase().includes('expression') ||
        result.error.toLowerCase().includes('required'),
      'Should mention expression is required'
    );
  });

  test('should report the missing session identically in either format', async () => {
    // 'compact' used to yield the bare token 'no_session' and 'detailed' a
    // sentence. One condition should not have two encodings, and neither should
    // masquerade as a successful result.
    await expectNoSession('debug_getCallStack');
    await assert.rejects(
      () => callTool('debug_getCallStack', { format: 'compact' }),
      (err: Error) => /No active debug session/.test(err.message),
      'compact format must fail the same way'
    );
  });

  // Note: Full integration tests with actual debug sessions would require:
  // 1. Starting a debug session with a specific configuration
  // 2. Setting breakpoints
  // 3. Running code until breakpoint is hit
  // 4. Then testing the runtime tools
  // This is complex to set up in unit tests and would be better as integration tests

  test.skip('should get call stack during debug session', async () => {
    // This would require a full debug session setup
    // Including:
    // - Start debug session
    // - Hit a breakpoint
    // - Then test getCallStack
  });

  test.skip('should inspect variables during debug session', async () => {
    // This would require a full debug session setup
    // Including:
    // - Start debug session
    // - Hit a breakpoint
    // - Then test inspectVariables
  });

  test.skip('should evaluate expressions during debug session', async () => {
    // This would require a full debug session setup
    // Including:
    // - Start debug session
    // - Hit a breakpoint
    // - Then test evaluateExpression
  });
});
