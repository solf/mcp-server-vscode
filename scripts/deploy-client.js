#!/usr/bin/env node
/*
 * Copies the built stdio client into a runner directory -- a standalone folder,
 * with its own node_modules, that MCP configs point at.
 *
 * Why not point configs straight at out/? Because that would make this repo
 * load-bearing for everyday tooling: a half-finished refactor, a checkout of an
 * older commit, or an `npm ci` (which deletes node_modules) would take MCP down
 * in every open window. Promoting by an explicit copy keeps the two separate.
 *
 * Usage: node scripts/deploy-client.js <target-dir>
 */
const fs = require('fs');
const path = require('path');

/**
 * The client and everything it requires. All three sit in one directory and
 * refer to each other relatively, so a flat copy is enough -- verified by there
 * being no '../' requires in the compiled output.
 */
const CLIENT_FILES = ['standalone-server.js', 'registry.js', 'resolve.js'];

const root = path.join(__dirname, '..');
const target = process.argv[2];

if (!target) {
  console.error('Usage: node scripts/deploy-client.js <target-dir>');
  process.exit(2);
}

// Fail on a missing target rather than creating one: a typo'd path would
// otherwise produce a plausible-looking directory that nothing ever reads.
if (!fs.existsSync(target)) {
  console.error(`Target does not exist: ${target}`);
  console.error('Create it and run "npm install @modelcontextprotocol/sdk" there first.');
  process.exit(1);
}

const sdk = path.join(target, 'node_modules', '@modelcontextprotocol', 'sdk');
if (!fs.existsSync(sdk)) {
  console.error(`Target has no @modelcontextprotocol/sdk installed: ${target}`);
  console.error('Run "npm install" there first, or the client will fail at startup.');
  process.exit(1);
}

const missing = CLIENT_FILES.filter((f) => !fs.existsSync(path.join(root, 'out', 'mcp', f)));
if (missing.length > 0) {
  console.error(`Not built: missing out/mcp/{${missing.join(', ')}}. Run "npm run compile" first.`);
  process.exit(1);
}

for (const file of CLIENT_FILES) {
  fs.copyFileSync(path.join(root, 'out', 'mcp', file), path.join(target, file));
  console.log(`  ${file}`);
}

// Version and build stamp of what was just promoted, so it can be compared
// against what a window reports on /health.
const info = require(path.join(root, 'out', 'buildInfo.js'));
console.log(`deployed v${info.BUILD_VERSION} ${info.BUILD_TIME} ${info.BUILD_COMMIT} -> ${target}`);
