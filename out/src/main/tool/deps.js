let _planManager = null;
let _credentialsManager = null;
let _memoryService = null;
let _skillManager = null;
let _proceduralMemory = null;
export function setPlanManager(pm) {
    _planManager = pm;
}
export function setCredentialsManager(cm) {
    _credentialsManager = cm;
}
export function setMemoryService(ms) {
    _memoryService = ms;
}
export function setSkillManager(sm) {
    _skillManager = sm;
}
export function setProceduralMemory(pm) {
    _proceduralMemory = pm;
}
export function getPlanManager() {
    return _planManager;
}
export function getCredentialsManager() {
    return _credentialsManager;
}
export function getMemoryService() {
    return _memoryService;
}
export function getSkillManager() {
    return _skillManager;
}
export function getProceduralMemory() {
    return _proceduralMemory;
}
