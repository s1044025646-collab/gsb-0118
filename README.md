# 空气污染源解析与异常排放追踪后端

本项目是一个完全本地运行的虚构系统：TypeScript + Node.js + 内置 `node:sqlite`。只提供 JSON API、CLI、虚构数据生成器和自动化测试；不包含网页，也不连接任何真实环保平台。

## 核心约束

- 原始观测保存在 `observations.raw_value`，更正只写入新版本记录的 `corrected_value`，模型估计不回写观测。
- 同一时间窗内对多种污染物做非负源贡献估计，并保存逐污染物残差。
- 风向、源-站方位、风速传播时滞共同筛选候选源；下风向或到达时刻不在窗口内的源不会被用于归因。
- 指纹高度共线、样本不足、无活跃上风向源、残差过大时生成 `rejected` 批次，不输出貌似精确的单源比例。
- 观测更正、气象更新或指纹换版后重新运行会生成新批次；旧批次、候选源、贡献、残差和人工核查仍可查询复算。
- 所有时间戳使用 ISO 8601/UTC 存储；测试固定随机种子和时间，不依赖真实等待。
- 迁移可重复执行；API 默认绑定 `127.0.0.1` 的系统分配空闲端口，也可用 `PORT` 指定。

## 快速开始

要求 Node.js 25+（当前环境为 v25.5.0）。

```powershell
npm install
npm run build
npm test
npm run demo
```

可重复演示会使用 `data/demo.db`，生成固定种子的虚构双源叠加、背景突变、风向反转、传感器漂移和缺测数据，并导出 `data/demo-event-report.json`。

## API 启动与停止

```powershell
# 默认自动端口，数据库为 data/airqs.db
$env:AIRQS_DB='data/airqs.db'
npm start
```

启动后输出类似：

```json
{"status":"listening","url":"http://127.0.0.1:53124","dbPath":"data/airqs.db"}
```

停止服务：在同一终端按 `Ctrl+C`，进程会关闭 HTTP server 和 SQLite 连接。指定固定端口：

```powershell
$env:PORT='18080'
npm start
```

## 主要 API

- `GET /health`：健康检查。
- `POST /v1/generate-fixture`：生成虚构夹具，可传 `{ "seed": 20260118, "start": "2026-01-18T00:00:00.000Z" }`。
- `POST /v1/pollutants`、`/v1/stations`、`/v1/sources`：基础数据。
- `POST /v1/fingerprint-versions`：指纹版本。
- `POST /v1/fingerprint-values`：某版本中源对污染物的指纹值和不确定度。
- `POST /v1/wind`：风向风速记录，`wind_from_deg` 表示风从哪个方位吹来。
- `POST /v1/backgrounds`：带有效期的背景浓度。
- `POST /v1/emission-periods`：源排放时段与相对强度。
- `POST /v1/observations`：原始观测；缺测传 `null`。
- `POST /v1/observations/{id}/quality`：标记 `ok`、`suspect`、`bad`、`missing`。
- `POST /v1/observations/{id}/correction`：保留原观测并创建更正版本。
- `POST /v1/analyses`：运行解析。
- `GET /v1/analyses/{id}`：查看批次、候选源筛选原因、贡献、残差、人工核查。
- `POST /v1/analyses/{id}/reviews`：人工核查结论。
- `GET /v1/...` 列表支持 `?page=1&limit=50`。

解析请求示例：

```json
{
  "station_id": 1,
  "window_start": "2026-01-18T00:00:00.000Z",
  "window_end": "2026-01-18T00:30:00.000Z",
  "fingerprint_version_id": 1,
  "max_travel_seconds": 1200,
  "wind_tolerance_deg": 45
}
```

错误响应统一为：

```json
{ "error": { "code": "VALIDATION_ERROR", "message": "station_id must be positive integer" } }
```

主要错误码：`VALIDATION_ERROR`、`NOT_FOUND`、`CONFLICT`、`INVALID_JSON`、`PAYLOAD_TOO_LARGE`、`INCOMPLETE_FINGERPRINT`、`INTERNAL_ERROR`。解析业务拒绝写在批次 `status=rejected` 和 `reason` 中，包括 `INSUFFICIENT_SAMPLES`、`NO_UPWIND_CANDIDATE`、`COLLINEAR_FINGERPRINTS`、`POOR_IDENTIFIABILITY`。

## CLI

```powershell
npm run build
node dist/src/cli/main.js help
node dist/src/cli/main.js generate-fixture --seed 20260118
node dist/src/cli/main.js import-observations --file observations.json
node dist/src/cli/main.js mark-quality --id 12 --flag bad --note "标定失败"
node dist/src/cli/main.js correct-observation --id 12 --value 18.5 --flag ok --note "人工复核"
node dist/src/cli/main.js run --station-id 1 --start 2026-01-18T00:00:00.000Z --end 2026-01-18T00:30:00.000Z --fingerprint-version-id 1
node dist/src/cli/main.js show --id 1
node dist/src/cli/main.js compare --a 1 --b 2
node dist/src/cli/main.js export-event --id 2 --out event.json
```

导入 JSON 需为对象数组；CSV 首行需包含 `station_id,pollutant_id,observed_at,raw_value`。关键 CLI 操作输出变更前后状态。

## 数据模型

主要表：`pollutants`、`stations`、`emission_sources`、`wind_observations`、`background_concentrations`、`fingerprint_versions`、`fingerprint_values`、`emission_periods`、`observations`、`analysis_batches`、`batch_candidate_sources`、`source_contributions`、`batch_residuals`、`manual_reviews`。

迁移位于 `src/core/db.ts`，当前为 `user_version=1`。重复打开数据库只会检查版本，不重复变更。

## 测试

```powershell
npm test
npm run build
```

测试覆盖：双源叠加合成误差、非负约束、背景突变、风向反转和传播时滞、传感器漂移更正、缺测/坏值、共线源拒绝、UTC 边界、API 校验/分页/错误码，以及关闭并重新打开 SQLite 后的批次持久化。
