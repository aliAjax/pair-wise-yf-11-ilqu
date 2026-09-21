const { createError, makeId } = require("../lib/utils");
const rubbings = require("./rubbings");
const scanBatches = require("./scanBatches");

// 调阅冻结模块
// 规则：
//  - 无已完成扫描版本：拒绝调阅（409）
//  - 最新扫描批次处于隔离：整批冻结，调阅 409，且不产生访问记录
//  - 补扫成功后新版本可用，自动解冻
//  - 旧版本只读，可通过 batchId 指定查阅，但隔离批次一律拒绝

function getAccessibleBatch(db, rubbingId, batchId) {
  const batches = scanBatches.listByRubbing(db, rubbingId);

  if (batchId) {
    const batch = batches.find((item) => item.id === batchId);
    if (!batch) {
      throw createError(404, "扫描批次不存在");
    }
    if (batch.status === scanBatches.STATUS.QUARANTINED) {
      throw createError(409, "该扫描批次校验和异常已隔离，禁止调阅", {
        batchId: batch.id,
        frozen: true
      });
    }
    if (batch.status !== scanBatches.STATUS.COMPLETED &&
        batch.status !== scanBatches.STATUS.SUPERSEDED) {
      throw createError(409, `该扫描批次状态为 ${batch.status}，尚不可调阅`, {
        batchId: batch.id,
        frozen: batch.status === scanBatches.STATUS.QUARANTINED
      });
    }
    return batch;
  }

  const latest = batches.length ? batches[batches.length - 1] : null;
  // 最新批次处于隔离 => 整批冻结，即便存在更早的已完成版本也拒绝调阅
  if (latest && latest.status === scanBatches.STATUS.QUARANTINED) {
    // 隔离即冻结：在此抛出，调用方不得写入访问记录
    throw createError(409, "扫描批次校验和异常，整批隔离冻结，暂停调阅", {
      batchId: latest.id,
      frozen: true
    });
  }
  // 新版本首扫在途时，仍可回退到最近一个已完成版本
  const currentVersion = [...batches].reverse().find(
    (item) => item.status === scanBatches.STATUS.COMPLETED
  );
  if (!currentVersion) {
    throw createError(409, "拓片尚无可调阅的扫描版本", { frozen: false });
  }
  return currentVersion;
}

// 调阅申请：通过冻结检查后才生成访问记录
function requestAccess(db, rubbingId, body = {}) {
  const rubbing = rubbings.getById(db, rubbingId);
  // 检查不通过直接抛 409，不会执行到写记录的步骤
  const batch = getAccessibleBatch(db, rubbingId, body.batchId);

  const record = {
    id: makeId("access"),
    rubbingId,
    batchId: batch.id,
    version: batch.version,
    requester: body.requester || "anonymous",
    purpose: body.purpose || "",
    files: batch.files,
    granted: true,
    createdAt: new Date().toISOString()
  };
  db.accessRecords.push(record);
  return { record, batch, rubbingCode: rubbing.code };
}

function listRecords(db, { rubbingId, batchId } = {}) {
  return db.accessRecords
    .filter(
      (record) =>
        (!rubbingId || record.rubbingId === rubbingId) &&
        (!batchId || record.batchId === batchId)
    )
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}

module.exports = { getAccessibleBatch, requestAccess, listRecords };
