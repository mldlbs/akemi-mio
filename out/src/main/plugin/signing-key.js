/**
 * Akemi Mio 插件签名公钥
 *
 * 生成方式：
 *   node -e "const {generateKeyPairSync}=require('crypto');const k=generateKeyPairSync('ed25519');console.log(k.publicKey.export({type:'spki',format:'der'}).toString('hex'))"
 *
 * 签名方式：
 *   从插件文件中移除签名行 → 用私钥签名剩余内容 → Base64 编码 → 追加签名行
 */
export const PLUGIN_SIGNING_PUBLIC_KEY = '302a300506032b6570032100da3984d425fd61409723b809d57cee8754a8ba5181f51c6f26dc34c69083b778';
/** 签名注释行前缀（出现在 .js 文件最后一行） */
export const SIGNATURE_COMMENT_PREFIX = '// @akemi-mio-signature:';
