'use strict';

function findCommandSubstitution(source, cursor = String(source).length) {
  const input = String(source).slice(0, cursor);
  let javascriptQuote;
  let escaped = false;
  const stack = [];

  for (let index = 0; index < input.length; index += 1) {
    const character = input[index];
    const context = stack.at(-1);

    if (!context) {
      if (javascriptQuote) {
        if (escaped) escaped = false;
        else if (character === '\\') escaped = true;
        else if (character === javascriptQuote) javascriptQuote = '';
        continue;
      }
      if (character === "'" || character === '"' || character === '`') {
        javascriptQuote = character;
        continue;
      }
      if (character !== '$') continue;
      let open = index + 1;
      while (/\s/.test(input[open] || '')) open += 1;
      if (input[open] === '(') {
        stack.push({
          start: index,
          open,
          innerStart: undefined,
          wrapperQuote: undefined,
          quote: undefined,
          escaped: false,
          wrapperClosed: false
        });
        index = open;
      }
      continue;
    }

    if (context.wrapperQuote) {
      if (context.escaped) context.escaped = false;
      else if (character === '\\') context.escaped = true;
      else if (character === context.wrapperQuote) {
        context.wrapperClosed = true;
        context.wrapperQuote = undefined;
      }
      continue;
    }

    if (context.innerStart === undefined) {
      if (/\s/.test(character)) continue;
      context.innerStart = index;
      if (character === "'" || character === '"' || character === '`') {
        context.wrapperQuote = character;
        context.innerStart = index + 1;
      }
      continue;
    }

    if (context.wrapperClosed) {
      if (character === ')') stack.pop();
      continue;
    }

    if (context.quote) {
      if (context.escaped) context.escaped = false;
      else if (character === '\\') context.escaped = true;
      else if (character === context.quote) context.quote = undefined;
      continue;
    }

    if (character === "'" || character === '"' || character === '`') {
      context.quote = character;
      continue;
    }
    if (character === '$') {
      let open = index + 1;
      while (/\s/.test(input[open] || '')) open += 1;
      if (input[open] === '(') {
        stack.push({
          start: index,
          open,
          innerStart: undefined,
          wrapperQuote: undefined,
          quote: undefined,
          escaped: false,
          wrapperClosed: false
        });
        index = open;
        continue;
      }
    }
    if (character === ')') stack.pop();
  }

  const context = stack.at(-1);
  if (!context || context.innerStart === undefined || context.wrapperClosed) return null;
  return {
    start: context.start,
    open: context.open,
    innerStart: context.innerStart,
    source: input.slice(context.innerStart),
    quoted: Boolean(context.wrapperQuote)
  };
}

module.exports = { findCommandSubstitution };
