import { useState } from 'react';
import { useIPCEvent } from './useIPCEvent';
export function useDeviceStatus() {
    const [active, setActive] = useState(false);
    const [ttsPlaying, setTtsPlaying] = useState(false);
    const [error, setError] = useState();
    const [sessionHealth, setSessionHealth] = useState('100:HEALTHY:RUNNING');
    const [personaLevel, setPersonaLevel] = useState('core');
    const [settingsOpen, setSettingsOpen] = useState(false);
    useIPCEvent(window.electronAPI.onStateUpdate, (s) => {
        if (s.error)
            setError(s.error);
        if (s.ttsPlaying !== undefined)
            setTtsPlaying(s.ttsPlaying);
        if (s.sessionHealth)
            setSessionHealth(s.sessionHealth);
    });
    useIPCEvent(window.electronAPI.onPersonaUpdated, (data) => {
        setPersonaLevel(data.level);
    });
    return { active, setActive, ttsPlaying, error, setError, sessionHealth, personaLevel, settingsOpen, setSettingsOpen };
}
