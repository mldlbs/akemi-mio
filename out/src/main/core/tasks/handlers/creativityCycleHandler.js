export const creativityCycleHandler = async (task, context) => {
    const svc = context.services.creativityService;
    if (!svc)
        throw new Error('creativityCycleHandler: creativityService not injected');
    await svc.cycle();
    return { cycled: true };
};
