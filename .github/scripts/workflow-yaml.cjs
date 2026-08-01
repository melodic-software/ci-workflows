"use strict";

// A fail-closed parser for the block-style YAML subset GitHub Actions workflow
// and action-metadata files are written in.
//
// It exists so a contract test can enumerate a job's steps STRUCTURALLY. An
// enumerator built on patterns over raw YAML text can always be walked past by a
// step spelled in a shape the pattern did not anticipate — a bare `-` on its own
// line, a `- name:` decoy inside a block scalar, a second step reusing an
// earlier step's name — and each of those is an ungated step the audit never
// sees.
//
// FAIL CLOSED is the entire safety argument. Every construct outside the subset
// raises WorkflowYamlError: anchors, aliases, merge keys, tags, directives,
// explicit keys, more than one document, tab indentation, a duplicate mapping
// key, an unterminated quote, or any line the grammar cannot place. A caller
// treats the throw as a finding, so a parser gap or an unfamiliar spelling
// surfaces as a red build rather than as a node that quietly went missing.
//
// The same property is asserted from the other end: parsing ends by proving
// every line of the source was consumed by exactly one production. A bug that
// skipped a region would have to account for its lines as well, which a
// silent-skip bug by definition does not.

class WorkflowYamlError extends Error {
  constructor(message, lineNumber) {
    super(
      lineNumber === undefined ? message : `line ${lineNumber}: ${message}`,
    );
    this.name = "WorkflowYamlError";
    this.lineNumber = lineNumber;
  }
}

// Leading `&`/`*`/`!`/`%` introduce an anchor, alias, tag, or directive; `?` an
// explicit key; `` ` `` and `@` are reserved by the spec. Each changes what a
// node means, so each is rejected rather than approximated.
const RESERVED_INDICATOR = /^[&*!%?@`]/u;
const DOCUMENT_MARKER = /^(?:---|\.\.\.)(?:\s|$)/u;
const SEQUENCE_ITEM = /^-(?:\s|$)/u;
const MERGE_KEY = /^<<\s*:/u;
const PLAIN_KEY = /^([^\s:#][^:#]*?)\s*:(?:\s+(.*))?$/u;
const BLOCK_SCALAR_HEADER = /^([|>])((?:[+-]|[1-9])*)$/u;
const INTEGER = /^[+-]?(?:0|[1-9][0-9]*)$/u;
const FLOAT = /^[+-]?(?:[0-9]+\.[0-9]*|\.[0-9]+)(?:[eE][+-]?[0-9]+)?$/u;

/**
 * Resolve a plain scalar with the YAML 1.2 core schema, which is the schema the
 * Actions runner applies — notably leaving `on`, `off`, `yes` and `no` strings.
 */
function resolvePlain(text) {
  if (text === "" || text === "~" || /^(?:null|Null|NULL)$/u.test(text)) {
    return null;
  }
  if (/^(?:true|True|TRUE)$/u.test(text)) return true;
  if (/^(?:false|False|FALSE)$/u.test(text)) return false;
  if (INTEGER.test(text) || FLOAT.test(text)) return Number(text);
  return text;
}

function unescapeDoubleQuoted(text, lineNumber) {
  const escapes = { n: "\n", t: "\t", r: "\r", 0: "\0", "\\": "\\", '"': '"' };
  let result = "";
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] !== "\\") {
      result += text[index];
      continue;
    }
    index += 1;
    const replacement = escapes[text[index]];
    if (replacement === undefined) {
      throw new WorkflowYamlError(
        `unsupported escape '\\${text[index]}'`,
        lineNumber,
      );
    }
    result += replacement;
  }
  return result;
}

/** Index of the closing quote of a quoted span opening at index 0, or -1. */
function closingQuote(text) {
  const quote = text[0];
  for (let index = 1; index < text.length; index += 1) {
    if (quote === '"' && text[index] === "\\") {
      index += 1;
      continue;
    }
    if (text[index] !== quote) continue;
    if (quote === "'" && text[index + 1] === "'") {
      index += 1;
      continue;
    }
    return index;
  }
  return -1;
}

/** Cut a trailing `#` comment, ignoring one inside a quoted span. */
function stripComment(text) {
  let quote = null;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quote) {
      if (char === quote) quote = null;
      else if (quote === '"' && char === "\\") index += 1;
      continue;
    }
    if (char === '"' || char === "'") quote = char;
    else if (char === "#" && (index === 0 || /\s/u.test(text[index - 1]))) {
      return text.slice(0, index);
    }
  }
  return text;
}

