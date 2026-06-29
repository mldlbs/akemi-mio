export const evolutionTickHandler = async (task, context) => {
    const svc = context.services.evolutionService;
    if (!svc)
        throw new Error('evolutionTickHandler: evolutionService not injected');
    await svc.schedulerTick();
    return { state: svc.getSchedulerState() };
};
