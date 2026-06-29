export const creativityDreamHandler = async (task, context) => {
    const svc = context.services.creativityService;
    if (!svc)
        throw new Error('creativityDreamHandler: creativityService not injected');
    await svc.dreamCycle();
    return { dreamed: true };
};