/** Split a flow collection's body at top-level commas. */
function splitFlowEntries(body, lineNumber) {
  const entries = [];
  let depth = 0;
  let quote = null;
  let start = 0;
  for (let index = 0; index < body.length; index += 1) {
    const char = body[index];
    if (quote) {
      if (char === quote) quote = null;
      else if (quote === '"' && char === "\\") index += 1;
      continue;
    }
    if (char === '"' || char === "'") quote = char;
    else if (char === "[" || char === "{") depth += 1;
    else if (char === "]" || char === "}") depth -= 1;
    else if (char === "," && depth === 0) {
      entries.push(body.slice(start, index));
      start = index + 1;
    }
  }
  if (quote) throw new WorkflowYamlError("unterminated quote", lineNumber);
  if (depth !== 0) {
    throw new WorkflowYamlError("unbalanced flow collection", lineNumber);
  }
  const tail = body.slice(start);
  if (tail.trim() !== "" || entries.length > 0) entries.push(tail);
  return entries.filter((entry) => entry.trim() !== "");
}

function parseScalar(text, lineNumber) {
  const trimmed = text.trim();
  if (trimmed.startsWith('"') || trimmed.startsWith("'")) {
    if (closingQuote(trimmed) !== trimmed.length - 1) {
      throw new WorkflowYamlError("unterminated quote", lineNumber);
    }
    return trimmed.startsWith('"')
      ? unescapeDoubleQuoted(trimmed.slice(1, -1), lineNumber)
      : trimmed.slice(1, -1).replaceAll("''", "'");
  }
  if (RESERVED_INDICATOR.test(trimmed)) {
    throw new WorkflowYamlError(
      `unsupported node indicator in '${trimmed}'`,
      lineNumber,
    );
  }
  return resolvePlain(trimmed);
}

function parseFlow(text, lineNumber) {
  const trimmed = text.trim();
  if (!trimmed.startsWith("[") && !trimmed.startsWith("{")) {
    return parseScalar(trimmed, lineNumber);
  }
  const close = trimmed.startsWith("[") ? "]" : "}";
  if (!trimmed.endsWith(close)) {
    throw new WorkflowYamlError(
      "a flow collection must close on the line it opens",
      lineNumber,
    );
  }
  const entries = splitFlowEntries(trimmed.slice(1, -1), lineNumber);
  if (close === "]") {
    return entries.map((entry) => parseFlow(entry, lineNumber));
  }
  const mapping = {};
  for (const entry of entries) {
    const separator = entry.indexOf(":");
    if (separator < 0) {
      throw new WorkflowYamlError(
        `flow mapping entry without a value: ${entry.trim()}`,
        lineNumber,
      );
    }
    const key = String(parseFlow(entry.slice(0, separator), lineNumber));
    if (Object.hasOwn(mapping, key)) {
      throw new WorkflowYamlError(`duplicate key '${key}'`, lineNumber);
    }
    mapping[key] = parseFlow(entry.slice(separator + 1), lineNumber);
  }
  return mapping;
}

function parseInline(text, lineNumber) {
  const trimmed = text.trim();
  return trimmed.startsWith("[") || trimmed.startsWith("{")
    ? parseFlow(trimmed, lineNumber)
    : parseScalar(stripComment(trimmed), lineNumber);
}

