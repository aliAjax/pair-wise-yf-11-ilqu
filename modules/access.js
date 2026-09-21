// 业务模块：调阅冻结
// 扫描批次只有校验通过（verified 且当前版本 active）才允许调阅；
// 隔离中的批次调阅一律 409，且不产生访问记录。补扫一致解除隔离后恢复调阅，
// 调阅对象为新版本，旧版本只读。
const { makeId, now, httpError, required } = require("../lib/util");
const scanBatches = require("./scanBatches");

function listAccessRecords(db, { rubbingId, scanBatchId } = {}) {
  return db.accessRecords.filter(
    (record) =>
      (!rubbingId || record.rubbingId === rubbingId) &&
      (!scanBatchId || record.scanBatchId === scanBatchId)
  );
}

// 调阅：校验未通过/整批隔离时直接 409，且不写入任何访问记录
function access(db, body) {
  required(body, ["scanBatchId"]);
  const batch = scanBatches.getBatch(db, body.scanBatchId);
  const version = scanBatches.currentVersion(batch);

  if (batch.status === "quarantined") {
    throw httpError(409, `扫描批次 ${batch.id} 已整批隔离（完整性校验异常），禁止调阅`);
  }
  if (batch.status !== "verified" || !version || version.status !== "active") {
    throw httpError(
      409,
      `扫描批次 ${batch.id} 当前不可调阅（批次状态：${batch.status}，版本状态：${version ? version.status : "无版本"}）`
    );
  }

  // 只有通过冻结检查才生成访问记录
  const record = {
    id: makeId("access"),
    scanBatchId: batch.id,
    rubbingId: batch.rubbingId,
    version: version.version,
    purpose: body.purpose || "",
    requester: body.requester || "",
    accessedAt: now()
  };
  db.accessRecords.push(record);
  return record;
}

module.exports = { listAccessRecords, access };
