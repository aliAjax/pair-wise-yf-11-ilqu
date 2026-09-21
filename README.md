# 古籍拓片缺损修补 API

纯后端零依赖 Node 服务，使用 `data/db.json` 持久化拓片、缺损项、修补批次，
并提供数字化送扫、完整性校验、调阅冻结的完整闭环。

## 启动

```bash
PORT=3020 node server.js
```

启动时自动迁移：旧拓片缺少结项/资料字段的，按**未归档**处理
（`projectStatus=open`、`materialsComplete=false`、`archiveStatus=unarchived`），状态写回数据文件。

## 模块划分

| 模块 | 文件 | 职责 |
| --- | --- | --- |
| 扫描批次（送扫） | `modules/scanBatches.js` | 送扫资格校验、重复送扫 409、批次状态机、补扫版本化 |
| 完整性校验 | `modules/integrity.js` | 校验和（SHA-256）登记与整批比对，输出异常页清单 |
| 调阅冻结 | `modules/access.js` | 隔离批次禁止调阅（409、不留访问记录），访问留痕 |
| 存储与旧数据迁移 | `lib/db.js` | JSON 读写、旧拓片未归档归一化并写回 |

扫描批次状态机：

```
scanning（未完成）
   ├── verify 一致 ───────> verified（currentVersion active，可调阅）
   └── verify 异常 ───────> quarantined（整批隔离，调阅 409）
                                └── rescan 一致 ─> verified（新版本 active，旧版本 readonly）
```

## 业务规则

- 仅**已结项**（`projectStatus=closed`）且**资料齐全**（`materialsComplete=true`）的拓片可以送扫，否则 409。
- 同一拓片存在未完成扫描批次（`scanning` / `quarantined`）时重复送扫返回 **409**，原批次与扫描状态不变。
- 完整性校验以送扫时登记的每页 SHA-256 为准；任一页缺失或校验和不一致即判定异常，**整批隔离**。
- 隔离期间调阅返回 **409 且不产生访问记录**。
- 补扫与原件一致后：生成**新版本**并解除隔离，旧版本转为只读（`readonly`），调阅只返回当前 active 版本。

## 接口

修补业务（原有）：

- `GET /health`
- `GET /rubbings` / `POST /rubbings` / `PATCH /rubbings/:id`
- `GET|POST /rubbings/:id/damages`
- `GET /damages?status=&type=` / `PATCH /damages/:id`
- `GET|POST /batches` / `GET /batches/:id` / `POST /batches/:id/complete`

数字化闭环（新增）：

- `POST /rubbings/:id/scan-batches` 送扫登记
- `GET /scan-batches?rubbingId=` / `GET /scan-batches/:id`
- `POST /scan-batches/:id/verify` 提交校验（`items` 可传 `checksum`，否则按 `content` 现算）
- `POST /scan-batches/:id/rescan` 补扫，一致后生成新版本
- `POST /accesses` 调阅（隔离/未就绪返回 409，不落访问记录）
- `GET /accesses?rubbingId=&scanBatchId=` 访问记录

## 闭环示例

```bash
# 1. 旧拓片补齐结项与资料（rubbing_demo 启动时已被迁移为未归档）
curl -X PATCH http://127.0.0.1:3020/rubbings/rubbing_demo \
  -H 'Content-Type: application/json' \
  -d '{"projectStatus":"closed","materialsComplete":true}'

# 2. 送扫（rubbing_demo_done 初始即可送扫）
curl -X POST http://127.0.0.1:3020/rubbings/rubbing_demo_done/scan-batches \
  -H 'Content-Type: application/json' \
  -d '{"operator":"张三","items":[{"page":"p1","content":"整拓影像-第1页"},{"page":"p2","content":"整拓影像-第2页"}]}'

# 3. 再次送扫 -> 409，原批次状态不变
# 4. 校验：故意提交错误内容 -> 整批隔离
curl -X POST http://127.0.0.1:3020/scan-batches/<id>/verify \
  -H 'Content-Type: application/json' \
  -d '{"items":[{"page":"p1","content":"被篡改的内容"},{"page":"p2","content":"整拓影像-第2页"}]}'

# 5. 隔离下调阅 -> 409，GET /accesses 中无记录
curl -X POST http://127.0.0.1:3020/accesses \
  -H 'Content-Type: application/json' \
  -d '{"scanBatchId":"<id>","requester":"李四","purpose":"展览核对"}'

# 6. 补扫一致 -> 生成 v2、解除隔离、v1 只读；随后调阅成功并留下访问记录
curl -X POST http://127.0.0.1:3020/scan-batches/<id>/rescan \
  -H 'Content-Type: application/json' \
  -d '{"items":[{"page":"p1","content":"整拓影像-第1页"},{"page":"p2","content":"整拓影像-第2页"}]}'
```