/** Decide whether a line opens a mapping entry or is a bare scalar node. */
function classifyLine(text, lineNumber) {
  if (text.startsWith('"') || text.startsWith("'")) {
    const end = closingQuote(text);
    if (end < 0) throw new WorkflowYamlError("unterminated quote", lineNumber);
    const after = text.slice(end + 1);
    if (!/^\s*:(?:\s|$)/u.test(after)) return { kind: "scalar" };
    return {
      kind: "key",
      key: String(parseScalar(text.slice(0, end + 1), lineNumber)),
      inline: after.replace(/^\s*:\s*/u, ""),
    };
  }
  const match = PLAIN_KEY.exec(text);
  if (!match) return { kind: "scalar" };
  return { kind: "key", key: match[1], inline: match[2] ?? "" };
}

/**
 * Fold a block scalar's lines per YAML's folded style: a break between two
 * lines at the block's own indentation becomes a space, a more-indented line
 * keeps its break and its extra indentation, and a run of k empty lines becomes
 * k breaks.
 */
function foldLines(body) {
  let result = "";
  let previous = null;
  let index = 0;
  while (index < body.length) {
    if (body[index] === "") {
      let empties = 0;
      while (index < body.length && body[index] === "") {
        empties += 1;
        index += 1;
      }
      result += "\n".repeat(empties);
      previous = "";
      continue;
    }
    const line = body[index];
    if (previous !== null && previous !== "") {
      result += /^\s/u.test(line) || /^\s/u.test(previous) ? "\n" : " ";
    }
    result += line;
    previous = line;
    index += 1;
  }
  return result;
}

class Reader {
  constructor(source) {
    this.lines = source.replace(/^﻿/u, "").split(/\r?\n/u);
    this.consumed = new Array(this.lines.length).fill(false);
    this.index = 0;
    for (const [index, line] of this.lines.entries()) {
      if (/^ *\t/u.test(line)) {
        throw new WorkflowYamlError("tab indentation", index + 1);
      }
      if (DOCUMENT_MARKER.test(line)) {
        throw new WorkflowYamlError(
          "document markers are not supported",
          index + 1,
        );
      }
    }
  }

  /** Advance past blank and comment-only lines, marking them consumed. */
  skipTrivia() {
    while (this.index < this.lines.length) {
      const text = this.lines[this.index].trim();
      if (text !== "" && !text.startsWith("#")) return;
      this.consumed[this.index] = true;
      this.index += 1;
    }
  }

  peek() {
    this.skipTrivia();
    if (this.index >= this.lines.length) return null;
    const raw = this.lines[this.index];
    return {
      number: this.index + 1,
      indent: raw.length - raw.trimStart().length,
      text: raw.trimStart(),
    };
  }

  take() {
    const line = this.peek();
    this.consumed[this.index] = true;
    this.index += 1;
    return line;
  }

  /**
   * Consume a block scalar's body: every following line indented past the
   * owning key, plus the blank lines interleaved with them.
   */
  takeBlockScalar(header, parentIndent) {
    const body = [];
    let contentIndent =
      header.indent === null ? null : parentIndent + header.indent;
    while (this.index < this.lines.length) {
      const raw = this.lines[this.index];
      const indent = raw.length - raw.trimStart().length;
      if (raw.trim() === "") {
        body.push("");
      } else {
        if (indent <= parentIndent) break;
        if (contentIndent === null) contentIndent = indent;
        if (indent < contentIndent) {
          throw new WorkflowYamlError(
            "block scalar line is less indented than the block",
            this.index + 1,
          );
        }
        body.push(raw.slice(contentIndent));
      }
      this.consumed[this.index] = true;
      this.index += 1;
    }
    if (header.chomp !== "keep") {
      while (body.length > 0 && body.at(-1) === "") body.pop();
    }
    const text = header.style === "|" ? body.join("\n") : foldLines(body);
    return text !== "" && header.chomp === "clip" ? `${text}\n` : text;
  }
}

