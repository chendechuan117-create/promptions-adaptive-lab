// Synthetic fixtures only. These directions are not housing facts or model output.
export const GOAL = '挑选住宿，兼顾通勤与日常生活';
export const SCOPE = '固定合成方向，仅验证交互；不是模型质量演示，建议未经核实。';
const option = (id, label, hint) => Object.freeze({ id, label, hint });
export const ROOT_OPTIONS = Object.freeze([
  option('commute', '通勤', '可考虑往返时间、路线与备选方式。'),
  option('rest', '休息', '可考虑安静、采光与自己的作息。'),
  option('daily', '日常安排', '可考虑吃饭、办事与居住空间。'),
  option('cost', '开销', '可考虑总支出、调整余地与取舍。'),
]);
export const EXPANDED_OPTIONS = Object.freeze({
  commute: Object.freeze([
    option('commute-time', '往返时间', '可考虑在实际出行时段核实门到门耗时。'),
    option('commute-route', '路线体验', '可考虑步行、换乘和高峰拥挤的影响。'),
    option('commute-backup', '备选通勤方式', '可考虑路线中断或晚归时的其他方式。'),
  ]),
  rest: Object.freeze([
    option('rest-noise', '安静程度', '可考虑在不同时间实地了解噪声。'),
    option('rest-light', '采光与遮光', '可考虑白天采光与夜间遮光需求。'),
    option('rest-routine', '作息适配', '可考虑自己的作息与周边活动时间。'),
  ]),
  daily: Object.freeze([
    option('daily-food', '吃饭安排', '可考虑做饭、买菜与外食的便利程度。'),
    option('daily-errands', '日常办事', '可考虑购物、运动和常用服务的距离。'),
    option('daily-space', '空间使用', '可考虑休息、工作和收纳的空间需求。'),
  ]),
  cost: Object.freeze([
    option('cost-total', '总支出', '可考虑租金、交通、水电与其他费用。'),
    option('cost-flexibility', '调整余地', '可考虑租期、搬迁与支出变化的余地。'),
    option('cost-tradeoff', '取舍边界', '可考虑愿为时间、安静或便利付出多少。'),
  ]),
});
export const ALL_OPTIONS = Object.freeze([...ROOT_OPTIONS, ...Object.values(EXPANDED_OPTIONS).flat()]);
export const OPTION_IDS = Object.freeze(ALL_OPTIONS.map(({ id }) => id));
export function rootResult() {
  return { fixture: true, view: 'root', scope: SCOPE, goal: GOAL, options: ROOT_OPTIONS };
}
export function expandedResult(focus) {
  return { fixture: true, view: 'expanded', focus, scope: SCOPE, goal: GOAL, options: EXPANDED_OPTIONS[focus] };
}
export function handoffResult(selected_ids, note = '') {
  const selected = [...new Set(selected_ids)].map((id) => {
    const { label } = ALL_OPTIONS.find((item) => item.id === id);
    return { id, label };
  });
  const directions = selected.length ? selected.map(({ label }) => `可考虑方向：${label}`).join('；') : '尚未选择考虑方向';
  const summary = `目标：${GOAL}。${directions}。这些是固定合成方向，未经核实，不代表住宿事实或已满足的条件。用户提供的备注：${note || '（无）'}。请根据当前信息回答原问题，区分用户补充与待核实事项。`;
  return { fixture: true, goal: GOAL, selected, note, summary };
}
