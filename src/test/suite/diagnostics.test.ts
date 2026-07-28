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

suite('Diagnostics Tool Tests', () => {
  let context: TestContext;

  suiteSetup(async () => {
    context = await setupTest();
    // Open files to trigger diagnostics
    await openTestFile('app.ts');
    await openTestFile('math.ts');
    // Wait for diagnostics to be computed
    await new Promise((resolve) => setTimeout(resolve, 2000));
  });

  suiteTeardown(async () => {
    await teardownTest(context);
  });

  test('should detect type error in app.ts', async () => {
    const uri = getTestFileUri('app.ts');

    const result = await callTool('diagnostics', {
      format: 'detailed',
      uri: uri.toString(),
    });

    // The envelope must identify what it actually answered about, so an empty
    // result can be read as "this file is clean" rather than any of the other
    // things an empty array used to mean.
    assert.strictEqual(result.status, 'ok', 'File exists and was analysed');
    assert.ok(result.scope, 'Response must name the workspace that answered');
    assert.deepStrictEqual(
      result.subject.resolved,
      [uri.fsPath],
      'Resolved subject should be the file we asked about'
    );

    assert.ok(result.results, 'Should return diagnostics');
    assert.ok(Array.isArray(result.results), 'Should return array of diagnostics');

    // Find the type error we intentionally added
    const typeError = result.results.find(
      (d: any) =>
        d.message.includes('Type') &&
        d.message.includes('string') &&
        d.message.includes('number') &&
        d.range.start.line === 23 // hasTypeError function line with type error (1-based)
    );

    assert.ok(typeError, 'Should detect type mismatch error');
    assert.strictEqual(typeError.severity, 'Error', 'Should be an error severity');
  });

  test('should detect unused variable warning', async () => {
    const uri = getTestFileUri('app.ts');

    const result = await callTool('diagnostics', {
      format: 'detailed',
      uri: uri.toString(),
    });

    assert.ok(result.results, 'Should return diagnostics');

    // TypeScript might report unused variable
    const unusedVar = result.results.find(
      (d: any) =>
        d.message.includes('unused') ||
        (d.message.includes('declared') && d.message.includes('never'))
    );

    // Check that we found the unused variable diagnostic
    assert.ok(unusedVar, 'Should find unused variable diagnostic');

    // Find the specific unusedVariable diagnostic
    const unusedVariableDiag = result.results.find((d: any) =>
      d.message.includes("'unusedVariable'")
    );
    assert.ok(unusedVariableDiag, 'Should find unusedVariable diagnostic specifically');
  });

  test('should return empty array for file with no issues', async () => {
    const uri = getTestFileUri('math.ts');

    const result = await callTool('diagnostics', {
      format: 'detailed',
      uri: uri.toString(),
    });

    assert.ok(result.results, 'Should return diagnostics');
    assert.ok(Array.isArray(result.results), 'Should return array');

    // math.ts should have no errors
    const errors = result.results.filter((d: any) => d.severity === 'Error');
    assert.strictEqual(errors.length, 0, 'math.ts should have no errors');
  });

  test('should get all workspace diagnostics', async () => {
    // Get diagnostics for entire workspace (no uri)
    const result = await callTool('diagnostics', {
      format: 'detailed',
    });

    assert.ok(result.results, 'Should return diagnostics');
    assert.ok(
      typeof result.results === 'object',
      'Should return object with file URIs as keys'
    );

    // Should have diagnostics for app.ts
    // const appTsUri = getTestFileUri('app.ts').toString();
    const hasDiagnosticsForApp = Object.keys(result.results).some((uri) =>
      uri.endsWith('app.ts')
    );

    assert.ok(hasDiagnosticsForApp, 'Should include diagnostics for app.ts');
  });

  test('should include diagnostic source', async () => {
    const uri = getTestFileUri('app.ts');

    const result = await callTool('diagnostics', {
      format: 'detailed',
      uri: uri.toString(),
    });

    assert.ok(result.results, 'Should return diagnostics');

    const diagnostic = result.results.find((d: any) => d.severity === 'Error');
    if (diagnostic) {
      assert.ok(diagnostic.source, 'Diagnostic should have source');
      assert.ok(
        diagnostic.source === 'ts' || diagnostic.source === 'typescript',
        'Source should be TypeScript'
      );
    }
  });

  test('should include diagnostic code', async () => {
    const uri = getTestFileUri('app.ts');

    const result = await callTool('diagnostics', {
      format: 'detailed',
      uri: uri.toString(),
    });

    const typeError = result.results.find(
      (d: any) => d.message.includes('Type') && d.severity === 'Error'
    );

    if (typeError) {
      assert.ok(typeError.code, 'Type error should have error code');
      assert.ok(
        typeof typeError.code === 'number' || typeof typeError.code === 'string',
        'Error code should be number or string'
      );
    }
  });

  test('should report a non-existent file as not-found, not as clean', async () => {
    const uri = vscode.Uri.file('/non/existent/file.ts');

    const result = await callTool('diagnostics', {
      format: 'detailed',
      uri: uri.toString(),
    });

    // This used to return an empty array, indistinguishable from a file with no
    // problems -- the whole reason the contract exists. A missing file must say
    // so rather than reporting itself clean.
    assert.strictEqual(result.status, 'not-found', 'Missing file must be not-found');
    assert.deepStrictEqual(result.subject.resolved, [], 'Nothing should have resolved');
    assert.ok(result.reason, 'not-found must explain itself');
    assert.strictEqual(result.results.length, 0, 'No diagnostics to report');
  });

  test('should refuse to call an unanalysed file clean', async () => {
    // A file that exists but no language server has looked at. Reporting zero
    // problems for it would be a fabricated answer, so the tool errors instead;
    // callTool surfaces that as a rejection.
    const uri = getTestFileUri('../.gitignore');

    await assert.rejects(
      () => callTool('diagnostics', { format: 'detailed', uri: uri.toString() }),
      (err: Error) => /has not been analysed/.test(err.message),
      'Unanalysed file must be reported as indeterminate, not as clean'
    );
  });
});
