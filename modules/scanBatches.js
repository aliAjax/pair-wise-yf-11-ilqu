// 业务模块：扫描批次（数字化送扫）
// 扫描批次状态机：scanning（未完成）-> verified（校验通过）
//                         \-> quarantined（校验和异常，整批隔离）-> 补扫一致后 verified
// 同一拓片存在 scanning / quarantined 批次时禁止再次送扫（409，原状态不变）。
const { makeId, now, httpError, required } = require("../lib/util");
const { findUnfinishedScanBatch } = require("../lib/db");
const integrity = require("./integrity");

// 仅已结项且资料齐全的拓片可以送扫
function assertCanSubmitForScan(rubbing) {
  if (rubbing.projectStatus !== "closed") {
    throw httpError(409, `拓片 ${rubbing.code} 尚未结项，不能送扫`);
  }
  if (rubbing.materialsComplete !== true) {
    throw httpError(409, `拓片 ${rubbing.code} 资料不齐全，不能送扫`);
  }
}

function listBatches(db, { rubbingId } = {}) {
  return db.scanBatches
    .filter((batch) => !rubbingId || batch.rubbingId === rubbingId)
    .map((batch) => serialize(db, batch));
}

function getBatch(db, batchId) {
  const batch = db.scanBatches.find((item) => item.id === batchId);
  if (!batch) throw httpError(404, "扫描批次不存在");
  return batch;
}

function createBatch(db, rubbing, body) {
  assertCanSubmitForScan(rubbing);

  // 同一拓片存在未完成扫描时：重复送扫 409，原批次与扫描状态不变
  const unfinished = findUnfinishedScanBatch(db, rubbing.id);
  if (unfinished) {
    throw httpError(
      409,
      `拓片 ${rubbing.code} 存在未完成扫描批次 ${unfinished.id}（${unfinished.status}），不能重复送扫`
    );
  }

  required(body, ["items"]);
  integrity.assertScanItems(body.items);

  const checksums = integrity.buildChecksums(body.items);
  const batch = {
    id: makeId("scanbatch"),
    rubbingId: rubbing.id,
    status: "scanning",
    operator: body.operator || "",
    note: body.note || "",
    currentVersion: null,
    versions: [],
    rescanCount: 0,
    createdAt: now(),
    verifiedAt: null,
    quarantinedAt: null,
    quarantinedReason: null,
    rescannedAt: null
  };
  // 送扫时登记初版影像与校验和，供完整性校验比对
  batch.versions.push({
    version: 1,
    status: "pending",
    items: checksums,
    submittedAt: now(),
    verifiedAt: null
  });
  batch.currentVersion = 1;
  db.scanBatches.push(batch);
  return batch;
}

// 完整性校验：通过则批次可调阅；异常则整批隔离
function verify(db, batchId, body) {
  const batch = getBatch(db, batchId);
  required(body, ["items"]);
  integrity.assertScanItems(body.items);

  if (batch.status === "verified") {
    throw httpError(409, `扫描批次 ${batchId} 已校验通过，无需重复校验`);
  }

  const version = batch.versions.find((item) => item.version === batch.currentVersion);
  const submittedItems = body.items.map((item) => ({
    page: String(item.page),
    checksum: item.checksum || integrity.calcChecksum(item.content)
  }));

  const result = integrity.verifyBatch(version.items, submittedItems);
  if (result.ok) {
    batch.status = "verified";
    batch.verifiedAt = now();
    batch.quarantinedAt = null;
    batch.quarantinedReason = null;
    version.status = "active";
    version.verifiedAt = now();
  } else {
    // 校验和异常：整批隔离，调阅将被冻结
    batch.status = "quarantined";
    batch.quarantinedAt = now();
    batch.quarantinedReason = "完整性校验未通过";
    version.status = "quarantined";
  }
  return { batch, result };
}

// 补扫：仅隔离中的批次可补扫。补扫一致 -> 生成新版本并解除隔离，旧版本只读；
// 仍不一致 -> 保持隔离，批次与扫描状态不变。
function rescan(db, batchId, body) {
  const batch = getBatch(db, batchId);
  if (batch.status !== "quarantined") {
    throw httpError(409, `扫描批次 ${batchId} 当前状态为 ${batch.status}，仅隔离批次可以补扫`);
  }
  required(body, ["items"]);
  integrity.assertScanItems(body.items);

  const previous = batch.versions.find((item) => item.version === batch.currentVersion);
  const submittedItems = body.items.map((item) => ({
    page: String(item.page),
    checksum: item.checksum || integrity.calcChecksum(item.content)
  }));
  const result = integrity.verifyBatch(previous.items, submittedItems);

  if (!result.ok) {
    // 补扫仍不一致：不改批次状态、不生成新版本，等待再次补扫
    throw httpError(409, "补扫影像与原件校验和不一致，批次继续隔离", {
      code: "RESCAN_MISMATCH",
      anomalies: result.anomalies
    });
  }

  // 旧版本转为只读
  batch.versions.forEach((item) => {
    if (item.status === "active" || item.status === "quarantined" || item.status === "pending") {
      item.status = "readonly";
    }
  });

  const nextVersionNo = batch.currentVersion + 1;
  batch.versions.push({
    version: nextVersionNo,
    status: "active",
    items: integrity.buildChecksums(body.items),
    submittedAt: now(),
    verifiedAt: now()
  });
  batch.currentVersion = nextVersionNo;
  batch.status = "verified";
  batch.verifiedAt = now();
  batch.rescannedAt = now();
  batch.quarantinedAt = null;
  batch.quarantinedReason = null;
  batch.rescanCount += 1;
  if (body.note) batch.note = body.note;

  return { batch, result };
}

function currentVersion(batch) {
  return batch.versions.find((item) => item.version === batch.currentVersion) || null;
}

function serialize(db, batch) {
  const rubbing = db.rubbings.find((item) => item.id === batch.rubbingId) || null;
  const version = currentVersion(batch);
  return {
    ...batch,
    rubbingCode: rubbing ? rubbing.code : null,
    available: batch.status === "verified" && !!version && version.status === "active",
    pageCount: version ? version.items.length : 0
  };
}

module.exports = {
  assertCanSubmitForScan,
  listBatches,
  getBatch,
  createBatch,
  verify,
  rescan,
  currentVersion,
  serialize
};
