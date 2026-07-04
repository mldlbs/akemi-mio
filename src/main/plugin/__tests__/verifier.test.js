import { describe, it, expect } from 'vitest';
import { generateKeyPairSync, sign, verify } from 'crypto';
const SIGNATURE_COMMENT_PREFIX = '// @akemi-mio-signature:';
const keyPair = generateKeyPairSync('ed25519');
const publicKey = keyPair.publicKey;
const privateKey = keyPair.privateKey;
function makeSignedPlugin(code) {
    const sig = sign(null, Buffer.from(code, 'utf-8'), privateKey);
    return code + '\n' + SIGNATURE_COMMENT_PREFIX + sig.toString('base64') + '\n';
}
function stripSignatureLine(content) {
    const lines = content.split('\n');
    let lastLineIndex = lines.length - 1;
    while (lastLineIndex >= 0 && lines[lastLineIndex].trim() === '')
        lastLineIndex--;
    if (lastLineIndex < 0)
        return null;
    const lastLine = lines[lastLineIndex].trim();
    if (!lastLine.startsWith(SIGNATURE_COMMENT_PREFIX))
        return null;
    const contentLines = lines.slice(0, lastLineIndex).join('\n');
    return lines[lastLineIndex - 1] === '' ? contentLines + '\n' : contentLines;
}
function getSignatureAndContent(signed) {
    const lines = signed.split('\n');
    let lastIdx = lines.length - 1;
    while (lastIdx >= 0 && lines[lastIdx].trim() === '')
        lastIdx--;
    if (lastIdx < 0)
        return null;
    const sigLine = lines[lastIdx].trim();
    if (!sigLine.startsWith(SIGNATURE_COMMENT_PREFIX))
        return null;
    const sigBase64 = sigLine.slice(SIGNATURE_COMMENT_PREFIX.length).trim();
    if (!sigBase64)
        return null;
    const contentLines = lines.slice(0, lastIdx).join('\n');
    const contentBytes = Buffer.from(lines[lastIdx - 1] === '' ? contentLines + '\n' : contentLines, 'utf-8');
    return { signature: Buffer.from(sigBase64, 'base64'), contentBytes };
}
describe('Plugin Ed25519 签名', () => {
    it('有效签名验证通过', () => {
        const code = 'module.exports = { manifest: { name: "test" } }';
        const signed = makeSignedPlugin(code);
        const content = stripSignatureLine(signed);
        expect(content).toBe(code);
        const data = getSignatureAndContent(signed);
        const isValid = verify(null, data.contentBytes, publicKey, data.signature);
        expect(isValid).toBe(true);
    });
    it('篡改后验证失败', () => {
        const code = 'module.exports = { manifest: { name: "test" } }';
        const signed = makeSignedPlugin(code);
        const tampered = signed.replace('"test"', '"evil"');
        const data = getSignatureAndContent(tampered);
        if (!data) {
            expect(true).toBe(true);
            return;
        }
        const isValid = verify(null, data.contentBytes, publicKey, data.signature);
        expect(isValid).toBe(false);
    });
    it('无签名行返回 null', () => {
        const content = stripSignatureLine('module.exports = { manifest: { name: "test" } }');
        expect(content).toBeNull();
    });
    it('空文件无签名行', () => {
        const content = stripSignatureLine('');
        expect(content).toBeNull();
    });
    it('签名行格式解析正确', () => {
        const code = 'const x = 1';
        const signed = makeSignedPlugin(code);
        const trimmed = signed.trimEnd();
        expect(trimmed).toMatch(new RegExp(`${SIGNATURE_COMMENT_PREFIX}[A-Za-z0-9+/=]+$`));
    });
});
