const { createError, makeId } = require("../lib/utils");
const rubbings = require("./rubbings");

// 数字化扫描批次模块
// 状态机：
//   awaiting_scan        已送扫、待扫描
//   awaiting_verification 扫描文件已上传、待完整性校验
//   quarantined          校验和异常，整批隔离（补扫期间仍保持隔离）
//   completed            校验通过，当前可用版本
//   superseded           已被补扫新版本替代，旧版本只读

const STATUS = {
  AWAITING_SCAN: "awaiting_scan",
  AWAITING_VERIFICATION: "awaiting_verification",
  QUARANTINED: "quarantined",
  COMPLETED: "completed",
  SUPERSEDED: "superseded"
};

// 尚未完成的扫描：存在这些状态的批次时，重复送扫返回 409
const UNFINISHED_STATUSES = [
  STATUS.AWAITING_SCAN,
  STATUS.AWAITING_VERIFICATION,
  STATUS.QUARANTINED
];

function getById(db, batchId) {
  const batch = db.scanBatches.find((item) => item.id === batchId);
  if (!batch) {
    throw createError(404, "扫描批次不存在");
  }
  return batch;
}

function listByRubbing(db, rubbingId) {
  return db.scanBatches
    .filter((item) => item.rubbingId === rubbingId)
    .sort((a, b) => a.version - b.version);
}

function latestForRubbing(db, rubbingId) {
  const list = listByRubbing(db, rubbingId);
  return list.length ? list[list.length - 1] : null;
}

// 终态/只读批次禁止变更
function assertNotReadOnly(batch) {
  if (batch.status === STATUS.SUPERSEDED) {
    throw createError(409, "旧版本已只读，请以补扫产生的新版本为准");
  }
  if (batch.status === STATUS.COMPLETED) {
    throw createError(409, "扫描批次已完成，不可修改");
  }
}

// 送扫：仅已结项且资料齐全的拓片可送扫；存在未完成扫描时 409（原批次/扫描状态不变）
function submitForScan(db, rubbingId, body = {}) {
  const rubbing = rubbings.getById(db, rubbingId);
  rubbings.assertScannable(db, rubbing);

  const unfinished = listByRubbing(db, rubbingId).find((item) =>
    UNFINISHED_STATUSES.includes(item.status)
  );
  if (unfinished) {
    throw createError(409, "该拓片存在未完成的扫描批次，请勿重复送扫", {
      existingBatchId: unfinished.id,
      existingStatus: unfinished.status
    });
  }

  const version = (latestForRubbing(db, rubbingId)?.version || 0) + 1;
  const batch = {
    id: makeId("scan"),
    rubbingId,
    version,
    status: STATUS.AWAITING_SCAN,
    requestedBy: body.requestedBy || "",
    note: body.note || "",
    files: [],
    checksumStatus: "pending",
    checksumError: null,
    rescanCount: 0,
    rescanRequested: false,
    supersededById: null,
    createdAt: new Date().toISOString(),
    scannedAt: null,
    verifiedAt: null,
    quarantinedAt: null,
    completedAt: null
  };
  db.scanBatches.push(batch);
  return batch;
}

// 扫描方上传文件（每个文件含 name 与 checksum），上传后进入待校验
function uploadFiles(db, batchId, files) {
  const batch = getById(db, batchId);
  assertNotReadOnly(batch);
  if (batch.status !== STATUS.AWAITING_SCAN) {
    throw createError(409, `批次当前状态为 ${batch.status}，不能上传首扫文件，请使用补扫接口`);
  }
  if (!Array.isArray(files) || files.length === 0) {
    throw createError(400, "files必须是非空数组，每项包含 name 和 checksum");
  }
  batch.files = files;
  batch.status = STATUS.AWAITING_VERIFICATION;
  batch.scannedAt = new Date().toISOString();
  return batch;
}

// 补扫上传：仅隔离中的批次可补扫；补扫期间整批保持隔离，等待校验结果
function rescanUpload(db, batchId, files) {
  const batch = getById(db, batchId);
  assertNotReadOnly(batch);
  if (batch.status !== STATUS.QUARANTINED) {
    throw createError(409, `批次当前状态为 ${batch.status}，只有隔离中的批次允许补扫`);
  }
  if (!Array.isArray(files) || files.length === 0) {
    throw createError(400, "files必须是非空数组，每项包含 name 和 checksum");
  }
  batch.files = files;
  batch.rescanRequested = true;
  batch.rescanCount += 1;
  batch.rescanAt = new Date().toISOString();
  // 补扫文件到位、等待校验，隔离不解除
  return batch;
}

function enrich(db, batch) {
  const rubbing = db.rubbings.find((item) => item.id === batch.rubbingId) || null;
  return {
    ...batch,
    fileCount: batch.files.length,
    rubbingCode: rubbing ? rubbing.code : null,
    readOnly: batch.status === STATUS.SUPERSEDED
  };
}

module.exports = {
  STATUS,
  UNFINISHED_STATUSES,
  getById,
  listByRubbing,
  latestForRubbing,
  submitForScan,
  uploadFiles,
  rescanUpload,
  enrich
};
