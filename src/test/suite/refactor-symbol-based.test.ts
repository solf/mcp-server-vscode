import * as assert from 'assert';
import * as vscode from 'vscode';
import { setupTest, teardownTest, callTool, TestContext } from '../helpers/testHelpers';

suite('Refactor Tools Tests (Symbol-Based)', () => {
  let context: TestContext;
  const tempFiles: vscode.Uri[] = [];

  suiteSetup(async () => {
    context = await setupTest();
  });

  suiteTeardown(async () => {
    await teardownTest(context);
    // Clean up any remaining temp files
    for (const uri of tempFiles) {
      try {
        await vscode.workspace.fs.delete(uri);
      } catch {
        // Ignore cleanup errors
      }
    }
  });

  // Helper to create temporary test files
  async function createTempFile(name: string, content: string): Promise<vscode.Uri> {
    const uri = vscode.Uri.joinPath(context.workspaceUri, 'src', `temp-test-${Date.now()}-${name}`);
    await vscode.workspace.fs.writeFile(uri, Buffer.from(content));
    tempFiles.push(uri);

    // Open and wait for language server
    const doc = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(doc);
    await new Promise((resolve) => setTimeout(resolve, 2000));

    return uri;
  }

  // Clean up temp files after each test
  teardown(async () => {
    for (const uri of tempFiles) {
      try {
        await vscode.workspace.fs.delete(uri);
      } catch {
        // Ignore cleanup errors
      }
    }
    tempFiles.length = 0;
  });

  suite('Symbol-Based Rename Tests', () => {
    test('should rename function by symbol name', async () => {
      const content = `export function calculateTotal(items: number[]): number {
  return items.reduce((sum, item) => sum + item, 0);
}

export function processOrder() {
  const items = [10, 20, 30];
  const total = calculateTotal(items);
  console.log('Total:', total);
}`;

      await createTempFile('rename-test.ts', content);

      // Test renaming by symbol name only
      const result = await callTool('refactor_rename', {
        symbol: 'calculateTotal',
        newName: 'computeSum',
      });

      assert.strictEqual(result.status, 'ok', 'Rename should succeed');
      // Symbol names might include () for functions
      assert.ok(
        result.results.renamed.oldName === 'calculateTotal' ||
          result.results.renamed.oldName === 'calculateTotal()',
        `Expected 'calculateTotal' or 'calculateTotal()' but got '${result.results.renamed.oldName}'`
      );
      assert.strictEqual(result.results.renamed.newName, 'computeSum');
      assert.ok(result.results.filesChanged > 0, 'Should have changed files');
      assert.ok(result.results.totalEdits >= 2, 'Should have at least 2 edits (definition + usage)');
    });

    test('should provide suggestions for misspelled symbol', async () => {
      const content = `export function calculateTotal(items: number[]): number {
  return items.reduce((sum, item) => sum + item, 0);
}`;

      await createTempFile('suggestions-test.ts', content);

      // Test with misspelled symbol name
      const result = await callTool('refactor_rename', {
        symbol: 'calculteTotal', // Missing 'a'
        newName: 'computeSum',
      });

      // A misspelling means the symbol does not exist -- a real answer, not a
      // failure. The near-misses come back as results so the caller can correct
      // the name, and `reason` states plainly that nothing was renamed.
      assert.strictEqual(result.status, 'not-found', 'Misspelled symbol must be not-found');
      assert.ok(result.reason.includes('nothing renamed'), 'Must confirm nothing was written');
      assert.ok(result.results.length > 0, 'Should have at least one suggestion');
      assert.ok(
        result.results.some(
          (s: any) => s.name === 'calculateTotal' || s.name === 'calculateTotal()'
        ),
        'Should suggest the correct name'
      );
    });

    test('should handle multiple matches with disambiguation', async () => {
      const content1 = `export class Calculator {
  add(a: number, b: number): number {
    return a + b;
  }
}`;

      const content2 = `export function add(x: number, y: number): number {
  return x + y;
}`;

      await createTempFile('class-test.ts', content1);
      await createTempFile('function-test.ts', content2);

      // This tool writes to disk. An ambiguous name used to come back as a
      // successful result carrying disambiguation info -- a caller skimming for
      // an error saw none and could reasonably assume the rename had happened.
      // It now refuses outright, and says which candidates it could not choose
      // between.
      await assert.rejects(
        () => callTool('refactor_rename', { symbol: 'add', newName: 'sum' }),
        (err: Error) =>
          /Refusing to rename/.test(err.message) &&
          /matches \d+ symbols/.test(err.message) &&
          /qualified name/.test(err.message),
        'Ambiguous rename must refuse, name the candidates, and say how to disambiguate'
      );
    });

    test('should rename with file URI disambiguation', async () => {
      const content = `export function processData(data: any): void {
  console.log('Processing:', data);
}`;

      const uri = await createTempFile('uri-test.ts', content);

      // Test with URI to disambiguate
      const result = await callTool('refactor_rename', {
        symbol: 'processData',
        newName: 'handleData',
        uri: uri.toString(),
      });

      assert.strictEqual(result.status, 'ok', 'Rename should succeed');
      assert.ok(
        result.results.renamed.oldName === 'processData' ||
          result.results.renamed.oldName === 'processData()',
        `Expected 'processData' or 'processData()' but got '${result.results.renamed.oldName}'`
      );
      assert.strictEqual(result.results.renamed.newName, 'handleData');
    });
  });

  suite('Compact vs Detailed Format Tests', () => {
    test('should return compact format by default', async () => {
      const content = `export const PI = 3.14159;`;
      await createTempFile('compact-test.ts', content);

      const result = await callTool('refactor_rename', {
        symbol: 'PI',
        newName: 'MATH_PI',
      });

      if (result.status === 'ok') {
        assert.ok(!result.results.changes, 'Compact format should not include detailed changes');
        assert.ok(result.results.filesChanged !== undefined, 'Should include file count');
        assert.ok(result.results.totalEdits !== undefined, 'Should include edit count');
      }
    });

    test('should return detailed format when requested', async () => {
      const content = `export const PI = 3.14159;`;
      await createTempFile('detailed-test.ts', content);

      const result = await callTool('refactor_rename', {
        symbol: 'PI',
        newName: 'MATH_PI',
        format: 'detailed',
      });

      if (result.status === 'ok') {
        assert.ok(result.results.changes, 'Detailed format should include changes');
        assert.ok(result.results.renamed.kind, 'Should include symbol kind');
        assert.ok(result.results.renamed.location, 'Should include location');
      }
    });
  });

  suite('Error Handling and Edge Cases', () => {
    test('should handle external/non-renameable symbols', async () => {
      const content = `import { readFile } from 'fs';

export function loadData() {
  readFile('data.txt', (err, data) => {
    console.log(data);
  });
}`;

      await createTempFile('external-test.ts', content);

      const result = await callTool('refactor_rename', {
        symbol: 'readFile',
        newName: 'readFileSync',
      });

      // An external symbol either does not resolve in this workspace at all
      // (not-found) or resolves but has no rename provider (which throws, since
      // the operation was requested and did not happen). Either way it must not
      // report success, because nothing was written.
      assert.notStrictEqual(
        result.status,
        'ok',
        `Expected a refusal for an external symbol. Got: ${JSON.stringify(result)}`
      );
      assert.ok(result.reason, 'Must say why the rename did not happen');
    });

    test('should validate required parameters', async () => {
      // Missing newName
      const result1 = await callTool('refactor_rename', {
        symbol: 'someSymbol',
      });
      assert.ok(result1.error, 'Should error on missing newName');

      // Missing symbol
      const result2 = await callTool('refactor_rename', {
        newName: 'newName',
      });
      assert.ok(result2.error, 'Should error on missing symbol');
    });
  });
});
