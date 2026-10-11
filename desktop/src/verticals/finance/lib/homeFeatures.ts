/**
 * 首页目录：分组和侧栏一级栏目一一对应（首页本身、固定在侧栏底部的「接入 AI」不列），顺序也一样。
 * 每组列出它的二级栏目；只有一个页面的一级就列这一页。
 */
export const HOME_FEATURE_GROUPS = [
  { title: "每日复盘", detail: "收盘后回头看今天", features: [
    { to: "/daily-review", title: "每日复盘", detail: "盘面表现、资金、连板与涨停分档" },
  ] },
  { title: "产业资讯", detail: "产业正在发生什么", features: [
    { to: "/intel", title: "资讯雷达", detail: "聚合新闻、公告与事件线索" },
    { to: "/signals", title: "产业信号", detail: "跟踪上下游的变化线索" },
  ] },
  { title: "产业研究", detail: "按板块拆产业链", features: [
    { to: "/sectors", title: "产业研究", detail: "各个板块，配好让 AI 一步步梳理的提示词" },
  ] },
  { title: "研究工具", detail: "深挖一只、正反立论、拿历史验证", features: [
    { to: "/research", title: "个股深挖", detail: "K 线、财报、事件回看，六阶段研究" },
    { to: "/debate", title: "多空辩论", detail: "同一份数据正反立论，寻找盲点（A 股）" },
    { to: "/backtest", title: "回测", detail: "验证历史表现与策略假设" },
    { to: "/candidates", title: "候选池", detail: "按你设的条件逐只核对，不排名" },
  ] },
  { title: "我的股票", detail: "自选、持仓和它们的事件", features: [
    { to: "/my-stocks", title: "自选与持仓", detail: "自选总览、持仓台账与收益" },
    { to: "/calendar", title: "事件日历", detail: "自选和持仓未来 30 天的事件" },
    { to: "/inbox", title: "提醒", detail: "收盘摘要、自选变化与推送" },
  ] },
  { title: "资料库", detail: "把研究积累留在自己手里", features: [
    { to: "/my-reports", title: "我的研报", detail: "导入、查阅和分析研究资料" },
    { to: "/notes", title: "研究记录", detail: "沉淀观点、问题与研究笔记" },
  ] },
] as const;
