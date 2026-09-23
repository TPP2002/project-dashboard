# AD-20260924-MODEL-CACHE-LEDGER 施工记录

现状：Claude Code 的模型表已有互斥的普通输入、缓存读、缓存写分桶；DeepSeek 的按模型汇总已算命中率，但页面只列金额；GLM 工单有按模型四桶，页面没列模型；Codex 有输入含缓存和缓存子集，当前只按项目汇总。原来的项目级缓存百分比不能代表各模型。

改法：Claude、DeepSeek、GLM 的模型命中率按 `缓存读 ÷ (普通输入 + 缓存读 + 缓存写)`；Codex 的缓存读是输入的子集，按 `缓存读 ÷ 输入`，不能再把两者相加。分母为零、分桶缺失或不可信时显示“无法计算”，已识别部分不冒充完整账。Codex 会话按已识别的会话模型归组，模型可能在会话中切换，页面明示这一限制。全部项目表引导进入项目查看模型分桶。

全局记账：项目施工 skill 只覆盖代码任务；用户要求所有对话记账，另用用户级 `AGENTS.md` 触发专用个人 skill。按实际项目和任务卡用发布副本 CLI 登记；没有可归属卡或读不到额度时留出明确的落账/未知路径，不伪造消耗或把账户并发差值独占到本对话。

验收：有输入分母的 0% 正常显示，零分母/缺分桶显示“无法计算”；Codex 两个模型的分桶不串账。定向测试 `node --test --test-concurrency=1 test/codexSessions.test.cjs test/deepseekCostUsage.test.cjs test/costUsage.test.cjs` 为 52/52；调度入口 `npm run typecheck`、`npm run build` 均以退出码 0 完成，`npm test` 为 998/998。开发实例浏览器实看：看板项目 GLM `glm-5.3-flash` 显示 97.6%，Codex `gpt-6-astra` 94.7% 和 `gpt-6-sol` 95.5%，Claude 模型行显示命中率；DeepSeek 在该项目近 30 天无工单，空分母显示“无法计算”。全部项目表可进入“通用对话”，并提示点项目查看模型命中率。
