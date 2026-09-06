// 画布对象的唯一 id 生成器（时间+自增+随机，避免同 tick 撞车）
let seq = 0;
const rid = () => Date.now().toString(36) + "-" + (seq++).toString(36) + Math.random().toString(36).slice(2, 6);

export const newId = (prefix: string) => `${prefix}-${rid()}`;
