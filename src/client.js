'use strict';

const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const { spawn } = require('node:child_process');

const { isStatementComplete } = require('./statement-completion');
const { findCommandSubstitution } = require('./substitution-context');

const SHELL_COMMAND_PATTERN =
  /^(?:!.*|get|post|put|find|show|set|echo|record|history|save|load|help|\?|exit|quit)(?:\s|$)/;
const HISTORY_SIZE = 1000;

function formatResult(value) {
  if (value === undefined) return '';
  if (typeof value === 'string') return value.endsWith('\n') ? value : `${value}\n`;
  return `${JSON.stringify(value, null, 2)}\n`;
}

function isInsideQuotes(source, cursor) {
  let quote;
  let escaped = false;
  for (const character of source.slice(0, cursor)) {
    if (escaped) {
      escaped = false;
    } else if (character === '\\' && quote !== "'") {
      escaped = true;
    } else if (quote) {
      if (character === quote) quote = undefined;
    } else if (character === "'" || character === '"') {
      quote = character;
    }
  }
  return Boolean(quote);
}

class BackendClient {
  constructor(options = {}) {
    this.backendPath = options.backendPath || path.join(__dirname, 'backend.js');
    this.child = spawn(process.execPath, [this.backendPath], {
      cwd: options.cwd || process.cwd(),
      stdio: ['pipe', 'pipe', options.errorOutput || process.stderr]
    });
    this.nextId = 1;
    this.pending = new Map();
    this.buffer = '';
    this.closed = false;
    this.output = options.output || process.stdout;
    this.child.stdout.on('data', (chunk) => this.handleData(chunk));
    this.child.on('error', (error) => this.failPending(error));
    this.child.on('exit', (code, signal) => {
      this.failPending(new Error(`Backend exited (${signal || code})`));
      this.closed = true;
    });
  }

  handleData(chunk) {
    this.buffer += chunk.toString();
    let newline;
    while ((newline = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      if (!line.trim()) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        this.output.write(`${line}\n`);
        continue;
      }
      if (message.type === 'stdout' || message.type === 'stderr') {
        (message.type === 'stdout' ? this.output : process.stderr).write(message.data);
        continue;
      }
      const request = this.pending.get(message.id);
      if (!request) continue;
      if (message.type === 'result') request.result = message.result;
      if (message.type === 'error') {
        const error = new Error(message.error?.message || message.message || 'Backend request failed');
        error.name = message.error?.name || message.errorType || 'Error';
        error.stack = message.error?.stack || error.stack;
        request.error = error;
      }
      if (message.type === 'done') {
        this.pending.delete(message.id);
        clearTimeout(request.timer);
        if (request.error) request.reject(request.error);
        else request.resolve(request.result);
      }
    }
  }

  failPending(error) {
    for (const request of this.pending.values()) {
      clearTimeout(request.timer);
      request.reject(error);
    }
    this.pending.clear();
  }

