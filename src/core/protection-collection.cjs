'use strict';
// A collection contains verified original packages without nested collections.
const fs = require('node:fs/promises'),
  path = require('node:path'),
  crypto = require('node:crypto');
const migration = require('./migration.cjs');
const MAGIC = Buffer.from('YIJIANBUNDLE00001');
const MAX_HEADER = 256 * 1024,
  MAX_BYTES = 2 * 1024 ** 3,
  MAX_COMPONENTS = 1001,
  CHUNK = 64 * 1024;
const hashOK = (value) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const check = (ok, message, code) => {
  if (!ok) throw Object.assign(Error(message), code ? { code } : {});
};
function keys(value, expected) {
  check(value && typeof value === 'object' && !Array.isArray(value), '集合元数据无效');
  check(
    Object.keys(value).length === expected.length && expected.every((k) => Object.hasOwn(value, k)),
    '集合字段无效',
  );
}
function descriptor(header) {
  keys(header, ['schema', 'kind', 'createdAt', 'components']);
  check(header.schema === 1 && header.kind === 'yijian-protection-collection', '换机集合版本不支持');
  check(
    typeof header.createdAt === 'string' && new Date(header.createdAt).toISOString() === header.createdAt,
    '集合时间无效',
  );
  check(
    Array.isArray(header.components) &&
      header.components.length > 0 &&
      header.components.length <= MAX_COMPONENTS,
    '集合数量超限',
  );
  const seen = new Set();
  let total = 0;
  for (const [index, component] of header.components.entries()) {
    keys(component, ['kind', 'bytes', 'sha256']);
    check(component.kind === (index === 0 ? 'current' : 'history'), '集合内容顺序无效');
    check(hashOK(component.sha256) && !seen.has(component.sha256), '集合校验或去重信息无效');
    check(
      Number.isSafeInteger(component.bytes) && component.bytes > 52 && component.bytes <= MAX_BYTES,
      '内包大小超限',
    );
    seen.add(component.sha256);
    total += component.bytes;
    check(total <= MAX_BYTES, '集合总大小超限');
  }
  return total;
}
async function openStable(file) {
  const before = await fs.lstat(file, { bigint: true });
  check(before.isFile() && !before.isSymbolicLink(), '保护包必须是普通文件');
  check(before.size > 0 && before.size <= BigInt(MAX_BYTES + MAX_HEADER + 52), '保护包大小超限');
  const handle = await fs.open(file, 'r');
  try {
    const stat = await handle.stat({ bigint: true });
    check(
      stat.isFile() &&
        stat.dev === before.dev &&
        stat.ino === before.ino &&
        stat.size === before.size &&
        stat.mtimeNs === before.mtimeNs &&
        stat.ctimeNs === before.ctimeNs,
      '保护包打开时发生变化',
    );
    return { file, handle, stat, size: Number(stat.size) };
  } catch (e) {
    await handle.close();
    throw e;
  }
}
async function assertStable(opened) {
  for (const stat of [
    await opened.handle.stat({ bigint: true }),
    await fs.lstat(opened.file, { bigint: true }),
  ]) {
    check(
      stat.isFile() &&
        !stat.isSymbolicLink() &&
        stat.dev === opened.stat.dev &&
        stat.ino === opened.stat.ino &&
        stat.size === opened.stat.size &&
        stat.mtimeNs === opened.stat.mtimeNs &&
        stat.ctimeNs === opened.stat.ctimeNs,
      '保护包读取时发生变化',
    );
  }
}
async function exact(handle, length, position) {
  const buffer = Buffer.alloc(length);
  let offset = 0;
  while (offset < length) {
    const { bytesRead } = await handle.read(buffer, offset, length - offset, position + offset);
    check(bytesRead > 0, '保护包被截断');
    offset += bytesRead;
  }
  return buffer;
}
async function write(handle, bytes) {
  let offset = 0;
  while (offset < bytes.length) {
    const { bytesWritten } = await handle.write(bytes, offset, bytes.length - offset);
    check(bytesWritten > 0, '保护包写入失败');
    offset += bytesWritten;
  }
}
async function stream(opened, offset, size, visitor) {
  for (let at = 0; at < size; ) {
    const bytes = await exact(opened.handle, Math.min(CHUNK, size - at), offset + at);
    await visitor(bytes);
    at += bytes.length;
  }
}
async function fileDigest(file) {
  const opened = await openStable(file),
    hash = crypto.createHash('sha256');
  try {
    await stream(opened, 0, opened.size, (bytes) => hash.update(bytes));
    await assertStable(opened);
    return { bytes: opened.size, sha256: hash.digest('hex') };
  } finally {
    await opened.handle.close();
  }
}
async function isCollection(file) {
  const handle = await fs.open(file, 'r');
  try {
    const bytes = Buffer.alloc(MAGIC.length),
      read = await handle.read(bytes, 0, bytes.length, 0);
    return read.bytesRead === bytes.length && bytes.equals(MAGIC);
  } finally {
    await handle.close();
  }
}
async function exportCollection({ components, file }) {
  check(
    Array.isArray(components) && components.length > 0 && components.length <= MAX_COMPONENTS,
    '换机资料数量超限',
  );
  const selected = [],
    seen = new Set();
  for (const [index, component] of components.entries()) {
    check(component.kind === (index === 0 ? 'current' : 'history'), '换机资料顺序无效');
    // Full original package validation is mandatory; no summary is authority.
    await migration.previewProtection({ file: component.file });
    const digest = await fileDigest(component.file);
    if (seen.has(digest.sha256)) continue;
    seen.add(digest.sha256);
    selected.push({ file: component.file, kind: component.kind, ...digest });
  }
  const header = {
    schema: 1,
    kind: 'yijian-protection-collection',
    createdAt: new Date().toISOString(),
    components: selected.map(({ kind, bytes, sha256 }) => ({ kind, bytes, sha256 })),
  };
  descriptor(header);
  const metadata = Buffer.from(JSON.stringify(header)),
    prefix = Buffer.alloc(MAGIC.length + 4);
  check(metadata.length <= MAX_HEADER, '换机集合清单超限');
  MAGIC.copy(prefix);
  prefix.writeUInt32BE(metadata.length, MAGIC.length);
  const target = path.resolve(file),
    temporary = path.join(path.dirname(target), '.collection-' + crypto.randomUUID() + '.tmp');
  const output = await fs.open(temporary, 'wx', 0o600),
    digest = crypto.createHash('sha256');
  try {
    for (const bytes of [prefix, metadata]) {
      await write(output, bytes);
      digest.update(bytes);
    }
    for (const component of selected) {
      const opened = await openStable(component.file),
        inner = crypto.createHash('sha256');
      try {
        check(opened.size === component.bytes, '内包大小发生变化');
        await stream(opened, 0, opened.size, async (bytes) => {
          digest.update(bytes);
          inner.update(bytes);
          await write(output, bytes);
        });
        check(inner.digest('hex') === component.sha256, '内包内容发生变化');
        await assertStable(opened);
      } finally {
        await opened.handle.close();
      }
    }
    const footer = digest.digest();
    await write(output, footer);
    await output.sync();
    await output.close();
    await scanCollection({ file: temporary });
    try {
      await fs.link(temporary, target);
    } catch (error) {
      if (error.code === 'EEXIST') error.protectionOutput = target;
      throw error;
    }
    return {
      file: target,
      packageHash: footer.toString('hex'),
      components: header.components.length,
      histories: header.components.length - 1,
    };
  } finally {
    await output.close().catch(() => {});
    await fs.unlink(temporary).catch(() => {});
  }
}
async function scanCollection({ file, extractionDirectory }) {
  const opened = await openStable(file),
    hash = crypto.createHash('sha256');
  const components = [];
  try {
    const prefix = await exact(opened.handle, MAGIC.length + 4, 0);
    check(prefix.subarray(0, MAGIC.length).equals(MAGIC), '此文件不是换机集合');
    const length = prefix.readUInt32BE(MAGIC.length);
    check(length > 0 && length <= MAX_HEADER, '集合清单大小超限');
    const metadata = await exact(opened.handle, length, prefix.length);
    const header = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(metadata)),
      total = descriptor(header);
    check(opened.size === prefix.length + length + total + 32, '集合被截断或有多余内容');
    hash.update(prefix);
    hash.update(metadata);
    if (extractionDirectory) {
      const parent = await fs.realpath(path.dirname(path.resolve(extractionDirectory)));
      check((await fs.lstat(parent)).isDirectory(), '导入临时目录无效');
      await fs.mkdir(extractionDirectory); // Exclusive new, trusted caller-chosen directory.
    }
    let offset = prefix.length + length;
    for (const [index, component] of header.components.entries()) {
      const componentFile = extractionDirectory
        ? path.join(extractionDirectory, String(index) + '.yijian-protection')
        : undefined;
      const output = componentFile ? await fs.open(componentFile, 'wx', 0o600) : null;
      const inner = crypto.createHash('sha256');
      try {
        await stream(opened, offset, component.bytes, async (bytes) => {
          hash.update(bytes);
          inner.update(bytes);
          if (output) await write(output, bytes);
        });
        check(inner.digest('hex') === component.sha256, '集合内包校验失败', 'PROTECTION_CHECKSUM_MISMATCH');
        if (output) await output.sync();
      } finally {
        if (output) await output.close();
      }
      components.push({ ...component, ...(componentFile ? { file: componentFile } : {}) });
      offset += component.bytes;
    }
    const digest = hash.digest(),
      footer = await exact(opened.handle, 32, offset);
    check(crypto.timingSafeEqual(digest, footer), '集合整体校验失败', 'PROTECTION_CHECKSUM_MISMATCH');
    await assertStable(opened);
    // Inner semantic validation occurs only after the complete outer hash passes.
    if (extractionDirectory)
      for (const component of components)
        component.preview = await migration.previewProtection({ file: component.file });
    return {
      schema: header.schema,
      createdAt: header.createdAt,
      packageHash: digest.toString('hex'),
      components,
    };
  } finally {
    await opened.handle.close();
  }
}
module.exports = {
  exportCollection,
  scanCollection,
  isCollection,
  fileDigest,
  MAGIC,
  MAX_BYTES,
  MAX_COMPONENTS,
};
