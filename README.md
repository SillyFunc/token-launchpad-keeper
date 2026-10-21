# SillyFunc Launchpad Keeper

Cloudflare Workers 免费层上的 BSC 四通道税费、自动加池与自动回购执行器。它规划三类任务:`tax`(市场/销毁/LP/分红拆分)、`liquidity`(双边加池并销毁 LP)和 `buyback`。四通道资金流的设计与威胁模型见主仓库 [`docs/four-channel-tax-design.md`](https://github.com/SillyFunc/token-launchpad-contracts/blob/main/docs/four-channel-tax-design.md)。keeper 的独立部署与验收文档已移除,部署前请以源码和 `wrangler.jsonc` 为准。

## 安全边界

- Keeper 仅持有 `KEEPER_ROLE` 与少量 Gas,不得持有 Admin 权限。
- 私钥只通过 `wrangler secret put KEEPER_PRIVATE_KEY` 录入。
- 主网交易必须使用独立的 MEV 保护 `SEND_RPC_URL`。
- Worker 不暴露 HTTP 管理接口:仅 `/health` 可访问,其余路径返回 404,Cron 是唯一的执行触发来源。Signer 会重新核对 D1 注册表和链上状态。

## Gas 优化设计与威胁模型

以下策略只修改 Keeper 源码与示例配置,尚未部署到 Worker;现有定时任务不会因本次本地修改自动改变。代币、TaxProcessor、BuybackVault 的链上代码、权限、资金接收方和税率均不改变。

税代币仍由 token / TaxProcessor 托管,LP 双边资产仍由处理器按原账本托管,市场收入仍归固定接收方或金库;经济等待不发送交易、不转移或挪用这些资产。处理器的卖出与加池仍可能产生二次卖税,等待合批只减少执行频次,不提供免税或提款路径。金库回购仍须满足合约的时间、余额及池储备门槛。

Signer 在重新读取链上状态、验证历史价格锚并估算交易后,要求 Gas 成本不超过本批经济价值的配置比例。`tax` 按整批代币在现价与已校验历史锚中的较低 BNB 价值估值,包含纯销毁批次;`liquidity` 只计较低的 WBNB 单边价值,不将两侧重复计价;`buyback` 按实际 BNB 输入计价。估值为 0 不得绕过成本检查。现有储备上限、滑点、历史偏差与短 deadline 继续约束执行,不能为通过经济门槛而放宽。

税处理与加池各自合批,并受单币与全局 Gas 窗口预算约束。Signer 将已签名交易的预算保留到 receipt 到达;pending 交易不能靠重试或窗口滚动逃逸预算,同 nonce 的 replacement 不重复开启冷却。receipt 按实际 Gas 费用结算,链上 revert 同样计费。经济等待使用 `deferred`,由后续检查在冷却结束、余额累计、Gas 降低或窗口预算恢复后重算;它不代表链上故障。

预算预留采用签名的 Gas 上限乘以最终 Gas 价格,包含估算余量。同 nonce 的候选交易全局只预留最高额度;确定赢家后,其他候选不再占费。缺少 receipt 费用字段或 nonce 已前进但 RPC 找不到任何候选回执时,按签名最高费用保守结算,可能在预算窗口内高估支出;不会按零成本释放。旧 Signer 的 pending 会从已保存的原始签名恢复预留,无法恢复时停止签名并报错。

`deferred` 的明细会记录 `gas-ratio`、`cooldown`、`token-gas-budget` 或 `global-gas-budget`。冷却从首次签名与预算成功持久化时开始,失败交易同样受间隔限制;普通检查、经济等待和同 raw 重播不重置计时。已有旧交易尚在 pending 时,新计划被经济门槛拒绝也不会删除旧交易跟踪。Signer 的 `status()` 方法仍返回当前窗口已计费用、未结算预留与全局预算上限,但当前已无 HTTP 路由暴露该方法。

现有 LP 算法在 WBNB 不足时按卖税反推名义代币输入;10% 卖税与 WBNB 限额的回归验证了税后实际配比,因此本次保留该算法。此前链上约 19% 尾数递减和 30 秒调度尚未对应到这个本地实现;本次回归不能证明另一个线上进程已修复。发布前必须核实实际运行程序与唯一调度实例,避免旧实例继续耗 Gas。

攻击者可能制造小额税、捐赠、操纵即时储备或诱发失败来消耗 Keeper 余额。最小经济比例、执行间隔和持久化预算限制此类消耗;历史储备锚、受保护发送端、交易模拟、链上最低输出与权限检查共同约束价格和回调风险。历史锚与 RPC 属于既有链外信任边界,不是链上预言机;未确认交易始终保留 nonce 和费用归属,失败不应清空待处理资产账本。

### 非密钥策略参数

| 环境变量 | 默认值 | 含义 |
|---|---:|---|
| `MAX_GAS_COST_BPS` | `1000` | Gas 成本最多为本批保守经济价值的 10%;范围 1–10000 |
| `TAX_EXECUTION_INTERVAL_SECONDS` | `900` | 同币税处理首次签名之间至少间隔 15 分钟 |
| `LIQUIDITY_EXECUTION_INTERVAL_SECONDS` | `900` | 同币加池首次签名之间至少间隔 15 分钟 |
| `GAS_BUDGET_WINDOW_SECONDS` | `3600` | Gas 预算统计窗口,默认 1 小时 |
| `MAX_TOKEN_GAS_PER_WINDOW_WEI` | `1000000000000000` | 每币每窗口最多 0.001 BNB Gas |
| `MAX_TOTAL_GAS_PER_WINDOW_WEI` | `10000000000000000` | 全局每窗口最多 0.01 BNB Gas |

三个时间参数均为 60–86400 秒;两个预算必须为正 wei,单币预算不得大于全局预算。未设置环境变量时源码采用上述默认值。示例配置新增同名非密钥参数;只有部署包含新 Signer 逻辑的 Worker 后才生效,发布前须完成测试与目标环境配置核对。Cron 检查频率与交易执行间隔是两个独立参数。

## 本地验证

```text
pnpm install
pnpm check
pnpm test
```

复制 `.dev.vars.example` 为 `.dev.vars` 后,使用测试专用私钥运行本地 Worker。`.dev.vars` 已被 Git 忽略。

## Cloudflare 资源

- Cron:每分钟触发一次。
- Workflow:发现、采样、规划、执行和可恢复重试。
- D1:资产注册表、历史储备、运行记录、交易和告警。
- SQLite Durable Object:单钱包 nonce 串行化和幂等签名广播。

`wrangler.jsonc` 是唯一的 Wrangler 配置文件。其中的 `COORDINATOR_ADDRESS`、`KEEPER_ADDRESS` 目前仍为占位值,确认地址后必须替换再部署,然后用 Cloudflare Secrets 录入私钥。D1 不写 `database_id`:首次 `wrangler deploy` 按 `database_name` 自动连接同名数据库,不存在则自动创建;随后立即执行远程迁移建表。测试网运行时直接修改该文件的 `CHAIN_ID`、RPC、合约地址、D1 与 Worker 名称;测试网与主网的数据库及私钥必须相互隔离,不得复用。

主网上线前验收使用同一文件中的 `env.test`(独立 Worker、D1 与 Workflow 名称,放宽单批门槛并收紧 Gas 预算):`pnpm deploy:test`(自动创建 D1)后立即 `pnpm db:migrate:remote:test`,私钥用 `wrangler secret put KEEPER_PRIVATE_KEY --env test` 录入。它与正式 Worker 共用 Keeper 私钥时不得同时运行。验收流程见主仓库 [`docs/mainnet-keeper-test.md`](https://github.com/SillyFunc/token-launchpad-contracts/blob/main/docs/mainnet-keeper-test.md)。