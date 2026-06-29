export interface SkillManifest {
    name: string;
    version: string;
    description: string;
    author?: string;
    triggers?: string[];
    type?: 'knowledge' | 'executor';
    tools?: string[];
    requires?: string[];
    enabled?: boolean;
}
export interface InstalledSkill {
    manifest: SkillManifest;
    enabled: boolean;
    promptModule: string | null;
    toolsLoaded: boolean;
}
export interface SkillRegistryData {
    name: string;
    description: string;
    version: string;
}
export interface AgentSkillSearchResult {
    name: string;
    description: string;
    version: string;
    author?: string;
}
export interface AgentSkillPackage {
    name: string;
    version: string;
    description: string;
    author?: string;
    manifest: SkillManifest;
    promptContent: string;
    tools?: any[];
}
