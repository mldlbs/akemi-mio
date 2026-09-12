/**
 * FanqiePublish — 番茄小说 CDP 发布 类型定义
 */

/** 凭据 KEY 前缀 */
export const CRED_PREFIX = 'fanqie'

/** 凭据 KEY 常量 */
export const CRED = {
  /** 设置为 'true' 表示已登录（cookie 存在） */
  LOGIN_ESTABLISHED: `${CRED_PREFIX}_login_established`,
  /** 番茄作者平台 URL（默认 https://author.fanqienovel.com） */
  AUTHOR_URL: `${CRED_PREFIX}_author_url`,
} as const