function parseNode(reader, indent) {
  const line = reader.peek();
  if (line === null || line.indent < indent) return null;
  if (line.indent > indent) {
    throw new WorkflowYamlError("unexpected indentation", line.number);
  }
  if (SEQUENCE_ITEM.test(line.text)) return parseSequence(reader, indent);
  if (classifyLine(line.text, line.number).kind === "key") {
    return parseMapping(reader, indent);
  }
  reader.take();
  return parseInline(line.text, line.number);
}

function parseSequence(reader, indent) {
  const items = [];
  for (;;) {
    const line = reader.peek();
    if (
      line === null ||
      line.indent !== indent ||
      !SEQUENCE_ITEM.test(line.text)
    ) {
      break;
    }
    const rest = line.text.slice(1);
    if (rest.trim() === "") {
      // A bare `-` opens the item's node on the following lines. Parsing that
      // structurally is what makes an appended bare-hyphen step a real step
      // rather than text absorbed into its predecessor.
      reader.take();
      const next = reader.peek();
      if (next === null || next.indent <= indent) {
        items.push(null);
        continue;
      }
      items.push(parseNode(reader, next.indent));
      continue;
    }
    // The item's content column is where its first character sits, so blanking
    // the hyphen turns `- name: x` plus its continuation lines into an ordinary
    // node at that column.
    const contentIndent = indent + 1 + (rest.length - rest.trimStart().length);
    reader.lines[reader.index] = " ".repeat(contentIndent) + rest.trimStart();
    items.push(parseNode(reader, contentIndent));
  }
  return items;
}

function parseMapping(reader, indent) {
  const mapping = {};
  for (;;) {
    const line = reader.peek();
    if (line === null || line.indent !== indent) break;
    if (SEQUENCE_ITEM.test(line.text)) break;
    if (MERGE_KEY.test(line.text)) {
      throw new WorkflowYamlError("merge keys are not supported", line.number);
    }
    const classified = classifyLine(line.text, line.number);
    if (classified.kind !== "key") {
      throw new WorkflowYamlError(
        `expected a mapping key: ${line.text}`,
        line.number,
      );
    }
    const { key } = classified;
    if (Object.hasOwn(mapping, key)) {
      throw new WorkflowYamlError(`duplicate key '${key}'`, line.number);
    }
    const inline = stripComment(classified.inline).trim();
    const header = BLOCK_SCALAR_HEADER.exec(inline);
    reader.take();
    if (header) {
      const indicators = header[2];
      const explicitIndent = /[1-9]/u.exec(indicators);
      mapping[key] = reader.takeBlockScalar(
        {
          style: header[1],
          chomp: indicators.includes("+")
            ? "keep"
            : indicators.includes("-")
              ? "strip"
              : "clip",
          indent: explicitIndent === null ? null : Number(explicitIndent[0]),
        },
        indent,
      );
      continue;
    }
    if (inline !== "") {
      mapping[key] = parseInline(classified.inline, line.number);
      continue;
    }
    const next = reader.peek();
    if (next === null || next.indent < indent) {
      mapping[key] = null;
      continue;
    }
    // A sequence may sit at its parent key's own column; anything else must be
    // indented past it or it belongs to an enclosing node.
    if (next.indent === indent) {
      mapping[key] = SEQUENCE_ITEM.test(next.text)
        ? parseSequence(reader, indent)
        : null;
      continue;
    }
    mapping[key] = parseNode(reader, next.indent);
  }
  return mapping;
}

/**
 * Parse a GitHub Actions workflow or action-metadata document.
 *
 * @throws {WorkflowYamlError} on any construct outside the supported subset.
 */
function parseWorkflow(source) {
  const reader = new Reader(source);
  const first = reader.peek();
  const document = first === null ? null : parseNode(reader, first.indent);
  reader.skipTrivia();
  if (reader.index < reader.lines.length) {
    throw new WorkflowYamlError("trailing content", reader.index + 1);
  }
  const unconsumed = reader.consumed.indexOf(false);
  if (unconsumed >= 0) {
    throw new WorkflowYamlError(
      "line was not consumed by any node",
      unconsumed + 1,
    );
  }
  return document;
}

module.exports = Object.freeze({ WorkflowYamlError, parseWorkflow });
