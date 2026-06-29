/** SSH 执行远程命令 */
export declare function sshExec(host?: string, command?: string, timeout?: number): Promise<string>;
/** SSH 读取远程文件内容 */
export declare function sshReadFile(remotePath: string): Promise<string>;
/** SSH 写入远程文件 */
export declare function sshWriteFile(remotePath: string, content: string): Promise<void>;
/** SSH grep 远程文件内容 */
export declare function sshGrep(pattern: string, path?: string): Promise<string>;
/** SSH glob 搜索远程文件 */
export declare function sshSearchFiles(pattern: string): Promise<string>;
