export declare class CredentialsManager {
    /** 验证凭据名称的合法性 */
    private validateKey;
    get(name: string): string | null;
    set(name: string, value: string): void;
    delete(name: string): boolean;
    list(): string[];
    has(name: string): boolean;
    migrate(): void;
}
export declare const credentialsManager: CredentialsManager;
