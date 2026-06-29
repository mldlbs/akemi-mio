import { WhisperEngine } from '../asr/WhisperEngine';
import { AsrService } from '../asr/AsrService';
import type { StateManager } from './StateManager';
export declare function loadEnvFile(): void;
export declare function setupTransformers(): void;
export declare function initASRWithCache(whisperEngine: WhisperEngine, stateManager: StateManager, asrService: AsrService): void;
