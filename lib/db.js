const { readFile, writeFile, mkdir } = require("fs/promises");
const path = require("path");

const DB_FILE = path.join(__dirname, "..", "data", "db.json");

const initialData = {
  rubbings: [
    {
      id: "rubbing_demo",
      code: "TP-清-014",
      source: "地方碑刻残页",
      paperSize: "42x68cm",
      note: "边缘有旧折痕",
      // 修补项目是否结项、资料是否齐全、是否归档
      projectStatus: "open",
      materialsComplete: false,
      archived: false,
      createdAt: new Date("2026-06-16T00:00:00.000Z").toISOString()
    }
  ],
  damages: [
    {
      id: "damage_demo_1",
      rubbingId: "rubbing_demo",
      position: "左上角第3列题字旁",
      type: "虫蛀孔",
      beforePhotoUrl: "https://example.local/before-014-1.jpg",
      afterPhotoUrl: "",
      status: "pending",
      repairNote: "",
      batchId: null,
      createdAt: new Date("2026-06-16T00:00:00.000Z").toISOString(),
      repairedAt: null
    },
    {
      id: "damage_demo_2",
      rubbingId: "rubbing_demo",
      position: "下边缘中央",
      type: "撕裂",
      beforePhotoUrl: "https://example.local/before-014-2.jpg",
      afterPhotoUrl: "",
      status: "pending",
      repairNote: "",
      batchId: null,
      createdAt: new Date("2026-06-16T00:00:00.000Z").toISOString(),
      repairedAt: null
    }
  ],
  batches: [],
  // 数字化扫描批次
  scanBatches: [],
  // 调阅访问记录
  accessRecords: []
};

// 旧数据迁移：补齐扫描闭环所需集合，旧拓片按“未归档”处理
function migrate(data) {
  let changed = false;

  if (!Array.isArray(data.scanBatches)) {
    data.scanBatches = [];
    changed = true;
  }
  if (!Array.isArray(data.accessRecords)) {
    data.accessRecords = [];
    changed = true;
  }
  if (!Array.isArray(data.batches)) {
    data.batches = [];
    changed = true;
  }
  if (!Array.isArray(data.damages)) {
    data.damages = [];
    changed = true;
  }

  for (const rubbing of data.rubbings || []) {
    // 旧拓片缺少结项/资料/归档字段：项目未结项、资料不齐、按未归档写回
    if (rubbing.projectStatus === undefined) {
      rubbing.projectStatus = "open";
      changed = true;
    }
    if (rubbing.materialsComplete === undefined) {
      rubbing.materialsComplete = false;
      changed = true;
    }
    if (rubbing.archived === undefined) {
      rubbing.archived = false;
      changed = true;
    }
  }

  return changed;
}

async function ensureDb() {
  await mkdir(path.dirname(DB_FILE), { recursive: true });
  try {
    JSON.parse(await readFile(DB_FILE, "utf8"));
  } catch {
    await writeFile(DB_FILE, JSON.stringify(initialData, null, 2));
  }
}

async function readDb() {
  await ensureDb();
  const data = JSON.parse(await readFile(DB_FILE, "utf8"));
  if (migrate(data)) {
    // 旧拓片状态写回数据文件
    await writeFile(DB_FILE, JSON.stringify(data, null, 2));
  }
  return data;
}

async function writeDb(data) {
  await writeFile(DB_FILE, JSON.stringify(data, null, 2));
}

module.exports = { DB_FILE, initialData, readDb, writeDb, migrate };
