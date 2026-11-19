import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { nextVersion, bumpFiles } from '../../scripts/bump-version.js';

// 每次测试创建独立临时目录，避免污染真实仓库
const tmpRoots = [];

function makeTmpRoot(workerVersion, pkgVersion = workerVersion) {
  const root = mkdtempSync(join(tmpdir(), 'bump-version-'));
  tmpRoots.push(root);
  writeFileSync(
    join(root, 'worker.js'),
    `const GATEWAY_VERSION = '${workerVersion}';\n`,
  );
  writeFileSync(
    join(root, 'package.json'),
    `{\n  "name": "telegram-private-chat-gateway",\n  "version": "${pkgVersion}",\n  "private": true\n}\n`,
  );
  return root;
}

afterEach(() => {
  for (const root of tmpRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('nextVersion 逢 10 进位', () => {
  it('patch 普通递增：1.0.0 -> 1.0.1', () => {
    expect(nextVersion('1.0.0')).toBe('1.0.1');
  });

  it('0.0.0 -> 0.0.1', () => {
    expect(nextVersion('0.0.0')).toBe('0.0.1');
  });

  it('patch 逢 10 进位到 minor：1.0.9 -> 1.1.0', () => {
    expect(nextVersion('1.0.9')).toBe('1.1.0');
  });

  it('minor 逢 10 进位到 major：1.9.9 -> 2.0.0', () => {
    expect(nextVersion('1.9.9')).toBe('2.0.0');
  });

  it('major 可跨 10：9.9.9 -> 10.0.0', () => {
    expect(nextVersion('9.9.9')).toBe('10.0.0');
  });

  it('非法版本号抛出异常', () => {
    expect(() => nextVersion('abc')).toThrow();
    expect(() => nextVersion('1.2')).toThrow();
    expect(() => nextVersion('1.2.3.4')).toThrow();
    expect(() => nextVersion('1.-1.0')).toThrow();
  });
});

describe('bumpFiles 同步版本号', () => {
  it('同步递增 worker.js / package.json 并返回新版本', () => {
    const root = makeTmpRoot('1.0.9');
    const next = bumpFiles(root);
    expect(next).toBe('1.1.0');
    expect(readFileSync(join(root, 'worker.js'), 'utf8')).toContain("GATEWAY_VERSION = '1.1.0'");
    expect(readFileSync(join(root, 'package.json'), 'utf8')).toContain('"version": "1.1.0"');
  });

  it('worker.js 与 package.json 版本不一致时抛错且不写入任何文件', () => {
    const root = makeTmpRoot('1.0.0', '1.0.1');
    expect(() => bumpFiles(root)).toThrow(/不一致/);
    expect(readFileSync(join(root, 'worker.js'), 'utf8')).toContain("GATEWAY_VERSION = '1.0.0'");
    expect(readFileSync(join(root, 'package.json'), 'utf8')).toContain('"version": "1.0.1"');
  });
});
