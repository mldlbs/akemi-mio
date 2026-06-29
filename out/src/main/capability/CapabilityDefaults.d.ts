import type { CapabilityAction } from './types';
export declare const DEFAULT_CAPABILITIES: Readonly<Record<string, readonly CapabilityAction[]>>;
export declare function freezeDefaults(): void;
export declare function isDefaultsFrozen(): boolean;
