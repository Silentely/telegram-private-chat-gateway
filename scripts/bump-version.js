#!/usr/bin/env node
/**
 * 版本号递增脚本：patch 逢 10 进位到 minor，minor 逢 10 进位到 major。
 * 同步更新 worker.js 的 GATEWAY_VERSION 与 package.json 的 version。
 *
 * 直接运行（由 .githooks/pre-commit 调用）：node scripts/bump-version.js
 * 成功时向 stdout 输出新版本号（如 1.0.1），失败时退出非零并打印错误。
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const PKG_NAME = 'telegram-private-chat-gateway';

/**
 * 递增版本号，patch 逢 10 进位到 minor，minor 逢 10 进位到 major。
 * 例如 1.0.0 -> 1.0.1、1.0.9 -> 1.1.0、1.9.9 -> 2.0.0。
 * @param {string} version 形如 major.minor.patch 的版本号
 * @returns {string} 递增后的版本号
 */
export function nextVersion(version) {
  const parts = version.split('.').map(Number);
  if (parts.length !== 3 || parts.some((n) => !Number.isInteger(n) || n < 0)) {
    throw new Error(`无效版本号: ${version}`);
  }
  let [major, minor, patch] = parts;
  patch += 1;
  if (patch >= 10) {
    patch = 0;
    minor += 1;
  }
  if (minor >= 10) {
    minor = 0;
    major += 1;
  }
  return `${major}.${minor}.${patch}`;
}

/**
 * 读取并校验 worker.js / package.json 的版本号，一致则递增并写回两处文件。
 * 版本不一致时报错退出，避免静默覆盖手动改动。
 * @param {string} root 仓库根目录
 * @returns {string} 递增后的版本号
 */
export function bumpFiles(root) {
  const workerPath = join(root, 'worker.js');
  const pkgPath = join(root, 'package.json');

  const workerSrc = readFileSync(workerPath, 'utf8');
  const pkgSrc = readFileSync(pkgPath, 'utf8');

  const workerMatch = workerSrc.match(/GATEWAY_VERSION\s*=\s*'([\d.]+)'/);
  const pkgMatch = pkgSrc.match(/"version"\s*:\s*"([\d.]+)"/);
  if (!workerMatch || !pkgMatch) {
    throw new Error('未找到版本号（worker.js 的 GATEWAY_VERSION 或 package.json 的 version）');
  }

  const workerVersion = workerMatch[1];
  const pkgVersion = pkgMatch[1];
  if (workerVersion !== pkgVersion) {
    throw new Error(
      `worker.js(${workerVersion}) 与 package.json(${pkgVersion}) 版本不一致，请先手动对齐`,
    );
  }

  const next = nextVersion(workerVersion);

  writeFileSync(
    workerPath,
    workerSrc.replace(/GATEWAY_VERSION\s*=\s*'[\d.]+'/, `GATEWAY_VERSION = '${next}'`),
  );
  writeFileSync(pkgPath, pkgSrc.replace(/"version"\s*:\s*"[\d.]+"/, `"version": "${next}"`));

  return next;
}

// 主入口：仅作为脚本直接运行时执行，import 时不触发
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..');
  try {
    const next = bumpFiles(root);
    console.log(next);
  } catch (err) {
    console.error(`[bump-version] ${err.message}`);
    process.exit(1);
  }
}
