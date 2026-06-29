export declare function useDeviceStatus(): {
    readonly active: boolean;
    readonly setActive: import("react").Dispatch<import("react").SetStateAction<boolean>>;
    readonly ttsPlaying: boolean;
    readonly error: string | undefined;
    readonly setError: import("react").Dispatch<import("react").SetStateAction<string | undefined>>;
    readonly sessionHealth: string;
    readonly personaLevel: string;
    readonly settingsOpen: boolean;
    readonly setSettingsOpen: import("react").Dispatch<import("react").SetStateAction<boolean>>;
};
