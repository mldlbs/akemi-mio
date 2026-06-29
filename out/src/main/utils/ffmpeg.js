import { existsSync } from 'fs';
import { FFPLAY_PATHS, FFMPEG_PATHS } from '../config';
/** Find a usable ffplay executable from configured search paths. Falls back to bare name. */
export function findFfplay() {
    for (const p of FFPLAY_PATHS) {
        if (p === 'ffplay' || existsSync(p))
            return p;
    }
    return 'ffplay';
}
/** Find a usable ffmpeg executable from configured search paths. Falls back to bare name. */
export function findFfmpeg() {
    for (const p of FFMPEG_PATHS) {
        if (p === 'ffmpeg' || existsSync(p))
            return p;
    }
    return 'ffmpeg';
}
