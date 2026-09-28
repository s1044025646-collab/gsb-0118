# 虚构空气污染源解析与异常排放追踪后端

这是一个仅在本机运行的 TypeScript/Node.js/SQLite 后端。它只提供 HTTP API、CLI、虚构监测站/排放源数据生成器和自动化测试；不包含网页，也不连接任何真实环保平台。所有测站、污染物、气象、排放窗口和源指纹都是虚构数据。

## 环境

- Node.js 25（使用内置 `node:sqlite` 与 `node:http`）
- Windows 或类 Unix 终端
- 默认自动选择本机空闲端口

```bash
npm install
npm run build
npm test
```

## 启动与停止

```bash
npm start
```

启动日志会显示实际端口，例如 `http://127.0.0.1:51234`。按 `Ctrl+C` 停止。默认数据库为 `air-local.sqlite`；可用环境变量覆盖：

```powershell
$env:AIR_DB="demo.sqlite"
$env:PORT="0"
npm start
```

`PORT=0` 表示自动端口。迁移在每次打开数据库时执行，全部使用可重复执行的 `CREATE TABLE/INDEX IF NOT EXISTS`。

## 端到端演示

```bash
npm run demo
```

演示会生成虚构双源叠加场景，运行解析，并输出事件报告。报告包含：

- 候选源是否通过风向、传播时滞和排放时段筛选
- 使用的源指纹版本
- 非负贡献和占比
- 每种污染物的观测、模型值与残差
- 不可辨识或拒绝原因

## CLI

先构建：

```bash
npm run build
```

常用命令：

```bash
node dist/cli.js seed double-source
node dist/cli.js import-observations --file observations.json
node dist/cli.js mark-quality --id 12 --quality drift --note "calibration ramp" --corrected 8.2
node dist/cli.js analyze --station S1 --start 2026-01-01T00:00:00Z --end 2026-01-01T04:00:00Z
node dist/cli.js show-run --id 1
node dist/cli.js compare --left 1 --right 2
node dist/cli.js review --id 1 --reviewer analyst --decision confirmed --note "checked"
node dist/cli.js export-event --id 1 --out event.txt
node dist/cli.js demo
```

CLI 会在关键操作前后显示状态，例如导入前/后的记录数、质量标记前后的修订号、解析前/后的运行数。

## HTTP API

主要路由：

- `GET /health`
- `GET /pollutants`
- `GET /stations`
- `GET /sources`
- `POST /observations`
- `POST /observations/:id/quality`
- `GET /stations/:id/observations?start=...&end=...&limit=50&page=1`
- `POST /weather`
- `POST /backgrounds`
- `POST /fingerprints`
- `POST /emission-windows`
- `POST /analysis/runs`
- `GET /analysis/runs?station_id=S1&limit=50&page=1`
- `GET /analysis/runs/:id`
- `GET /analysis/runs/:id/contributions`
- `GET /analysis/runs/:id/residuals`
- `POST /analysis/runs/:id/review`
- `GET /analysis/compare/:left/:right`
- `POST /demo/seed`

所有输入都做参数校验。错误响应格式为：

```json
{
  "error": {
    "code": "INVALID_PARAMETER",
    "message": "value must be a finite number in [0, Infinity]"
  }
}
```

分页使用 `limit` 与 `page`，响应包含 `items`、`limit`、`offset`、`total`。

## 解析规则

解析器对每个时间窗内的多污染物观测执行非负投影最小二乘。原始观测值保存在 `original_value`，人工更正保存在 `corrected_value`，模型估计不会覆盖原始观测。

候选源必须同时满足：

- 源位于站点气象风向上风向，方位角误差不超过 45°
- 按 `距离 / 风速` 回推传播时滞
- 回推后的排放时刻落在该源活动排放时段内
- 有有效源指纹

以下情况不会输出貌似精确的单源比例：

- 完整多污染物样本不足
- 漂移、缺测或排除导致覆盖率不足
- 扣除背景后没有异常增量
- 时间窗内背景浓度发生阶跃
- 候选源指纹高度共线
- 采样污染物数不足以分离候选源

观测更正、气象更新或指纹换版不会改写历史运行；再次解析会生成新运行。历史运行保存数据修订摘要、源指纹 ID、贡献和残差，可继续查询和复算。

## 虚构夹具

生成器支持：

- `double-source`：双源叠加
- `background-jump`：背景突变
- `wind-reversal`：风向反转
- `sensor-drift`：传感器漂移
- `missing`：缺测
- `collinear`：共线源
- `false-alarm`：下风向误报

示例：

```bash
node dist/cli.js seed wind-reversal
```

## 测试

```bash
npm test
```

测试覆盖合成贡献误差、非负约束、拒绝条件、时区边界、重复迁移、并发事务、重启后的持久化状态、API 错误码和分页。时间与随机性通过注入或固定种子控制，不依赖真实等待。
