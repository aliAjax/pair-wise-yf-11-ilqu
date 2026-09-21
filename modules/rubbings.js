const { createError } = require("../lib/utils");

// 拓片生命周期：修补结项、资料确认、归档前置
// 只有“已结项 + 资料齐全”的拓片才允许数字化送扫

function getById(db, rubbingId) {
  const rubbing = db.rubbings.find((item) => item.id === rubbingId);
  if (!rubbing) {
    throw createError(404, "拓片不存在");
  }
  return rubbing;
}

// 检查资料是否齐全：基础字段完整且每项缺损都有修复后照片
function missingMaterials(db, rubbing) {
  const missing = [];
  if (!rubbing.code) missing.push("code");
  if (!rubbing.source) missing.push("source");
  if (!rubbing.paperSize) missing.push("paperSize");

  const damages = db.damages.filter((item) => item.rubbingId === rubbing.id);
  if (damages.length === 0) {
    missing.push("缺损记录（至少一项）");
  } else {
    const noAfterPhoto = damages.filter((item) => !item.afterPhotoUrl);
    if (noAfterPhoto.length) {
      missing.push(`缺损项缺少修复后照片：${noAfterPhoto.map((item) => item.id).join(", ")}`);
    }
  }
  return missing;
}

// 送扫前置校验：仅已结项且资料齐全可送扫
function assertScannable(db, rubbing) {
  const reasons = [];
  if (rubbing.projectStatus !== "closed") {
    reasons.push("修补项目未结项");
  }
  const missing = missingMaterials(db, rubbing);
  if (missing.length) {
    reasons.push(`资料不齐全（${missing.join("、")}）`);
  }
  if (reasons.length) {
    throw createError(409, `拓片不满足送扫条件：${reasons.join("；")}`, { reasons });
  }
}

// 结项：所有缺损必须已修复
function closeProject(db, rubbingId) {
  const rubbing = getById(db, rubbingId);
  const damages = db.damages.filter((item) => item.rubbingId === rubbingId);
  const unfinished = damages.filter((item) => item.status !== "repaired");
  if (unfinished.length) {
    throw createError(
      409,
      `尚有 ${unfinished.length} 项缺损未修复，无法结项`,
      { damageIds: unfinished.map((item) => item.id) }
    );
  }
  rubbing.projectStatus = "closed";
  rubbing.closedAt = new Date().toISOString();
  return rubbing;
}

// 资料确认：自动核验，齐全才写入
function confirmMaterials(db, rubbingId) {
  const rubbing = getById(db, rubbingId);
  const missing = missingMaterials(db, rubbing);
  if (missing.length) {
    throw createError(409, `资料不齐全，无法确认：${missing.join("、")}`, { missing });
  }
  rubbing.materialsComplete = true;
  rubbing.materialsCheckedAt = new Date().toISOString();
  return rubbing;
}

// 归档：必须先结项且资料齐全（旧拓片迁移后为未归档）
function archive(db, rubbingId) {
  const rubbing = getById(db, rubbingId);
  if (rubbing.projectStatus !== "closed" || !rubbing.materialsComplete) {
    throw createError(409, "拓片未结项或资料不齐全，无法归档");
  }
  rubbing.archived = true;
  rubbing.archivedAt = new Date().toISOString();
  return rubbing;
}

module.exports = {
  getById,
  missingMaterials,
  assertScannable,
  closeProject,
  confirmMaterials,
  archive
};
