export const memoryIndexHandler = async (task, context) => {
    const svc = context.services.memoryIndexer;
    if (!svc)
        throw new Error('memoryIndexHandler: memoryIndexer not injected');
    await svc.tick();
    return { lastIndexed: Date.now() };
};
