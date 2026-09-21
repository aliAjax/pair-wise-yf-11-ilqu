const { createError, makeId } = require("../lib/utils");
const scanBatches = require("./scanBatches");

// 完整性校验模块：以校验和比对扫描结果
// 校验和异常 -> 整批隔离（quarantined），调阅由冻结模块拦截
// 补扫一致 -> 生成新版本（completed），旧版本只读（superseded）

function normalizeFiles(files) {
  if (!Array.isArray(files) || files.length === 0) {
    throw createError(400, "files必须是非空数组，每项包含 name 和 checksum");
  }
  return files.map((file) => {
    if (!file || !file.name || !file.checksum) {
      throw createError(400, "每个文件必须包含 name 和 checksum");
    }
    return { name: String(file.name), checksum: String(file.checksum) };
  });
}

// 比对实际上传文件与期望文件清单的校验和
function compareChecksums(actualFiles, expectedFiles) {
  const expectedMap = new Map(expectedFiles.map((file) => [file.name, file.checksum]));
  const actualNames = new Set();
  const mismatches = [];

  for (const file of actualFiles) {
    actualNames.add(file.name);
    if (!expectedMap.has(file.name)) {
      mismatches.push({ name: file.name, reason: "unexpected", expected: null, actual: file.checksum });
    } else if (expectedMap.get(file.name) !== file.checksum) {
      mismatches.push({
        name: file.name,
        reason: "checksum_mismatch",
        expected: expectedMap.get(file.name),
        actual: file.checksum
      });
    }
  }
  for (const file of expectedFiles) {
    if (!actualNames.has(file.name)) {
      mismatches.push({ name: file.name, reason: "missing", expected: file.checksum, actual: null });
    }
  }
  return mismatches;
}

function markQuarantined(batch, mismatches) {
  batch.status = scanBatches.STATUS.QUARANTINED;
  batch.checksumStatus = "failed";
  batch.checksumError = `校验和异常：${mismatches
    .map((item) => `${item.name}(${item.reason})`)
    .join("、")}`;
  batch.quarantinedAt = new Date().toISOString();
  batch.verifiedAt = new Date().toISOString();
  // 补扫后仍不一致：等待下一次补扫
  batch.rescanRequested = false;
}

function spawnNewVersion(db, oldBatch) {
  const newBatch = {
    ...JSON.parse(JSON.stringify(oldBatch)),
    id: makeId("scan"),
    version: oldBatch.version + 1,
    status: scanBatches.STATUS.COMPLETED,
    checksumStatus: "passed",
    checksumError: null,
    rescanCount: 0,
    rescanRequested: false,
    supersededById: null,
    createdAt: new Date().toISOString(),
    scannedAt: new Date().toISOString(),
    verifiedAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
    quarantinedAt: null
  };

  // 旧版本只读保留
  oldBatch.status = scanBatches.STATUS.SUPERSEDED;
  oldBatch.supersededById = newBatch.id;
  oldBatch.rescanRequested = false;
  oldBatch.readOnly = true;

  db.scanBatches.push(newBatch);
  return newBatch;
}

function markCompleted(batch) {
  batch.status = scanBatches.STATUS.COMPLETED;
  batch.checksumStatus = "passed";
  batch.checksumError = null;
  batch.rescanRequested = false;
  batch.verifiedAt = new Date().toISOString();
  batch.completedAt = new Date().toISOString();
  batch.quarantinedAt = null;
}

// 执行完整性校验
// 返回 { batch, newBatch?, mismatches, passed }
function verify(db, batchId, expectedFiles) {
  const batch = scanBatches.getById(db, batchId);
  if (batch.status === scanBatches.STATUS.SUPERSEDED) {
    throw createError(409, "旧版本只读，不能再校验");
  }
  if (batch.status === scanBatches.STATUS.COMPLETED) {
    throw createError(409, "批次已完成校验");
  }
  const canVerify =
    batch.status === scanBatches.STATUS.AWAITING_VERIFICATION ||
    (batch.status === scanBatches.STATUS.QUARANTINED && batch.rescanRequested);
  if (!canVerify) {
    throw createError(409, `批次当前状态为 ${batch.status}，尚无待校验文件`);
  }

  const expected = normalizeFiles(expectedFiles);
  const mismatches = compareChecksums(batch.files, expected);

  if (mismatches.length) {
    // 校验和异常：整批隔离；补扫仍不一致时保持隔离
    markQuarantined(batch, mismatches);
    return { batch, passed: false, mismatches };
  }

  if (batch.rescanRequested) {
    // 补扫一致：生成新版本并解除隔离，旧版本只读
    const newBatch = spawnNewVersion(db, batch);
    return { batch, newBatch, passed: true, mismatches: [] };
  }

  markCompleted(batch);
  return { batch, passed: true, mismatches: [] };
}

// 补扫：上传补扫文件；若同时提供期望校验清单，立即执行校验
// 返回 { batch, newBatch?, passed?, mismatches? }
function rescan(db, batchId, body) {
  const files = normalizeFiles(body.files);
  const batch = scanBatches.rescanUpload(db, batchId, files);
  if (body.expectedFiles !== undefined) {
    return { batch, ...verify(db, batchId, body.expectedFiles) };
  }
  return { batch, quarantined: true };
}

module.exports = {
  normalizeFiles,
  compareChecksums,
  verify,
  rescan
};
