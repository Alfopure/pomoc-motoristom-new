#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';

const [path] = process.argv.slice(2);
if (!path) throw new Error('usage: digest-private-path-list.mjs FILE');
const metadata = lstatSync(path);
if (!metadata.isFile() || metadata.nlink !== 1 || (metadata.mode & 0o077) !== 0) {
  throw new Error('path list must be a private regular file with one link');
}
const text = readFileSync(path, 'utf8');
const paths = text.length === 0 ? [] : text.replace(/\n$/, '').split('\n');
if (paths.some((value) => !value || /[\r\0]/.test(value))) {
  throw new Error('path list contains an invalid entry');
}
const sorted = [...paths].sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)));
if (new Set(sorted).size !== sorted.length || sorted.some((value, index) => value !== paths[index])) {
  throw new Error('path list must be unique and byte-sorted');
}
process.stdout.write(`${JSON.stringify({
  count: paths.length,
  sha256: createHash('sha256').update(paths.join('\n')).digest('hex'),
})}\n`);