  request(type, payload = {}, timeout = 30000) {
    if (this.closed) return Promise.reject(new Error('Backend is not running'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${type} request timed out`));
      }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(`${JSON.stringify({ id, type, ...payload })}\n`);
    });
  }

  initialize(options = {}) {
    return this.request('initialize', options);
  }

  evaluate(code) {
    return this.request('evaluate', { code }).then((result) =>
      result && Object.prototype.hasOwnProperty.call(result, 'value') ? result.value : result);
  }

  command(source) {
    return this.request('command', { source });
  }

  complete(code, cursor = code.length) {
    return this.request('complete', { code, cursor }, 1000);
  }

  contextHelp(source) {
    return this.request('context-help', { source }, 1000);
  }

  interrupt() {
    if (!this.closed && this.pending.size > 0) this.child.kill('SIGINT');
  }

  async close() {
    if (this.closed) return;
    try {
      await this.request('exit', {}, 1000);
    } catch {
      this.child.kill();
    }
    this.closed = true;
  }
}

function loadHistory(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8').split(/\r?\n/).filter(Boolean).reverse();
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

function saveHistory(filePath, history) {
  const entries = history.filter(Boolean).slice(0, HISTORY_SIZE).reverse();
  fs.writeFileSync(filePath, `${entries.join('\n')}${entries.length ? '\n' : ''}`, { mode: 0o600 });
}

function isShellLine(line) {
  return SHELL_COMMAND_PATTERN.test(line.trim());
}

async function runScript(filePath, scriptArgs = [], options = {}) {
  const absolutePath = path.resolve(filePath);
  const source = fs.readFileSync(absolutePath, 'utf8').replace(/^#![^\n]*\n/, '');
  const backend = options.backend || new BackendClient(options);
  const output = options.output || process.stdout;
  let pending = '';
  try {
    await backend.initialize({
      scriptPath: absolutePath,
      scriptArgs,
      workingDirectory: path.dirname(absolutePath)
    });
    for (const line of source.split(/\r?\n/)) {
      if (!pending && (!line.trim() || line.trim().startsWith('#'))) continue;
      if (!pending && isShellLine(line)) {
        const result = await backend.command(line);
        if (result !== undefined) output.write(formatResult(result));
        if (/^(?:exit|quit)(?:\s|$)/.test(line.trim())) break;
        continue;
      }
      pending = pending ? `${pending}\n${line}` : line;
      if (!isStatementComplete(pending)) continue;
      const result = await backend.evaluate(pending);
      if (result !== undefined) output.write(formatResult(result));
      pending = '';
    }
    if (pending.trim()) throw new Error('Unexpected end of script inside an unterminated statement');
    return 0;
  } catch (error) {
    (options.errorOutput || process.stderr).write(`Error: ${error.message}\n`);
    return 1;
  } finally {
    await backend.close();
  }
}

async function runInteractive(options = {}) {
  const output = options.output || process.stdout;
  const errorOutput = options.errorOutput || process.stderr;
  const backend = new BackendClient({ ...options, output });
  const historyFile = options.historyFile || path.join(process.cwd(), '.akamai-shell-history');
  const rl = readline.createInterface({
    input: options.input || process.stdin,
    output,
    prompt: 'akamai> ',
    historySize: HISTORY_SIZE,
    removeHistoryDuplicates: true,
    completer(line, callback) {
      backend.complete(line).then((result) => {
        callback(null, [result?.candidates || [], result?.replacement || line]);
      }).catch(() => callback(null, [[], line]));
    }
  });
  rl.on('SIGINT', () => {
    backend.interrupt();
  });
  rl.history = loadHistory(historyFile);
  if (process.stdin.isTTY && process.stdout.isTTY) {
    const prompt = rl.getPrompt();
    let searching = false;
    let searchQuery = '';
    let searchIndex = 0;
    let savedLine = '';
    let savedCursor = 0;

    const findHistoryMatch = () => {
      if (!searchQuery) return null;
      for (let index = searchIndex; index < rl.history.length; index += 1) {
        if (rl.history[index].includes(searchQuery)) {
          searchIndex = index;
          return rl.history[index];
        }
      }
      return null;
    };

    const refreshSearch = () => {
      const match = findHistoryMatch();
      rl.setPrompt(`(reverse-i-search)\`${searchQuery}': `);
      rl.line = match || savedLine;
      rl.cursor = match ? match.length : savedCursor;
      rl._refreshLine();
    };

    const endSearch = (accepted) => {
      const line = accepted ? rl.line : savedLine;
      const cursor = accepted ? rl.cursor : savedCursor;
      searching = false;
      rl.setPrompt(prompt);
      rl.line = line;
      rl.cursor = cursor;
      rl._refreshLine();
    };

    const showContextHelp = () => {
      const rawSource = rl.line.slice(0, rl.cursor);
      const source = rawSource.endsWith('?') ? rawSource.slice(0, -1) : rawSource;
      const sourceCursor = rawSource.endsWith('?') ? rl.cursor - 1 : rl.cursor;
      const substitution = findCommandSubstitution(source);
      const commandSource = substitution?.source || source;
      if ((isInsideQuotes(rl.line, sourceCursor) && !substitution) ||
          !/^(?:get|post|put)\s+\S+/.test(commandSource)) {
        return false;
      }
      backend.contextHelp(source).then((entries) => {
        output.write('\n');
        for (const entry of entries) {
          output.write(`  ${entry.name}${entry.description ? ` - ${entry.description}` : ''}\n`);
        }
      }).catch((error) => {
        errorOutput.write(`${error.name}: ${error.message}\n`);
      }).finally(() => {
        if (!rl.closed) rl._refreshLine();
      });
      return true;
    };

    const ttyWrite = rl._ttyWrite.bind(rl);
    rl._ttyWrite = (character, key) => {
      if (!searching) {
        if (key && key.ctrl && key.name === 'r') {
          searching = true;
          searchQuery = rl.line;
          searchIndex = 0;
          savedLine = rl.line;
          savedCursor = rl.cursor;
          refreshSearch();
          return;
        }
        if ((character === '?' || key?.name === '?' || key?.name === 'question' ||
             key?.sequence === '?' || key?.sequence?.endsWith('?')) &&
            showContextHelp()) {
          return;
        }
        ttyWrite(character, key);
        return;
      }

      if (key && key.ctrl && key.name === 'r') {
        searchIndex += 1;
        refreshSearch();
      } else if (key && (key.name === 'return' || key.name === 'enter')) {
        endSearch(true);
      } else if (key && (key.name === 'escape' || (key.ctrl && key.name === 'g'))) {
        endSearch(false);
      } else if (key && key.name === 'backspace') {
        if (searchQuery) {
          searchQuery = searchQuery.slice(0, -1);
          searchIndex = 0;
          refreshSearch();
        }
      } else if (character && !key.ctrl && !key.meta) {
        searchQuery += character;
        searchIndex = 0;
        refreshSearch();
      }
    };
  }
  try {
    const initialized = backend.initialize({ workingDirectory: process.cwd() });
    let processing = Promise.resolve();
    let requestedExit = false;
    const processLine = async (line) => {
      if (line.trim() && rl.history[0] !== line) rl.history.unshift(line);
      if (!line.trim()) {
        if (!rl.closed) rl.prompt();
        return;
      }
      try {
        const result = isShellLine(line)
          ? await backend.command(line)
          : await backend.evaluate(line);
        if (result !== undefined) output.write(formatResult(result));
        if (/^(?:exit|quit)(?:\s|$)/.test(line.trim())) {
          requestedExit = true;
          rl.close();
        }
      } catch (error) {
        errorOutput.write(`${error.name}: ${error.message}\n`);
      }
      if (!rl.closed && !requestedExit) rl.prompt();
    };
    const closed = new Promise((resolve) => rl.once('close', resolve));
    rl.on('line', (line) => {
      processing = processing.then(() => initialized).then(() => processLine(line));
    });
    await initialized;
    if (!rl.closed) rl.prompt();
    await closed;
    await processing;
  } finally {
    saveHistory(historyFile, rl.history);
    rl.close();
    await backend.close();
  }
}

module.exports = {
  BackendClient,
  formatResult,
  isShellLine,
  runScript,
  runInteractive
};
