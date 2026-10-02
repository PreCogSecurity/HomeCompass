#!/usr/bin/env node
/**
 * Zero-dependency project linter.
 *
 * HomeCompass ships with no third-party packages, so linting cannot come from a
 * dev dependency either. This script implements the checks that actually protect
 * this codebase - a strict syntax pass plus the security-relevant content rules
 * in `lint.config.json` - and exits non-zero on any error so CI can gate on it.
 *
 * Usage: node scripts/lint.mjs [--fix]
 */
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import process from 'node:process';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\//, '')), '..');

/** @typedef {{file: string, line: number, column: number, rule: string, message: string}} Problem */

/**
 * Translate a glob into an anchored regular expression.
 * Supports `**`, `*` and `?`; everything else is literal.
 *
 * @param {string} glob
 * @returns {RegExp}
 */
function globToRegExp(glob) {
  let source = '';
  for (let index = 0; index < glob.length; index += 1) {
    const char = glob[index];
    if (char === '*') {
      if (glob[index + 1] === '*') {
        index += 1;
        if (glob[index + 1] === '/') {
          index += 1;
          source += '(?:[^/]+/)*';
        } else {
          source += '.*';
        }
      } else {
        source += '[^/]*';
      }
    } else if (char === '?') {
      source += '[^/]';
    } else if ('\\^$.|+()[]{}'.includes(char)) {
      source += `\\${char}`;
    } else {
      source += char;
    }
  }
  return new RegExp(`^${source}$`);
}

/** @param {string[]} globs */
function matchesAny(globs, relativePath) {
  return globs.some((glob) => globToRegExp(glob).test(relativePath));
}

/**
 * Walk the tree, skipping ignored directories.
 *
 * @param {string} directory
 * @param {string[]} ignore
 * @param {string[]} [collected]
 * @returns {Promise<string[]>} repo-relative POSIX-style paths
 */
async function collectFiles(directory, ignore, collected = []) {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return collected;
  }
  for (const entry of entries) {
    const relative = path.relative(ROOT, path.join(directory, entry.name)).split(path.sep).join('/');
    if (entry.isDirectory()) {
      if (matchesAny(ignore, `${relative}/`)) continue;
      await collectFiles(path.join(directory, entry.name), ignore, collected);
      continue;
    }
    if (entry.isFile()) collected.push(relative);
  }
  return collected;
}

/**
 * Parse the file with the very Node binary that will run it, so the syntax check
 * matches the runtime exactly (ESM included).
 *
 * @param {string} file
 * @returns {string|null} error message, or null when the file parses
 */
function syntaxError(file) {
  try {
    execFileSync(process.execPath, ['--check', path.join(ROOT, file)], { stdio: ['ignore', 'ignore', 'pipe'] });
    return null;
  } catch (error) {
    const stderr = error.stderr === undefined ? '' : String(error.stderr);
    const firstLine = stderr.split(/\r?\n/).find((line) => line.includes('Error')) ?? 'syntax error';
    return firstLine.replace(/^.*?SyntaxError:?\s*/, 'SyntaxError: ').trim();
  }
}

/**
 * @param {string} text
 * @param {string} file
 * @param {object} config
 * @returns {Problem[]}
 */
function checkText(text, file, config) {
  /** @type {Problem[]} */
  const problems = [];
  const lines = text.split('\n');
  const scope = file.split(path.sep).join('/');

  for (const [name, rule] of Object.entries(config.rules)) {
    if (rule.scope !== undefined && !matchesAny(rule.scope, scope)) continue;
    const pattern = new RegExp(rule.pattern, 'g');
    lines.forEach((line, index) => {
      pattern.lastIndex = 0;
      let match = pattern.exec(line);
      while (match !== null) {
        problems.push({
          file,
          line: index + 1,
          column: match.index + 1,
          rule: name,
          message: rule.message,
        });
        if (match.index === pattern.lastIndex) pattern.lastIndex += 1;
        match = pattern.exec(line);
      }
    });
  }

  if (config.allowTabs !== true) {
    lines.forEach((line, index) => {
      if (line.includes('\t')) {
        problems.push({
          file,
          line: index + 1,
          column: line.indexOf('\t') + 1,
          rule: 'no-tabs',
          message: 'use spaces',
        });
      }
    });
  }

  if (config.allowCrlf !== true && text.includes('\r')) {
    problems.push({ file, line: 1, column: 1, rule: 'line-endings', message: 'CRLF found; use LF' });
  }

  lines.forEach((line, index) => {
    if (/[ \t]+$/.test(line)) {
      problems.push({
        file,
        line: index + 1,
        column: line.replace(/[ \t]+$/, '').length + 1,
        rule: 'no-trailing-whitespace',
        message: 'trailing whitespace',
      });
    }
    if (Number.isInteger(config.maxLineLength) && line.length > config.maxLineLength) {
      problems.push({
        file,
        line: index + 1,
        column: config.maxLineLength + 1,
        rule: 'max-len',
        message: `line exceeds ${config.maxLineLength} characters (${line.length})`,
      });
    }
  });

  if (config.requireFinalNewline === true && text.length > 0 && !text.endsWith('\n')) {
    problems.push({ file, line: lines.length, column: 1, rule: 'eol-last', message: 'file must end with a newline' });
  }

  return problems;
}

/**
 * @param {string} file
 * @param {boolean} fix
 */
async function fixFile(file, fix) {
  const absolute = path.join(ROOT, file);
  const original = await readFile(absolute, 'utf8');
  const fixed = original
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+$/gm, '')
    .replace(/\n*$/, '\n');
  if (fixed !== original && fix) {
    await writeFile(absolute, fixed, 'utf8');
    return fixed;
  }
  return original;
}

async function main() {
  const fix = process.argv.includes('--fix');
  const config = require('../lint.config.json');
  const allFiles = await collectFiles(ROOT, config.ignore);
  const targets = allFiles.filter((file) => matchesAny(config.include, file)).sort();

  /** @type {Problem[]} */
  const problems = [];
  let checked = 0;

  for (const file of targets) {
    const isJs = /\.(mjs|cjs|js)$/.test(file);
    if (isJs) {
      const parseError = syntaxError(file);
      if (parseError !== null) {
        problems.push({ file, line: 1, column: 1, rule: 'syntax', message: parseError });
        continue;
      }
    }
    const text = await fixFile(file, fix);
    problems.push(...checkText(text, file, config));
    checked += 1;
  }

  const errors = problems.filter((problem) => problem.rule !== 'no-skipped-tests');
  const warnings = problems.filter((problem) => problem.rule === 'no-skipped-tests');

  for (const problem of problems) {
    const level = problem.rule === 'no-skipped-tests' ? 'warning' : 'error';
    process.stdout.write(
      `${level}  ${problem.file}:${problem.line}:${problem.column}  ${problem.message}  ${problem.rule}\n`,
    );
  }

  process.stdout.write(
    `\nlint: checked ${checked} file(s), ${errors.length} error(s), ${warnings.length} warning(s)` +
      `${fix ? ' (--fix applied)' : ''}\n`,
  );

  if (errors.length > 0) process.exitCode = 1;
}

main().catch((error) => {
  process.stderr.write(`lint failed: ${error.message}\n`);
  process.exitCode = 1;
});
