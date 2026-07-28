import * as assert from 'assert';
import * as vscode from 'vscode';
import {
  setupTest,
  teardownTest,
  openTestFile,
  callTool,
  TestContext,
  getTestFileUri,
} from '../helpers/testHelpers';
import { waitForLanguageServer } from '../helpers/languageServerReady';

suite('Call Hierarchy Tool Tests', () => {
  let context: TestContext;

  suiteSetup(async () => {
    context = await setupTest();
  });

  suiteTeardown(async () => {
    await teardownTest(context);
  });

  test('should find incoming calls to add function', async () => {
    await openTestFile('math.ts');

    // Use AI-friendly symbol-based approach
    const result = await callTool(
      'callHierarchy',
      {
        format: 'detailed',
        symbol: 'add',
        direction: 'incoming',
      },
      context
    );

    assert.ok(!result.error, `Should not have error: ${result.error}`);

    // Other suites create temp files that also declare `add`, so this resolves
    // to several symbols in a full run and to one when this suite runs alone.
    // Pick the math.ts entry either way rather than assuming a single match.
    const pickMathEntry = (envelope: any) =>
      envelope.results.find(
        (m: any) => m.symbol.file.includes('math.ts') && !m.symbol.file.includes('temp-test')
      ) ?? envelope.results[0];

    let entry = pickMathEntry(result);
    assert.ok(entry, 'Should find add function from math.ts');

    // "resolved, but nothing calls it and it calls nothing" is reported as a
    // reason on an otherwise-ok result -- distinct from the symbol not existing.
    if (!entry.calls?.length && result.reason) {
      // Language server might not be ready yet - retry with proper wait
      const doc = await vscode.workspace.openTextDocument(getTestFileUri('math.ts'));
      const ready = await waitForLanguageServer(doc);

      if (!ready) {
        assert.fail('Language server should be ready for call hierarchy');
      }

      const retryResult = await callTool(
        'callHierarchy',
        {
          format: 'detailed',
          symbol: 'add',
          direction: 'incoming',
        },
        context
      );

      entry = pickMathEntry(retryResult);
      if (!entry?.calls?.length) {
        assert.fail('Call hierarchy should be available after retry');
      }
    }

    assert.ok(entry.calls, 'Should return calls');
    assert.ok(entry.calls.length > 0, 'Should find at least one incoming call');

    // Should find the call from calculateSum in app.ts
    const callFromCalculateSum = entry.calls.find(
      (call: any) => call.from.name === 'calculateSum'
    );
    assert.ok(callFromCalculateSum, 'Should find call from calculateSum function');

    // Verify the call location details
    assert.ok(callFromCalculateSum.locations, 'Should have call locations');
    assert.ok(callFromCalculateSum.locations.length > 0, 'Should have at least one location');
    assert.ok(
      callFromCalculateSum.locations[0].line >= 0,
      'Should have valid line number (0-based)'
    );
  });

  test('should find outgoing calls from calculateSum function', async () => {
    await openTestFile('app.ts');

    const result = await callTool(
      'callHierarchy',
      {
        format: 'detailed',
        symbol: 'calculateSum',
        direction: 'outgoing',
      },
      context
    );

    assert.ok(!result.error, 'Should not have error');
    assert.ok(result.results[0].calls, 'Should return calls');
    assert.ok(result.results[0].calls.length > 0, 'Should find at least one outgoing call');

    // Should find the call to add function
    const callToAdd = result.results[0].calls.find((call: any) => call.to.name === 'add');
    assert.ok(callToAdd, 'Should find call to add function');

    // Verify it's the standalone function, not the method
    assert.ok(!callToAdd.to.container, 'Should call standalone add function, not method');
  });

  test('should find incoming calls to Calculator class methods', async () => {
    await openTestFile('math.ts');

    const result = await callTool(
      'callHierarchy',
      {
        format: 'detailed',
        symbol: 'Calculator.multiply',
        direction: 'incoming',
      },
      context
    );

    assert.ok(!result.error, `Should not have error: ${result.error}`);

    // Note: Calculator.multiply might not be used in our test files
    // This is a valid test case - the tool should handle unused methods gracefully
    if (result.reason) {
      assert.ok(
        result.reason.includes('no call hierarchy available'),
        'Should indicate no hierarchy available for unused method'
      );
      return;
    }

    assert.ok(result.results[0].calls, 'Should return calls array (possibly empty)');
  });

  test('should handle ambiguous symbol names correctly', async () => {
    // Test that when searching for 'add', we get the function not the method
    const result = await callTool(
      'callHierarchy',
      {
        format: 'detailed',
        symbol: 'add',
        direction: 'incoming',
      },
      context
    );

    assert.ok(!result.error, 'Should not have error');

    // Handle multiple matches case
    let symbolToCheck;
    if (result.subject.resolved.length > 1) {
      // Find the add function from math.ts (not from temp files)
      const mathMatch = result.results.find(
        (m: any) => m.symbol.file.includes('math.ts') && !m.symbol.file.includes('temp-test')
      );
      assert.ok(mathMatch, 'Should find add function from math.ts');
      symbolToCheck = mathMatch.symbol;
    } else if (result.results[0]?.symbol) {
      symbolToCheck = result.results[0].symbol;
    }

    if (symbolToCheck) {
      // Verify we got the standalone function
      assert.ok(!symbolToCheck.container, 'Should prioritize standalone function over method');
      assert.strictEqual(symbolToCheck.kind, 'Function', 'Should identify as function');
    }
  });

  test('should include call location information', async () => {
    await openTestFile('math.ts');

    const result = await callTool(
      'callHierarchy',
      {
        format: 'detailed',
        symbol: 'add',
        direction: 'incoming',
      },
      context
    );

    assert.ok(!result.error, 'Should not have error');

    // Skip if no hierarchy available (but don't just return)
    if (!result.reason && result.results[0].calls && result.results[0].calls.length > 0) {
      const firstCall = result.results[0].calls[0];
      assert.ok(firstCall.from, 'Should have from information');
      assert.ok(firstCall.from.name, 'Should have caller name');
      assert.ok(firstCall.from.file, 'Should have file path');
      assert.ok(firstCall.from.kind, 'Should have symbol kind');
      assert.ok(firstCall.locations, 'Should have call locations');
      assert.ok(Array.isArray(firstCall.locations), 'Locations should be an array');

      if (firstCall.locations.length > 0) {
        const loc = firstCall.locations[0];
        assert.ok(typeof loc.line === 'number', 'Line should be a number');
        assert.ok(loc.line >= 0, 'Line should be 0-based for AI');
        assert.ok(typeof loc.character === 'number', 'Character should be a number');

        // If preview is included, verify it
        if (loc.preview) {
          assert.ok(typeof loc.preview === 'string', 'Preview should be a string');
        }
      }
    }
  });

  test('should handle symbol not found', async () => {
    const result = await callTool(
      'callHierarchy',
      {
        format: 'detailed',
        symbol: 'nonExistentFunction',
        direction: 'incoming',
      },
      context
    );

    // An absent symbol is a legitimate answer, not a failure -- the caller asked
    // a valid question and there is nothing there. It says so explicitly rather
    // than returning an empty call list that could equally mean "never called".
    assert.strictEqual(result.status, 'not-found', 'Absent symbol must be not-found');
    assert.deepStrictEqual(result.subject.resolved, [], 'Nothing should have resolved');
    assert.ok(result.reason, 'not-found must explain itself');
  });

  test('should find both incoming and outgoing calls', async () => {
    await openTestFile('app.ts');

    const result = await callTool(
      'callHierarchy',
      {
        format: 'detailed',
        symbol: 'calculateSum',
        direction: 'both',
      },
      context
    );

    assert.ok(!result.error, 'Should not have error');
    assert.ok(result.results[0].calls, 'Should return calls');

    // Should have both incoming and outgoing calls
    const outgoingCalls = result.results[0].calls.filter((c: any) => c.type === 'outgoing');

    assert.ok(outgoingCalls.length > 0, 'Should find outgoing calls');
    // Note: calculateSum might not have incoming calls in test workspace

    // Verify call types are properly labeled
    result.results[0].calls.forEach((call: any) => {
      assert.ok(
        ['incoming', 'outgoing'].includes(call.type),
        'Call type should be incoming or outgoing'
      );
    });
  });

  test('should work with class method notation', async () => {
    const result = await callTool(
      'callHierarchy',
      {
        format: 'detailed',
        symbol: 'Calculator.add',
        direction: 'incoming',
      },
      context
    );

    assert.ok(!result.error, 'Should not have error');

    // The tool should handle class.method notation correctly
    // It might return multiple matches (both the method and function named 'add')
    if (result.subject.resolved.length > 1) {
      assert.ok(result.results, 'Should have matches array');
      const methodMatch = result.results.find(
        (m: any) => m.symbol.container === 'Calculator' && m.symbol.name.includes('add')
      );
      assert.ok(methodMatch, 'Should find the Calculator.add method among matches');
    } else if (result.results[0]?.symbol) {
      // Single match case
      assert.strictEqual(result.results[0].symbol.container, 'Calculator', 'Should identify container');
      assert.ok(result.results[0].symbol.name.includes('add'), 'Should identify method name');
    }
    // If no hierarchy is available, that's also valid
  });

  test('should provide helpful error messages with suggestions', async () => {
    const result = await callTool(
      'callHierarchy',
      {
        format: 'detailed',
        symbol: 'calc', // Partial name
        direction: 'incoming',
      },
      context
    );

    // A partial name either resolves or does not. When it does not, the
    // near-misses come back as results alongside status:not-found, so the caller
    // can correct the name instead of concluding nothing exists.
    if (result.status === 'not-found') {
      assert.ok(result.reason, 'not-found must explain itself');
      assert.ok(Array.isArray(result.results), 'Candidates should be an array');

      result.results.forEach((candidate: any) => {
        assert.ok(candidate.name, 'Candidate should have name');
        assert.ok(candidate.kind, 'Candidate should have kind');
      });
    } else {
      assert.strictEqual(result.status, 'ok', 'Otherwise it resolved');
      assert.ok(result.subject.resolved.length > 0, 'A resolved result names what it matched');
    }
  });
});
