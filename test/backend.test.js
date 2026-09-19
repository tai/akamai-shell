'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { PassThrough } = require('node:stream');
const fs = require('node:fs');
const path = require('node:path');
const { createBackend } = require('../src/backend');

function harness(options = {}) {
  const input = new PassThrough();
  const output = new PassThrough();
  const messages = [];
  output.on('data', (chunk) => messages.push(...chunk.toString().trim().split('\n').filter(Boolean).map(JSON.parse)));
  const backend = createBackend({ input, output, timeout: 100, ...options });
  return { input, messages, backend };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

test('handles initialize and evaluates in a persistent global context', async () => {
  const { input, messages, backend } = harness();
  input.write('{"id":1,"type":"initialize"}\n');
  input.write('{"id":2,"type":"evaluate","code":"globalThis.answer = 41"}\n');
  input.write('{"id":3,"type":"evaluate","code":"answer + 1"}\n');
  await settle();
  await backend.queue;
  assert.equal(messages.find((message) => message.id === 3 && message.type === 'result').result.value, 42);
  await backend.shutdown();
});

test('suppresses JavaScript expression results terminated by semicolons', async () => {
  const { input, messages, backend } = harness();
  input.write('{"id":66,"type":"evaluate","source":"foo = 123;"}\n');
  await settle();
  await backend.queue;
  const result = messages.find((message) => message.id === 66 && message.type === 'result').result;
  assert.equal(result, undefined);
  assert.equal(globalThis.foo, 123);
  delete globalThis.foo;
  await backend.shutdown();
});

test('loads an optional startup JavaScript file during initialization', async (t) => {
  const startupFile = path.join('/tmp', `akamai-shell-startup-${process.pid}.js`);
  fs.writeFileSync(startupFile, 'startupValue = 42\n');
  t.after(() => fs.rmSync(startupFile, { force: true }));
  const { input, messages, backend } = harness({ startupFile });
  input.write(JSON.stringify({ id: 27, type: 'initialize', startupFile }) + '\n');
  input.write('{"id":28,"type":"evaluate","source":"startupValue"}\n');
  await settle();
  await backend.queue;
  assert.equal(messages.find((message) => message.id === 28 && message.type === 'result').result.value, 42);
  await backend.shutdown();
});

test('uses config timeout default for evaluations', async () => {
  const { input, messages, backend } = harness();
  input.write('{"id":21,"type":"evaluate","source":"config.timeout.default = 2500"}\n');
  await settle();
  await backend.queue;
  assert.equal(backend.settings.timeout.default, 2500);
  await backend.shutdown();
});

test('serializes requests and reports structured output and errors', async () => {
  const { input, messages, backend } = harness();
  input.write('{"id":"a","type":"evaluate","code":"console.log(\\"hello\\"); 1"}\n');
  input.write('{"id":"b","type":"evaluate","code":"throw new Error(\\"bad\\")"}\n');
  await settle();
  await backend.queue;
  assert.deepEqual(messages.filter((message) => message.id === 'a').map((message) => message.type).slice(-2), ['result', 'done']);
  assert.equal(messages.find((message) => message.id === 'b' && message.type === 'error').error.message, 'bad');
  await backend.shutdown();
});

test('times out a long asynchronous evaluation and completes identifiers', async () => {
  const { input, messages, backend } = harness();
  input.write('{"id":1,"type":"evaluate","code":"await new Promise(resolve => setTimeout(resolve, 200))"}\n');
  input.write('{"id":2,"type":"complete","code":"Math.ra"}\n');
  await settle();
  await backend.queue;
  assert.match(messages.find((message) => message.id === 1 && message.type === 'error').error.message, /timed out/i);
  assert.ok(messages.find((message) => message.id === 2 && message.type === 'result').result.candidates.includes('Math.random'));
  await backend.shutdown();
});

test('survives SIGINT while an asynchronous command is in progress', async () => {
  const registry = {
    get: async () => new Promise((resolve) => {
      setTimeout(() => resolve({ statusCode: 200, body: { ok: true } }), 1000);
    })
  };
  const { input, messages, backend } = harness({ apiRegistry: registry });
  input.write('{"id":22,"type":"command","source":"get /papi/v1/properties"}\n');
  await new Promise((resolve) => setTimeout(resolve, 10));
  process.kill(process.pid, 'SIGINT');
  input.write('{"id":23,"type":"evaluate","source":"40 + 2"}\n');
  await backend.queue;
  assert.match(messages.find((message) => message.id === 22 && message.type === 'error').error.message, /interrupted/i);
  assert.equal(messages.find((message) => message.id === 23 && message.type === 'result').result.value, 42);
  await backend.shutdown();
});

test('exit emits a final done message and closes deterministically', async () => {
  const { input, messages, backend } = harness();
  input.write('{"id":9,"type":"exit"}\n');
  await settle();
  await backend.queue;
  assert.deepEqual(messages.slice(-2).map((message) => message.type), ['result', 'done']);
  assert.equal(backend.closed, true);
});

test('dispatches get commands through the API registry', async () => {
  const calls = [];
  const registry = {
    get: async (settings, apiPath, query, requestGet) => {
      calls.push({ settings, apiPath, query, requestGet });
      return { statusCode: 200, body: { ok: true } };
    },
    dispatch() {
      throw new Error('unexpected write');
    }
  };
  const requestGet = () => {};
  const { input, messages, backend } = harness({ apiRegistry: registry, requestGet });
  input.write('{"id":4,"type":"command","source":"get /papi/v1/properties?groupId=grp contractId==ctr"}\n');
  await settle();
  await backend.queue;
  assert.deepEqual(messages.find((message) => message.id === 4 && message.type === 'result').result, { ok: true });
  assert.equal(calls[0].apiPath, '/papi/v1/properties');
  assert.deepEqual(calls[0].query, { groupId: 'grp', contractId: 'ctr' });
  assert.equal(calls[0].requestGet, requestGet);
  await backend.shutdown();
});

test('parses HTTPie-style query and JSON body arguments', async () => {
  const calls = [];
  const registry = {
    dispatch: async (method, settings, apiPath, query, body) => {
      calls.push({ method, apiPath, query, body });
      return { statusCode: 200, body: { ok: true } };
    }
  };
  const { input, backend } = harness({ apiRegistry: registry });
  input.write(JSON.stringify({
    id: 53,
    type: 'command',
    source: 'post /example q==bar name=hello tags:=[1,2]'
  }) + '\n');
  await settle();
  await backend.queue;
  assert.deepEqual(calls[0], {
    method: 'POST',
    apiPath: '/example',
    query: { q: 'bar' },
    body: { name: 'hello', tags: [1, 2] }
  });
  await backend.shutdown();
});

test('writes GET output and merges JSON files into write bodies', async () => {
  const outputFile = path.join('/tmp', `akamai-shell-get-${process.pid}.json`);
  const bodyFile = path.join('/tmp', `akamai-shell-body-${process.pid}.json`);
  fs.writeFileSync(bodyFile, JSON.stringify({ name: 'from-file', count: 1 }));
  const calls = [];
  const registry = {
    get: async () => ({ statusCode: 200, body: { properties: [] } }),
    dispatch: async (method, settings, apiPath, query, body) => {
      calls.push({ method, apiPath, query, body });
      return { statusCode: 200, body: { saved: true } };
    }
  };
  const { input, messages, backend } = harness({ apiRegistry: registry });
  input.write(JSON.stringify({
    id: 60,
    type: 'command',
    source: `get -f ${outputFile} /papi/v1/properties`
  }) + '\n');
  input.write(JSON.stringify({
    id: 61,
    type: 'command',
    source: `put -f ${bodyFile} /example name=from-argument count:=2`
  }) + '\n');
  input.write('{"id":62,"type":"evaluate","source":"payload = { nested: [1, 2], enabled: true }"}\n');
  input.write('{"id":63,"type":"evaluate","source":"pp = \\"/papi/v1/properties/prp_526230\\""}\n');
  input.write('{"id":64,"type":"command","source":"put -v \\"$payload\\" $pp/versions/80/rules extra=value"}\n');
  await settle();
  await backend.queue;
  assert.equal(messages.find((message) => message.id === 60 && message.type === 'result').result, undefined);
  assert.deepEqual(JSON.parse(fs.readFileSync(outputFile, 'utf8')), { properties: [] });
  assert.deepEqual(calls[0], {
    method: 'PUT',
    apiPath: '/example',
    query: {},
    body: { name: 'from-argument', count: 2 }
  });
  assert.deepEqual(calls[1], {
    method: 'PUT',
    apiPath: '/papi/v1/properties/prp_526230/versions/80/rules',
    query: {},
    body: { nested: [1, 2], enabled: true, extra: 'value' }
  });
  fs.unlinkSync(outputFile);
  fs.unlinkSync(bodyFile);
  await backend.shutdown();
});

test('expands variables in non-JavaScript command input', async () => {
  const calls = [];
  const registry = {
    get: async (settings, apiPath) => {
      calls.push(apiPath);
      return { statusCode: 200, body: { ok: true } };
    }
  };
  const { input, messages, backend } = harness({ apiRegistry: registry });
  input.write('{"id":44,"type":"evaluate","source":"pp = \\"/papi/v1/properties/prp_526230\\""}\n');
  input.write('{"id":45,"type":"command","source":"get $pp"}\n');
  await settle();
  await backend.queue;
  assert.equal(calls[0], '/papi/v1/properties/prp_526230');
  assert.deepEqual(messages.find((message) => message.id === 45 && message.type === 'result').result, { ok: true });
  await backend.shutdown();
});

test('expands JavaScript expressions in command interpolation', async () => {
  const { input, messages, backend } = harness();
  input.write('{"id":74,"type":"evaluate","source":"config.target = { groupId: \\"grp_interpolated\\" }"}\n');
  input.write('{"id":75,"type":"command","source":"echo ${config[\\\"target\\\"][\\\"groupId\\\"]}"}\n');
  await settle();
  await backend.queue;
  assert.equal(
    messages.find((message) => message.id === 75 && message.type === 'result').result,
    'grp_interpolated'
  );
  await backend.shutdown();
});

test('pipes show output through local shell commands', async () => {
  const { input, messages, backend } = harness();
  input.write('{"id":46,"type":"command","source":"show config | head -1"}\n');
  await settle();
  await backend.queue;
  const result = messages.find((message) => message.id === 46 && message.type === 'result').result;
  assert.match(result, /^\{\n/);
  await backend.shutdown();
});

test('evaluates structured expressions passed to show', async () => {
  const { input, messages, backend } = harness();
  input.write('{"id":49,"type":"command","source":"show config[\\"target\\"]"}\n');
  await settle();
  await backend.queue;
  const result = messages.find((message) => message.id === 49 && message.type === 'result');
  assert.deepEqual(result.result, backend.settings.target);
  await backend.shutdown();
});

test('pipes every command result, including help and shell escapes', async () => {
  const { input, messages, backend } = harness();
  input.write('{"id":47,"type":"command","source":"help | head -1"}\n');
  input.write('{"id":48,"type":"command","source":"! printf hello | head -1"}\n');
  input.write('{"id":49,"type":"command","source":"!printf hello"}\n');
  await settle();
  await backend.queue;
  assert.equal(messages.find((message) => message.id === 47 && message.type === 'result').result, 'Commands:\n');
  assert.equal(messages.find((message) => message.id === 48 && message.type === 'result').result, 'hello');
  assert.equal(messages.find((message) => message.id === 49 && message.type === 'result').result, 'hello');
  await backend.shutdown();
});

test('formats command history as a numbered list', async () => {
  const { input, messages, backend } = harness();
  input.write('{"id":64,"type":"command","source":"help"}\n');
  input.write('{"id":65,"type":"command","source":"history"}\n');
  await settle();
  await backend.queue;
  const history = messages.find((message) => message.id === 65 && message.type === 'result').result;
  assert.match(history, /^1  help\n2  history$/);
  await backend.shutdown();
});

test('exposes config target values to API dispatch', async () => {
  const calls = [];
  const registry = {
    get: async (settings) => {
      calls.push(settings);
      return { statusCode: 200, body: { ok: true } };
    }
  };
  const { input, messages, backend } = harness({ apiRegistry: registry });
  input.write('{"id":41,"type":"evaluate","source":"config[\\"target\\"].contractId = \\"ctr_target\\""}\n');
  input.write('{"id":42,"type":"evaluate","source":"config.target = { contractId: \\"ctr_replaced\\", groupId: \\"grp_target\\" }"}\n');
  input.write('{"id":43,"type":"command","source":"get /papi/v1/properties"}\n');
  await settle();
  await backend.queue;
  assert.equal(messages.find((message) => message.id === 41 && message.type === 'result').result.value, 'ctr_target');
  assert.equal(calls[0].target.contractId, 'ctr_replaced');
  assert.equal(calls[0].target.groupId, 'grp_target');
  assert.equal(calls[0].contractId, '');
  await backend.shutdown();
});

test('set and show expose the current session state', async () => {
  const { input, messages, backend } = harness();
  input.write('{"id":5,"type":"command","source":"set edgercSection staging"}\n');
  input.write('{"id":51,"type":"evaluate","source":"visibleValue = 42"}\n');
  input.write('{"id":6,"type":"command","source":"show"}\n');
  await settle();
  await backend.queue;
  assert.equal(Object.prototype.hasOwnProperty.call(
    messages.find((message) => message.id === 5 && message.type === 'result'),
    'result'
  ), false);
  const state = messages.find((message) => message.id === 6 && message.type === 'result').result;
  assert.equal(state.config.edgercSection, 'staging');
  assert.equal(state.visibleValue, 42);
  await backend.shutdown();
});

test('rejects scalar target settings and the removed edgerc-section alias', async () => {
  const { input, messages, backend } = harness();
  input.write('{"id":52,"type":"command","source":"set target foo"}\n');
  input.write('{"id":53,"type":"command","source":"set edgerc-section staging"}\n');
  await settle();
  await backend.queue;
  assert.match(
    messages.find((message) => message.id === 52 && message.type === 'error').error.message,
    /target is structured/
  );
  assert.match(
    messages.find((message) => message.id === 53 && message.type === 'error').error.message,
    /Invalid setting name "edgerc-section"/
  );
  await backend.shutdown();
});

test('sets nested configuration values through dotted paths', async () => {
  const { input, messages, backend } = harness();
  input.write('{"id":54,"type":"command","source":"set target.accountSwitchKey foo"}\n');
  input.write('{"id":55,"type":"complete","source":"set target."}\n');
  await settle();
  await backend.queue;
  assert.equal(messages.find((message) => message.id === 54 && message.type === 'error'), undefined);
  assert.equal(
    messages.find((message) => message.id === 54 && message.type === 'done').id,
    54
  );
  assert.deepEqual(
    messages.find((message) => message.id === 55 && message.type === 'result').result.candidates,
    ['set target.accountSwitchKey', 'set target.contractId', 'set target.groupId']
  );
  await backend.shutdown();
});

test('initializes hidden setting metadata for plain config objects', async () => {
  const { input, messages, backend } = harness();
  input.write('{"id":60,"type":"evaluate","source":"config = { edgerc: \\"/tmp/.edgerc\\", edgercSection: \\"default\\", target: {} }"}\n');
  input.write('{"id":61,"type":"command","source":"set edgercSection papi"}\n');
  input.write('{"id":62,"type":"command","source":"show config"}\n');
  await settle();
  await backend.queue;
  assert.equal(messages.find((message) => message.id === 61 && message.type === 'error'), undefined);
  const config = messages.find((message) => message.id === 62 && message.type === 'result').result;
  assert.equal(config.edgercSection, 'papi');
  assert.equal(Object.hasOwn(config, 'parameterDefaults'), false);
  await backend.shutdown();
});

test('updates target shorthand without creating a top-level duplicate', async () => {
  const { input, messages, backend } = harness();
  input.write('{"id":63,"type":"evaluate","source":"config = { target: { groupId: \\"old\\" } }"}\n');
  input.write('{"id":64,"type":"command","source":"set groupId xxx"}\n');
  input.write('{"id":65,"type":"command","source":"show config"}\n');
  await settle();
  await backend.queue;
  const config = messages.find((message) => message.id === 65 && message.type === 'result').result;
  assert.equal(config.target.groupId, 'xxx');
  assert.equal(Object.hasOwn(config, 'groupId'), false);
  await backend.shutdown();
});

test('routes recognized commands separately from JavaScript evaluation', async () => {
  const registry = {
    get: async () => ({ statusCode: 200, body: { answer: 42 } }),
    dispatch: async () => ({ statusCode: 200, body: {} })
  };
  const { input, messages, backend } = harness({ apiRegistry: registry });
  input.write('{"id":7,"type":"command","source":"get /papi/v1/properties"}\n');
  input.write('{"id":8,"type":"command","source":"globalThis.value = 9"}\n');
  input.write('{"id":9,"type":"command","source":"value + 1"}\n');
  await settle();
  await backend.queue;
  assert.deepEqual(messages.find((message) => message.id === 7 && message.type === 'result').result, { answer: 42 });
  assert.equal(messages.find((message) => message.id === 9 && message.type === 'result').result, 10);
  await backend.shutdown();
});

test('provides command substitution in native JavaScript evaluation', async () => {
  const registry = {
    get: async () => ({ statusCode: 200, body: { value: 7 } }),
    dispatch: async () => ({ statusCode: 200, body: {} })
  };
  const { input, messages, backend } = harness({ apiRegistry: registry });
  input.write('{"id":10,"type":"evaluate","code":"globalThis.substituted = (await $(\\\"get /papi/v1/properties\\\")).value; substituted"}\n');
  input.write('{"id":11,"type":"evaluate","code":"substituted"}\n');
  await settle();
  await backend.queue;
  const result = messages.find((message) => message.id === 10 && message.type === 'result');
  assert.ok(result, JSON.stringify(messages));
  assert.equal(messages.find((message) => message.id === 11 && message.type === 'result').result.value, 7);
  await backend.shutdown();
});

test('automatically awaits substitutions interactively but not in scripts', async () => {
  const registry = {
    get: async () => ({ statusCode: 200, body: { path: '/properties/prp_1' } })
  };
  const interactive = harness({ apiRegistry: registry });
  interactive.input.write('{"id":30,"type":"evaluate","source":"$(\\"get /papi/v1/properties\\").path"}\n');
  await settle();
  await interactive.backend.queue;
  assert.equal(
    interactive.messages.find((message) => message.id === 30 && message.type === 'result').result.value,
    '/properties/prp_1'
  );
  await interactive.backend.shutdown();

  const script = harness({ apiRegistry: registry });
  script.input.write(JSON.stringify({
    id: 31,
    type: 'initialize',
    scriptPath: '/tmp/example-script.as'
  }) + '\n');
  script.input.write('{"id":32,"type":"evaluate","source":"typeof $(\\"get /papi/v1/properties\\").then"}\n');
  await settle();
  await script.backend.queue;
  assert.equal(
    script.messages.find((message) => message.id === 32 && message.type === 'result').result.value,
    'function'
  );
  await script.backend.shutdown();
});

test('provides JavaScript and shell completion through the backend', async () => {
  const registry = {
    completeMethod: async (method, inputPath) => {
      if (inputPath === '/papi/v1/properties/prp_526230/') {
        return [['/papi/v1/properties/prp_526230/versions'], inputPath];
      }
      return [['/papi/v1/properties'], '/papi/v1/pr'];
    },
    hasCompletionDescendants: () => false,
    parameterHelp: () => [{ name: 'contractId' }, { name: 'groupId' }]
  };
  const { input, messages, backend } = harness({ apiRegistry: registry });
  input.write('{"id":12,"type":"complete","source":"get /papi/v1/pr"}\n');
  input.write('{"id":28,"type":"complete","source":"get /papi/v1/properties"}\n');
  input.write('{"id":29,"type":"complete","source":"get /papi/v1/properties "}\n');
  input.write('{"id":30,"type":"complete","source":"get /papi/v1/properties contractId==value "}\n');
  input.write('{"id":31,"type":"complete","source":" get /"}\n');
  input.write('{"id":13,"type":"complete","source":"sho"}\n');
  input.write('{"id":27,"type":"complete","source":"set edg"}\n');
  input.write('{"id":56,"type":"complete","source":"set tar"}\n');
  input.write('{"id":57,"type":"complete","source":"set target"}\n');
  input.write('{"id":58,"type":"complete","source":"set target.accountSwitchKey"}\n');
  input.write('{"id":59,"type":"complete","source":"set edgercSection"}\n');
  input.write('{"id":14,"type":"evaluate","source":"pp = \\"/papi/v1/properties/prp_526230\\""}\n');
  input.write('{"id":15,"type":"complete","source":"get $pp/"}\n');
  input.write('{"id":18,"type":"evaluate","source":"config = { edgercSection: \\"papi\\", target: { groupId: \\"grp\\", contractId: \\"ctr\\" } }"}\n');
  input.write('{"id":19,"type":"complete","source":"config"}\n');
  input.write('{"id":20,"type":"complete","source":"config["}\n');
  input.write('{"id":21,"type":"complete","source":"config[\\"edgercS"}\n');
  input.write('{"id":22,"type":"complete","source":"config[\\"target\\"]"}\n');
  input.write('{"id":23,"type":"complete","source":"config[\\"target\\"]."}\n');
  input.write('{"id":24,"type":"complete","source":"config[\\"target\\"][\\"co"}\n');
  input.write('{"id":25,"type":"complete","source":"show confi"}\n');
  input.write('{"id":26,"type":"complete","source":"show config[\\"target\\"]."}\n');
  await settle();
  await backend.queue;
  assert.deepEqual(
    messages.find((message) => message.id === 12 && message.type === 'result').result.candidates,
    ['/papi/v1/properties']
  );
  assert.deepEqual(
    messages.find((message) => message.id === 28 && message.type === 'result').result.candidates,
    ['/papi/v1/properties ']
  );
  assert.deepEqual(
    messages.find((message) => message.id === 29 && message.type === 'result').result.candidates,
    ['contractId==', 'groupId==']
  );
  assert.deepEqual(
    messages.find((message) => message.id === 30 && message.type === 'result').result,
    { candidates: ['contractId==', 'groupId=='], replacement: '' }
  );
  assert.deepEqual(
    messages.find((message) => message.id === 31 && message.type === 'result').result.candidates,
    ['/papi/v1/properties']
  );
  assert.ok(messages.find((message) => message.id === 13 && message.type === 'result')
  .result.candidates.includes('show'));
  assert.deepEqual(
  messages.find((message) => message.id === 27 && message.type === 'result').result.candidates,
  ['set edgerc', 'set edgercSection']
  );
  assert.deepEqual(
    messages.find((message) => message.id === 56 && message.type === 'result').result.candidates,
    ['set target']
  );
  assert.deepEqual(
    messages.find((message) => message.id === 57 && message.type === 'result').result.candidates,
    ['set target.']
  );
  assert.deepEqual(
    messages.find((message) => message.id === 58 && message.type === 'result').result.candidates,
    ['set target.accountSwitchKey ']
  );
  assert.deepEqual(
    messages.find((message) => message.id === 59 && message.type === 'result').result.candidates,
    ['set edgercSection ']
  );
  assert.deepEqual(
    messages.find((message) => message.id === 15 && message.type === 'result').result.candidates,
    ['$pp/versions']
  );
  assert.deepEqual(
    messages.find((message) => message.id === 19 && message.type === 'result').result.candidates,
    ['config[']
  );
  assert.deepEqual(
    messages.find((message) => message.id === 20 && message.type === 'result').result.candidates,
    ['config["edgercSection"]', 'config["target"]']
  );
  assert.deepEqual(
    messages.find((message) => message.id === 21 && message.type === 'result').result.candidates,
    ['config["edgercSection"]']
  );
  assert.deepEqual(
    messages.find((message) => message.id === 22 && message.type === 'result').result.candidates,
    ["config[\"target\"]["]
  );
  assert.deepEqual(
    messages.find((message) => message.id === 23 && message.type === 'result').result.candidates,
    ['config["target"].groupId', 'config["target"].contractId']
  );
  assert.deepEqual(
    messages.find((message) => message.id === 24 && message.type === 'result').result.candidates,
    ['config["target"]["contractId"]']
  );
  assert.deepEqual(
    messages.find((message) => message.id === 25 && message.type === 'result').result.candidates,
    ['show config']
  );
  assert.deepEqual(
    messages.find((message) => message.id === 26 && message.type === 'result').result.candidates,
    ['show config["target"].groupId', 'show config["target"].contractId']
  );
  await backend.shutdown();
});

test('completes commands inside JavaScript command substitutions', async () => {
  const registry = {
    completeMethod: async (method, inputPath) => {
      assert.equal(method, 'GET');
      assert.equal(inputPath, '/papi/v1/pr');
      return [['/papi/v1/properties'], '/papi/v1/pr'];
    },
    hasCompletionDescendants: () => false,
    parameterHelp: () => [{ name: 'groupId', in: 'query', description: 'The group.' }]
  };
  const { input, messages, backend } = harness({ apiRegistry: registry });
  input.write(JSON.stringify({
    id: 78,
    type: 'complete',
    source: 'value = await $("get /papi/v1/pr'
  }) + '\n');
  input.write(JSON.stringify({
    id: 79,
    type: 'context-help',
    source: 'value = await $("get /papi/v1/properties '
  }) + '\n');
  await settle();
  await backend.queue;
  assert.deepEqual(
    messages.find((message) => message.id === 78 && message.type === 'result').result,
    { candidates: ['/papi/v1/properties'], replacement: '/papi/v1/pr' }
  );
  assert.deepEqual(
    messages.find((message) => message.id === 79 && message.type === 'result').result,
    [{ name: 'groupId==', description: 'The group.' }]
  );
  await backend.shutdown();
});

test('completes shell files after escapes and pipelines', async () => {
  const { input, messages, backend } = harness();
  input.write('{"id":70,"type":"complete","source":"! cat src/back"}\n');
  input.write('{"id":71,"type":"complete","source":"get / | cat src/back"}\n');
  await settle();
  await backend.queue;
  for (const id of [70, 71]) {
    assert.deepEqual(
      messages.find((message) => message.id === id && message.type === 'result').result,
      { candidates: ['src/backend.js'], replacement: 'src/back' }
    );
  }
  await backend.shutdown();
});

test('completes file paths for load and save commands', async () => {
  const { input, messages, backend } = harness();
  input.write('{"id":72,"type":"complete","source":"load src/back"}\n');
  input.write('{"id":73,"type":"complete","source":"save src/back"}\n');
  input.write('{"id":76,"type":"complete","source":"load ${process.cwd()}/src/back"}\n');
  input.write('{"id":77,"type":"complete","source":"save ${process.cwd()}/src/back"}\n');
  await settle();
  await backend.queue;
  for (const id of [72, 73, 76, 77]) {
    assert.deepEqual(
      messages.find((message) => message.id === id && message.type === 'result').result,
      id < 76
        ? { candidates: ['src/backend.js'], replacement: 'src/back' }
        : {
        candidates: ['${process.cwd()}/src/backend.js'],
        replacement: '${process.cwd()}/src/back'
        }
    );
  }
  await backend.shutdown();
});

test('provides OpenAPI parameter context help without changing the input', async () => {
  const registry = {
    parameterHelp: () => [
      { name: 'groupId', in: 'query', description: 'The group identifier.' },
      { name: 'contractId', in: 'query', description: 'The contract identifier. Used for filtering.' },
      { name: 'createFromVersion', in: 'body', schema: { type: 'integer' },
        description: 'The version.' },
      { name: 'createFromVersionEtag', in: 'body', schema: { type: 'string' },
        description: 'The version ETag.' },
      { name: 'contractId', description: 'Duplicate entry.' }
    ]
  };
  const { input, messages, backend } = harness({ apiRegistry: registry });
  input.write(JSON.stringify({
    id: 52,
    type: 'context-help',
    source: 'post /papi/v1/properties '
  }) + '\n');
  input.write(JSON.stringify({
    id: 54,
    type: 'complete',
    source: 'post /papi/v1/properties createFromVersion:'
  }) + '\n');
  input.write(JSON.stringify({
    id: 55,
    type: 'context-help',
    source: 'post /papi/v1/properties createFromVersion:='
  }) + '\n');
  input.write(JSON.stringify({
    id: 56,
    type: 'context-help',
    source: 'post /papi/v1/properties createFromVersion:=1 '
  }) + '\n');
  input.write(JSON.stringify({
    id: 57,
    type: 'context-help',
    source: 'post /papi/v1/properties createFromVersion:=2 createFromVersion:='
  }) + '\n');
  input.write(JSON.stringify({
    id: 58,
    type: 'context-help',
    source: 'post /papi/v1/properties createFromVersion:=1 createFromVersion:'
  }) + '\n');
  input.write(JSON.stringify({
    id: 59,
    type: 'context-help',
    source: 'post /papi/v1/properties createFromVersion:=1 createFromVersion:='
  }) + '\n');
  await settle();
  await backend.queue;
  assert.deepEqual(
    messages.find((message) => message.id === 52 && message.type === 'result').result,
    [
      { name: 'contractId==', description: 'The contract identifier.' },
      { name: 'createFromVersion:=', description: 'The version.' },
      { name: 'createFromVersionEtag=', description: 'The version ETag.' },
      { name: 'groupId==', description: 'The group identifier.' }
    ]
  );
  assert.deepEqual(
    messages.find((message) => message.id === 54 && message.type === 'result').result,
    { candidates: ['createFromVersion:='], replacement: 'createFromVersion:' }
  );
  assert.deepEqual(
    messages.find((message) => message.id === 55 && message.type === 'result').result,
    [{ name: 'createFromVersion:=', description: 'The version.' }]
  );
  assert.deepEqual(
    messages.find((message) => message.id === 56 && message.type === 'result').result,
    [
      { name: 'contractId==', description: 'The contract identifier.' },
      { name: 'createFromVersion:=', description: 'The version.' },
      { name: 'createFromVersionEtag=', description: 'The version ETag.' },
      { name: 'groupId==', description: 'The group identifier.' }
    ]
  );
  assert.deepEqual(
    messages.find((message) => message.id === 57 && message.type === 'result').result,
    [{ name: 'createFromVersion:=', description: 'The version.' }]
  );
  assert.deepEqual(
    messages.find((message) => message.id === 58 && message.type === 'result').result,
    [{ name: 'createFromVersion:=', description: 'The version.' }]
  );
  assert.deepEqual(
    messages.find((message) => message.id === 59 && message.type === 'result').result,
    [{ name: 'createFromVersion:=', description: 'The version.' }]
  );
  await backend.shutdown();
});

test('initializes native script module bindings and arguments', async () => {
  const { input, messages, backend } = harness();
  input.write(JSON.stringify({
    id: 16,
    type: 'initialize',
    scriptPath: '/tmp/example-script.as',
    scriptArgs: ['one', 'two'],
    workingDirectory: '/tmp'
  }) + '\n');
  input.write('{"id":17,"type":"evaluate","source":"[process.argv[1], process.argv[2], __dirname, typeof require]"}\n');
  await settle();
  await backend.queue;
  assert.deepEqual(
    messages.find((message) => message.id === 17 && message.type === 'result').result.value,
    ['/tmp/example-script.as', 'one', '/tmp', 'function']
  );
  await backend.shutdown();
});

test('saves and loads the new executable JavaScript state format', async (t) => {
  const stateName = `.akamai-shell-state-${process.pid}.js`;
  const stateFile = path.join(os.homedir(), stateName);
  t.after(() => fs.rmSync(stateFile, { force: true }));
  const { input, messages, backend } = harness();
  input.write('{"id":16,"type":"evaluate","source":"config = { custom: 7 }; savedValue = { answer: 42 }"}\n');
  input.write(JSON.stringify({ id: 17, type: 'command', source: `save ~/${stateName}` }) + '\n');
  input.write('{"id":18,"type":"evaluate","source":"config = {}; savedValue = undefined"}\n');
  input.write(JSON.stringify({ id: 19, type: 'command', source: `load ~/${stateName}` }) + '\n');
  input.write('{"id":20,"type":"evaluate","source":"config.custom + savedValue.answer"}\n');
  await settle();
  await backend.queue;
  assert.equal(messages.find((message) => message.id === 20 && message.type === 'result').result.value, 49);
  const stateSource = fs.readFileSync(stateFile, 'utf8');
  assert.match(stateSource, /globalThis\.config/);
  assert.match(stateSource, /globalThis\.savedValue/);
  assert.match(stateSource, /"custom": 7/);
  await backend.shutdown();
});
