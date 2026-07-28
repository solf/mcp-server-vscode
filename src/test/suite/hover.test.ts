import * as assert from 'assert';
import {
  setupTest,
  teardownTest,
  openTestFile,
  callTool,
  TestContext,
} from '../helpers/testHelpers';

suite('Hover Tool Tests', () => {
  let context: TestContext;

  suiteSetup(async () => {
    context = await setupTest();
    // Open test files to ensure they're indexed
    await openTestFile('math.ts');
    await openTestFile('app.ts');
    // Give extra time for language server to index
    await new Promise((resolve) => setTimeout(resolve, 2000));
  });

  suiteTeardown(async () => {
    await teardownTest(context);
  });

  test('should return type information for add function', async () => {
    // Ensure file is open for this test
    await openTestFile('math.ts');

    // Use AI-friendly symbol-based approach
    const result = await callTool('hover', {
      format: 'detailed',
      symbol: 'add',
    });

    console.log('Hover result:', JSON.stringify(result, null, 2));

    assert.ok(!result.error, `Should not have error: ${result.error}`);

    // Find the add function from math.ts (not from temp files)
    const match = result.results.find(
        (m: any) => m.symbol.file.includes('math.ts') && !m.symbol.file.includes('temp-test')
    );
    assert.ok(match, 'Should find add function from math.ts');
    const hoverInfo = match.hover;

    assert.ok(hoverInfo.contents, 'Should have contents');
    const content = hoverInfo.contents.join(' ');
    // Should show function signature with parameter types
    assert.ok(content.includes('number'), 'Should show parameter types');
    assert.ok(content.includes('add'), 'Should include function name');
  });

  test('should return JSDoc documentation for function', async () => {
    const result = await callTool('hover', {
      format: 'detailed',
      symbol: 'add',
    });

    assert.ok(!result.error, 'Should not have error');

    // Find the add function from math.ts (not from temp files)
    const match = result.results.find(
        (m: any) => m.symbol.file.includes('math.ts') && !m.symbol.file.includes('temp-test')
    );
    assert.ok(match, 'Should find add function from math.ts');
    const hoverInfo = match.hover;

    const content = hoverInfo.contents.join(' ');
    // Check for JSDoc content
    assert.ok(
      content.includes('Adds two numbers') || content.includes('sum of a and b'),
      'Should include JSDoc documentation'
    );
  });

  test('should return class information', async () => {
    const result = await callTool('hover', {
      format: 'detailed',
      symbol: 'Calculator',
    });

    assert.ok(!result.error, 'Should not have error');

    // Find the Calculator class from math.ts (not from temp files)
    const match = result.results.find(
        (m: any) => m.symbol.file.includes('math.ts') && !m.symbol.file.includes('temp-test')
    );
    assert.ok(match, 'Should find Calculator class from math.ts');
    const hoverInfo = match.hover;

    assert.ok(hoverInfo.contents, 'Should have contents');
    const content = hoverInfo.contents.join(' ');
    assert.ok(content.includes('Calculator'), 'Should include class name');
    assert.ok(content.includes('class'), 'Should indicate it is a class');
  });

  test('should return method information with JSDoc', async () => {
    const result = await callTool('hover', {
      format: 'detailed',
      symbol: 'Calculator.add',
    });

    console.log('Calculator.add hover result:', JSON.stringify(result, null, 2));

    assert.ok(!result.error, `Should not have error: ${result.error}`);

    // The symbol resolved but no hover provider had anything to say. That is
    // reported as a reason on an otherwise-ok result, distinct from the symbol
    // not existing.
    if (result.reason) {
      console.log('No hover information:', result.reason);
      return;
    }

    const methodMatch = result.results.find(
      (m: any) => m.symbol.container === 'Calculator' && m.symbol.name.startsWith('add')
    );
    assert.ok(methodMatch, 'Should find Calculator.add method');
    assert.ok(methodMatch.hover, 'Method should have hover info');
    const content = methodMatch.hover.contents.join(' ');
    assert.ok(
      content.includes('Adds a number') || content.includes('current result'),
      'Should include method documentation'
    );
  });

  test('should handle symbol not found', async () => {
    const result = await callTool('hover', {
      format: 'detailed',
      symbol: 'nonExistentFunction',
    });

    assert.strictEqual(result.status, 'not-found', 'Absent symbol must be not-found');
    assert.deepStrictEqual(result.subject.resolved, [], 'Nothing should have resolved');
    assert.ok(result.reason, 'not-found must explain itself');
  });

  test.skip('should show imported type information', async () => {
    // This test depends on TypeScript language features availability
    // Skip if not available
  });

  test('should include code snippet in response', async () => {
    const result = await callTool('hover', {
      format: 'detailed',
      symbol: 'multiply',
    });

    assert.ok(!result.error, 'Should not have error');

    if (result.reason) {
      console.log('No hover information:', result.reason);
      return;
    }

    const hover = result.results[0]?.hover;
    assert.ok(hover, 'Should return hover information');
    assert.ok(hover.codeSnippet, 'Should include code snippet');

    // Code snippet should show the function with context
    assert.ok(hover.codeSnippet.includes('multiply'), 'Code snippet should include function name');
    assert.ok(hover.codeSnippet.includes('>'), 'Code snippet should mark the target line');
  });

  test('should handle multiple matches', async () => {
    // If there are multiple symbols with the same name, it should return all
    const result = await callTool('hover', {
      format: 'detailed',
      symbol: 'add', // This could match both the function and the method
    });

    assert.ok(!result.error, 'Should not have error');

    if (result.reason) {
      console.log('No hover information:', result.reason);
      return;
    }

    // One shape regardless of how many matched -- the caller no longer has to
    // branch on a `multipleMatches` flag to know where to look.
    assert.ok(Array.isArray(result.results), 'Results should always be an array');
    assert.ok(result.results.length > 0, 'Should have at least one match');
    assert.strictEqual(
      result.results.length,
      result.subject.resolved.length,
      'One hover entry per resolved symbol'
    );

    result.results.forEach((match: any) => {
      assert.ok(match.hover, 'Each match should have hover info');
      assert.ok(match.symbol, 'Each match should have symbol info');
    });
  });
});
