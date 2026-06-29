import { log } from '../logger/Logger';
export class DualWriteHelper {
    constructor() {
        this.jsonEnabled = true;
    }
    disableJson() {
        this.jsonEnabled = false;
        log('INFO', 'dual_write_json_disabled');
    }
    write(config) {
        config.writeDb();
        if (this.jsonEnabled) {
            try {
                config.writeJson();
            }
            catch (err) {
                log('WARN', 'dual_write_json_failed', { label: config.label, error: String(err) });
            }
        }
    }
    verify(config) {
        const dbCount = config.countDb();
        const jsonCount = config.countJson();
        if (dbCount === jsonCount) {
            log('INFO', 'dual_write_consistent', { label: config.label, dbCount, jsonCount });
            return true;
        }
        log('WARN', 'dual_write_inconsistent', { label: config.label, dbCount, jsonCount });
        return false;
    }
}
export const dualWrite = new DualWriteHelper();
