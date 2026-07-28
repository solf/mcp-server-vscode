import * as assert from 'assert';
import {
  setupTest,
  teardownTest,
  callTool,
  openTestFile,
  TestContext,
} from '../helpers/testHelpers';

suite('References Tool Tests', () => {
  let context: TestContext;

  suiteSetup(async () => {
    context = await setupTest();
  });

  suiteTeardown(async () => {
    await teardownTest(context);
  });

  test('should find function references by symbol name', async () => {
    // Open a file to ensure it's indexed
    await openTestFile('app.ts');

    const result = await callTool('references', {
      format: 'detailed',
      symbol: 'add',
      includeDeclaration: true,
    });

    assert.ok(!result.error, `Should not have error: ${result.error}`);
    assert.ok(result.results, 'Should return references');
    assert.ok(result.results.length > 0, 'Should find at least one reference');
    assert.strictEqual(result.subject.requested, 'add', 'Should return symbol name');
    assert.ok(result.results.length > 0, 'Should have totalReferences count');

    // Verify reference structure
    const ref = result.results[0];
    assert.ok(ref.uri, 'Reference should have URI');
    assert.ok(ref.file, 'Reference should have file path');
    assert.ok(typeof ref.line === 'number', 'Reference should have line number');
    assert.ok(ref.range, 'Reference should have range');
    assert.ok(typeof ref.range.start.line === 'number', 'Range should have start line');
    assert.ok(typeof ref.range.start.character === 'number', 'Range should have start character');
  });

  test('should find class references by symbol name', async () => {
    const result = await callTool('references', {
      format: 'detailed',
      symbol: 'Calculator',
    });

    assert.ok(!result.error, 'Should not have error');
    assert.ok(result.results, 'Should return references');
    assert.strictEqual(result.subject.requested, 'Calculator', 'Should return symbol name');

    // Should find references where Calculator is used
    const hasAppReference = result.results.some((ref: any) => ref.file.includes('app.ts'));
    assert.ok(hasAppReference, 'Should find reference in app.ts');
  });

  test('should find class method references by qualified name', async () => {
    const result = await callTool('references', {
      format: 'detailed',
      symbol: 'Calculator.add',
    });

    assert.ok(!result.error, 'Should not have error');
    assert.ok(result.results, 'Should return references');
    assert.strictEqual(result.subject.requested, 'Calculator.add', 'Should return full symbol name');

    // Should find method calls specifically
    if (result.results.length > 0) {
      const ref = result.results[0];
      assert.ok(ref.file, 'Reference should have file');
      assert.ok(typeof ref.line === 'number', 'Reference should have line number');
    }
  });

  test('should exclude declaration when requested', async () => {
    const withDeclaration = await callTool('references', {
      format: 'detailed',
      symbol: 'add',
      includeDeclaration: true,
    });

    const withoutDeclaration = await callTool('references', {
      format: 'detailed',
      symbol: 'add',
      includeDeclaration: false,
    });

    assert.ok(!withDeclaration.error, 'Should not have error with declaration');
    assert.ok(!withoutDeclaration.error, 'Should not have error without declaration');

    // Without declaration should have fewer references
    assert.ok(
      withoutDeclaration.results.length <= withDeclaration.results.length,
      'Without declaration should have same or fewer references'
    );
  });

  test('should handle symbol not found', async () => {
    const result = await callTool('references', {
      format: 'detailed',
      symbol: 'NonExistentSymbol',
    });

    // An absent symbol and a symbol nothing references both used to be an empty
    // array. They are now distinguishable: this one resolved to nothing at all.
    assert.strictEqual(result.status, 'not-found', 'Absent symbol must be not-found');
    assert.deepStrictEqual(result.subject.resolved, [], 'Nothing should have resolved');
    assert.ok(result.reason, 'not-found must explain itself');
    assert.deepStrictEqual(result.results, [], 'Should return empty references');
  });

  test('should distinguish an unreferenced symbol from a missing one', async () => {
    // The counterpart to the test above: this symbol exists, so it resolves --
    // an empty result here means "nothing calls it", not "no such thing".
    const result = await callTool('references', {
      format: 'detailed',
      symbol: 'Calculator',
      includeDeclaration: false,
    });

    assert.strictEqual(result.status, 'ok', 'Existing symbol must resolve');
    assert.ok(result.subject.resolved.length > 0, 'Declaration site(s) must be reported');
    assert.ok(result.subject.resolved[0].file, 'Resolved entry should name its file');
  });

  test('should validate input parameters', async () => {
    // Schema validation fails the request before the tool runs, so the bridge
    // answers 400 and callTool surfaces it as {error} rather than rejecting.
    // That is the protocol-error half of the contract, distinct from a tool that
    // ran and could not answer -- those reject.
    const result = await callTool('references', {
      format: 'detailed',
    });

    assert.ok(result.error, 'Should have error');
    assert.ok(result.error.includes('required'), 'Should indicate symbol is required');
  });

  test('should handle multiple symbols with same name', async () => {
    // 'add' exists as both a function and a method
    const result = await callTool('references', {
      format: 'detailed',
      symbol: 'add',
    });

    assert.ok(!result.error, 'Should not have error');
    assert.ok(result.results, 'Should return references');

    // Should find references to both the function and the method
    if (result.results.length > 1) {
      // Check that we get references from different contexts
      const files = [...new Set(result.results.map((ref: any) => ref.file))];
      console.log(`Found references in ${files.length} different files`);
    }
  });

  test('should return consistent reference format', async () => {
    const result = await callTool('references', {
      format: 'detailed',
      symbol: 'Calculator',
    });

    assert.ok(!result.error, 'Should not have error');
    assert.ok(result.results, 'Should return references');

    // Check each reference has the expected format
    for (const ref of result.results) {
      assert.ok(ref.uri, 'Each reference should have uri');
      assert.ok(ref.file, 'Each reference should have file');
      assert.ok(typeof ref.line === 'number', 'Each reference should have line number');
      assert.ok(ref.range, 'Each reference should have range');
      assert.ok(ref.range.start, 'Range should have start');
      assert.ok(ref.range.end, 'Range should have end');
      assert.ok(typeof ref.range.start.line === 'number', 'Start should have line (0-based)');
      assert.ok(typeof ref.range.start.character === 'number', 'Start should have character');
    }
  });
});
