import * as assert from 'assert';
import * as vscode from 'vscode';
import {
  setupTest,
  teardownTest,
  openTestFile,
  callTool,
  TestContext,
} from '../helpers/testHelpers';

suite('Debug Tools Tests', () => {
  let context: TestContext;

  suiteSetup(async () => {
    context = await setupTest();
  });

  suiteTeardown(async () => {
    await teardownTest(context);
    // Ensure debugging is stopped and breakpoints cleared
    try {
      await vscode.debug.stopDebugging();
    } catch {
      // Ignore errors if no debug session
    }
    vscode.debug.removeBreakpoints(vscode.debug.breakpoints);
  });

  // Clean up after each test
  teardown(async () => {
    // Remove all breakpoints
    const allBreakpoints = vscode.debug.breakpoints;
    if (allBreakpoints.length > 0) {
      vscode.debug.removeBreakpoints(allBreakpoints);
    }
    // Stop any active debug sessions
    if (vscode.debug.activeDebugSession) {
      await vscode.debug.stopDebugging();
    }
  });

  test('should list all breakpoints', async () => {
    const document = await openTestFile('app.ts');

    // Set a few breakpoints manually
    const bp1 = new vscode.SourceBreakpoint(
      new vscode.Location(document.uri, new vscode.Position(4, 0))
    );
    const bp2 = new vscode.SourceBreakpoint(
      new vscode.Location(document.uri, new vscode.Position(10, 0))
    );
    vscode.debug.addBreakpoints([bp1, bp2]);

    // Call the tool to list breakpoints
    const result = await callTool('debug_listBreakpoints', {
      format: 'detailed',
    });

    assert.ok(!result.error, 'Should not have error');
    assert.ok(Array.isArray(result.results.breakpoints), 'Should return array of breakpoints');
    assert.strictEqual(result.results.breakpoints.length, 2, 'Should have 2 breakpoints');

    // Check breakpoint structure
    const firstBp = result.results.breakpoints[0];
    assert.ok(firstBp.file.endsWith('app.ts'), 'Should include file name');
    assert.strictEqual(firstBp.line, 5, 'Should have correct line number (1-based)');
  });

  test('should clear all breakpoints', async () => {
    const document = await openTestFile('app.ts');

    // Set some breakpoints
    const bp = new vscode.SourceBreakpoint(
      new vscode.Location(document.uri, new vscode.Position(5, 0))
    );
    vscode.debug.addBreakpoints([bp]);

    assert.ok(vscode.debug.breakpoints.length > 0, 'Should have breakpoints before clear');

    // Clear all breakpoints
    const result = await callTool('debug_clearBreakpoints', {
      format: 'detailed',
    });

    // debug_clearBreakpoints is a command, not a query, so it stays raw and its
    // `status` describes the action -- see the shape-C exception in
    // docs/response-contract.md. It does carry `scope`.
    assert.ok(!result.error, 'Should not have error');
    assert.strictEqual(result.status, 'All breakpoints cleared', 'Should confirm cleared');
    assert.ok(result.scope, 'Commands must still say which window acted');
    assert.strictEqual(vscode.debug.breakpoints.length, 0, 'Should have no breakpoints');
  });

  test('should set breakpoint by symbol name', async () => {
    await openTestFile('app.ts');

    const result = await callTool('debug_setBreakpoint', {
      symbol: 'calculateSum',
      format: 'detailed',
    });

    console.log('Set breakpoint by symbol result:', JSON.stringify(result, null, 2));
    assert.ok(!result.error, `Should not have error: ${result.error}`);
    assert.ok(result.results.breakpoint, 'Should return breakpoint info');
    assert.strictEqual(result.results.breakpoint.symbol, 'calculateSum', 'Should have symbol name');
    assert.ok(result.results.breakpoint.file.endsWith('app.ts'), 'Should be in app.ts');
    assert.ok(typeof result.results.breakpoint.line === 'number', 'Should have line number');

    // Verify breakpoint exists
    const breakpoints = vscode.debug.breakpoints;
    assert.ok(breakpoints.length > 0, 'Should have at least one breakpoint');
  });

  test('should set breakpoint with condition', async () => {
    await openTestFile('app.ts');

    const result = await callTool('debug_setBreakpoint', {
      symbol: 'calculateSum',
      condition: 'numbers.length > 5',
      format: 'detailed',
    });

    assert.ok(!result.error, 'Should not have error');
    assert.ok(result.results.breakpoint, 'Should return breakpoint info');
    assert.strictEqual(result.results.breakpoint.condition, 'numbers.length > 5', 'Should have condition');

    // Verify breakpoint has condition
    const bp = vscode.debug.breakpoints[0] as vscode.SourceBreakpoint;
    assert.strictEqual(bp.condition, 'numbers.length > 5', 'Breakpoint should have condition');
  });

  test('should set breakpoint by file and line', async () => {
    await openTestFile('app.ts');

    const result = await callTool('debug_setBreakpoint', {
      file: 'app.ts',
      line: 9,
      format: 'detailed',
    });

    assert.ok(!result.error, 'Should not have error');
    assert.ok(result.results.breakpoint, 'Should return breakpoint info');
    assert.ok(result.results.breakpoint.file.endsWith('app.ts'), 'Should be in app.ts');
    assert.strictEqual(result.results.breakpoint.line, 9, 'Should have correct line');
  });

  test('should handle symbol not found', async () => {
    await openTestFile('app.ts');

    const result = await callTool('debug_setBreakpoint', {
      symbol: 'nonExistentFunction',
      format: 'detailed',
    });

    // No breakpoint was set, and the response says so outright rather than
    // leaving the caller to infer it. Near-misses come back as results.
    assert.strictEqual(result.status, 'not-found', 'Absent symbol must be not-found');
    assert.ok(
      result.reason.includes('no breakpoint was set'),
      'Must state that nothing was set'
    );
    assert.ok(Array.isArray(result.results), 'Candidates should be an array');
  });

  test('should toggle breakpoint', async () => {
    await openTestFile('app.ts');

    // First call should set breakpoint
    const result1 = await callTool('debug_toggleBreakpoint', {
      symbol: 'calculateSum',
      format: 'detailed',
    });

    assert.ok(!result1.error, 'Should not have error');
    assert.strictEqual(result1.results.action, 'added', 'Should add breakpoint');
    assert.strictEqual(vscode.debug.breakpoints.length, 1, 'Should have 1 breakpoint');

    // Second call should remove breakpoint
    const result2 = await callTool('debug_toggleBreakpoint', {
      symbol: 'calculateSum',
      format: 'detailed',
    });

    assert.ok(!result2.error, 'Should not have error');
    assert.strictEqual(result2.results.action, 'removed', 'Should remove breakpoint');
    assert.strictEqual(vscode.debug.breakpoints.length, 0, 'Should have 0 breakpoints');
  });

  test('should list breakpoints with conditions in compact format', async () => {
    await openTestFile('app.ts');

    // Set a conditional breakpoint
    const setBpResult = await callTool('debug_setBreakpoint', {
      symbol: 'calculateSum',
      condition: 'numbers.length > 10',
      format: 'detailed',
    });

    assert.ok(!setBpResult.error, 'Should set conditional breakpoint');

    // List breakpoints in compact format
    const result = await callTool('debug_listBreakpoints', {
      format: 'compact',
    });

    assert.ok(!result.error, 'Should not have error');
    assert.ok(result.format, 'Should include format description');
    assert.ok(result.format.includes('condition?'), 'Format should indicate optional condition');
    assert.ok(result.results.bps, 'Should have breakpoints array');

    // Find the breakpoint with condition
    const bpWithCondition = result.results.bps.find((bp: any) => bp.length === 4);
    assert.ok(bpWithCondition, 'Should have breakpoint with condition');
    assert.strictEqual(
      bpWithCondition[3].condition,
      'numbers.length > 10',
      'Should include condition'
    );
  });

  test('should get debug configurations', async () => {
    const result = await callTool('debug_listConfigurations', {
      format: 'detailed',
    });

    assert.ok(!result.error, 'Should not have error');
    assert.ok(Array.isArray(result.results.configurations), 'Should return array of configurations');
    assert.ok(result.results.configurations.length > 0, 'Should have at least one configuration');

    const config = result.results.configurations[0];
    assert.ok(config.name, 'Configuration should have name');
    assert.ok(config.type, 'Configuration should have type');
  });

  test('should provide debug status', async () => {
    const result = await callTool('debug_status', {
      format: 'detailed',
    });

    assert.ok(!result.error, 'Should not have error');
    assert.strictEqual(result.status, 'ok', 'Envelope status');
    assert.ok(result.results.status, 'Should have status object');
    assert.ok(typeof result.results.status.isActive === 'boolean', 'Should have isActive flag');
    assert.ok(typeof result.results.status.breakpointCount === 'number', 'Should have breakpoint count');
    assert.ok(Array.isArray(result.results.status.configurations), 'Should have configurations list');
  });

  test('should handle compact format', async () => {
    await openTestFile('app.ts');

    const result = await callTool('debug_setBreakpoint', {
      symbol: 'calculateSum',
      format: 'compact',
    });

    assert.ok(!result.error, 'Should not have error');
    assert.ok(result.format, 'Should include format description');
    assert.strictEqual(result.format, '[file, line, enabled]', 'Should describe array format');
    assert.ok(result.results.bp, 'Should have compact breakpoint info');
    assert.ok(Array.isArray(result.results.bp), 'Compact format should be array');
    assert.strictEqual(result.results.bp.length, 3, 'Should have [file, line, enabled]');
    assert.ok(result.results.bp[0].endsWith('app.ts'), 'First element should be file');
    assert.ok(typeof result.results.bp[1] === 'number', 'Second element should be line number');
    assert.strictEqual(result.results.bp[2], true, 'Third element should be enabled status');
  });

  test('should validate input parameters', async () => {
    // Test missing required parameters for setBreakpoint
    // Neither `symbol` nor `file`+`line` was given. The schema cannot express
    // "one of these two", so the tool checks it itself and throws -- which
    // reaches the caller as a rejection, not a payload that merely mentions an
    // error and could be mistaken for a result.
    await assert.rejects(
      () => callTool('debug_setBreakpoint', { format: 'detailed' } as any),
      (err: Error) => /Provide either a symbol name/.test(err.message),
      'Missing parameters must reject rather than return'
    );
  });

  test('should handle multiple symbols with same name', async () => {
    await openTestFile('math.ts');

    // 'add' exists as both a function and a method. Setting a breakpoint mutates
    // state, so an ambiguous name is refused rather than resolved by guessing --
    // the old behaviour returned match details in a success-shaped payload, and
    // "no breakpoint was set" was easy to miss.
    await assert.rejects(
      () => callTool('debug_setBreakpoint', { symbol: 'add', format: 'detailed' }),
      (err: Error) =>
        /matches \d+ symbols/.test(err.message) &&
        /no breakpoint\s+was set/.test(err.message) &&
        /qualified name/.test(err.message),
      'Ambiguous symbol must refuse, list candidates, and say how to disambiguate'
    );

    assert.strictEqual(
      vscode.debug.breakpoints.length,
      0,
      'Refusing must leave no breakpoint behind'
    );
  });

  // Skip debug session tests for now as they require more setup
  test.skip('should start debug session', async () => {
    const result = await callTool('debug_startSession', {
      configuration: 'Debug TypeScript File',
      format: 'detailed',
    });

    assert.ok(!result.error, 'Should not have error');
    assert.ok(result.session, 'Should return session info');

    // Clean up
    await vscode.debug.stopDebugging();
  });
});
